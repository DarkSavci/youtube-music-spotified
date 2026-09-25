// Real DOM event/focus regression for fullscreen inactivity controls.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const ts=require('../../ui/node_modules/typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../../ui/src/lib/fullscreenIdle.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadURL('about:blank');
 await win.webContents.executeJavaScript(`(async()=>{
  const exports={}; ${code}
  document.body.innerHTML='<div class="fsp" tabindex="-1"><button class="fsp__close">Exit</button><div class="fsp__foot"><input type="range"></div><div class="art"></div></div>';
  const root=document.querySelector('.fsp'), art=root.querySelector('.art');root.focus();
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const assert=(v,m)=>{if(!v)throw Error(m)};
  const stop=exports.watchFullscreenIdle(root,hidden=>root.dataset.controlsHidden=String(hidden),80);
  await sleep(120);assert(root.dataset.controlsHidden==='true','did not hide');
  art.dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));assert(root.dataset.controlsHidden==='false','did not reveal');
  root.querySelector('input').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await sleep(120);assert(root.dataset.controlsHidden==='false','hid while dragging');
  window.dispatchEvent(new PointerEvent('pointerup'));await sleep(120);assert(root.dataset.controlsHidden==='true','did not hide after release');
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',cancelable:true}));await sleep(120);assert(document.activeElement===root.querySelector('button'),'Tab did not restore focus');assert(root.dataset.controlsHidden==='false','hid keyboard controls');
  root.focus();await sleep(120);assert(root.dataset.controlsHidden==='true','root focus prevented hide');
  stop();art.dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));assert(root.dataset.controlsHidden==='true','listener survived cleanup');
 })()`);console.log('FULLSCREEN PASS');win.destroy();app.exit(0);
}).catch(e=>{console.error(e);app.exit(1)});
