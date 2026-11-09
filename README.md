# html-to-mp4-recording

> 把一个「按时间 t 渲染」的演示网页，录成可以直接投稿的 MP4。**逐帧渲染，不掉帧、可复现。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 为什么不用录屏软件

实时录屏在无头浏览器里实测只有 **~8fps**（帧间隔中位数 24ms，P95 高达 274ms），而且随机器负载波动。10 分钟的片子必然卡顿掉帧，不可交付。

这里改用**确定性逐帧**：对每一帧 `t = i/fps`，让页面渲染到那个时刻 → 截图 → 推给 ffmpeg。同一个 `t` 两次截图**字节一致**，所以可复现、绝不掉帧。

代价是慢：单帧约 73ms（1920×1080），约 **9–12 fps 出片**，录制耗时 ≈ 成片时长 × 2.5。10 分钟的片子要录 20–30 分钟，**务必后台跑**。

## 前置条件（三个，缺一不可）

| 依赖 | 说明 |
|---|---|
| **Node 18+** | 跑脚本 |
| **playwright-core** + 本机 Chrome/Edge | 驱动浏览器。`npm i -D playwright-core`，或指向已有的全局安装 |
| **ffmpeg** | 编码。**先扫一遍装机软件自带的**，很多软件（剪辑、AI 工具）目录里就有 `ffmpeg.exe`，比 pip 下载快得多 |

页面侧还有一条硬要求：**页面必须是时间的纯函数** —— 给定 `t`，当前页、元素状态、进度条都唯一确定。用 CSS `animation` / `transition` 驱动的连续运动不满足这条（它们走合成器墙钟，暂停后还在动）。

## 两种页面形态，用错就报错

| 形态 | 特征 | 用哪个脚本 |
|---|---|---|
| **A 裸 HTML** | 全局有 `SCENES` / `DUR` / `render()` | `scripts/record_page.mjs` |
| **B Vite/React 打包页** | 已 bundle，没有 `SCENES`，页自己挂了 `window.__rec = {duration, pages, renderAt}` | `scripts/record_vite.mjs` |

用错了会报 `No timed scenes found` / `Timed scenes are not hydrated yet`。

**先跑体检，30 秒出结论**（换机器 / 换页面 / 换协议时必跑）：

```bash
node scripts/page_health.mjs "<url>"
# [PASS] 73 幕 / DUR=408s / DOM 24.1MB
```

## 快速开始

```bash
# 形态 A
node scripts/record_page.mjs \
  --url http://127.0.0.1:8931/index.html \
  --mp3 口播.mp3 --out 成片.mp4 \
  --size 1920x1080 --fps 30 --crf 18

# 形态 B（Vite/React）
node scripts/record_vite.mjs \
  --url "http://127.0.0.1:8931/index.html?review=1" \
  --mp3 口播.mp3 --sfx 音效轨.mp3 --sfx-vol 0.9 \
  --out 成片.mp4
```

调试时用 `--range 60,90` 只录 30 秒，一分钟出结果，先验证管线再录全长。

录完验收（规格 / 时长 / 削波 / 音效是否真在）：

```bash
node scripts/verify_mp4.mjs --mp4 成片.mp4 --mp3 口播.mp3 --sfx-tl 音效事件表.json --dur 407.954
```

## 它和同族 skill 的关系

```
口播音频 + SRT + 素材
   ↓  voice-to-deck        （出动态网页，双档时钟）
   ↓  audit-motion         （录前体检：页尾别死、每拍真在动）
   ↓  html-to-mp4-recording（本包，导出 MP4）
```

上游那个在 [github.com/Rodegrs-lin/voice-to-deck](https://github.com/Rodegrs-lin/voice-to-deck)。

- **上游 [`voice-to-deck`](https://github.com/Rodegrs-lin/voice-to-deck)** —— 本包认它产的页面（形态 B，`window.__rec`）
- **可选 `anchor-driven-demo-page`** —— 高密度单文件演示页（形态 A）；装了可以用它的 `check-timing-gaps` / `check-motion-coverage` 做录前检查
- **可选 `video-frame-sharpness-forensics`** —— 成片「看起来糊」时做像素级归因，别瞎调参数

**这些都不是硬依赖。** 没有它们，本包照样能录任何满足「时间纯函数」的页面。

## 最值钱的部分：16 个坑

`SKILL.md` 末尾有 16 条实测踩坑记录，包括：

- `libx264 报 height not divisible by 2 (1904x985)` —— 窗口边框让截图尺寸变奇数
- 音效完全没有 —— 逐帧模式下页面 Web Audio 不发声，必须离线合成
- 页面里的 `<video>` 自己跑完好几轮 —— 每次录制结果都不一样
- `t < 5 ? 5.0 : t` 这种「防首帧空白」的兜底，会把片头 5 秒悄悄换掉
- 录完临时目录删不掉 —— 残留的浏览器子进程锁着 `--user-data-dir`
- Node 拉起的 Chrome 走 `http://127.0.0.1` 完全不通，但 `file://` 能渲染 —— 症状伪装成「取不到幕」

**录之前先扫一遍这张表，比录完 26 分钟再抽帧划算得多。**

## 验收

```bash
node scripts/verify_mp4.mjs --mp4 成片.mp4 --mp3 口播.mp3 --sfx-tl 音效事件表.json --dur 407.954
```

一次判四项：规格（1920×1080 / 30fps / h264 + aac）、时长差 ≤ 0.12s、混音峰值 < −0.5dB、**音效残差命中的事件占比 ≥ 90%**。

音效那项不能靠听：成片音轨 − 口播原声 = 只剩音效，按整轨解码后互相关求偏移再逐样本相减。判据是「底噪 < −42dB 且峰值 > 底噪 + 10dB 的事件 ≥ 90%」，实测 129/129 命中、底噪 −64.8dB、偏移 0ms。

## 文件结构

```
html-to-mp4-recording/
├── SKILL.md                    # 完整规程：形态判断、逐帧法、音轨策略、16 个坑
├── README.md                   # 本文件
├── LICENSE                     # MIT
├── references/
│   └── methodology.md          # 逐帧法原理、音效离线合成、ffmpeg 排查的完整记录
└── scripts/
    ├── page_health.mjs         # 页面体检：录制器能不能拿到页面（先跑这个）
    ├── record_page.mjs         # 形态 A 录制器
    ├── record_vite.mjs         # 形态 B 录制器（认 window.__rec）
    ├── record_probe.mjs        # 环境探针：实测帧率 + setTime 能否定位
    └── verify_mp4.mjs          # 成片验收：规格 + 时长 + 削波 + 音效命中率
```

## 安全边界

- 不改你的源页面、源音频、源字幕。录制只读取。
- 不调用任何云端服务，全部在本机完成。
- 不做 TTS、不做图像生成、不写 API Key。
- 中途的探针件、失败件收进 `_trash/`，交付文件名就是《片名》.mp4，不带 `_v2` / `_final`。
