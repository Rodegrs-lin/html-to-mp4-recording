---
name: html-to-mp4-recording
description: 把「单文件 HTML 演示页 / 播放页」录成可投稿的 MP4（含口播人声 + 音效）。采用确定性逐帧渲染（页面按时间 t 手动渲染 → 逐帧截图 → 推给 ffmpeg image2pipe），不用实时录屏，因此绝不掉帧、可复现；口播用原音频直接对齐（天然同步），UI 音效在 Node 侧按页面同参离线合成后混音。当用户说「把这个网页录成视频」「html 录一遍」「输出 MP4」「要有音效和口播」，或需要把 SRT+音频驱动的时间轴演示页导出成 1080p/4K 视频时使用。也覆盖录制的常见故障：画面卡顿掉帧、音画不同步、libx264 报 height not divisible by 2、找不到 ffmpeg、录制后临时目录被残留浏览器进程锁住无法删除、音轨单声道等。
agent_created: true
---

# 把 HTML 演示页录成 MP4

> 前置条件（node / playwright-core / ffmpeg）、两种页面形态怎么分辨、以及它和 `voice-to-deck` 的上下游关系，见 [README.md](README.md)。

## 用途

把「由时间轴驱动、可全屏播放」的单文件 HTML（典型是口播视频页：内嵌音频 base64 +
按 `t` 切幕/切字幕）录成 **可直接投稿的 MP4**：1920×1080 / 30fps / H.264 + AAC，
带**口播人声**与 **UI 音效**。

适用前提：页面是**时间的纯函数** —— 给定 `t`，当前幕、字幕、页眉章徽标、进度条都唯一确定。
只要满足这一点（本类演示页都满足），就能用本技能的确定性逐帧法录制。

**先认清页面属于哪种形态**，两者的「取幕」方式完全不同，用错就报
`Timed scenes are not hydrated yet` / `No timed scenes found`：

| 形态 | 特征 | 取幕方式 |
|---|---|---|
| A `narration-to-video-page` 产物 | 裸 HTML，全局有 `SCENES` / `DUR` / `render()`，`#sceneMount .scene` | `record_page.mjs` 的注入式 `init()` 直接可用 |
| B Vite/React 打包页 | 单文件但已 bundle，**没有** `SCENES`，页自己挂了 `window.__rec = {duration, pages, renderAt}` | 用 **`record_vite.mjs`**（见「页面形态 B」）。**不要**用 `record_page.mjs`：它会注入自己的 `__rec` 把页面的接口冲掉 |


## 何时使用

- 「把 html 录成视频」「录一遍」「输出 MP4」「要带口播和音效」
- 已有演示页要导出成 1080p / 1440p / 4K 成片投稿
- 录制故障：画面卡顿掉帧 / 音画不同步 / 编码器拒绝尺寸 / 找不到 ffmpeg / 临时目录删不掉

## 核心结论：不要用实时录屏

无头 Chrome 的 `Page.startScreencast` 实时抓帧**实测只有 ~8fps**
（帧间隔中位数 24ms、P95 高达 274ms），且随机器负载波动 —— 10 分钟成片必然卡顿掉帧，
**不可交付**。

**正解 = 确定性逐帧**：对每一帧 `t = i/fps`：

1. 用注入的 `__rec.renderAt(t)` 把 DOM **手动渲染**到该时刻
2. `Page.captureScreenshot` 取图（JPEG）
3. 把 JPEG 推进 ffmpeg 的 stdin（`image2pipe`）

同一 `t` 两次截图**字节一致** → 可复现、绝不掉帧。实测单帧 ~73ms（1920×1080），
约 **12fps** 出片 → 10 分钟片子录制约 20~30 分钟。

## 前置条件

1. **页面已定稿**。若页面来自 `narration-to-video-page` 技能，先跑
   `quality_gate.py` 三条线（音画同步 / 逐幕排版 / 播放可用）**全绿** ——
   否则会把错误一起录进成片，返工成本最高。
