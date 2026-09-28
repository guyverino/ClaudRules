---
name: tutorial-video
description: Turn 1–6 MoonTerminal screenshots into a short how-to clip for Telegram — a cursor that moves and clicks through the UI, a highlight on the answer, captions, an end card with the path — as an mp4 ready to send. For answering a user's question in the group ("народ, а есть автозакрытие графиков?"). Trigger on "видос для обучения", "сделай видос", "видео-ответ", "ролик по скринам", "/tutorial-video".
---

# How-to clip from screenshots

The developer answers questions in a Telegram group. Instead of sending two screenshots they send
a 8–20 s clip: the screenshots in order, a cursor clicking through them, the answer highlighted,
one short caption per step, and a final card with the path (`Настройки → Общие → …`). Length
follows the question — two screenshots make ~12–17 s, never padded.

The engine is fixed and lives next to this file; per clip you write ONE `story.json` and run it.
Do not rewrite the engine per clip. If a clip needs something it cannot do, extend the engine
(and this file) once.

- `engine/scene.html` — the scene. Every style is a pure function of time in `seek(t)`; the
  timeline is compiled from the story at load.
- `engine/render.py <job> marks|proof|render` — coordinates check, proof sheet, final mp4.

Tools on this machine: Python 3.11 with `playwright` (Chromium installed), `numpy`, `Pillow`,
`imageio_ffmpeg` (bundled ffmpeg 7.1). Nothing else is needed.

## Inputs

1. **The screenshots.** Usually attached to the message — their paths are in the
   `[Image: source: …]` lines. Otherwise ask for a folder. Order = the order the user clicks.
2. **The question**, verbatim if given. It becomes the first caption (a short, clean version) and
   is stored in `story.json` as `question`.
3. Nothing else by default. Do not ask about music, format or length — see the defaults below.

## Workflow

