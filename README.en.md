# html-to-mp4-recording

**Record a time-driven presentation page into a publish-ready MP4.** Deterministic frame-by-frame capture — no dropped frames, reproducible.

[中文说明](README.md) · [License: MIT](LICENSE)

## Why not screen recording

Real-time screencast in a headless browser measured **~8fps** (median frame gap 24ms, P95 274ms), and it fluctuates with machine load. A 10-minute film will stutter. Not deliverable.

This package renders each frame deterministically instead: for every `t = i/fps`, put the page into that state → screenshot → pipe into ffmpeg. **The same `t` twice gives byte-identical screenshots**, so it is reproducible and never drops a frame.

The cost is time: ~73ms per frame at 1920×1080, about **9–12 fps effective**, so recording takes ≈ 2.5× the film length. A 10-minute film takes 20–30 minutes. **Always run it in the background.**

## Prerequisites

| Need | Notes |
|---|---|
| **Node 18+** | runs the scripts |
| **playwright-core** + a local Chrome/Edge | `npm i -D playwright-core` |
| **ffmpeg** | Check software already on the machine first — editors and AI tools often ship an `ffmpeg.exe`. Much faster than pip. |

Page-side requirement: **the page must be a pure function of time.** Given `t`, the active page, element states and progress bar are uniquely determined. CSS `animation` / `transition` for continuous motion breaks this (they run on the compositor clock and keep advancing while paused).

## Two page forms — using the wrong one errors out

| Form | Signature | Script |
|---|---|---|
| **A plain HTML** | globals `SCENES` / `DUR` / `render()` | `scripts/record_page.mjs` |
| **B Vite/React bundle** | no `SCENES`; the page exposes `window.__rec = {duration, pages, renderAt}` | `scripts/record_vite.mjs` |

Wrong choice gives `No timed scenes found` / `Timed scenes are not hydrated yet`.

**Health-check first, 30 seconds to a verdict** (always after changing machine, page or protocol):

```bash
node scripts/page_health.mjs "<url>"
# [PASS] 73 scenes / DUR=408s / DOM 24.1MB
```

## Quick start

```bash
# Form A
node scripts/record_page.mjs \
  --url http://127.0.0.1:8931/index.html \
  --mp3 narration.mp3 --out film.mp4 \
  --size 1920x1080 --fps 30 --crf 18

# Form B (Vite/React)
node scripts/record_vite.mjs \
  --url "http://127.0.0.1:8931/index.html?review=1" \
  --mp3 narration.mp3 --sfx sfx-track.mp3 --sfx-vol 0.9 \
  --out film.mp4
```

While wiring things up, use `--range 60,90` to record 30 seconds and check the pipeline in a minute before committing to the full run.

Verify the result:

```bash
node scripts/verify_mp4.mjs --mp4 film.mp4 --mp3 narration.mp3 --sfx-tl sfx-events.json --dur 407.954
```

## The audio track

| Track | Source | Why |
|---|---|---|
| Narration | the **original MP3** as an ffmpeg input | same origin as the picture → inherently in sync, no alignment work |
| SFX | **synthesised offline in Node** | in frame-by-frame mode the page's Web Audio never actually plays, so it produces no waveform |

Keep the synthesised parameters identical to the page's. Changing one means changing both.

## Sixteen traps, measured

The most valuable part of `SKILL.md` is a list of 16 traps with measured evidence, including:

- `libx264: height not divisible by 2 (1904x985)` — `--window-size` includes window chrome
- No SFX at all — Web Audio does not run under frame-by-frame capture
- A `<video>` in the page plays itself several times over — every take comes out different
- A `t < 5 ? 5.0 : t` clamp silently replaces the first five seconds
- Temp directory cannot be deleted — orphaned browser children still hold `--user-data-dir`
- Chrome launched by node cannot reach `http://127.0.0.1` at all, while `file://` renders fine — the symptom disguises itself as "cannot find scenes"

**Read that list before recording, not after a 26-minute run.**

## Verification

```bash
node scripts/verify_mp4.mjs --mp4 film.mp4 --mp3 narration.mp3 --sfx-tl sfx-events.json --dur 407.954
```

Four assertions in one pass: stream spec (1920×1080 / 30fps / h264 + aac), duration delta ≤ 0.12s, mix peak < −0.5 dB, and **SFX residual hit rate ≥ 90%**.

The last one cannot be judged by ear. Film track minus narration = SFX only; decode the whole track, cross-correlate to find the global offset, then subtract sample by sample. Pass condition: noise floor < −42 dB and ≥ 90% of events peak above floor + 10 dB. Measured: 129/129 hits, floor −64.8 dB, offset 0ms.

## Related

- **[voice-to-deck](https://github.com/Rodegrs-lin/voice-to-deck)** — upstream: builds the dynamic deck this package records (form B, `window.__rec`)
- **anchor-driven-demo-page** — high-density single-file decks (form A). Optional, not a dependency.
- **video-frame-sharpness-forensics** — pixel-level attribution when a finished film looks soft

**None of these are hard dependencies.** The five scripts record any page that is a pure function of time.

## Layout

```
html-to-mp4-recording/
├── SKILL.md                # full procedure + 16 traps
├── README.md               # 中文
├── README.en.md            # this file
├── references/methodology.md
└── scripts/
    ├── page_health.mjs     # can the recorder reach the page? run this first
    ├── record_page.mjs     # form A
    ├── record_vite.mjs     # form B
    ├── record_probe.mjs    # environment probe
    └── verify_mp4.mjs      # four-assertion delivery check
```