2. **起本地 HTTP**（`file://` 下字体/内联资源可能失效）：
   ```bash
   cd <页面目录> && python -m http.server 8931 --bind 127.0.0.1   # 后台
   ```
   ⚠️ **但先验证 Chrome 真的能拿到页面**（见「常见坑 12」）：若页面是**全内联**的
   （图片/音频都是 `data:` URI、字体只用系统字），**直接走 `file://` 更稳**，
   连 HTTP 都不需要——脚本已内置 `--allow-file-access-from-files`。
   一行验证（**推荐，30 秒出结论**）：
   ```bash
   "$NODE" scripts/page_health.mjs "<url>"   # [PASS] / [FAIL] 直接给判定
   ```
3. **有口播音频文件**（页面内嵌的那份原始 mp3/wav）。
4. **有 ffmpeg**（见「ffmpeg 从哪来」）。

## 用法

```bash
NODE="C:/Users/<you>/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
FFMPEG_BIN="D:/path/to/ffmpeg.exe" \
TEMP="<大盘路径>" TMPDIR="<大盘路径>" \
"$NODE" scripts/record_page.mjs \
  --url  http://127.0.0.1:8931/index.html \
  --mp3  /path/口播.mp3 \
  --out  /path/成片.mp4 \
  --size 1920x1080 --fps 30 --crf 18
```

参数：

| 参数 | 说明 |
|---|---|
| `--url` | 演示页地址：`http://…` 或 `file://…`（全内联页面用 file 更稳，见坑 12） |
| `--mp3` | 口播音频（与页面内嵌音频同源的那份） |
| `--out` | 输出 mp4 |
| `--size` | `1920x1080`（默认）；奇数会被自动收敛到偶数 |
| `--fps` | `30`（默认） |
| `--crf` | `18`（默认，越大越小越糊；18 视觉无损） |
| `--quality` | JPEG 截图质量 `92`（默认） |
| `--range s,e` | **调试用**：只录 `s~e` 秒，约 1 分钟出片，用来验证管线 |

- `FFMPEG_BIN` 指定 ffmpeg；否则自动找 `imageio_ffmpeg` 的静态二进制或 PATH
- `TEMP` / `TMPDIR` **务必指到大盘**：音效 WAV 可达 50MB，别写满 C 盘
- **务必后台运行**（`run_in_background`）：10 分钟片子要录 20~30 分钟
- 退出码：`0` 成功 / `1` 录制或编码失败 / `2` 环境错误

先跑**页面体检**确认「录制器真能拿到页面」（换机器 / 换页面 / 换协议时**先跑这个**）：

```bash
"$NODE" scripts/page_health.mjs "<url>"      # [PASS] 73 幕 / DUR=… / DOM 24.1MB
```

再用探针确认环境可行：

```bash
"$NODE" scripts/record_probe.mjs http://127.0.0.1:8931/index.html 1920x1080 6
# 打印实时 screencast 帧率 + 验证 setTime(120) 能否定位（决定逐帧法可行否）
```

## 页面形态 B：Vite/React 打包的时间轴页（无 SCENES）

这类页把时间轴编进 bundle，全局只有 `window.__rec`。**不要去注入 `SCENES` 回写那套**
（那是形态 A 的兜底，B 里既不存在也不需要），而是直接用页自己暴露的接口。

**直接用 `scripts/record_vite.mjs`**（本技能自带，参数与 `record_page.mjs` 一致）：

```bash
"$NODE" scripts/record_vite.mjs \
  --url "file:///<页面>.html?review=1" \
  --mp3 口播.mp3 --sfx 音效轨.mp3 --sfx-vol 0.9 \
  --out 成片.mp4
```

它在 `record_page.mjs` 基础上多做了三件事：不注入 `__rec`；断言 `__rec.pages[i].start`
与 `__rec.timeline` 一致（>0.02s 直接退出）；每帧给 `<video>` 按页内时间 seek（见坑 15）。

页面侧要配合三件事（否则录出来是错的）：

