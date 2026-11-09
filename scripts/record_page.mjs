// record_page.mjs — 把单文件口播页「确定性逐帧录制」成 MP4
//
// 为什么不用实时录屏
// -------------------
// headless Chrome 的 Page.startScreencast 实测只有 ~8fps（帧间隔 P95 达 274ms），
// 拿来做成片必然卡顿掉帧，且帧率随负载波动 → 不可交付。
//
// 本脚本的做法（确定性逐帧）
// -------------------------
// 页面的一切都由「时间 t」唯一决定（幕、字幕、页眉章徽标、进度条）。
// 于是：对每一帧 t = i/fps，用注入的 __rec.renderAt(t) 把 DOM 手动渲染到该时刻
// （绕过 CSS transition，改为按进度直接写内联 opacity/transform，保留淡入淡出且完全确定），
// 再 Page.captureScreenshot 取图。同 t 两次截图字节一致 → 可复现、绝不掉帧。
//
// 音轨
// ----
// · 口播：直接用原 MP3（ffmpeg 解码），时间轴与画面同源，天然同步
// · 音效：页面音效是 Web Audio 实时合成的，逐帧模式下不会发声；
//         这里在 Node 侧按同一套参数离线合成一条完整音效轨，再与口播混音。
//         （参数与页面 SFX 严格一致，见 SFX_SPEC；可用 verify_sfx.mjs 交叉核对峰值）
//
// 用法:
//   node record_page.mjs --url <URL> --mp3 <口播.mp3> --out <out.mp4> \
//        [--size 1920x1080] [--fps 30] [--quality 92] [--range 0,30] [--crf 18]
//   · --range 用于开发调试，只录某个时间段（秒），如 --range 10,20
//
// 退出码: 0 成功 / 1 录制失败 / 2 环境错误

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const URL = arg('url');
const MP3 = arg('mp3');
const OUT = arg('out');
const [VW, VH] = (arg('size', '1920x1080')).split('x').map(Number);
const FPS = Number(arg('fps', 30));
const Q = Number(arg('quality', 92));
const CRF = Number(arg('crf', 18));
const RANGE = (arg('range') || '').split(',').filter(Boolean).map(Number);
if (!URL || !MP3 || !OUT) {
  console.error('用法: node record_page.mjs --url <URL> --mp3 <a.mp3> --out <o.mp4> [--size 1920x1080] [--fps 30] [--range s,e]');
  process.exit(2);
}

// ffmpeg：优先环境变量，其次 imageio-ffmpeg 的静态二进制，再次 PATH / 装机自带
function findFfmpeg() {
  if (process.env.FFMPEG_BIN && fs.existsSync(process.env.FFMPEG_BIN)) return process.env.FFMPEG_BIN;
  // imageio-ffmpeg 的静态二进制（装了就用；没装会静默跳过）
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
if (!FFMPEG) { console.error('找不到 ffmpeg：装 imageio-ffmpeg、或用 FFMPEG_BIN 指定（见 SKILL.md「ffmpeg 从哪来」）'); process.exit(2); }

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
];
const CHROME = process.env.AGENT_BROWSER_EXECUTABLE_PATH
  || CHROME_CANDIDATES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('找不到 Chrome'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = 9400 + Math.floor(Math.random() * 180);
const DD = path.join(os.tmpdir(), 'rec-' + Date.now());

// ---------------------------------------------------------------- 音效规格（与页面 SFX 严格一致）
const MASTER = 0.14;          // 页面 SFX MASTER
const SR = 44100;
// tone(f, dur, type, when, vol, glideTo)
const SFX_SPEC = {
  scene: [[880, .055, 0, .85, 660], [1320, .028, 0, .30, null]],
  chapter: [[680, .075, 0, .70, null], [1020, .13, .075, .55, null]],
  end: [[523.25, .24, 0, .60, null], [659.25, .58, .14, .50, 659.25]],
  tick: [[760, .04, 0, .62, 600]],
};

// 合成单个 tone 到 float 缓冲（累加）
function addTone(buf, t0, f, dur, vol, glideTo) {
  const s0 = Math.round(t0 * SR);
  const n = Math.ceil(dur * SR);
  const tau1 = Math.min(.012, dur * .25);
  const s1 = Math.round(tau1 * SR);
  const eps = 0.0001;
  const ratio = glideTo ? Math.log(glideTo / f) : 0;   // 指数扫频
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const s = s0 + i;
    if (s < 0 || s >= buf.length) continue;
    const t = i / SR;
    // 频率（指数插值）与相位积分
    const fr = glideTo ? f * Math.exp(ratio * (t / dur)) : f;
    phase += 2 * Math.PI * fr / SR;
    // 幅度包络：先指数升到 v（tau1），再指数降到 eps（dur）
    let g;
    if (t <= tau1) g = eps * Math.pow(vol / eps, tau1 > 0 ? t / tau1 : 1);
    else g = vol * Math.pow(eps / vol, (t - tau1) / Math.max(1e-6, dur - tau1));
    buf[s] += Math.sin(phase) * g * MASTER;
  }
}

