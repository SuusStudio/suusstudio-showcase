#!/usr/bin/env node
// Read-only browser capture of current public SuusStudio production.
// NOT a Vercel deployment, PR #11 preview, human visual PASS, or rights approval.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = 'https://suus-studio.vercel.app';
const cases = [
  ['home-mobile', '/', 390, 844, true],
  ['home-desktop', '/', 1440, 900, false],
  ['framework-mobile', '/framework', 390, 844, true],
  ['framework-desktop', '/framework', 1440, 900, false],
  ['home-landscape', '/', 844, 390, true],
];
const out = join(process.cwd(), 'browser-smoke-artifacts');
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'suusstudio-chrome-'));
const pause = ms => new Promise(r => setTimeout(r, ms));
let child, socket, counter = 0;
const waiting = new Map();
function timeout(p, ms, label) {
  let timer;
  return Promise.race([p, new Promise((_,reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}
function cd(method, params = {}) {
  return timeout(new Promise((resolve, reject) => {
    const id = ++counter;
    waiting.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  }), 15000, method);
}
async function start() {
  const bin = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
    .find(existsSync) || execFileSync('which', ['google-chrome'], {encoding:'utf8'}).trim();
  child = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--remote-allow-origins=*',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], {stdio:'ignore'});
  const portFile = join(profile, 'DevToolsActivePort');
  for(let i=0; i<120 && !existsSync(portFile); i++) {
    if(child.exitCode !== null) throw new Error('Chrome exited before CDP startup');
    await pause(100);
  }
  if(!existsSync(portFile)) throw new Error('DevToolsActivePort missing');
  const port = Number(readFileSync(portFile,'utf8').split('\n')[0]);
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = tabs.find(t=>t.type==='page');
  if(!page) throw new Error('No Chromium page target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.onmessage = event => {
    const msg = JSON.parse(event.data);
    if(!msg.id || !waiting.has(msg.id)) return;
    const pending = waiting.get(msg.id); waiting.delete(msg.id);
    if(msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
    else pending.resolve(msg.result || {});
  };
  await timeout(new Promise((resolve,reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('CDP WebSocket failure'));
  }), 10000, 'WebSocket open');
  await cd('Page.enable');
  await cd('Runtime.enable');
}
const probe = '(() => { const d = document.documentElement; const b = document.body; ' +
  'return {url:location.href,title:document.title,readyState:document.readyState, ' +
  'viewportWidth:d.clientWidth,innerWidth:innerWidth,viewportHeight:innerHeight, ' +
  'documentWidth:Math.max(d.scrollWidth,b?.scrollWidth||0), ' +
  'overflowPx:Math.max(0,Math.max(d.scrollWidth,b?.scrollWidth||0)-d.clientWidth), ' +
  'rootFound:!!document.querySelector("#root"),links:document.querySelectorAll("a[href]").length, ' +
  'canvases:document.querySelectorAll("canvas").length, ' +
  'bodyTextChars:(b?.innerText||"").trim().length}; })()';
async function capture([name, path, width, height, mobile]) {
  const url = root + path;
  const h = await timeout(fetch(url, {redirect:'follow'}), 12000, 'HTTP request');
  if(h.status!==200 || !(h.headers.get('content-type') || '').includes('text/html')) {
    throw new Error('Expected HTML 200 for ' + url + ', received ' + h.status);
  }
  await cd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
  const nav = await cd('Page.navigate',{url});
  if(nav.errorText) throw new Error(nav.errorText);
  await pause(4500);
  const evalResult = await cd('Runtime.evaluate',{expression:probe,returnByValue:true});
  if(evalResult.exceptionDetails) throw new Error('DOM probe failed');
  const metrics = evalResult.result.value;
  if(!metrics || !metrics.title || !metrics.viewportWidth) throw new Error('Empty page/metrics');
  const screenshot = await cd('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});
  const png=Buffer.from(screenshot.data,'base64');
  if(png.length<1024) throw new Error('Screenshot empty');
  writeFileSync(join(out,name+'.png'),png);
  writeFileSync(join(out,name+'.json'),JSON.stringify({name,width,height,mobile,...metrics},null,2));
  console.log('BROWSER_CAPTURE case='+name+' screenshot_bytes='+png.length+
    ' overflow_px='+metrics.overflowPx+' links='+metrics.links+' canvases='+metrics.canvases+
    ' title='+JSON.stringify(metrics.title));
  return {name,width,height,mobile,...metrics,screenshotBytes:png.length};
}
let failed=false; const results=[];
try {
  await start();
  for(const c of cases) {
    try {results.push(await capture(c));}
    catch(err) {
      failed=true;
      results.push({name:c[0],error:String(err.message||err)});
      console.error('BROWSER_CAPTURE FAIL '+c[0]+': '+String(err.message||err));
    }
  }
} catch(err) {
  failed=true;
  console.error('BROWSER_CAPTURE bootstrap FAIL '+String(err.message||err));
} finally {
  writeFileSync(join(out,'summary.json'),JSON.stringify({
    target:'CURRENT_PRODUCTION_NOT_SHOWCASE_PR11',
    results,
    note:'Chrome capture + DOM metrics only. Not visual human review, not rights clearance.'
  },null,2));
  try {socket?.close();}catch{}
  try {child?.kill('SIGTERM');}catch{}
  await pause(150);
  try {rmSync(profile,{recursive:true,force:true});}catch{}
}
console.log(failed?'BROWSER_CAPTURE=FAIL':'BROWSER_CAPTURE=PASS (human visual QA still HOLD)');
if(failed) process.exitCode=1;
