const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { writeJSON } = require("../account-store");
function setup(t, ok = true, coreFetch) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), "spotifier-manager-"));
 t.after(() => fs.rmSync(root, {recursive:true,force:true}));
 writeJSON(path.join(root,"credentials.json"),{cookie:"old-session"});
 const handlers = new Map(), captured = [], cleared=[];
 const filename=path.resolve(__dirname,"../accounts.js"), req=createRequire(filename), module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,"utf8"), {module,AbortSignal,
  require: name => name==="electron" ? {ipcMain:{handle:(name,fn)=>handlers.set(name,fn),on(){}}} : name==="./auth" ? {
   signIn:async(dir,_parent,partition)=>{captured.push({dir,partition});if(ok)writeJSON(path.join(dir,"credentials.json"),{cookie:"new-session"});return {ok};},
   signOut:async(dir,partition)=>{cleared.push({dir,partition});fs.rmSync(path.join(dir,"credentials.json"),{force:true});},
   refreshCredentials:async()=>({ok:true}),
  } : req(name),
  fetch:coreFetch || (async url=>({ok:true,json:async()=>url.endsWith("/channels")?[{id:"",name:"Personal"},{id:"123",name:"Channel"}]:{account:{name:"Personal"}}})),
 });
 const manager=module.exports; manager.initialize(root);
 let restarts=0;
 manager.register(()=>null,8674,async change=>{restarts++; if(change)await change();});
 return {root,manager,captured,cleared,call:(name,...args)=>handlers.get(`auth:${name}`)(null,...args),restarts:()=>restarts};
}
test("adding an account preserves the existing session; switching selects its partition and database",async t=>{
 const h=setup(t), before=await h.call("accounts"), original=before.activeId;
 await h.call("sign-in");const after=await h.call("accounts");
 assert.equal(after.accounts.length,2);assert.notEqual(after.activeId,original);
 assert.notEqual(h.captured[0].partition,"persist:ytmusic");
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.root,"credentials.json"))).cookie,"old-session");
 await h.call("switch-account",original);
 await h.call("channels");await h.call("select-channel","123");
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.root,"credentials.json"))).onBehalfOfUser,"123");
 assert.match(h.manager.activeDatabase(),/channels/);
 assert.equal(h.manager.scope(),"legacy:123");
 await h.call("remove-account",original);
 const remaining=await h.call("accounts");assert.equal(remaining.accounts.length,1);assert.equal(remaining.activeId,null);
 assert.equal(h.cleared[0].partition,"persist:ytmusic");
 await h.call("switch-account",remaining.accounts[0].id);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.manager.activeDirectory(),"credentials.json"))).cookie,"new-session");
});
test("canceled sign-in leaves the active account and service unchanged",async t=>{
 const h=setup(t,false);const before=JSON.stringify(await h.call("accounts"));
 await h.call("sign-in");
 assert.equal(JSON.stringify(await h.call("accounts")),before);assert.equal(h.restarts(),0);
 assert.equal(fs.existsSync(h.captured[0].dir),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(h.root,"credentials.json"))).cookie,"old-session");
});

for (const fails of [false, true]) test(`profile name is saved when channel discovery ${fails ? "fails" : "is empty"}`, async t => {
 const h = setup(t, true, async url => ({ok: !fails || !url.endsWith("/channels"), json: async () => url.endsWith("/channels") ? [] : {account:{name:"Harris"}}}));
 await h.call("sign-in");
 if (fails) await assert.rejects(h.call("channels")); else await h.call("channels");
 const state = await h.call("accounts");
 assert.equal(state.accounts.find(a => a.id === state.activeId).name, "Harris");
 assert.equal(state.accounts.find(a => a.id === state.activeId).channels.length, 0);
});

test("concurrent channel readers share the refresh instead of reporting an account change", async t => {
 const h = setup(t);
 const [a, b] = await Promise.all([h.call("channels"), h.call("channels")]);
 assert.equal(a.activeId, b.activeId);
 assert.equal(a.accounts[0].channels.length, 2);
});
