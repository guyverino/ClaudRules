---
name: tutorial-video
description: Answer a MoonTerminal user's question with a short square how-to clip for Telegram — logo + question, a cursor clicking through the UI, a highlight on the answer, captions, an end card with the path — as an mp4 ready to send. Built straight from the site's UI atlas (no screenshots needed); falls back to screenshots the developer attaches. For answering a user's question in the group ("народ, а есть автозакрытие графиков?"). Trigger on "видос для обучения", "сделай видос", "видео-ответ", "ролик по скринам", "/tutorial-video".
---

# How-to clip for a question

The developer answers questions in a Telegram group. Instead of screenshots they send a 12–20 s
square clip: the MoonTerminal logo with the question, the app screens in order, a cursor clicking
through them, the answer highlighted, one short caption per step, and a final card with the path
(`Настройки → Общие → …`). Length follows the question, never padded.

The engine is fixed and lives next to this file; per clip you write ONE `story.json` and run it.
Do not rewrite the engine per clip. If a clip needs something it cannot do, extend the engine
(and this file) once.

- `engine/scene.html` — the scene. Every style is a pure function of time in `seek(t)`; the
  timeline is compiled from the story at load.
- `engine/render.py <job> marks|proof|render` — coordinates check, proof sheet, final mp4.
- `engine/atlas.py find|make` — the fast path: story straight from the site's UI atlas.
- `engine/logo.svg` — the MoonTerminal logo of the intro card (`assets/brand/moonterminal-logo-blue-dark.svg`).

Tools on this machine: Python 3.11 with `playwright` (Chromium installed), `numpy`, `Pillow`,
`imageio_ffmpeg` (bundled ffmpeg 7.1). Nothing else is needed.

## Fast path — from the atlas (try it FIRST)

The site `D:\projects\MoonterminalWeb` is built from a UI atlas: `src/data/atlas/main.json` lists
every captured screen with its shot (`public/atlas/main/<id>.<lang>.png`, test cores, no private
data), the screen it was opened from (`opened_from`), and every control on it with its exact
rectangle, title and description in ru/en/es. The click path to any control is the
`opened_from` chain — nothing to search, nothing to measure. Do not read `main.json` by hand;
`atlas.py` does it.

1. `python <skill>/engine/atlas.py find "<2–3 key words of the question>"` — prints candidates:
   `screen/control`, the click path, the first words of the description. Words in the title rank
   first. **Pick by the path and the description, not the first line** — «автозакр» also matches
   «Автозакрепление». Nothing found → rephrase once (a synonym, the English word) → still nothing
   → the screenshots path below.
2. `python <skill>/engine/atlas.py make <screen>/<control> <job> --question "<clean question>"` —
   copies the shots of the whole path, writes `story.json` (intro, one click per screen, zoom,
   highlight, end card with the path and the first sentence of the description) and renders the
   proof sheet. A target that opens a menu or popup is clicked, and the popup it opened is shown
   and framed by its own controls. Job folder as in step 1 of the workflow below.
3. Open `<job>/_build/proof.png` ONCE. Fix `story.json` by hand only if a frame is wrong
   (a caption covering the target, a target too small), then `render.py <job> proof` again.
   **Do not research the code, do not re-measure a correct frame.** The shot is the truth for what
   the clip shows: if its text differs from the atlas title (the atlas lags the code), put the
   shot's wording in the caption and the end card and name the difference in the hand-over — the
   developer decides whether the atlas needs a new capture. Settings take effect after «Сохранить»
   (bottom of the Settings window, not in the atlas): say it in the end card's `sub`, do not measure
   the button.
4. `render.py <job> render` (foreground, ≈11 s), then steps 8–9 of the workflow below.

Know the limits and say them: the atlas shots show the TEST configuration (a checkbox may be off,
a field may read 0), and a control the atlas never captured is not there — then screenshots.

## Inputs (screenshots path)

1. **The screenshots.** Usually attached to the message — their paths are in the
   `[Image: source: …]` lines. Otherwise ask for a folder. Order = the order the user clicks.
2. **The question**, verbatim if given. A short, clean version goes on the intro card
   (`intro`) and the original into `question`.
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
7. `python <skill>/engine/render.py <job> render` — ≈11 s for a 17 s clip (8 browsers in parallel),
   so run it in the FOREGROUND; background and a notification only cost more turns.
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
  "intro": "Есть ли автозакрытие графиков?",
  "screens": ["1.png", "2.png"],
  "steps": [
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
name, defaults to the folder name), `intro` (text on the logo card; defaults to `question`; `false`
turns the card off), `size` (`[720, 720]`), `accent` (`"#ffb347"`, the app's orange), `maxZoom`
(`2`), `out` (video size in px, `480`). With the intro on, a `zoom` in the FIRST step frames the first screen as it arrives.

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
to come back to a view, list the same file again in `screens`. Captions and the end card wrap onto
lines (and shrink only if a single word is too wide); keep captions ≤ 45 characters — two lines is
the most the caption band holds.

## What a good clip looks like

- **First frame = the logo and the question.** Telegram shows the first frame as the preview.
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

`<job>\<name>.mp4` — H.264 yuv420p, 480×480 (laid out at 720, shot at `--out 480`), 30 fps with
motion blur (3 subframes), rendered by `--workers 8` browsers in parallel (58 s with 1, 17 s with 4, 11 s with 8), AAC click sounds,
`+faststart`. `<job>\<name>-silent.mp4` — the same without audio. `<job>\_build\` holds the
proof sheet and the marks; it can be deleted.
