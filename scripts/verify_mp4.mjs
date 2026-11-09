// verify_mp4.mjs — 成片四项验收：规格 / 时长 / 电平 / 音效是否真的进了音轨
//
// 音效判定用「残差」：成片音轨 − 口播原声 = 只剩音效。
//
// 为什么不用 -ss 按窗口取来减：MP3 的 seek 精度只有一帧（1152 采样 ≈ 26ms），成片里是 AAC，
// 两轨各 seek 一次就错开 20~30ms，残差里剩下的全是人声 —— 实测安静窗口 −4dB、比音效点还响，
// 于是「到处都有音效」，判据全废。
// 正解：整轨解码 → 互相关求全局偏移 → 逐样本相减 → 40ms 跳窗算 RMS。
//
// 用法:
//   node verify_mp4.mjs --mp4 成片.mp4 --mp3 口播.mp3 [--sfx-tl 音效事件表.json] [--dur 407.954]
//   事件表格式: { "events": [ { "at": 3.324, ... }, ... ] }
// 退出码: 0 全过 / 1 有未通过项

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const MP4 = arg('mp4');
const NARR = arg('mp3');
const TL = arg('sfx-tl');
const EXPECT = Number(arg('dur', '0'));
if (!MP4 || !NARR) { console.error('用法: node verify_mp4.mjs --mp4 <成片> --mp3 <口播> [--sfx-tl 事件表] [--dur N]'); process.exit(2); }

const SR = 16000;
const HOP = Math.round(0.04 * SR);
const db = v => (v > 0 ? 20 * Math.log10(v) : -999);
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function probe(f) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_name,width,height,r_frame_rate,channels,sample_rate',
    '-of', 'json', f], { encoding: 'utf8' }));
}
function decodeAll(f) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('解码失败: ' + String(r.stderr).slice(0, 300));
  const b = r.stdout;
  const a = new Float32Array(b.length / 4);
  for (let i = 0; i < a.length; i++) a[i] = b.readFloatLE(i * 4);
  return a;
}

const out = { ok: true, checks: [], detail: {} };
const bad = (k, msg) => { out.ok = false; out.checks.push({ k, pass: false, msg }); };
const good = (k, msg) => out.checks.push({ k, pass: true, msg });

// 1. 规格
const p = probe(MP4);
const V = p.streams.find(s => s.codec_name === 'h264' || s.codec_name === 'hevc');
const A = p.streams.find(s => s.codec_name === 'aac' || s.codec_name === 'mp3');
if (!V || V.width !== 1920 || V.height !== 1080) bad('规格', `视频不是 1920x1080：${V ? V.width + 'x' + V.height : '无'}`);
else if (V.r_frame_rate !== '30/1') bad('规格', `帧率 ${V.r_frame_rate} ≠ 30/1`);
else good('规格', `${V.codec_name} ${V.width}x${V.height} ${V.r_frame_rate} / ${A ? `${A.codec_name} ${A.sample_rate}Hz ${A.channels}ch` : '无音轨'}`);
if (!A) bad('音轨', '没有音轨');

// 2. 时长
const dur = Number(p.format.duration);
if (EXPECT > 0) {
  const d = Math.abs(dur - EXPECT);
  if (d > 0.12) bad('时长', `${dur.toFixed(3)}s 与预期 ${EXPECT}s 差 ${d.toFixed(3)}s`);
  else good('时长', `${dur.toFixed(3)}s ≈ 预期 ${EXPECT}s（差 ${d.toFixed(3)}s）`);
} else good('时长', `${dur.toFixed(3)}s`);

// 3. 电平
{
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', MP4, '-af', 'volumedetect', '-f', 'null', 'NUL'], { encoding: 'utf8' });
  const s = r.stderr || '';
  const mn = (s.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1];
  const mx = (s.match(/max_volume:\s*(-?[\d.]+) dB/) || [])[1];
  if (mx === undefined) bad('电平', 'volumedetect 未取到值（没测到 ≠ 通过）');
  else if (Number(mx) > -0.5) bad('电平', `峰值 ${mx}dB 有削波风险`);
  else good('电平', `mean ${mn}dB / max ${mx}dB`);
}

