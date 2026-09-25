// Run after building ui: electron desktop/test/navigation-smoke.js
// Isolated renderer, fixture HTTP server, no account or external network access.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../ui/dist');
let first = 0, next = 0, full = 0, failNext = true;
let previewActive = 0, previewMax = 0;
const previews = new Set();
const track = i => ({id:`fixture${String(i).padStart(4,'0')}`,title:`Fixture song ${i}`,artists:[{id:'artist',name:'Fixture artist'}],artwork:[],durationMs:180000,playable:true});
const server = http.createServer((req,res) => {
 const url = new URL(req.url,'http://localhost');
 if (url.pathname.startsWith('/v1/')) {
  res.setHeader('Content-Type','application/json');
  let body;
  if (url.pathname === '/v1/browse/FEmusic_moods_and_genres') {
   body={shelves:[],moods:Array.from({length:60},(_,i)=>({id:'mood'+i,title:'Mood '+i,color:'#185a74'}))};
  } else if (url.pathname.startsWith('/v1/browse/')) {
   previews.add(url.pathname); previewActive++; previewMax=Math.max(previewMax,previewActive);
   let finished=false;
   const finish=()=>{if(!finished){finished=true;previewActive--;}};
   res.on('close',finish);
   setTimeout(()=>{finish();res.end(JSON.stringify({shelves:[{title:'Recommendations',items:[{playlist:{id:'preview',title:'Preview',artwork:[{url:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22240%22%3E%3Crect width=%22240%22 height=%22240%22 fill=%22red%22/%3E%3C/svg%3E',width:240,height:240}]}}]}]}));},120);
   return;
  } else if (url.pathname === '/v1/playlists/fixture') {
   if (url.searchParams.get('paged') !== '1') { full++; body={id:'fixture',title:'Fixture playlist',tracks:Array.from({length:120},(_,i)=>track(i+1))}; }
   else if (url.searchParams.has('continuation')) { next++; if(failNext) { res.statusCode=503; res.end(JSON.stringify({error:'temporary fixture failure'})); return; } body={playlist:{id:'fixture',tracks:Array.from({length:20},(_,i)=>track(i+101))}}; }
   else { first++; body={playlist:{id:'fixture',title:'Fixture playlist',artwork:[],trackCount:120,tracks:Array.from({length:100},(_,i)=>track(i+1))},next:'page2'}; }
  } else if (url.pathname === '/v1/me/liked') body={tracks:[]};
  else if (url.pathname === '/v1/me/library') body=Array.from({length:20},(_,i)=>({id:'list'+i,kind:'playlist',title:'Saved playlist '+i,subtitle:'Fixture owner',artwork:[]}));
  else if (url.pathname === '/v1/me') body={state:'logged_out'};
  else { res.statusCode=404; body={error:'fixture endpoint unavailable'}; }
  res.end(JSON.stringify(body)); return;
 }
 if(url.pathname === '/test-errors.js'){res.setHeader('Content-Type','text/javascript');res.end("window.addEventListener('error',e=>console.error(e.error?.stack));");return;}
 const file = path.join(root,url.pathname==='/'?'index.html':url.pathname);
 if (!file.startsWith(root+path.sep) || !fs.existsSync(file)) {res.writeHead(404).end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
 if(file.endsWith('.html')) res.end(fs.readFileSync(file,'utf8').replace('<head>','<head><script src="/test-errors.js"></script>'));
 else fs.createReadStream(file).pipe(res);
});
app.whenReady().then(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{partition:'navigation-smoke',backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith(origin+'/') && !details.url.startsWith('data:')}));
 win.webContents.on('console-message', (_event, level, message, line, source) => { if (level >= 2) console.error(message, source, line); });
 const read=script=>win.webContents.executeJavaScript(script);
 const waitFor=async script=>{
  const end=Date.now()+10000;
  while(Date.now()<end){if(await read(script)) return; await new Promise(r=>setTimeout(r,50));}
  console.error(await read('document.body.innerText'));
  throw Error(`Timed out: ${script}`);
 };
 await win.loadURL(origin+'/#/playlist/fixture');
 await waitFor(`document.querySelector('.trackrow') && document.querySelectorAll('.libitem').length===20`);
 await read(`document.querySelector('.end-time').click()`);
 assert.equal(await read(`document.querySelector('.end-time').getAttribute('aria-label')`),'Show total duration');
 assert.ok(await read(`!document.querySelector('.end-time').textContent.includes('−')`));
 await win.reload();
 await waitFor(`document.querySelector('.end-time')?.getAttribute('aria-label')==='Show total duration' && document.querySelector('.trackrow')`);
 await read(`document.querySelector('[aria-label="Search"]').click()`);
 assert.equal(await read(`document.activeElement.type`),'search');
 await read(`document.querySelector('[aria-label="Browse all"]').click()`);
 assert.equal(await read(`location.hash`),'#/search');
 await waitFor(`document.querySelector('.mood__art')?.complete && document.querySelector('.mood__art')?.naturalWidth>0`);
 assert.ok(previewMax<=2, 'preview requests must be bounded');
 assert.ok(!previews.has('/v1/browse/mood59'), 'offscreen categories must not fetch artwork');
 assert.ok(await read(`(()=>{const b=document.querySelector('[aria-label="Browse all"]'),f=b.closest('.searchfield');if(!f)return false;const br=b.getBoundingClientRect(),fr=f.getBoundingClientRect();return Math.abs(br.right-fr.right)<3 && Math.abs(br.height-fr.height)<3 && getComputedStyle(b).borderTopRightRadius!=='0px';})()`), 'browse hitbox must reach the rounded search-field edge');
 await read(`window.location.hash='/playlist/fixture'`);
 await waitFor(`document.querySelector('.trackrow')`);
 await read(`(()=>{const e=document.querySelector('[aria-label="Search in your library"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'playlist 19');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await waitFor(`document.querySelectorAll('.libitem').length===1`);
 await read(`document.querySelector('[aria-label="Expand library view"]').click()`);
 assert.equal(await read(`getComputedStyle(document.querySelector('.main')).display`),'none');
 assert.ok(await read(`document.querySelector('.sidebar').getBoundingClientRect().width>800`));
 await read(`document.querySelector('[aria-label="Collapse library view"]').click()`);
 await waitFor(`document.querySelector('.trackrow')`);
 await read(`document.querySelector('[aria-label="Expand library view"]').click(); window.location.hash='/search'`);
 await waitFor(`getComputedStyle(document.querySelector('.main')).display!=='none'`);
 await read(`window.location.hash='/playlist/fixture'`);
 await waitFor(`document.querySelector('.trackrow')`);
 await read(`document.querySelector('[aria-label="Search music"]').focus()`);
 await read(`document.querySelector('.trackrow').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:1150,clientY:760}))`);
 await waitFor(`document.querySelector('[aria-haspopup="menu"]')`);
 assert.equal(await read(`document.querySelectorAll('.ctxmenu').length`),1);
 await read(`document.querySelector('.ctxmenu [aria-haspopup="menu"]').click()`);
 await waitFor(`document.querySelectorAll('.ctxmenu').length===2`);
 // The fixture library's 20 playlists plus "New playlist…".
 assert.equal(await read(`document.querySelectorAll('.ctxmenu')[1].querySelectorAll('[role=menuitem]').length`),20+1);
 assert.ok(await read(`Array.from(document.querySelectorAll('.ctxmenu')).every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})`));
 await read(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 assert.equal(await read(`document.querySelectorAll('.ctxmenu').length`),1);
 await read(`document.querySelector('.ctxmenu [aria-haspopup="menu"]').click()`);
 await waitFor(`document.querySelectorAll('.ctxmenu').length===2`);
 await read(`document.querySelector('.ctxmenu__item:not([aria-haspopup])').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
 await waitFor(`document.querySelectorAll('.ctxmenu').length===1`);
 assert.ok(await read(`document.activeElement.closest('.ctxmenu') !== null`));
 await read(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 assert.equal(await read(`document.querySelectorAll('.ctxmenu').length`),0);
 assert.equal(await read(`document.activeElement.getAttribute('aria-label')`),'Search music');
 console.log('NAVIGATION PASS: time preference survives reload, search focuses, library filters/expands, playlist submenu includes all entries and flips at edges');
 win.destroy();server.close();app.exit(0);
}).catch(err=>{console.error(err);server.close();app.exit(1);});