1. **`?review=1` 必须让页面「只渲染、不自播」** —— 关掉自动 play、关掉 `renderT` 的兜底钳位
   （本项目里 `t < 5.0 ? 5.0 : t` 这种「防止第一帧空白」的兜底，会让前 5 秒全被替换掉）。
2. **视频交给录制器**：页面只 `window.__videoEl = el; window.__videoLocalT = t - page.start`，
   不要自己 `play()`。逐帧比实时慢 3 倍，自己播的视频会跑完好几轮（见坑 15）。
3. **先确认页面没有「长时间只有标题」的段落、且每一句都有画面变化**。渲染是忠实的——页面里
   7.5 秒不出内容、或者 60 句说完画面不动，成片里一模一样，而且逐帧录制不会替你发现它。
   录制前先跑 `anchor-driven-demo-page` 的两个体检（比录完 26 分钟再抽帧发现划算得多）：
   - `check-timing-gaps.cjs`：标题 → 首个内容 ≤3s
   - `check-motion-coverage.cjs`：**每句都有一次可见变化**（覆盖率 ≥90%，连续无动作 ≤2 句/≤3.5s）

原始说明（手写实现时可参考）：

```js
// 起浏览器后
await page.waitForFunction(() => Boolean(window.__rec));
await page.evaluate(() => document.fonts.ready.then(() => true));  // 等字体，否则首帧是 fallback 字形
await page.evaluate(() => {                                        // 关掉 CSS 过渡/动画
  const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}'
    + 'html,body{overflow:hidden!important}.controls,.start{display:none!important}';
  document.head.appendChild(s);
});
const { duration, pages } = await page.evaluate(() => window.__rec);
```

**逐帧必须等两个 rAF**（这条是踩实的坑，不是保险）：

```js
await page.evaluate(async (t) => {
  window.__rec.renderAt(t);                        // 内部只做 flushSync(setTime) = commit，未 paint
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}, t);
const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true });
```

少等这一下，整片会**整体延后一帧**（表现为「字幕总是慢半拍」），而且因为每一帧都延后，
连「同 t 两次截图一致」都验不出来 —— 两次都拍到同一个旧帧。

`__rec.pages` 里的页起点要与音效事件用的 timeline 对齐，**开录前断言一次**：
`max|pages[i].start − timeline.pages[i].start| < 0.02s`，否则音效会全线错位。

## 音轨策略


| 音轨 | 来源 | 说明 |
|---|---|---|
| 口播 | **原 MP3** 作 ffmpeg 输入 | 与画面同源 → **天然同步**，不需要对时 |
| 音效 | **Node 侧离线合成** | 逐帧模式下页面 Web Audio **不发声**，必须离线合成 |

**音效为何要离线合成**：页面音效通常是 Web Audio 现场合成的（见
`narration-to-video-page` 的「音效」一节）。逐帧录制时页面并不真的在播放，
`AudioContext` 不会产出波形。所以要在 Node 侧**按页面同一套参数**合成一条完整音效轨
（WAV），再与口播 `amix`。

硬纪律：

- **参数必须与页面严格一致**，改音效时两边同步改。`record_page.mjs` 里的 `SFX_SPEC`
  就是页面 `SFX` 的镜像（`MASTER` / 频率 / 时长 / 音量 / 扫频），可用 `verify_sfx.mjs`
  交叉核对峰值。

### 更稳的做法：离线渲染采样，页面与成片共用同一份波形

> **先判自己是哪一种，别照抄这一节。** 下面这条路（页面用 Web Audio 自播、成片抓同一份字节）
> 适用于「页面要能单独播放出声」的形态 A。本项目实测走的是**形态 B：页面完全不播、离线渲染整轨**，
> 脚本在 `anchor-driven-demo-page/scripts/gen_sfx.cjs` + `render_sfx_track.cjs`，
> 一致性由「动画与音效读同一份 `beats.json`」保证，不存在两套合成逻辑。
> 选型表见本节末尾。