// 4. 残差
if (!fs.existsSync(NARR)) {
  bad('音效', '口播文件不存在，无法做残差判定');
} else {
  console.log('解码整轨…');
  const mix = decodeAll(MP4);
  const nar = decodeAll(NARR);

  // 互相关求全局偏移（60s 处取 1s 窗，粗搜 4 采样再细搜）
  const W = SR, C = Math.min(Math.round(60 * SR), Math.max(0, mix.length - W - 1));
  let best = { lag: 0, score: -1 };
  for (let lag = -Math.round(0.2 * SR); lag <= Math.round(0.2 * SR); lag += 4) {
    let s = 0;
    for (let i = 0; i < W; i += 2) {
      const j = C + i - lag;
      if (j < 0 || j >= nar.length) continue;
      s += mix[C + i] * nar[j];
    }
    if (s > best.score) best = { lag, score: s };
  }
  for (let lag = best.lag - 4; lag <= best.lag + 4; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const j = C + i - lag;
      if (j < 0 || j >= nar.length) continue;
      s += mix[C + i] * nar[j];
    }
    if (s > best.score) best = { lag, score: s };
  }
  const lag = best.lag;
  out.detail.lagMs = +(lag / SR * 1000).toFixed(2);

  const N = Math.min(mix.length, nar.length + lag);
  const res = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const j = i - lag;
    res[i] = mix[i] - (j >= 0 && j < nar.length ? nar[j] : 0);
  }
  const hops = [];
  for (let i = 0; i + HOP <= N; i += HOP) {
    let s = 0;
    for (let k = 0; k < HOP; k++) s += res[i + k] * res[i + k];
    hops.push(Math.sqrt(s / HOP));
  }
  const base = median(hops);
  out.detail.residualMedianDb = +db(base).toFixed(1);

  let times = [];
  if (TL && fs.existsSync(TL)) times = JSON.parse(fs.readFileSync(TL, 'utf8')).events.map(e => e.at);
  times = times.filter(t => t > 2 && t < dur - 1);
  const marks = times.map(t => {
    const from = Math.max(0, Math.floor((t - 0.14) * SR));
    const to = Math.min(N, Math.floor((t + 1.2) * SR));
    let m = 0;
    for (let i = from; i < to; i++) m = Math.max(m, Math.abs(res[i]));
    return { t: +t.toFixed(2), peak: +db(m).toFixed(1) };
  });
  const loud = marks.filter(m => m.peak > db(base) + 10).length;
  const hit = marks.length ? loud / marks.length : 0;
  out.detail.events = marks.length;
  out.detail.loudEvents = loud;
  out.detail.hitRate = +(hit * 100).toFixed(1);
  out.detail.sample = marks.slice(0, 6);

  if (!marks.length) bad('音效', '没有可比对的事件点（给 --sfx-tl）');
  else if (db(base) > -42) bad('音效', `残差底噪 ${db(base).toFixed(1)}dB 过高，两轨没对齐，判据不可用`);
  else if (hit < 0.9) bad('音效', `只有 ${loud}/${marks.length} 个事件在残差里可见（${(hit * 100).toFixed(1)}%）`);
  else good('音效', `${loud}/${marks.length} 个事件残差明显（底噪 ${db(base).toFixed(1)}dB，偏移 ${out.detail.lagMs}ms）`);
}

console.log(JSON.stringify(out, null, 2));
try {
  const f = path.join(path.dirname(MP4), '_qc', 'mp4-verify.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out, null, 2));
} catch { }
console.log(out.ok ? '\nPASS 全部通过' : '\nFAIL 有未通过项');
process.exit(out.ok ? 0 : 1);
