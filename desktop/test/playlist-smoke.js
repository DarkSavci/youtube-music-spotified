// Run after building ui: electron desktop/test/playlist-smoke.js
// Isolated renderer, fixture HTTP server, no account or external network access.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../ui/dist');
let first = 0, next = 0, full = 0, failNext = true;
const track = i => ({id:`fixture${String(i).padStart(4,'0')}`,title:`Fixture song ${i}`,artists:[{id:'artist',name:'Fixture artist'}],artwork:[],durationMs:180000,playable:true});
const server = http.createServer((req,res) => {
 const url = new URL(req.url,'http://localhost');
 if (url.pathname.startsWith('/v1/')) {
  res.setHeader('Content-Type','application/json');
  let body;
  if (url.pathname === '/v1/playlists/fixture') {
   if (url.searchParams.get('paged') !== '1') { full++; body={id:'fixture',title:'Fixture playlist',tracks:Array.from({length:120},(_,i)=>track(i+1))}; }
   else if (url.searchParams.has('continuation')) { next++; if(failNext) { res.statusCode=503; res.end(JSON.stringify({error:'temporary fixture failure'})); return; } body={playlist:{id:'fixture',tracks:Array.from({length:20},(_,i)=>track(i+101))}}; }
   else { first++; body={playlist:{id:'fixture',title:'Fixture playlist',artwork:[],trackCount:120,tracks:Array.from({length:100},(_,i)=>track(i+1))},next:'page2'}; }
  } else if (url.pathname === '/v1/me/liked') body={tracks:[]};
  else if (url.pathname === '/v1/me/library') body=[];
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
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{partition:'playlist-smoke',backgroundThrottling:false}});
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
 await waitFor(`document.querySelector('.trackrow') && document.querySelector('.entityheader')`);
 assert.equal(first,1);assert.equal(next,0);assert.equal(full,0);
 await read(`document.querySelector('.entityactions__more').click()`);
 await waitFor(`document.querySelector('[role=menu]')`);
 assert.equal(full,0,'opening a menu must not fetch the complete playlist');
 await read(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 const start=await read(`({top:document.querySelector('.entityheader').getBoundingClientRect().top,rows:document.querySelectorAll('.trackrow').length})`);
 assert.ok(start.rows>0 && start.rows<50,'rows must be virtualized');
 await read(`document.querySelector('.main__scroll').scrollTop=800`);
 await waitFor(`document.querySelector('.main__scroll').dataset.entityScrolled==='true'`);
 const scrolled=await read(`(()=>{const scroll=document.querySelector('.main__scroll');const head=document.querySelector('.entityheader');const actions=document.querySelector('.entityactions');const table=document.querySelector('.tracktable__head');return {hero:head.getBoundingClientRect().bottom,scrollTop:scroll.getBoundingClientRect().top,actions:actions.getBoundingClientRect().top,table:table.getBoundingClientRect().top,title:getComputedStyle(document.querySelector('.entityactions__title')).display,rows:document.querySelectorAll('.trackrow').length};})()`);
 assert.ok(scrolled.hero<scrolled.scrollTop);
 assert.ok(Math.abs(scrolled.actions-scrolled.scrollTop)<2);
 assert.ok(Math.abs(scrolled.table-scrolled.actions-80)<2);
 assert.notEqual(scrolled.title,'none');assert.ok(scrolled.rows<50);
 assert.equal(next,0,'must not fetch offscreen tail early');
 await read(`document.querySelector('.main__scroll').scrollTop=100000`);
 await waitFor(`document.querySelector('.playlist-more button')?.textContent.includes('retry')`);
 assert.ok(await read(`document.querySelectorAll('.trackrow').length > 0`),'failed next page must retain loaded rows');
 failNext=false;
 await read(`document.querySelector('.playlist-more button').click()`);
 await waitFor(`!document.querySelector('.playlist-more')`);
 await read(`document.querySelector('.main__scroll').scrollTop=100000`);
 await waitFor(`document.body.textContent.includes('Fixture song 120')`);
 assert.equal(next,3);assert.equal(full,0);
 assert.equal(await read(`!!document.querySelector('.playlist-more')`),false);
 console.log('PLAYLIST PASS',JSON.stringify({first,next,full,start,scrolled}));
 win.destroy();server.close();app.exit(0);
}).catch(err=>{console.error(err);server.close();app.exit(1);});