「Node 侧照参数复刻」的致命弱点是要写**两遍**合成逻辑：页面的 Web Audio biquad 与
Node 手写滤波器实现不同，听感必然有偏差；改一次参数要改两处，漏一处就悄悄不一致。
噪声类音效（翻页、撕纸、雨声）尤其明显 —— 噪声样本、滤波阶数任何一点差异都听得出。

改成**一份波形两处用**，问题从根上消失：

1. 用固定种子 PRNG + 手写 RBJ biquad 离线算出采样（Float32）；
2. 把采样写成 16bit WAV 的 base64 → `src/sfxData.ts`（122KB 换两个采样）；
3. 页面 `decodeAudioData` 成 AudioBuffer 播放，`master.gain = MASTER`；
4. 成片脚本把**同一批字节**按事件表摆进整片音轨。

这样「页面播放听到的」与「成片里的」是同一份波形，一致性是构造出来的，不是核对出来的。

两条实现细节（都踩过）：

- **采样要在挂载时就解码**，别等用户手势：`decodeAudioData` 不需要 running 的
  context，`AudioContext` 才是。等手势会让「第 9 秒第一次翻页」有机会哑掉。
- 触发要绑「真的在播」＋「相邻页」：`if (el.paused || index !== prev + 1) return;`。
  否则拖一次进度条能连响几十声（跳页不是翻页）。
- 事件时刻用**画面切换点**而不是口播句首：页面若有 `LEAD`（字幕/画面提前量，本项目
  0.12s），音效要跟画面走，摆轨时同样减去 `LEAD`，两边才咬着同一次翻页。

**三种形态的选型表**（先认形态，再决定成片怎么混）：

| 形态 | 页面侧 | 成片音轨 | 一致性靠什么 |
|---|---|---|---|
| A 页面自播 | `decodeAudioData` + `AudioBufferSource` | 抓系统声，或按同一批采样离线摆轨 | 同一批字节（需拿到 `sfxData.ts`） |
| B 页面静音★本项目实测 | 只读事件表做动画，不放声 | `gen_sfx.cjs` → 整条 wav → 混进 mp4 | 动画与音效读**同一份 `beats.json`** |
| C 外部 wav | `<audio>` 播固定文件 | 混同一批文件 | 文件级，但要防采样率/位深被转码 |

### 翻页声怎么调得像纸，而不是像「嘶」

三个可量的判据（听不出来时先量这三项，别反复试听）：

| 指标 | 目标 | 不对时的症状 |
|---|---|---|
| 频谱重心 | **2–3.5 kHz** | >5k 是「嘶」的电流声（白噪声带通后的高频尾巴没压） |
| 20ms 峰值包络 | 起振 ≥50ms 才到顶 | 20ms 内到顶 = 「啪」的爆音，不是翻页 |
| 采样首尾样本 | 恰好 0 + 8ms 淡出 | 非零 = 每翻一页都有一声「嗒」 |

只做带通时噪声在通带外的尾巴仍很亮（实测重心 5.9kHz）→ 混完再过两级一阶低通 4.6kHz，
重心落到 3.5kHz 才是纸。低频加一层 380Hz 低通噪声（gain 0.55）给「纸的厚度」，
笔记本外放才不虚。

- **音效事件表从页面取**（`__rec.events()`），保证与画面上「真的会发生」的转场一致：
  换幕（跳过封面幕）+ 换章 + 收尾。
- **合成要复刻「指数扫频 + 指数衰减包络」**，且**相位要积分**（`phase += 2π·f/SR`），
  不能直接 `sin(2πft)` —— 否则扫频段的听感与页面不一致。

## 关键实现要点

### 1. 视口必须用 CDP 精确锁定（否则编码器拒收）

`--window-size=1920,1080` 在 headless 下**含窗口边框**，截图出来是 **1904×985** ——
高度是奇数，libx264 直接报 `height not divisible by 2` 并拒绝编码。

