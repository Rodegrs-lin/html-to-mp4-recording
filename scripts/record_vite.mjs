// record_vite.mjs — 形态 B（Vite/React 打包页）确定性逐帧录制
//
// 与 record_page.mjs 的区别
// ------------------------
// record_page.mjs 面向形态 A（裸 HTML + 全局 SCENES），会注入自己的 __rec 覆盖页面。
// 形态 B 是打包后的 React 页，自己挂了 window.__rec = {duration, pages, renderAt}，
// 注入会把它冲掉。所以本脚本不注入，直接用页面自己的接口。
//
// 逐帧仍是三步：renderAt(t) → 两次 rAF → captureScreenshot → 推 ffmpeg
// 额外第三步：若页面里有 <video>，按「页内时间」精确 seek 并等 seeked（见坑 15）。
//
// 用法:
//   node record_vite.mjs --url <file://…|http://…> --mp3 <口播.mp3> [--sfx 音效轨.mp3] \
//        --out <out.mp4> [--size 1920x1080] [--fps 30] [--crf 18] [--quality 92] \
//        [--sfx-vol 1] [--range 0,10] [--hide-foot]
// 退出码: 0 成功 / 1 录制失败 / 2 环境错误

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);

const PAGE_URL = arg('url');
const MP3 = arg('mp3');
const SFX = arg('sfx');
const OUT = arg('out');
const SFX_VOL = Number(arg('sfx-vol', '1'));
const [VW, VH] = (arg('size', '1920x1080')).split('x').map(Number);
const FPS = Number(arg('fps', '30'));
const Q = Number(arg('quality', '92'));
const CRF = Number(arg('crf', '18'));
const RANGE = (arg('range') || '').split(',').filter(Boolean).map(Number);

if (!PAGE_URL || !MP3 || !OUT) {
  console.error('用法: node record_vite.mjs --url <URL> --mp3 <a.mp3> --out <o.mp4> [--sfx b.mp3] [--range s,e]');
  process.exit(2);
}

function findFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  for (const py of [process.env.PY_BIN, 'python', 'python3'].filter(Boolean)) {
    try {
      const r = spawnSync(py, ['-c', 'import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' });
      const p = (r.stdout || '').trim();
      if (p && fs.existsSync(p)) return p;
    } catch { }
  }
  const w = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' }).stdout?.trim().split(/\r?\n/)[0];
  if (w && fs.existsSync(w)) return w;
  return null;
}
const FFMPEG = findFfmpeg();
if (!FFMPEG) { console.error('找不到 ffmpeg：用 FFMPEG_BIN 指定'); process.exit(2); }

const CHROME = process.env.AGENT_BROWSER_EXECUTABLE_PATH
  || ['C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe']
    .find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9500 + Math.floor(Math.random() * 300);
const TMP_ROOT = process.env.REC_TMP || os.tmpdir();
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DD = path.join(TMP_ROOT, 'rec-' + Date.now());

