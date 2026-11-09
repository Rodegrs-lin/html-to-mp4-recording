# 页面录制成 MP4（确定性逐帧 + 离线音效合成）

把单文件 HTML 口播页录成**可直接投稿的 MP4**（1920×1080 / 30fps / H.264 + AAC）。

> ⚠️ **动手前先做 §七「页面体检」**。录制失败最常见的报错长得很像「脚本 bug」，
> 但真相往往是**页面根本没加载成功** —— 这个伪装症状消化掉过一整轮返工。

---

## 一、为什么不用「实时录屏」

最直觉的做法是无头 Chrome 的 `Page.startScreencast` 实时抓帧，但**实测只有 ~8fps**
（6 秒抓到 49 帧，帧间隔中位数 24ms、P95 高达 274ms），而且帧率随机器负载波动。
拿来做 10 分钟成片必然卡顿掉帧，**不可交付**。

**正解 = 确定性逐帧**：页面的一切都由「时间 t」唯一决定（当前幕、字幕、页眉章徽标、
进度条）。于是对每一帧 `t = i/fps`：

1. 用注入的 `__rec.renderAt(t)` 把 DOM **手动渲染**到该时刻
2. `Page.captureScreenshot` 取图
3. 把 JPEG 推进 ffmpeg 的 stdin（`image2pipe`）

同一 t 两次截图字节一致（已实测）→ **可复现、绝不掉帧**。实测单帧 ~73ms
（1920×1080），录制速度约 **12fps**。

**本项目实测（12:03.93 成片 / 21718 帧）**：11.7–12.0 fps，**总耗时 30.3 分钟**，
0 失败帧，输出 68.2MB（1080p30 / crf18）。
⇒ 记成「**录制耗时 ≈ 成片时长 × 2.5**」最省事：10 分钟片子约 25~30 分钟。

---

## 二、关键实现要点

### 1. 视口必须用 CDP 精确锁定（否则 libx264 拒收）

`--window-size=1920,1080` 在 headless 下**含窗口边框**，截图出来是 **1904×985** ——
高度是奇数，libx264 直接报 `height not divisible by 2` 并拒绝编码。

```js
const EV = { w: VW % 2 ? VW - 1 : VW, h: VH % 2 ? VH - 1 : VH };
await send('Emulation.setDeviceMetricsOverride',
  { width: EV.w, height: EV.h, deviceScaleFactor: 1, mobile: false });
```

并在开录前**断言实际截图尺寸**（解析 JPEG 的 SOF 段读宽高），奇数就退出。

### 2. 关掉 CSS transition，改为按进度直接写内联样式

页面换幕靠 `transition: opacity .46s`。逐帧模式下如果保留 transition，
截图会抓到动画中间态（不确定）。做法：注入
`*{transition:none!important;animation:none!important}`，
然后在 `renderAt` 里**按进度算出透明度直接写内联** —— 既确定，又保留了淡入淡出的观感：

```js
const p = clamp01((t - cur.start) / TR);
const pe = 1 - Math.pow(1 - p, 3);        // 近似 CSS ease
cur.el.style.opacity = pe;                 // 当前幕淡入
prev.el.style.opacity = 1 - pe;            // 上一幕淡出
cur.el.style.transform = `translateY(${(1.2 * (1 - pe)).toFixed(3)}%)`;
```

### 3. 录屏时隐藏控制条

`.controls` 是 hover 才显示的，但页面初始状态也应显式 `display:none`，
否则偶发的 hover 状态会被录进去。

### 4. 音轨：口播用原 MP3，音效离线合成

- **口播**：直接把原 MP3 作为 ffmpeg 输入 —— 时间轴与画面同源，**天然同步**
- **音效**：页面音效是 Web Audio 实时合成的，逐帧模式下**不会发声**。
  所以在 Node 侧**按同一套参数**离线合成一条完整音效轨（WAV），再与口播混音。
  参数必须与页面 `SFX` 严格一致；改动音效时两边同步改。

音效事件表直接从页面取（`__rec.events()`），保证与画面上「真的会发生」的转场一致：
换幕（跳过封面幕）、换章、收尾。

### 5. 音效合成要复刻「指数扫频 + 指数衰减包络」

页面 `tone()` 用 `exponentialRampToValueAtTime` —— 频率与增益都是**指数**变化。
Node 侧若用线性插值会得到不同的听感。正确做法（注意相位要积分，不能直接 `sin(2πft)`）：

