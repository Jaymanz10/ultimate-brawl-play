// Online play for Ultimate Brawl (docs/superpowers/specs/2026-09-26-online-play-design.md).
// Lockstep: both sides run the same fight from the same inputs. Only one input byte per player per frame crosses the network.
(function(G){
class Lockstep{
 constructor(side,delay,send,id){this.side=side;this.D=delay;this.send=send;this.id=id||1;this.frame=0;this.buf=[new Map(),new Map()];this.localTop=delay-1;
  for(let f=0;f<delay;f++){this.buf[0].set(f,0);this.buf[1].set(f,0)}   // nobody can have pressed anything before the delay
  this.mine=new Map();this.theirs=new Map();this.desync=-1;this.onDesync=null;this.rFrame=0;this.rAdv=0;this.adv=[];this.skipT=0}
 pkt(){const L=this.buf[this.side],b=[];for(let g=this.localTop-7;g<=this.localTop;g++)b.push(L.has(g)?L.get(g):-1);
  return{t:'in',id:this.id,f:this.localTop,b,fr:this.frame,a:this.frame-this.rFrame}}
 local(bits){const f=this.frame+this.D,L=this.buf[this.side];if(!L.has(f)){L.set(f,bits);this.localTop=f}this.send(this.pkt())}
 resend(){this.send(this.pkt())}
 recv(m){if(m.id!==this.id)return;
  if(m.t==='in'){const R=this.buf[1-this.side];m.b.forEach((v,i)=>{const g=m.f-m.b.length+1+i;if(v>=0&&g>=this.frame&&!R.has(g))R.set(g,v)});this.rFrame=Math.max(this.rFrame,m.fr);this.rAdv=m.a}
  else if(m.t==='hash'){this.theirs.set(m.f,m.h);this.check(m.f)}}
 ready(){return this.buf[0].has(this.frame)&&this.buf[1].has(this.frame)}
 inputs(){return[this.buf[0].get(this.frame),this.buf[1].get(this.frame)]}
 advance(){this.buf[0].delete(this.frame-16);this.buf[1].delete(this.frame-16);this.frame++}
 // GGPO-style time sync: half the difference between our lead and theirs. Symmetric latency cancels out.
 slow(){this.adv.push((this.frame-this.rFrame-this.rAdv)/2);if(this.adv.length>60)this.adv.shift();
  const avg=this.adv.reduce((s,v)=>s+v,0)/this.adv.length;if(avg>1&&++this.skipT>=20){this.skipT=0;return true}return false}
 hash(f,h){this.mine.set(f,h);this.send({t:'hash',id:this.id,f,h});this.check(f)}
 check(f){if(!this.mine.has(f)||!this.theirs.has(f))return;if(this.mine.get(f)!==this.theirs.get(f)&&this.desync<0){this.desync=f;if(this.onDesync)this.onDesync(f)}this.mine.delete(f);this.theirs.delete(f)}}
// Room: a PeerJS connection between two browsers. The public PeerJS broker only introduces them; game traffic goes direct.
// Two channels: 'ctl' (reliable, ordered) for lobby/start/hash/bye, 'in' (unreliable) for per-frame inputs.
const ABC='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',PREFIX='ubrawl-';
// STUN finds a direct route. TURN relays when a strict network blocks it: paste free TURN credentials here (docs/ONLINE.md).
const STUN=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}],TURN=[];
class Room{
 constructor(PeerImpl){this.Peer=PeerImpl||G.Peer;this.peer=null;this.ctl=null;this.inp=null;this.connected=false;this.last=0;this.rtt=0;this.code='';this.timer=null;
  this.onready=()=>{};this.onopen=()=>{};this.onmsg=()=>{};this.onclose=()=>{};this.onerror=()=>{}}
 static ok(){return typeof G.Peer==='function'}
 static code(){let s='';for(let i=0;i<5;i++)s+=ABC[Math.random()*ABC.length|0];return s}
 opts(){return{config:{iceServers:STUN.concat(TURN)}}}
 host(tries){tries=tries||0;this.code=Room.code();const p=this.peer=new this.Peer(PREFIX+this.code,this.opts());
  p.on('open',()=>this.onready(this.code));
  p.on('connection',c=>{if(c.label==='ctl'&&!this.ctl)this.ctl=c;else if(c.label==='in'&&!this.inp)this.inp=c;else{c.close();return}this.wire(c)});
  p.on('error',e=>{if(e.type==='unavailable-id'&&tries<3){p.destroy();this.host(tries+1)}else this.onerror(String(e.type||e).toUpperCase())})}
 join(code){this.code=code;const p=this.peer=new this.Peer(this.opts());
  p.on('open',()=>{this.ctl=p.connect(PREFIX+code,{label:'ctl',reliable:true,serialization:'json'});this.inp=p.connect(PREFIX+code,{label:'in',reliable:false,serialization:'json'});this.wire(this.ctl);this.wire(this.inp)});
  p.on('error',e=>this.onerror(e.type==='peer-unavailable'?'NO ROOM WITH THAT CODE':String(e.type||e).toUpperCase()))}
 wire(c){c.on('open',()=>{if(!this.connected&&this.ctl&&this.inp&&this.ctl.open&&this.inp.open){this.connected=true;this.last=Date.now();
   this.timer=setInterval(()=>this.send({t:'ping',s:Date.now()}),1000);this.onopen()}});
  c.on('data',d=>{this.last=Date.now();if(d.t==='ping')this.send({t:'pong',s:d.s});else if(d.t==='pong')this.rtt=Date.now()-d.s;else this.onmsg(d)});
  c.on('close',()=>{if(this.connected)this.end('closed')})}
 send(d){const c=d.t==='in'?this.inp:this.ctl;if(c&&c.open)try{c.send(d)}catch(e){}}
 alive(){return!this.connected||Date.now()-this.last<5000}
 end(r){if(this.timer)clearInterval(this.timer);this.timer=null;const was=this.connected;this.connected=false;if(this.peer)try{this.peer.destroy()}catch(e){}this.peer=null;if(was)this.onclose(r)}
 leave(){this.send({t:'bye'});this.onclose=()=>{};this.onmsg=()=>{};setTimeout(()=>this.end('left'),200)}}
Room.ABC=ABC;
G.Room=Room;
G.Lockstep=Lockstep;
if(typeof module!=='undefined')module.exports={Lockstep,Room};
})(typeof window!=='undefined'?window:globalThis);