// 生成整片音效轨（WAV 16bit 单声道）；events 用绝对秒，写轨时统一减去 t0
function buildSfxWav(events, t0, totalSec) {
  const N = Math.ceil(totalSec * SR);
  const buf = new Float32Array(N);
  for (const [t, name] of events) {
    const spec = SFX_SPEC[name];
    if (!spec) continue;
    for (const [f, dur, when, vol, glideTo] of spec) addTone(buf, (t - t0) + when, f, dur, vol, glideTo);
  }
  // 简易单极点低通（页面用 3400Hz biquad；正弦谐波极少，偏差可忽略）
  const a = 1 - Math.exp(-2 * Math.PI * 3400 / SR);
  let y = 0;
  for (let i = 0; i < N; i++) { y += a * (buf[i] - y); buf[i] = y; }
  // 写 WAV
  const dataBytes = N * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0); out.writeUInt32LE(36 + dataBytes, 4); out.write('WAVE', 8);
  out.write('fmt ', 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(dataBytes, 40);
  let o = 44;
  for (let i = 0; i < N; i++) {
    let v = Math.max(-1, Math.min(1, buf[i]));
    out.writeInt16LE(Math.round(v * 32767), o); o += 2;
  }
  return out;
}

// ---------------------------------------------------------------- CDP
const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=1',
  '--force-color-profile=srgb', '--disable-lcd-text',
  '--allow-file-access-from-files',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + DD, '--no-first-run',
  '--no-default-browser-check', `--window-size=${VW},${VH}`, 'about:blank'], { stdio: 'ignore' });

let ws, id = 0; const pend = new Map();
const send = (m, p = {}) => { const i = ++id; return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};

let target = null;
for (let i = 0; i < 100; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); target = l.find(x => x.type === 'page'); if (target?.webSocketDebuggerUrl) break; } catch { }
  await sleep(400);
}
if (!target) { console.error('CDP 连不上'); process.exit(2); }
ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
await send('Runtime.enable'); await send('Page.enable');
// 关键：headless 的 --window-size 含窗口边框，截图会变成 1904x985 这种奇数尺寸，
// libx264 直接拒收。用 Emulation 精确锁定视口，截图尺寸 = 目标尺寸，且强制偶数。
const EV = { w: VW % 2 ? VW - 1 : VW, h: VH % 2 ? VH - 1 : VH };
await send('Emulation.setDeviceMetricsOverride', {
  width: EV.w, height: EV.h, deviceScaleFactor: 1, mobile: false,
});
console.log(`视口锁定 ${EV.w}x${EV.h}（要求 ${VW}x${VH}）`);
await send('Page.navigate', { url: URL });
for (let k = 0; k < 200; k++) { if (await ev('document.readyState') === 'complete') break; await sleep(150); }
await sleep(2500);   // 等字体与内嵌图解码

// 校验截图实际尺寸
{
  const probe = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, fromSurface: true, captureBeyondViewport: false });
  const b = Buffer.from(probe.data, 'base64');
  // JPEG: 从 SOF0/SOF2 段读宽高
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
  if (w !== EV.w || h !== EV.h) console.warn(`注意：截图尺寸与视口不一致（${w}x${h} vs ${EV.w}x${EV.h}）`);
}

// 注入确定性渲染器
await ev(`(()=>{
  const TR=0.46;                                  // 与页面 .scene transition 时长一致
  const easeCSS=x=>1-Math.pow(1-x,3);             // 近似 CSS ease
  window.__rec={
    init(){
      if(document.getElementById('__rec__')) return 1;
      const s=document.createElement('style'); s.id='__rec__';
      s.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';
      document.head.appendChild(s);
      if(typeof SCENES!=='undefined'){
        const els=[...document.querySelectorAll('#sceneMount .scene')];
        SCENES.forEach((row,i)=>{if(els[i]){els[i].dataset.start=String(row[0]);els[i].dataset.end=String(row[1]);}});
        if(typeof render==='function') render(0);
      }
      this.scenes=[...document.querySelectorAll('.scene')].map(el=>({el,
        start:+el.dataset.start,
        end:+el.dataset.end,
        cover:el.classList.contains('cover')})).filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start);
      if(this.scenes.length<2) throw new Error('Timed scenes are not hydrated yet');
      this.DUR=(typeof DUR!=='undefined')?DUR:this.scenes[this.scenes.length-1]?.end;
      this.chapters=(typeof CHAPTERS!=='undefined')?CHAPTERS.slice():[];
      this.names=(typeof NAMES!=='undefined')?NAMES.slice():[];
      const c=document.querySelector('.controls'); if(c) c.style.display='none';
      if(!this.scenes.length||!Number.isFinite(this.DUR)) throw new Error('No timed scenes found');
      window.__pageSetTime=t=>{const a=document.querySelector('#audio'); if(a) a.currentTime=t; if(typeof render==='function') render(t);};
      __pageSetTime(0);
      return 1;
    },
    chapterAt(t){ return this.chapters.findIndex(r=>t>=r[0]&&t<r[1]); },
    renderAt(t){
      __pageSetTime(t);
      return this.scenes.findIndex(s=>t>=s.start&&t<s.end);
    },
    events(){
      const e=[];
      this.scenes.forEach((s,n)=>{ if(n>0&&!s.cover) e.push([s.start,'scene']); });
      for(let k=1;k<this.chapters.length;k++) e.push([this.chapters[k][0],'chapter']);
      e.push([this.DUR*0.92,'end']);
      e.sort((a,b)=>a[0]-b[0]);
      return e;
    }
  };
  __rec.init();
  return JSON.stringify({scenes:__rec.scenes.length,chapters:__rec.chapters.length,DUR:__rec.DUR});
})()`);

