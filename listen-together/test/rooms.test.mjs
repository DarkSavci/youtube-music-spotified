import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRoomServer } from '../server.mjs';
import { RoomClient } from '../client.mjs';
import { cleanSnapshot, decodeInvite, encodeInvite, endpointURL, positionAt } from '../protocol.mjs';
const state = { track: { isVideo:false, id: 'abcdefghijk', title: 'Test track', durationMs: 180000, artists: [{name:'Test artist'}] }, playing: true, positionMs: 5000 };
async function setup(t, options) {
 const server = createRoomServer(options);
 server.http.listen(0, '127.0.0.1'); await once(server.http, 'listening');
 t.after(() => server.close());
 return `ws://127.0.0.1:${server.http.address().port}`;
}
async function peer(t, url) {
 const ws = new WebSocket(url); const queue = []; const waits = [];
 ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  const at = waits.findIndex(w => w.type === msg.type);
  if (at >= 0) { const [w] = waits.splice(at, 1); clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg);
 });
 await once(ws, 'open'); t.after(() => ws.terminate());
 return { ws, send: msg => ws.send(JSON.stringify(msg)), next: type => {
  const at = queue.findIndex(m => m.type === type);
  if (at >= 0) return Promise.resolve(queue.splice(at,1)[0]);
  return new Promise((resolve,reject) => { const timer=setTimeout(()=>reject(new Error(`Missing ${type}`)),3000); waits.push({type,resolve,timer}); });
 }};
}
test('private rooms replay current state, reject guest control, and end with the host', async t => {
 const url=await setup(t); const host=await peer(t,url);host.send({type:'create'});const room=await host.next('joined');
 const guest=await peer(t,url);guest.send({type:'join',room:room.room,token:room.token});assert.equal((await guest.next('joined')).role,'guest');
 host.send({type:'publish',...state,at:Date.now(),cookie:'secret',streamURL:'private'});
 const snapshot=await guest.next('snapshot');assert.equal(snapshot.track.id,state.track.id);assert.equal(snapshot.cookie,undefined);assert.equal(snapshot.streamURL,undefined);
 const late=await peer(t,url);late.send({type:'join',room:room.room,token:room.token});await late.next('joined');assert.equal((await late.next('snapshot')).seq,snapshot.seq);
 guest.send({type:'publish',...state});assert.match((await guest.next('error')).message,/Only the host/);
 host.ws.close();assert.match((await late.next('ended')).reason,/host left/);
});
test('wrong invitations, expired rooms and capacity are rejected', async t => {
 const url=await setup(t,{maxMembers:1,lifetimeMs:20});const host=await peer(t,url);host.send({type:'create'});const room=await host.next('joined');
 const invalid=await peer(t,url);invalid.send({type:'join',room:room.room,token:'x'.repeat(43)});assert.match((await invalid.next('error')).message,/invalid|expired/);
 const full=await peer(t,url);full.send({type:'join',room:room.room,token:room.token});assert.match((await full.next('error')).message,/full|expired/);
 await new Promise(r=>setTimeout(r,25));const expired=await peer(t,url);expired.send({type:'join',room:room.room,token:room.token});assert.match((await expired.next('error')).message,/expired/);
});
test('protocol omits account data and URLs and computes clock-adjusted position', () => {
 const cleaned=cleanSnapshot({...state,account:{cookie:'secret'},track:{...state.track,artwork:[{url:'private'}],streamURL:'private'}});
 assert.deepEqual(cleaned,state);
 assert.equal(positionAt({...state,at:1000},2500),6500);
 assert.equal(positionAt({...state,playing:false,at:1000},2500),5000);
 assert.equal(positionAt({...state,positionMs:179900,at:1000},2500),180000);
 assert.throws(()=>cleanSnapshot({...state,track:{...state.track,id:'https://private'}}));
 assert.throws(()=>cleanSnapshot({...state,positionMs:Infinity}));
 assert.throws(()=>endpointURL('ws://example.com'));
 assert.throws(()=>endpointURL('wss://user:secret@example.com'));
 const invite=encodeInvite('wss://example.com/rooms','a'.repeat(16),'b'.repeat(43));
 assert.equal(decodeInvite(invite).server,'wss://example.com/rooms');
});
test('the shared app client synchronizes two independent participants and stops cleanly', async t => {
 const server=await setup(t);let hostRoom;let receive;
 const ready=new Promise(r=>{hostRoom=r;});const received=new Promise(r=>{receive=r;});
 const host=new RoomClient({WebSocketImpl:WebSocket,getSnapshot:()=>state,onSnapshot:()=>{},onStatus:s=>{if(s.status==='connected')hostRoom(s);}});
 host.connect({server});const room=await ready;
 const guest=new RoomClient({WebSocketImpl:WebSocket,getSnapshot:()=>null,onSnapshot:receive,onStatus:()=>{}});
 t.after(()=>{host.stop();guest.stop();});guest.connect({invitation:room.invitation});
 const snapshot=await received;assert.equal(snapshot.track.id,state.track.id);assert.equal(snapshot.playing,true);
 host.stop();guest.stop();assert.equal(host.socket,null);assert.equal(guest.socket,null);
});

test('per-IP room and socket caps and browser origins are enforced',async t=>{
 const url=await setup(t,{maxRoomsPerIP:1,maxConnectionsPerIP:2});
 const host=await peer(t,url);host.send({type:'create'});await host.next('joined');
 const second=await peer(t,url);
 const rejected=new WebSocket(url,{headers:{'X-Forwarded-For':'192.0.2.9'}});
 await once(rejected,'error');
 second.send({type:'create'});assert.match((await second.next('error')).message,/Cannot create/);
 const evil=new WebSocket(url,{origin:'https://untrusted.example'});await once(evil,'error');
});

test('a guest reconnects after a dropped socket and receives the latest host snapshot', async t => {
 const url=await setup(t);
 let invitation;
 const host=new RoomClient({WebSocketImpl:WebSocket,onStatus:s=>{if(s.invitation)invitation=s.invitation},onSnapshot:()=>{},getSnapshot:()=>state});
 t.after(()=>host.stop());host.connect({server:url});
 const wait=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,20));}};
 await wait(()=>invitation);
 let connected=0, snapshots=0, reconnecting=false;
 const guest=new RoomClient({WebSocketImpl:WebSocket,onStatus:s=>{if(s.status==='connected')connected++;if(s.status==='reconnecting')reconnecting=true},onSnapshot:()=>snapshots++,getSnapshot:()=>state});
 t.after(()=>guest.stop());guest.connect({invitation});
 await wait(()=>connected===1&&snapshots>0);
 guest.socket.terminate();
 await wait(()=>connected===2&&snapshots>1);
 assert.ok(reconnecting);assert.equal(guest.role,'guest');
 guest.socket.terminate();await wait(()=>guest.retryTimer);guest.stop();
 await new Promise(r=>setTimeout(r,1100));assert.equal(guest.socket,null);
});

test('snapshot retains video mode without sharing private track fields', () => {
 const got=cleanSnapshot({...state,track:{...state.track,isVideo:true,cookie:'private',streamURL:'private'}});
 assert.equal(got.track.isVideo,true);assert.equal(got.track.cookie,undefined);assert.equal(got.track.streamURL,undefined);
});
