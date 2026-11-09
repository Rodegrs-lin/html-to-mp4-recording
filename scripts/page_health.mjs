// page_health.mjs — 录制前体检：确认「录制器真能拿到页面」
//
// 为什么需要它
// ------------
// 录制失败的报错常常长这样：`No timed scenes found` / `Timed scenes are not hydrated yet`，
// 看起来像「场景采集逻辑坏了」。但实测最常见的真相是 **页面压根没加载成功**
// （DNS/代理/端口/目录配错/协议不通），于是取不到幕被误判成脚本 bug，白改好几轮。
//
// 本脚本用 CDP 打开页面，直接读页面真实状态并给出结论：
//   · document.title            —— Chrome 网络错误页会变成主机名（如 "127.0.0.1"）
//   · outerHTML.length          —— 远小于页面体量 ⇒ 截断/错误页
//   · typeof SCENES/CHAPTERS/DUR —— 页面脚本有没有跑完
//   · .scene / #sceneMount 子元素 —— 幕有没有挂载
//   · 收集 Runtime.exceptionThrown / Log.entryAdded
//
// 用法:
//   node page_health.mjs <URL>
//   · <URL> 可以是 http://… 或 file://…（全内联页面推荐 file://）
// 退出码: 0 页面健康 / 1 页面没加载成功 / 2 环境错误

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL = process.argv[2];
if (!URL) { console.error('用法: node page_health.mjs <URL>'); process.exit(2); }

const CHROME = [
  process.env.AGENT_BROWSER_EXECUTABLE_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const PORT = 9711 + Math.floor(Math.random() * 89);
const DD = path.join(os.tmpdir(), 'health-' + Date.now());
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + DD, '--no-first-run',
  '--no-default-browser-check', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const pend = new Map(); const logs = [];
const send = (m, p = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result?.value;
};

let target = null;
for (let i = 0; i < 100; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find(x => x.type === 'page'); if (target?.webSocketDebuggerUrl) break; } catch { }
  await sleep(400);
}
if (!target) { console.error('CDP 连不上（Chrome 没起来？）'); process.exit(2); }
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 300));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('LOG.error: ' + String(m.params.entry.text).slice(0, 300));
};
await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: URL });
for (let k = 0; k < 200; k++) { if (await ev('document.readyState') === 'complete') break; await sleep(150); }
await sleep(3000);

const s = await ev(`(()=>{
  const q=n=>document.querySelectorAll(n).length;
  return {
    title: document.title,
    domLen: document.documentElement.outerHTML.length,
    SCENES: typeof SCENES, CHAPTERS: typeof CHAPTERS, DUR: typeof DUR, COVER_END: typeof COVER_END,
    render: typeof render,
    scene: q('.scene'), mountScene: q('#sceneMount .scene'), withEnd: q('.scene[data-end]'),
    mountChildren: document.querySelector('#sceneMount')?.children.length ?? -1,
    DURval: (typeof DUR!=='undefined')?DUR:null,
    SCENESlen: (typeof SCENES!=='undefined')?SCENES.length:null,
  };
})()`);

const size = await ev('document.documentElement.outerHTML.length');
console.log('URL      :', URL);
console.log('状态     :', JSON.stringify(s, null, 2));
if (logs.length) { console.log('页面报错 :'); for (const l of logs.slice(0, 10)) console.log('  · ' + l); }
else console.log('页面报错 : 无');

try { ws.close(); } catch { } try { ch.kill(); } catch { }

// ------- 判定 -------
const ok = s && typeof s === 'object' && !s.__err
  && s.SCENES === 'object' && s.withEnd >= 2 && s.domLen > 5000;
if (!ok) {
  console.error('\n[FAIL] 录制器拿到的不是正常页面 —— 先修「加载」，别改场景采集逻辑。');
  if (s && s.title && !s.title.includes('.') === false && s.domLen < 100000)
    console.error('       提示：title 像主机名 / DOM 只有几十 KB ⇒ Chrome 打开的是网络错误页。');
  console.error('       全内联页面请改走 file://；用 http.server 时务必 --directory 指到页面目录。');
  process.exit(1);
}
console.log(`\n[PASS] 页面健康：${s.SCENESlen} 幕 / DUR=${s.DURval}s / DOM ${(s.domLen / 1048576).toFixed(1)}MB`);
process.exit(0);
