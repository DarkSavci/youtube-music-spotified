const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AccountStore, writeJSON } = require("../account-store");
function setup(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spotifier-accounts-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 return dir;
}
test("migration keeps existing credentials, session partition and history in place", t => {
 const dir = setup(t);
 writeJSON(path.join(dir, "credentials.json"), { cookie: "synthetic" });
 const store = new AccountStore(dir);
 assert.equal(store.directory(), dir);
 assert.equal(store.partition(), "persist:ytmusic");
 assert.equal(store.database(), path.join(dir, "spotifier.db"));
 assert.equal(new AccountStore(dir).get().id, store.get().id);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "credentials.json"))).cookie, "synthetic");
});
test("accounts and channels keep distinct databases and survive restart", t => {
 const dir = setup(t); const store = new AccountStore(dir);
 const a = store.create("A"); store.add(a);
 const dbA = store.database(); const partitionA = store.partition();
 store.setChannels([{id:"",name:"Personal"},{id:"123",name:"Brand"}]);
 store.selectChannel("123"); const dbBrand = store.database();
 assert.notEqual(dbA, dbBrand);
 store.setChannels([{id:"",name:"Personal"},{id:"123",name:"Renamed"}]);
 assert.equal(store.database(), dbBrand);
 const b = store.create("B");store.add(b);
 assert.notEqual(store.database(), dbA);assert.notEqual(store.partition(), partitionA);
 store.activate(a.id);
 assert.equal(new AccountStore(dir).database(), dbBrand);
 assert.throws(() => store.selectChannel("../../outside"), /not found/);
 assert.throws(() => store.activate("../../outside"), /not found/);
});
test("removing one account retains other accounts and uses a separate guest database", t => {
 const dir=setup(t), store=new AccountStore(dir);
 const a=store.create("A"),b=store.create("B");store.add(a);store.add(b);
 const db=store.database();store.remove(b.id);
 assert.equal(store.publicState().activeId,null);
 assert.equal(store.publicState().accounts.length,1);
 assert.notEqual(store.database(),db);
 store.activate(a.id);assert.equal(store.get().name,"A");
});
