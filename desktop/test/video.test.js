const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('../../ui/node_modules/typescript');
const path=require('node:path');
function setup(canControl=false){
 const videoElements=[],ticks=[],switches=[],roomCommands=[];
 const song={id:'song1234567',title:'Song',isVideo:false,playable:true,durationMs:120000};
 const clip={...song,id:'clip1234567',isVideo:true};
 const player={track:song,state:'paused',followingRoom:false,position:12000};
 const makeStore=initial=>{let state=initial();return {getState:()=>state,setState:patch=>{state={...state,...patch};}};};
 let response=[song,clip];
 const doc={createElement(){
  const el={muted:false,defaultMuted:false,readyState:1,currentTime:0,duration:120,paused:true,ended:false,error:null,listeners:{},src:'',
   pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},load(){},removeAttribute(k){this[k]='';},setAttribute(){},addEventListener(k,f){this.listeners[k]=f;},remove(){this.parentElement=null;}};
  videoElements.push(el);return el;
 }};
 const source=fs.readFileSync(path.join(__dirname,'../../ui/src/lib/video.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,Map,Promise,Error,Math,Number,queueMicrotask,document:doc,setInterval:f=>{ticks.push(f);return ticks.length;},clearInterval:()=>{},fetch:async()=>({ok:true,json:async()=>response}),require:n=>{
  if(n==='zustand')return {create:makeStore};
  if(n==='./base')return {apiUrl:p=>p};
  if(n==='./player')return {usePlayer:{getState:()=>player},currentPosition:s=>s.position};
  if(n==='./together')return {useTogether:{getState:()=>({room:{current:'entry'}})},roomCanControl:()=>canControl,roomCommand:async c=>{roomCommands.push(c);if(c.kind==='variant')player.track=c.track;return true;}};
  if(n==='./playback')return {switchTrackVariant:async(t,expected)=>{switches.push({t,expected});player.track=t;return true;}};
  throw Error(n);
 }});
 const host=()=>({appendChild(el){el.parentElement=this;}});
 return {...module.exports,player,song,clip,switches,roomCommands,videoElements,host,tick:()=>ticks.at(-1)(),respond:r=>response=r};
}
test('video uses one muted picture element across views and follows audio without commanding it',async()=>{
 const h=setup();await h.setVideoEnabled(true);
 assert.equal(h.switches.length,1);assert.equal(h.player.track.id,h.clip.id);
 const main=h.host(),mini=h.host();const closeMain=h.attachVideo(main,0);
 const el=h.videoElements[0];assert.equal(el.muted,true);assert.equal(el.defaultMuted,true);assert.equal(el.currentTime,12);assert.equal(el.paused,true);
 h.player.position=30000;h.player.state='playing';h.tick();assert.equal(el.currentTime,30);assert.equal(el.paused,false);
 const closeMini=h.attachVideo(mini,20);assert.equal(h.videoElements.length,1);assert.equal(el.parentElement,mini);
 closeMini();assert.equal(el.parentElement,main);assert.equal(h.switches.length,1);
 h.player.state='paused';h.tick();assert.equal(el.paused,true);
 closeMain();await Promise.resolve();assert.equal(el.src,'');
 await h.setVideoEnabled(false);assert.equal(h.player.track.id,h.song.id);assert.equal(h.useVideo.getState().enabled,false);
});
test('unavailable counterpart is explicit and a room guest cannot change versions',async()=>{
 const h=setup();h.respond([]);await h.setVideoEnabled(true);assert.equal(h.useVideo.getState().enabled,false);assert.match(h.useVideo.getState().error,/No matching/);assert.equal(h.switches.length,0);
 const guest=setup();guest.player.followingRoom=true;await guest.setVideoEnabled(true);assert.equal(guest.switches.length,0);assert.match(guest.useVideo.getState().error,/leader/);
});

test('availability is checked without switching playback and cached per track',async()=>{
 const h=setup();h.respond([h.song]);await h.checkVideoAvailability();
 assert.equal(h.useVideo.getState().availability,'unavailable');assert.equal(h.switches.length,0);
 h.player.track=h.clip;await h.checkVideoAvailability();
 assert.equal(h.useVideo.getState().availability,'available');assert.equal(h.switches.length,0);
 h.player.track=h.song;await h.checkVideoAvailability();
 assert.equal(h.useVideo.getState().availability,'unavailable');
});
test('late availability response cannot overwrite the next track',async()=>{
 const h=setup();let finish;h.respond(new Promise(resolve=>{finish=resolve;}));
 const checking=h.checkVideoAvailability();h.player.track=h.clip;
 await h.checkVideoAvailability();finish([h.song]);await checking;
 assert.equal(h.useVideo.getState().availabilityID,h.clip.id);
 assert.equal(h.useVideo.getState().availability,'available');
});

test('slow seeks and buffering are not repeatedly restarted',async()=>{
 const h=setup();await h.setVideoEnabled(true);const detach=h.attachVideo(h.host(),0);
 const el=h.videoElements[0];el.seeking=true;el.currentTime=12;h.player.position=22000;h.tick();assert.equal(el.currentTime,12);
 el.seeking=false;el.listeners.waiting();h.tick();assert.equal(el.currentTime,12);
 el.listeners.canplay();h.tick();assert.equal(el.currentTime,22);
 h.player.state='playing';h.player.position=22400;h.tick();assert.equal(el.currentTime,22);assert.equal(el.playbackRate,1.05);
 h.player.track=h.song;h.tick();assert.equal(el.src,'','next song must not resolve a static art-track video');
 detach();await Promise.resolve();
});

test('room video visibility remains personal while shared variant is selected through the relay',async()=>{
 const h=setup(true);h.player.followingRoom=true;await h.setVideoEnabled(true);
 assert.equal(h.roomCommands[0].kind,'variant');assert.equal(h.player.track.id,h.clip.id);assert.equal(h.switches.length,0);
 await h.setVideoEnabled(false);assert.equal(h.player.track.id,h.clip.id);assert.equal(h.roomCommands[1].kind,'display');assert.equal(h.roomCommands[1].shown,false);
 const guest=setup();guest.player.followingRoom=true;guest.player.track=guest.clip;await guest.setVideoEnabled(true);assert.equal(guest.useVideo.getState().enabled,true);assert.equal(guest.roomCommands.length,0);
});

test('a restored video version without its isVideo flag still shows the picture', async () => {
 const h=setup();
 // A queue saved by an older version: the clip's id, but no video flag.
 h.player.track={...h.clip,isVideo:false};
 await h.setVideoEnabled(true);
 assert.equal(h.switches.length,0,'already the video version; nothing to switch');
 assert.equal(h.isVideoTrack(h.player.track),true);

 h.attachVideo(h.host(),0);h.tick();
 assert.match(h.videoElements[0].src,/\/v1\/video-stream\/clip1234567$/);
});