```js
const EV = { w: VW % 2 ? VW - 1 : VW, h: VH % 2 ? VH - 1 : VH };
await send('Emulation.setDeviceMetricsOverride',
  { width: EV.w, height: EV.h, deviceScaleFactor: 1, mobile: false });
```

开录前**断言实际截图尺寸**（解析 JPEG 的 SOF 段读宽高），奇数就退出。

### 2. 关掉 CSS transition，改为按进度写内联样式

页面换幕靠 `transition: opacity .46s`。逐帧模式保留 transition 会抓到动画中间态（不确定）。
注入 `*{transition:none!important;animation:none!important}`，再在 `renderAt` 里
**按进度算透明度直接写内联** —— 既确定，又保留淡入淡出观感：

```js
const p  = clamp01((t - cur.start) / TR);   // TR = 页面 transition 时长（如 0.46）
const pe = 1 - Math.pow(1 - p, 3);          // 近似 CSS ease
cur.el.style.opacity  = pe;                  // 当前幕淡入
prev.el.style.opacity = 1 - pe;              // 上一幕淡出
cur.el.style.transform = `translateY(${(1.2*(1-pe)).toFixed(3)}%)`;
```

### 3. 录屏时隐藏控制条 / 提示

`.controls` 是 hover 才显示的，但要在页面初始状态显式 `display:none`，
否则偶发 hover 会被录进去。

### 4. ffmpeg 显式 scale + format

pipe 进来的 JPEG 尺寸理论上已等于目标，但显式 `scale=W:H,format=yuv420p` 更稳
（顺手消掉 `deprecated pixel format` 警告）：

```
[0:v]scale=W:H,format=yuv420p[v]
[1:a]aformat=channel_layouts=stereo[sp];[2:a]aformat=channel_layouts=stereo[sx];
[sp][sx]amix=inputs=2:duration=longest:normalize=0[a]
```

`-thread_queue_size 512` 避免 `Thread message queue blocking`；
`-movflags +faststart` 让 MP4 可边下边播。

## ffmpeg 从哪来（本机踩坑）

| 途径 | 结果 |
|---|---|
| PATH 里 | 常常**没有** |
| `pip install imageio-ffmpeg`（默认源） | 卡住（下载慢，30MB 级） |
| 清华镜像 `pypi.tuna.tsinghua.edu.cn` | **该包不存在**（镜像不全） |
| 阿里云镜像 `mirrors.aliyun.com/pypi/simple` | ✅ 有（但可能下 10 分钟） |
| **装机软件自带的 ffmpeg**（剪辑 / AI 工具的安装目录里常见） | ✅ **直接可用** |

**教训：装机已有软件常自带 ffmpeg，先扫一遍再下载。** 扫描（限深度，别全盘）：

```bash
export PATH="/c/Users/<you>/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:$PATH"
find /c/Program\ Files /d /e -maxdepth 4 -iname "ffmpeg.exe"
```

gyan essentials build（6.x）的 `libx264` + `aac` + mp3 解码头都齐全，够用。

**注意**：给 Node 传 ffmpeg 路径要用 **Windows 风格**（`D:/...`），
MSYS 风格（`/d/...`）Node 不认。

## 验收（录完必查）

### 音效「到底在不在」只能靠残差，不能靠肉眼听

成片音轨 − 口播原声 = 只剩音效。

**不要用 `-ss` 按窗口取来相减。** 两轨取同一个 `-ss` 也不够：`-ss` 只作用于它后面那个 `-i`，
而且 **MP3 的 seek 精度只有一帧（1152 采样 ≈ 26ms），成片里是 AAC** ——
两轨各 seek 一次就错开 20~30ms，残差里剩下的全是说话声。
实测症状很有欺骗性：安静窗口的残差是 **-4dB**，比音效点还响，于是「到处都有音效」，判据全废。

**正解：整轨解码 → 互相关求全局偏移 → 逐样本相减。**
408 秒的片子按 16kHz 单声道解码只有 6.5M 采样（26MB），一次算完，几秒钟。
找偏移在 60s 附近取 1s 窗，先粗搜 ±0.2s（步长 4 采样）再细搜，实测偏移 0ms。