const ch = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
  '--force-device-scale-factor=1', '--force-color-profile=srgb', '--disable-lcd-text',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + DD,
  '--no-first-run', '--no-default-browser-check',
  `--window-size=${VW},${VH}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
let id = 0;
const pend = new Map();
const send = (m, p = {}) => {
  const i = ++id;
  return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
};
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r.result?.value;
};

let target = null;
for (let i = 0; i < 120; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = l.find(x => x.type === 'page');
    if (target?.webSocketDebuggerUrl) break;
  } catch { }
  await sleep(400);
}
if (!target) { console.error('CDP 连不上'); process.exit(2); }

ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
await send('Runtime.enable');
await send('Page.enable');

const EV = { w: VW % 2 ? VW - 1 : VW, h: VH % 2 ? VH - 1 : VH };
await send('Emulation.setDeviceMetricsOverride', { width: EV.w, height: EV.h, deviceScaleFactor: 1, mobile: false });
console.log(`视口锁定 ${EV.w}x${EV.h}`);

await send('Page.navigate', { url: PAGE_URL });
for (let k = 0; k < 200; k++) { if (await ev('document.readyState') === 'complete') break; await sleep(150); }

// 页面体检：__rec 在不在、DOM 有没有真的长出来（坑 12：加载失败会伪装成"取不到幕"）
const health = JSON.parse(await ev(`JSON.stringify({
  title: document.title,
  domKB: Math.round(document.documentElement.outerHTML.length/1024),
  hasRender: !!(window.__rec && typeof window.__rec.renderAt === 'function')
})`));
console.log(`页面：title="${health.title}" DOM=${health.domKB}KB renderAt=${health.hasRender}`);
if (!health.hasRender) { console.error('页面没暴露 __rec.renderAt —— 不是形态 B，或页面没加载成功'); process.exit(1); }

await ev(`document.fonts.ready.then(()=>true)`);
await sleep(600);

// 关掉过渡/动画；卸掉音频（逐帧不需要播放，且每帧 seek mp3 会拖慢十倍）
await ev(`(() => {
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'
    + 'html,body{overflow:hidden!important}'
    + ${has('hide-foot') ? `'.page-foot,.progress{display:none!important}'` : `''`};
  document.head.appendChild(s);
  document.querySelectorAll('audio').forEach(a => { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {} });
  return 1;
})()`);

const meta = JSON.parse(await ev(`JSON.stringify({ duration: window.__rec.duration, pages: window.__rec.pages.length })`));
const DUR = meta.duration;
const t0 = RANGE.length === 2 ? RANGE[0] : 0;
const t1 = RANGE.length === 2 ? RANGE[1] : DUR;
console.log(`时长 ${DUR.toFixed(3)}s / ${meta.pages} 页；录制区间 ${t0}~${t1}`);

// 页起点与 timeline 对齐断言（音效轨按 timeline 摆的事件）
{
  const drift = JSON.parse(await ev(`(() => {
    const tl = window.__PPT_TIMELINE__;
    if (!tl) return 'null';
    const p = window.__rec.pages;
    let mx = 0;
    for (let i = 0; i < Math.min(p.length, tl.pages.length); i++) mx = Math.max(mx, Math.abs(p[i].start - tl.pages[i].start));
    return JSON.stringify(mx);
  })()`));
  console.log(`页起点与 timeline 最大偏差 ${drift === 'null' ? '(无 timeline)' : drift.toFixed(4) + 's'}`);
  if (typeof drift === 'number' && drift > 0.02) { console.error('偏差超过 0.02s，音效会全线错位'); process.exit(1); }
}

// 截图尺寸断言
{
  await ev(`window.__rec.renderAt(${t0.toFixed(3)}), 1`);
  const probe = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true, captureBeyondViewport: false });
  const b = Buffer.from(probe.data, 'base64');
  let i = 2, w = 0, h = 0;
  while (i < b.length - 1) {
    if (b[i] !== 0xFF) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break;
    }
    if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  console.log(`截图实测 ${w}x${h}`);
  if (w % 2 || h % 2) { console.error('截图尺寸为奇数，libx264 会拒绝'); process.exit(1); }
  if (w !== EV.w || h !== EV.h) { console.error(`截图尺寸与视口不一致（${w}x${h} vs ${EV.w}x${EV.h}）`); process.exit(1); }
}

// ---------------- ffmpeg
const totalFrames = Math.max(1, Math.round((t1 - t0) * FPS));
const audioIn = ['-ss', String(t0), '-t', String(t1 - t0), '-i', MP3];
if (SFX) audioIn.push('-ss', String(t0), '-t', String(t1 - t0), '-i', SFX);

const filter = SFX
  ? `[0:v]scale=${EV.w}:${EV.h},format=yuv420p[v];` +
    `[1:a]aformat=channel_layouts=stereo[sp];` +
    `[2:a]aformat=channel_layouts=stereo,volume=${SFX_VOL}[sx];` +
    `[sp][sx]amix=inputs=2:duration=longest:normalize=0[a]`
  : `[0:v]scale=${EV.w}:${EV.h},format=yuv420p[v];[1:a]aformat=channel_layouts=stereo[a]`;

const args = [
  '-y', '-hide_banner', '-loglevel', 'warning',
  '-thread_queue_size', '512',
  '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'mjpeg', '-i', 'pipe:0',
  ...audioIn,
  '-filter_complex', filter,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF),
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2),
  '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
  '-movflags', '+faststart', '-shortest', OUT,
];
console.log(`ffmpeg ${FFMPEG}`);
const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'inherit', 'inherit'] });
let ffErr = '';
ff.on('error', e => { ffErr = String(e); });
const closed = new Promise(res => ff.on('close', res));

// ---------------- 逐帧
let ok = 0, fail = 0;
const started = Date.now();
for (let f = 0; f < totalFrames; f++) {
  const t = t0 + f / FPS;
  try {
    /* 视频必须按「页内时间」seek：逐帧比实时慢，<video> 自己播会跑完好几轮（坑 15） */
    await ev(`(async (t) => {
      window.__rec.renderAt(t);
      await new Promise(r => requestAnimationFrame(r));
      const v = window.__videoEl;
      if (v) {
        if (!v.paused) v.pause();
        const d = v.duration;
        if (Number.isFinite(d) && d > 0) {
          const want = (window.__videoLocalT || 0) % d;
          if (Math.abs(v.currentTime - want) > 0.002 || v.readyState < 2) {
            v.currentTime = want;
            await new Promise(res => {
              const to = setTimeout(res, 600);
              v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
            });
          }
        }
      }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return 1;
    })(${t.toFixed(5)})`);
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: Q, fromSurface: true, captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    if (!ff.stdin.write(buf)) await new Promise(res => ff.stdin.once('drain', res));
    ok++;
  } catch (e) {
    fail++;
    if (fail <= 3) console.error(`  帧 ${f} (t=${t.toFixed(2)}) 失败: ${e.message.slice(0, 200)}`);
  }
  if (f % 600 === 0) {
    const el = (Date.now() - started) / 1000;
    const eta = el / Math.max(1, f + 1) * (totalFrames - f - 1);
    console.log(`  ${f}/${totalFrames} 帧  (${(f / Math.max(0.001, el)).toFixed(1)} fps, ETA ${(eta / 60).toFixed(1)} 分)`);
  }
}
console.log(`录制完成：成功 ${ok} / 失败 ${fail}，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分`);

ff.stdin.end();
const rc = await closed;
try { ws.close(); } catch { }
try { ch.kill(); } catch { }

if (rc === 0 && fs.existsSync(OUT)) {
  console.log(`OK -> ${OUT}  (${(fs.statSync(OUT).size / 1048576).toFixed(1)}MB)`);
  process.exit(0);
}
console.error(`ffmpeg 退出码 ${rc} ${ffErr}`);
process.exit(1);
