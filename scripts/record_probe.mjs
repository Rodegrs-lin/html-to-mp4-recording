// record_probe.mjs — 探测无头 Chrome 下的「实时帧率」与「确定性逐帧截图」可行性
//
// 目的：决定页面录屏走哪条路。
//   · 实时录：CDP Page.startScreencast 给多少帧就是多少帧（帧率随机器负载波动）
//   · 确定性：把页面播放改由「虚拟时间」驱动，每渲染一帧截一张 —— 帧率恒定、绝不掉帧
// 本脚本先测：① 实时 screencast 帧率；② 页面里能否强制指定时间点并稳定渲染。
//
// 用法: node record_probe.mjs <URL> [WxH] [seconds]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const BASE = process.argv[2] || 'http://127.0.0.1:8931/index.html';
const VIEW = (process.argv[3] || '1920x1080').split('x').map(Number);
const SECS = Number(process.argv[4] || 6);
const CHROME = CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9600 + Math.floor(Math.random() * 120);
const DD = path.join(os.tmpdir(), 'fr-' + Date.now());

const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + DD, '--no-first-run',
  '--no-default-browser-check', `--window-size=${VIEW[0]},${VIEW[1]}`, 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); };
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; };

let t = null;
for (let i = 0; i < 90; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t?.webSocketDebuggerUrl) break; } catch { }
  await sleep(400);
}
if (!t) { console.error('CDP 连不上'); process.exit(2); }
ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let frames = 0, firstTs = 0, lastTs = 0, bytes = 0;
const timestamps = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Page.screencastFrame') {
    const ts = m.params.metadata?.timestamp ?? Date.now() / 1000;
    frames++; if (!firstTs) firstTs = ts; lastTs = ts;
    timestamps.push(Date.now());
    bytes += (m.params.data || '').length;
    send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => { });
  }
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: BASE });
for (let k = 0; k < 120; k++) { if (await ev('document.readyState') === 'complete') break; await sleep(150); }
await sleep(1500);

// ---- ① 实时 screencast 帧率
await send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: VIEW[0], maxHeight: VIEW[1], everyNthFrame: 1 });
// 触发播放（页面有 ?auto 逻辑，也手动点一下保险）
await ev(`(()=>{const b=document.querySelector('#play'); if(b) b.click(); const g=document.querySelector('#autoplayGate'); if(g) g.classList.remove('on'); return 1})()`).catch(() => { });
const t0 = Date.now();
await sleep(SECS * 1000);
const elapsed = (Date.now() - t0) / 1000;
await send('Page.stopScreencast');

// 帧间隔统计
const gaps = [];
for (let i = 1; i < timestamps.length; i++) gaps.push(timestamps[i] - timestamps[i - 1]);
gaps.sort((a, b) => a - b);
const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
const p95 = gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0;
console.log('--- 实时 screencast ---');
console.log(`  时长 ${elapsed.toFixed(1)}s，帧数 ${frames}，平均 ${(frames / elapsed).toFixed(1)} fps`);
console.log(`  帧间隔 中位 ${med}ms / P95 ${p95}ms  (16.7ms ≈ 60fps, 33ms ≈ 30fps)`);
console.log(`  平均帧大小 ${(bytes / Math.max(1, frames) / 1024).toFixed(0)} KB (jpeg q80)`);

// ---- ② 能否确定性定位时间点（决定「逐帧精确录制」可行否）
const canSeek = await ev(`(()=>{ try{
  const a=document.querySelector('#audio');
  const before=a.currentTime;
  // 页面 setTime 是函数声明，全局可见
  if(typeof setTime!=='function') return 'no-setTime';
  setTime(120.0);
  return JSON.stringify({before:+before.toFixed(2), after:+a.currentTime.toFixed(2),
    active:(document.querySelector('.scene.active')||{}).dataset?.start});
}catch(e){ return 'err:'+e }} )()`);
console.log('--- 确定性定位 ---');
console.log('  setTime(120) =>', canSeek);

// ---- ③ 音频是否在真实推进（实时录的同步基础）
const aud = await ev(`(()=>{const a=document.querySelector('#audio');return JSON.stringify({ct:+a.currentTime.toFixed(2),dur:+a.duration.toFixed(2),paused:a.paused,rs:a.readyState})})()`);
console.log('--- 音频状态 ---');
console.log('  ', aud);

try { ws.close(); } catch { } try { ch.kill(); } catch { }
setTimeout(() => process.exit(0), 300);