判据也从「绝对静音」改成**底噪 + 命中率**：40ms 跳窗算残差 RMS，取中位数当底噪，
再量每个事件点 ±0.14s 内的残差峰值。

```
PASS 条件：底噪 < -42dB 且 峰值 > 底噪 + 10dB 的事件占比 ≥ 90%
```

实测（23 轮）：底噪 **-64.8dB**、129/129 个事件峰值 **-17 ~ -21dB**、偏移 0ms。
底噪如果只有 -30dB 上下，说明两轨还没对齐，这时候的「命中率」不能信。

### 常规项

**先跑一条命令，再手工看**：

```bash
"$NODE" scripts/verify_mp4.mjs --mp4 成片.mp4 --mp3 口播.mp3 --sfx-tl 音效事件表.json --dur 407.954
```

四项一次判完并落 `_qc/mp4-verify.json`：规格（1920×1080/30fps/h264+aac）、时长差 ≤0.12s、
混音峰值 < −0.5dB、**残差命中的事件占比 ≥90%**。下面这些是手工复核用的补充项：

用 ffmpeg 自身检查，别只看文件存在：


```bash
FF="D:/path/ffmpeg.exe"; OUT="成片.mp4"

# 1. 流规格：应 1920x1080 / 30fps / h264 / aac 44100
"$FF" -hide_banner -i "$OUT" 2>&1 | grep -E "Duration|Stream"

# 2. 音轨电平：口播 + 音效混音后不应削波（max_volume 应 < -1 dB）
"$FF" -hide_banner -i "$OUT" -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"

# 3. 抽帧核对画面（首 / 中 / 尾）——确认幕、字幕、页眉章徽标都对
"$FF" -y -ss 10 -i "$OUT" -frames:v 1 f_mid.jpg

# 4. 时长须与页面 DUR 精确一致（DUR=723.93 → 应得 00:12:03.93）
"$FF" -hide_banner -i "$OUT" 2>&1 | grep Duration

# 5. moov 应在文件头部（+faststart ⇒ 可边下边播）
"$FF" -hide_banner -v trace -i "$OUT" 2>&1 | grep -m1 "type:'moov'"
```

抽出的帧要**真的看一眼**（能 Read 图片），核对「幕 / 章节徽标 / 章进度点 / 配图 / 字幕」是否对得上。

**交付文件名去掉过程痕迹**：`_重录` / `_v2` / `_final` / `_probe` 都不要留在成片名里 ——
交付物是「可直接投稿」的，文件名就是《片名》.mp4。中途的探针/失败件另起名或收进 `_trash/`。

**音轨 mono 属正常**（口播源常是单声道）。若要立体声，**不要重录** ——
视频流直接复制、只重编音频即可（秒级）：

```bash
"$FF" -i out.mp4 -c:v copy -c:a aac -b:a 192k -ac 2 out_stereo.mp4
```

## 分辨率与时长参考

| 目标 | `--size` | 说明 |
|---|---|---|
| 1080p（B站标准档） | `1920x1080` | 默认；B站 1080p 要求就是 1920×1080 |
| 1440p | `2560x1440` | 需重录；字号按舞台高同比放大，观感一致 |
| 4K | `3840x2160` | 需重录；录制时间与磁盘占用显著上升 |

- 30fps 对「按幕切换 + 字幕」这类内容足够；改 60fps 需重录，通常收益不大
- **录制耗时 ≈ 成片时长 × 2.5**（实测 11.7–12.0 fps）。本项目 12:03.93 的成片
  录了 **30.3 分钟**、**21718 帧 0 失败**、输出 1080p30/crf18 = **68.2MB**。