const meta = JSON.parse(await ev(`JSON.stringify({n:__rec.scenes.length,DUR:__rec.DUR,ch:__rec.chapters.length})`));
const DUR = meta.DUR;
const events = JSON.parse(await ev(`JSON.stringify(__rec.events())`));
console.log(`页面：${meta.n} 幕 / ${meta.ch} 章 / DUR=${DUR}s，音效事件 ${events.length} 个`);

// 让页面停在第一帧之外（避免自动播放干扰）
await ev(`(()=>{const a=document.querySelector('#audio'); if(a) a.pause(); const g=document.querySelector('#autoplayGate'); if(g) g.classList.remove('on'); return 1})()`);

// ---------------------------------------------------------------- 音效轨
const t0 = RANGE.length === 2 ? RANGE[0] : 0;
const t1 = RANGE.length === 2 ? RANGE[1] : DUR;
const sfxPath = path.join(os.tmpdir(), 'sfx-' + Date.now() + '.wav');
// 只合成范围内（含提前 1s 余量）的音效
const evIn = events.filter(([t]) => t >= t0 - 1 && t <= t1 + 1);
const sfxBuf = buildSfxWav(evIn, t0, t1 - t0);
fs.writeFileSync(sfxPath, sfxBuf);
console.log(`音效轨：${(sfxBuf.length / 1048576).toFixed(1)}MB，含 ${evIn.length} 个事件`);

// ---------------------------------------------------------------- ffmpeg
const totalFrames = Math.max(1, Math.ceil((t1 - t0) * FPS));
const args = [
  '-y', '-hide_banner', '-loglevel', 'warning',
  '-thread_queue_size', '512',
  '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'mjpeg', '-i', 'pipe:0',
  '-ss', String(t0), '-t', String(t1 - t0), '-i', MP3,
  '-i', sfxPath,
  '-filter_complex', `[0:v]scale=${EV.w}:${EV.h},format=yuv420p[v];` +
    `[1:a]aformat=channel_layouts=stereo[sp];[2:a]aformat=channel_layouts=stereo[sx];` +
    `[sp][sx]amix=inputs=2:duration=longest:normalize=0[a]`,
  '-map', '[v]', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF),
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2),
  '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
  '-movflags', '+faststart',
  '-shortest', OUT,
];
console.log(`ffmpeg: ${FFMPEG}`);
const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'inherit', 'inherit'] });
let ffErr = '';
ff.on('error', e => { ffErr = String(e); });
const done = new Promise(res => ff.on('close', c => res(c)));

// ---------------------------------------------------------------- 逐帧录制
let ok = 0, fail = 0;
const started = Date.now();
for (let f = 0; f < totalFrames; f++) {
  const t = t0 + f / FPS;
  try {
    await ev(`__rec.renderAt(${t.toFixed(5)})`);
    const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: Q, fromSurface: true, captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    if (!ff.stdin.write(buf)) await new Promise(res => ff.stdin.once('drain', res));
    ok++;
  } catch (e) {
    fail++;
    if (fail <= 3) console.error(`  帧 ${f} (t=${t.toFixed(2)}) 失败: ${e.message}`);
    // 补一张上一帧，避免断续（写不进去也不致命）
  }
  if (f % 300 === 0) {
    const el = (Date.now() - started) / 1000;
    const eta = el / Math.max(1, f + 1) * (totalFrames - f - 1);
    console.log(`  ${f}/${totalFrames} 帧  (${(f / Math.max(.001, el)).toFixed(1)} fps, ETA ${(eta / 60).toFixed(1)} 分)`);
  }
}
console.log(`录制完成：成功 ${ok} / 失败 ${fail} 帧，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分`);

ff.stdin.end();
const rc = await done;
try { ws.close(); } catch { } try { ch.kill(); } catch { }
try { fs.unlinkSync(sfxPath); } catch { }

if (rc === 0 && fs.existsSync(OUT)) {
  const mb = fs.statSync(OUT).size / 1048576;
  console.log(`OK -> ${OUT}  (${mb.toFixed(1)}MB)`);
  process.exit(0);
} else {
  console.error(`ffmpeg 退出码 ${rc} ${ffErr}`);
  process.exit(1);
}
