// Electron renderer smoke: real decoding and cross-document view handoff.
// Default is a generated offline WebM. VIDEO_SMOKE_ORIGIN/ID optionally test
// an isolated local core with a real MP4 stream; never use production sessions.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('../../ui/node_modules/typescript');
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../../ui/src/lib/video.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{backgroundThrottling:false}});
 await win.loadURL('about:blank');
 const result=await win.webContents.executeJavaScript(`(async()=>{
  let url;
  const origin=${JSON.stringify(process.env.VIDEO_SMOKE_ORIGIN||'')};
  if(!origin){
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
   const ctx=canvas.getContext('2d');const stream=canvas.captureStream(30);const chunks=[];
   const recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
   recorder.ondataavailable=e=>chunks.push(e.data);
   const done=new Promise(r=>recorder.onstop=r);recorder.start();
   let frame=0;const timer=setInterval(()=>{ctx.fillStyle=frame++%2?'#2677d0':'#32ba72';ctx.fillRect(0,0,320,180);},30);
   await new Promise(r=>setTimeout(r,2000));recorder.stop();await done;clearInterval(timer);stream.getTracks().forEach(t=>t.stop());
   url=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));
  }
  const state={track:{isVideo:true,id:${JSON.stringify(process.env.VIDEO_SMOKE_ID||'abcdefghijk')}},position:600,state:'paused'};
  const exports={};const module={exports};
  const require=name=>{
   if(name==='zustand')return {create:initial=>{let s=initial();return {getState:()=>s,setState:p=>{s={...s,...p}}}}};
   if(name==='./base')return {apiUrl:p=>origin?origin+p:url};
   if(name==='./player')return {usePlayer:{getState:()=>state},currentPosition:s=>s.position};
   if(name==='./playback')return {switchTrackVariant:()=>{throw Error('View changed audio session')}};
   throw Error(name);
  };
  ${source}
  const wait=async predicate=>{const end=Date.now()+45000;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error('Video decode/handoff timed out: '+JSON.stringify(exports.useVideo.getState()));};
  exports.useVideo.setState({enabled:true});
  const main=document.createElement('div');main.style.cssText='width:640px;height:360px';document.body.append(main);
  const closeMain=exports.attachVideo(main,0);
  await wait(()=>main.querySelector('video')?.videoWidth>0);
  const video=main.querySelector('video');
  if(!video.muted||!video.defaultMuted)throw Error('Picture can produce duplicate audio');
  state.position=1200;await wait(()=>Math.abs(video.currentTime-1.2)<0.1);
  const iframe=document.createElement('iframe');document.body.append(iframe);
  const mini=iframe.contentDocument.createElement('div');iframe.contentDocument.body.append(mini);
  const closeMini=exports.attachVideo(mini,20);
  await wait(()=>video.ownerDocument===iframe.contentDocument&&video.videoWidth>0);
  if(mini.querySelector('video')!==video||main.querySelector('video'))throw Error('Handoff created another player');
  state.state='playing';await wait(()=>!video.paused);
  state.state='paused';await wait(()=>video.paused);
  closeMini();if(main.querySelector('video')!==video)throw Error('Closing mini did not restore video');
  await wait(()=>video.videoWidth>0 && Math.abs(video.currentTime-1.2)<0.1 && video.paused);
  const result={width:video.videoWidth,height:video.videoHeight,muted:video.muted,position:video.currentTime,sharedElement:true};
  closeMain();await Promise.resolve();if(video.getAttribute('src'))throw Error('Video stream not released');
  if(url)URL.revokeObjectURL(url);return result;
 })()`);
 console.log('VIDEO PASS',JSON.stringify(result));win.destroy();app.exit(0);
}).catch(e=>{console.error(e);app.exit(1);});
