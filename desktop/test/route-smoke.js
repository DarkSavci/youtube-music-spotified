// Run after building ui: electron desktop/test/route-smoke.js
// Reproduce a missing lazy chunk without modifying the installed app.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../ui/dist');
// The test hides the Listen Together route's lazy chunk. Say so plainly if a
// build change renames or inlines it, rather than failing on a timeout later.
assert.ok(fs.readdirSync(path.join(root, 'assets')).some(f => /^Together-[^/]+\.js$/.test(f)), 'ui/dist has no Together-*.js chunk; update route-smoke.js for the new lazy route layout');
let missing = true;
const server = http.createServer((req,res) => {
 const url = new URL(req.url,'http://localhost');
 if (url.pathname.startsWith('/v1/')) {
  res.setHeader('Content-Type','application/json');
  let body;
  if (url.pathname === '/v1/me/liked') body={tracks:[]};
  else if (url.pathname === '/v1/me/library') body=[];
  else if (url.pathname === '/v1/me') body={state:'logged_out'};
  else { res.statusCode=404; body={error:'fixture endpoint unavailable'}; }
  res.end(JSON.stringify(body)); return;
 }
 const file = path.join(root,url.pathname==='/'?'index.html':url.pathname);
 if (!file.startsWith(root+path.sep) || !fs.existsSync(file) || (missing && /\/Together-[^/]+\.js$/.test(url.pathname))) {res.writeHead(404).end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
 fs.createReadStream(file).pipe(res);
});
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{partition:'route-smoke',backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith(origin+'/') && !details.url.startsWith('data:')}));
 const read=script=>win.webContents.executeJavaScript(script);
 const waitFor=async script=>{
  const end=Date.now()+10000;
  while(Date.now()<end){if(await read(script)) return; await new Promise(r=>setTimeout(r,50));}
  throw Error(`Timed out: ${script}`);
 };
 await win.loadURL(origin+'/#/together');
 await waitFor(`document.querySelector('[role=alert]')?.textContent.includes('This page could not be opened')`);
 assert.ok(await read(`!!document.querySelector('.topbar') && !!document.querySelector('.bar')`),'navigation and playback must survive');
 await read(`window.location.hash='/'`);
 await waitFor(`!document.body.textContent.includes('This page could not be opened')`);
 await read(`window.location.hash='/together'`);
 await waitFor(`document.body.textContent.includes('Reload app')`);
 missing=false;
 await read(`document.querySelector('.pagestate button').click()`);
 await waitFor(`document.querySelector('.together-page')?.textContent.includes('Create a room')`);
 assert.ok(await read(`document.querySelector('.together-page').textContent.includes('Join a friend')`));
 console.log('ROUTE PASS: missing chunk contained; navigation survives; reload opens Listen Together');
 win.destroy();server.close();app.exit(0);
}).catch(err=>{console.error(err);server.close();app.exit(1);});
