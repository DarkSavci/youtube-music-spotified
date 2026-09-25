const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../ui/node_modules/typescript');

// Exercise the actual UI coordinator independently of React rendering/audio.
function create(initial) {
 let state;
 const listeners = new Set();
 const store = () => state;
 store.getState = () => state;
 store.setState = patch => { state = {...state, ...patch}; for (const fn of listeners) fn(state); };
 store.subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
 state = initial(store.setState, store.getState);
 return store;
}
async function setup(t) {
 const protocol = await import('../../listen-together/protocol.mjs');
 const player = create(() => ({track:null,state:'paused',followingRoom:false,notice:null,anchor:{positionMs:0,atMs:performance.now(),rate:0}}));
 const clients=[], calls=[];
 class Client {
  constructor(options) { Object.assign(this,options); clients.push(this); }
  serverNow() { return Date.now(); }
  connect() { this.onStatus({status:'connected',role:'guest',members:2}); }
  stop() { this.onStatus({status:'disconnected',role:null,members:0}); }
  publish() {}
 }
 const source=fs.readFileSync(path.join(__dirname,'../../ui/src/lib/together.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(code,{module,exports:module.exports,Date,Math,Promise,setInterval,clearInterval,setTimeout,clearTimeout,
  require: name => {
   if(name==='zustand')return {create};
   if(name.endsWith('client.mjs'))return {RoomClient:Client};
   if(name.endsWith('protocol.mjs'))return protocol;
   if(name==='./player')return {usePlayer:player,currentPosition:s=>s.anchor.positionMs};
   if(name==='./playback')return {
    isServerAuthoritative:()=>true,
    leaveRoomPlayback:async()=>player.setState({followingRoom:false,state:'paused'}),
    syncRoomPlayback:async(track,positionMs,playing)=>{calls.push({track,positionMs,playing});player.setState({track,followingRoom:true,state:playing?'playing':'paused',anchor:{positionMs,atMs:performance.now(),rate:playing?1:0}});},
   };
   throw new Error(name);
  },
 });
 const coordinator=module.exports;
 t.after(()=>coordinator.leaveTogether());
 return {coordinator,player,clients,calls,flush:()=>new Promise(r=>setImmediate(r))};
}
const track={id:'abcdefghijk',title:'Fixture',durationMs:180000,artists:[]};
test('guest applies host state, avoids tiny corrections, waits on failure, and unlocks on leave',async t=>{
 const h=await setup(t);await h.coordinator.connectTogether({invitation:'test'});await h.flush();
 const client=h.clients[0];
 client.onSnapshot({track,playing:false,positionMs:12000,at:Date.now(),seq:1});await h.flush();
 assert.equal(h.player.getState().track.id,track.id);assert.equal(h.player.getState().followingRoom,true);
 const count=h.calls.length;
 client.onSnapshot({track,playing:false,positionMs:12100,at:Date.now(),seq:2});await h.flush();
 assert.equal(h.calls.length,count,'tiny drift should not seek');
 h.player.setState({track:{...track,playable:false},notice:'Unavailable'});
 client.onSnapshot({track,playing:true,positionMs:12100,at:Date.now(),seq:3});await h.flush();
 assert.equal(h.calls.length,count,'failed track must not loop retries');
 h.coordinator.retryTogetherPlayback();await h.flush();assert.equal(h.calls.length,count+1);
 await h.coordinator.leaveTogether();assert.equal(h.coordinator.useTogether.getState().status,'disconnected');assert.equal(h.player.getState().followingRoom,false);assert.equal(h.player.getState().state,'paused');
});
test('late messages from a departed room cannot replace a new session',async t=>{
 const h=await setup(t);await h.coordinator.connectTogether({invitation:'old'});const old=h.clients[0];
 await h.coordinator.connectTogether({invitation:'new'});await h.flush();const count=h.calls.length;
 old.onSnapshot({track,playing:true,positionMs:5000,at:Date.now(),seq:50});await h.flush();
 assert.equal(h.calls.length,count);
 h.clients[1].onStatus({status:'disconnected',error:'Host left'});await h.flush();
 assert.equal(h.coordinator.useTogether.getState().status,'disconnected');assert.equal(h.player.getState().followingRoom,false);
});

test('an explicit host seek is applied promptly even inside the drift cooldown',async t=>{
 const h=await setup(t);await h.coordinator.connectTogether({invitation:'test'});await h.flush();
 const client=h.clients[0];client.onSnapshot({track,playing:false,positionMs:10000,at:Date.now(),seq:1});await h.flush();
 client.onSnapshot({track,playing:false,positionMs:60000,at:Date.now(),seq:2});await h.flush();
 assert.equal(h.player.getState().anchor.positionMs,60000);
});