1. **Job folder:** `%USERPROFILE%\Videos\MoonTerminal-howto\<YYYY-MM-DD>-<slug>\`, slug = 2–3
   English words from the question (`autoclose-charts`). Copy the screenshots in as `1.png`,
   `2.png`, … — never edit the originals.
2. **Read every screenshot** (Read tool) and understand the path to the answer: what is clicked
   on each one, where the answer is on the last one. The answer must be something the screenshots
   actually show — never invent a control, a value or a menu. If the path is ambiguous (two
   plausible buttons, a step missing between screenshots), ask ONE question and stop.
3. **Measure coordinates, do not eyeball them.** Draw a grid over each screenshot with PIL
   (lines every 20 px on small images, 50 px on large, labelled, upscaled ×2–3) and read the
   target rectangles off it. All story coordinates are in ORIGINAL screenshot pixels.
4. **Write `story.json`** (format below).
5. `python <skill>/engine/render.py <job> marks` → open `_build/marks_<i>.png`. Every click cross
   must sit on its control, every highlight must wrap the whole answer row with no clipped text.
   Fix and repeat until it does.
6. `python <skill>/engine/render.py <job> proof` → open `_build/proof.png` (one frame per step,
   labelled). Check: the caption is readable and does not cover the target; the target is large
   enough to read on a phone; the cursor is on the control at the click; the end card fits.
7. `python <skill>/engine/render.py <job> render` in the BACKGROUND (≈1–3 min for 15 s), and do
   not poll — the notification arrives.
8. **Check the result**, not the log: `ffprobe`-style facts from the render line (frames, seconds,
   MB), plus 2–3 frames pulled from the mp4 at the clicks and the end
   (`ffmpeg -ss <t> -i <mp4> -frames:v 1 x.png`) and looked at.
9. **Hand it over:** open the folder with the file selected
   (`explorer /select,"<job>\<name>.mp4"`) and send the file with SendUserFile when available.
   Say in 2–3 lines: path, length, what the clip shows, and anything made up or doubtful.

## story.json

```json
{
  "name": "autoclose-charts",
  "question": "народ, а есть автозакрытие графиков?",
  "screens": ["1.png", "2.png"],
  "steps": [
    {"caption": "Есть ли автозакрытие графиков?", "hold": 1.3},
    {"caption": "Открываем «Настройки»", "click": [380, 49]},
    {"screen": 1, "zoom": [0, 0, 943, 280], "caption": "Вкладка «Общие»", "click": [716, 55]},
    {"zoom": [20, 555, 640, 100], "highlight": [28, 572, 622, 44], "hover": [41, 586],
     "caption": "Галочка «Автозакрытие графиков Main»", "hold": 1.6},
    {"highlight": [28, 621, 400, 27], "hover": [371, 634],
     "caption": "«Закрывать через» — сколько секунд ждать", "hold": 1.6},
    {"end": {"text": "Настройки → Общие → Автозакрытие графиков Main",
             "sub": "Неактивность — окно Main не в фокусе или мышь не двигается"}}
  ]
}
```

Top level: `screens` (files in the job folder, in order), `steps`, optional `name` (output file
name, defaults to the folder name), `size` (`[1280, 720]`), `accent` (`"#ffb347"`, the app's
orange), `maxZoom` (`2`).

A step may combine keys; within a step they run in this order:
`screen` → `zoom` → `caption` → `highlight` → `hover` → `click` → `hold`.

| key | value | effect |
|---|---|---|
| `screen` | index | the next screenshot grows out of the cursor position. With `zoom` in the same step, it arrives already framed |
| `zoom` | `[x,y,w,h]` or `"fit"` | camera frames that rectangle (capped at `maxZoom`) |
| `caption` | text | bottom caption; stays until the next caption or the end card |
| `highlight` | `[x,y,w,h]` | orange frame around the rectangle, everything else dimmed; stays until the next `highlight` / `zoom` / `screen` |
| `hover` | `[x,y]` | cursor moves there |
| `click` | `[x,y]` | cursor moves there and clicks: press, ring, click sound |
| `hold` | seconds | extra wait; long captions are held for reading time automatically |
| `end` | text, or `{text, sub}` | final card, `→` drawn in the accent colour. Always the last step |

Each screenshot can be entered once (a second `screen` step to the same index leaves it invisible);
to come back to a view, list the same file again in `screens`. Text too wide for the frame shrinks
to fit, but keep captions ≤ 45 characters and the end line ≤ 55 — shrunk text is hard to read on a
phone.

## What a good clip looks like

- **First frame = the question.** Telegram shows the first frame as the preview.
- **One caption per step, ≤ 45 characters,** Russian, in the app's own words: quote the control
  as it is labelled («Настройки», «Общие»), say what to do, not what the camera does.
- **Zoom so the answer is readable on a phone:** the highlighted row must end up ≥ 1.5× in the
  frame. A small first screenshot (a header strip) is already large at `fit`.
- **Click what the user clicks, hover what they read.** A checkbox that must be ON and already is
  on the screenshot gets a `hover` + `highlight`, not a click (a click would mean "turn it off").
- **The end card is the answer in one line** — the path; `sub` for the one fact that matters
  (a limit, a default, a condition), taken from the screenshot text.
- No music. A click sound on every click and a soft whoosh on every `screen` / `zoom` (the silent
  version is written too — Telegram plays a clip without an audio track as a looping GIF).

## Privacy — check before rendering

The clips go to a public group. On every screenshot look for: API keys and secrets, passwords,
balances, account and core names, server addresses, Telegram IDs. Key fields and passwords are
never shown: cover them with a patch (paint the rectangle in the surrounding background colour
with PIL in the job copy, never in the original). For balances and names, say in one line what is
visible and render as is unless the developer said otherwise.

## Output

`<job>\<name>.mp4` — H.264 yuv420p, 1280×720, 60 fps with motion blur, AAC click sounds,
`+faststart`. `<job>\<name>-silent.mp4` — the same without audio. `<job>\_build\` holds the
proof sheet and the marks; it can be deleted.