- 另一组实测（Vite/React 形态 B，含大图 Ken Burns）：7:07.73 成片 → **12832 帧**、
  **24.8 分钟**、**8.6 fps**、82.9MB。同为 1080p30/crf18，逐帧成本却比形态 A 高 40% ——
  页面每帧都要重新栅格化 transform 后的大图。**别用别的项目的 fps 估自己的时间。**
- 再一组（Vite/React 形态 B，24 页、满屏真截图、末页带 `<video>`）：6:47.95 成片 →
  **12239 帧 0 失败**、**22.5 分钟**、**9.2 fps**、66MB。含视频的那 21 秒掉到 4.7fps。
- 单帧成本拆开量过（1920×1080）：`renderAt + 2×rAF` = **34ms**，
  `Page.captureScreenshot(jpeg,92)` = **99ms** —— 瓶颈在截图，不在渲染也不在编码。
  想提速只能从截图下手（降 quality 收益很小）。
- **不要用输出文件大小估算进度**：平铺浅色页压缩率远高于满版图片页，
  按体积会算出「还要 50 分钟」然后 10 分钟就结束。
- 输出体积参考：10 分钟 1080p/crf18 ≈ 55~70MB（纯排版页）/ 90~110MB（多图页）

## 常见坑

1. **libx264 报 `height not divisible by 2 (1904x985)`** —— `--window-size` 含窗口边框。
   用 `Emulation.setDeviceMetricsOverride` 锁定 + 断言实际截图尺寸（见「要点 1」）。
2. **截图抓到 transition 中间态 / 同 t 两次不一致** —— 没禁用 CSS transition。见「要点 2」。
3. **音效完全没声音** —— 逐帧模式下页面 Web Audio 不发声，必须离线合成。见「音轨策略」。
4. **音效听感与页面不一样** —— 扫频用线性插值 / 没积分相位。改用指数扫频 + 相位积分。
5. **找不到 ffmpeg** —— 先扫装机自带（`find ... -iname ffmpeg.exe`），别急着 pip。
6. **`FFMPEG_BIN=/d/...` Node 不认** —— 用 `D:/...`（Windows 风格）。
7. **磁盘写满** —— 音效 WAV 可达 50MB，`TEMP`/`TMPDIR` 指到大盘，别写 C 盘。
8. **输出目录不存在** —— ffmpeg 首帧后才开门，脚本启动前先 `mkdir -p` 输出目录。
9. **录制中途被打断** —— 务必后台跑；前台跑或被通知打断会 SIGTERM。
10. **录完临时目录删不掉（`EBUSY`/`EPERM`）** —— 录制用的无头 Chrome **主进程虽结束，
    子进程（crashpad / gpu / network / renderer）会残留**，锁住 `--user-data-dir`。
    先**精准**找出这些实例再杀（**别误杀用户自己的浏览器**，认 `--user-data-dir` 路径）：
    ```powershell
    # PowerShell：命令行含 _rec\rec- 的才是录制实例
    $t = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'") |
         Where-Object { $_.CommandLine -like '*_rec\rec-*' }
    $t | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    ```
    杀完再删目录即可。**本机 PowerShell 工具不回传 stdout**，要 `Out-File` 落盘再 Read。
11. **抽帧糊了 / 不确定是不是画质问题** —— 用 `video-frame-sharpness-forensics` 技能做像素级归因。
12. **「No timed scenes found」/「Timed scenes are not hydrated yet」—— 先怀疑页面根本没加载成功，别急着改场景逻辑。**
    实测踩坑：本机**由 node 拉起的 Chrome 走 `http://127.0.0.1` 完全不通**（`--dump-dom` 0 字节；
    CDP 里 `document.title` 是主机名 = Chrome 网络错误页，`htmlLen` 只有 187KB，`SCENES` 全 `undefined`），
    但 **PowerShell 的 `Invoke-WebRequest` 能正常拉满 17.9MB**、同一个 Chrome 走 **`file://` 也能渲染出 24MB DOM**。
    → 症状被伪装成「脚本取不到幕」，真相是**页面压根没加载**。
    **判据（30 秒定位）**：注入前先查 `document.title` / `document.documentElement.outerHTML.length` /
    `typeof SCENES`；长度远小于页面体量或 `SCENES` 为 `undefined` ⇒ **网络/加载问题，不是场景检测问题**。
    **解法**：全内联页面直接用 `file://`（脚本已带 `--allow-file-access-from-files`）。
    另外：`localhost` 服务一定要用 **`--directory` 或 `-WorkingDirectory` 指到页面目录**，
    否则 `http.server` 会用默认 cwd 返回 404（`title` = `Error response`、314 字节），同样是这个伪装症状。