```js
const ratio = glideTo ? Math.log(glideTo / f) : 0;
let phase = 0;
for (let i = 0; i < n; i++) {
  const t = i / SR;
  const fr = glideTo ? f * Math.exp(ratio * (t / dur)) : f;
  phase += 2 * Math.PI * fr / SR;          // ← 相位积分
  const g = t <= tau1
    ? eps * Math.pow(vol / eps, t / tau1)  // 指数升
    : vol * Math.pow(eps / vol, (t - tau1) / (dur - tau1));  // 指数降
  buf[s0 + i] += Math.sin(phase) * g * MASTER;
}
```

### 6. ffmpeg 要显式 scale + format

pipe 进来的 JPEG 尺寸理论上已等于目标，但显式 `scale=W:H,format=yuv420p`
更稳（也顺手把 `-pix_fmt` 的 deprecated 警告消掉）：

```
[0:v]scale=W:H,format=yuv420p[v]
[1:a]aformat=channel_layouts=stereo[sp];[2:a]aformat=channel_layouts=stereo[sx];
[sp][sx]amix=inputs=2:duration=longest:normalize=0[a]
```

`-thread_queue_size 512` 避免 `Thread message queue blocking`。

---

## 三、命令

```bash
node record_page.mjs \
  --url  http://127.0.0.1:8931/index.html \
  --mp3  /path/口播.mp3 \
  --out  /path/成片.mp4 \
  --size 1920x1080 --fps 30 --crf 18
# 调试：只录一段（秒）
#   --range 100,120  → 只录 100~120s，约 1 分钟出片，用来验证管线
```

- `FFMPEG_BIN` 指定 ffmpeg；否则自动找 `imageio_ffmpeg` 的静态二进制或 PATH
- `TEMP` / `TMPDIR` 指到大盘（音效 WAV 可达 50MB，别写满 C 盘）
- 退出码：0 成功 / 1 录制或编码失败 / 2 环境错误

---

## 四、ffmpeg 从哪来（本机踩坑）

| 途径 | 结果 |
|---|---|
| PATH 里 | **没有** |
| `pip install imageio-ffmpeg`（默认源） | 卡住（下载慢） |
| 清华镜像 `pypi.tuna.tsinghua.edu.cn` | **该包不存在**（镜像不全） |
| 阿里云镜像 `mirrors.aliyun.com/pypi/simple` | ✅ 有 |
| **本机已有的 `D:/MiniMaxHub/resources/ffmpeg/ffmpeg.exe`** | ✅ **直接可用** |

**教训：装机已有软件常自带 ffmpeg，先扫一遍再下载。** 扫描命令（限深度，别全盘）：
`find /c/Program\ Files /d /e -maxdepth 4 -iname "ffmpeg.exe"`。
该二进制为 6.1.1 gyan essentials build，`libx264` + `aac` + mp3 解码齐全，够用。

（`pip install` 若走默认源卡住，换阿里云源并加 `--cache-dir` 指到大盘，别占 C 盘。）

---

## 五、验收

录完必须核这几项（用 ffmpeg 自身检查，别只看文件存在）：

```bash
# 1. 流规格：应为 1920x1080 / 30fps / h264 / aac 44100 stereo
ffmpeg -hide_banner -i out.mp4 2>&1 | grep -E "Duration|Stream"

# 2. 音轨电平：口播 + 音效混音后不应削波（max_volume 应 < -1 dB）
ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"

# 3. 抽帧核对画面（首帧 / 中段 / 尾帧）——确认幕、字幕、页眉章徽标都对
ffmpeg -y -ss 10 -i out.mp4 -frames:v 1 f2.jpg
```

**注意**：音轨若为 mono 属正常（口播源通常是单声道）。若要立体声，
**不要重录** —— 视频流直接复制、只重编音频即可（秒级）：

```bash
ffmpeg -i out.mp4 -c:v copy -c:a aac -b:a 192k -ac 2 out_stereo.mp4
```

---

## 六、流程位置

录屏是「页面定稿之后」的最后一步。前置闸门（音画同步 / 逐幕排版 / 播放可用）
**必须先全绿**，否则会把错误一起录进成片。顺序：

```
页面定稿 → quality_gate.py 三条全绿 → record_page.mjs 录 MP4 → 抽帧/电平验收 → 投稿
```

---

## 七、录制前必做：先给页面做体检（本轮最大坑，别跳过）

### 症状有多会骗人

录制脚本会抛这两种错：

```
Error: No timed scenes found
Error: Timed scenes are not hydrated yet
```

看起来 100% 是「场景采集逻辑坏了」—— 于是很自然会去改 `init()` 里收集 `.scene` 的代码。
**改了好几轮都没用，因为页面压根没加载成功。**

### 决定性判据（30 秒定位，别猜）

注入渲染器**之前**，先读页面真实状态：

```js
{ title: document.title,                       // Chrome 网络错误页 → 变主机名，如 "127.0.0.1"
  domLen: document.documentElement.outerHTML.length,   // 远小于页面体量 ⇒ 截断/错误页
  SCENES: typeof SCENES, DUR: typeof DUR }     // 页面脚本有没有跑完
```

一行跑完（本技能脚本，直接给判定）：

```bash
"$NODE" scripts/page_health.mjs "<url>"
# [PASS] 页面健康：73 幕 / DUR=723.93s / DOM 24.1MB
# [FAIL] 录制器拿到的不是正常页面 —— 先修「加载」，别改场景采集逻辑。
```

### 本项目实测到的两种「没加载」

| 现场 | 症状指纹 | 真因 |
|---|---|---|
| A | `title="Error response"`、`domLen=314` | `http.server` 用**默认 cwd** 目录跑，页面在子目录里 ⇒ 直接 **404** |
| B | `title="127.0.0.1"`、`domLen=187099`、`SCENES=undefined` | **node 拉起的 Chrome 出不了 loopback** ⇒ 拿到 Chrome 网络错误页 |

同一台机、同一时刻的对照（这是最容易误判的地方 —— **不同通道结论相反**）：

| 通道 | 结果 |
|---|---|
| PowerShell `Invoke-WebRequest` → `http://127.0.0.1:8931/index.html` | ✅ 读满 17,890,000+ 字节 |
| node 的 `fetch` → 同一 URL | ❌ `fetch failed` |
| node 拉起的 Chrome 走 http | ❌ **0 字节** |
| **同一个 Chrome 走 `file://`** | ✅ **24,142,794 字节 DOM**（JS 跑完，图已灌进各幕） |

### 解法：全内联页面直接走 `file://`

页面若把图片/音频都内联成 `data:` URI、字体只用系统字，**本就不依赖 HTTP**。
Windows 路径转 URL：

```powershell
$url = [System.Uri]::new((Join-Path $dir 'index.html')).AbsoluteUri
```

给 Chrome 加 `--allow-file-access-from-files`（`record_page.mjs` 已内置）。
`file://` 下 `localStorage` 也没炸 —— 24MB DOM 证明页面脚本从头跑到尾。

### 纪律

1. **见到「取不到幕」先跑体检**，`domLen` / `typeof SCENES` 不对就别动场景代码。
2. 用 `http.server` 必须 `--directory`（或 `-WorkingDirectory`）指到页面目录。
3. **「用 node 起服务 + 用 node 校验」是自证循环，会给假阴性** —— 换通道交叉验证
   （PowerShell / `--dump-dom` / `file://`）。
4. 懒挂载页面（空壳 `.scene` + JS 再填内容）可在注入的 `init()` 里按全局 `SCENES`
   显式回写 `data-start`/`data-end` 兜底（脚本已内置），但这**只是保险，不解决加载问题**。

---

## 八、验收补充：两项容易漏

```bash
# 4. 时长必须与页面 DUR 精确一致（本页 DUR=723.93 → 应得 00:12:03.93）
ffmpeg -hide_banner -i out.mp4 2>&1 | grep Duration
#    对不上说明帧数/起止算错，别直接交付

# 5. moov 应在文件头部（+faststart），可边下边播
ffmpeg -hide_banner -v trace -i out.mp4 2>&1 | grep -m1 "type:'moov'"
#    type:'moov' parent:'root' sz: … 且偏移很小 ⇒ 正常
```

**成片命名去掉过程痕迹**：`_重录` / `_v2` / `_final` 这类后缀不要留在交付文件名里
（用户口径：交付物要可直接发布）。文件名就是 `《片名》.mp4`。