13. **后台跑时别接 `| tail -n`** —— 管道要等进程结束才吐输出，20 分钟的录制期间
    一行进度都看不到，还以为卡死了。要么不接管道（`run_in_background` 本身就收输出），
    要么把日志 `tee` 到文件再 tail。
14. **懒挂载页面的幕表兜底**：若页面用「空壳 `<section class="scene">` + JS 再填内容」的结构，
    且全局有 `SCENES`（`[start,end,title,chIdx,points,img,...]`）数组，可在注入的 `init()` 里
    **按 `SCENES[i]` 显式回写每个空壳的 `data-start`/`data-end` 再采幕**，
    这样即使页面自身的自动挂载时序有差异也能拿到完整 73 幕（本脚本已内置此兜底）。
15. **页面里有 `<video>` —— 会按墙上时钟自己跑，录出来乱跳。**
    逐帧比实时慢 3 倍（本项目 408s 的片子录了 22.5 分钟），所以 21 秒的页面里
    一段 8 秒的视频会跑完 3 轮、每帧落在哪全看运气：画面上表现为「画面在跳、反复从头来」，
    而且**每次录制结果都不一样**，不是可复现的确定性渲染。
    这个坑不看视频是发现不了的 —— 单抽一帧看还挺正常，只有把 3 秒一格的 6 帧并排才看得出来。
    **判据**：抽同一个页面的 6~8 帧并排，视频区域的内容是否**单调**推进；不单调就是它。
    **修法**：页面侧 `?review=1` 时不自己播（连 `autoPlay` 也要条件化），只暴露
    `window.__videoEl = el; window.__videoLocalT = t - page.start`；录制侧每帧
    `v.pause(); v.currentTime = __videoLocalT % v.duration;` 并**等 `seeked` 再截图**。
    代价：seek 让每个含视频的帧多花 ~30ms，全程从 9.2fps 掉到约 4.7fps（本项目只影响最后 21 秒）。
16. **`renderT` / 兜底钳位会把前几秒悄悄吃掉**：很多页为了「打开时别停在空白帧」写
    `t < 5.0 ? 5.0 : t`。录制时必须让 `?review=1` 走另一条分支（本项目 `isReview` 就是干这个的），
    否则片头 5 秒全被替换成第 5 秒的画面，而且**看起来像页面本身没做片头**。

## 完整方法论

`references/methodology.md` —— 逐帧法原理、音效离线合成细节、ffmpeg 来源排查、
录后清理流程的完整记录（含各步骤的实测数据）。

## 相关技能

**以下全部可选。不装任何一个，本技能的 5 个脚本照样能录任何满足「时间的纯函数」的页面。** 装了只是多一层检查或一个上游选择。

- `anchor-driven-demo-page` —— 上游：锚点驱动的单文件演示页。**录制前先跑它的 `check-timing-gaps.cjs`**
  （页内空场）与 `check-beats.cjs`（音效点是否有画面动作）；返修口径见它的 `references/acceptance.md`
- `html-deck-visual-probes` —— 版面与标注框的探针验收（框画回原图、时序空场）
- `narration-to-video-page` —— 上游：SRT + 音频 → 单文件口播演示页（含音效）；
  **录制前先跑它的 `quality_gate.py` 闸门**
- `html-presentation-autoplay` —— 演示页的零点击自动播放与启动器
- `video-frame-sharpness-forensics` —— 成片/截图「发糊」的像素级归因
