---
name: youtube-video
description: Make a full MoonTerminal tutorial video for YouTube from the developer's rough idea — no plan stop: live takes on the studio cores, narration written to the takes, ElevenLabs voice, and the final 1920x1080 cut with logo intro, music, dissolves and SRT, handed over for their review. Trigger on "ролик для ютуба", "сделай ролик про …", "снимем ролик", "следующий ролик серии", "/youtube-video".
---

# YouTube tutorial video

The developer writes a few lines about what the video should show. You make the whole video right away
and hand it over; they watch it and say what to redo (their decision 22.11: «не спрашивать, а делать
сразу — мне нужно увидеть, чтобы понять»). No plan stop: ask only what the brief itself demands
(e.g. whether a line kind's formulas were checked), and name the decisions you took alone in the
hand-over.

Everything lives in the private overlay (`private/`, its own git) and in the studio
`<studio>` (the `moonfilm` folder beside the repo checkout; `shoot.ps1` names it). The overlay has no PR and no CI: commit your own
files by name and push them to its `main` as part of the task (memory `overlay-commit-means-push`).

## Read first (do not re-research what these already say)

- `private/film/DIRECTOR_NOTES.md` — control names, banned substrings, what the director can and
  cannot reach (no scrolling inside dialogs), the studio reset before every take, the wheel scale.
- `private/film/SCENARIO_GUIDE.md` — how a scenario and its narration are written: a lesson, not a
  tour; clicks are not narrated; 14 chars/s; filler words; intros (check `private/film/INTROS.md`).
  §10 is the developer's binding list of review notes — read it before writing any line.
- `private/film/SERIES.md` — the series table of contents.
- Memory `youtube-video-plan.md` (every decision of the series) and `youtube-video-review-rules.md`.
- Facts about the terminal: ONLY the site FAQ (`<site>\src\data\faq\ru.json`, the site checkout)
  and the locale files (`locales/ru/*.yml`). What the screen shows in a take beats the FAQ when
  they differ (e.g. pivot 2/1 on screen vs "3 and 3" in the FAQ): then say it without numbers.

## 1. Brief → baselines → scenarios (no plan stop)

1. A video about one kind of auto line is shot only after that kind's formulas were checked
   (SERIES, section В). If the 21.11 audit (`docs-internal/auto-figures-audit/REPORT.md`) did not
   run it, say so and hand the developer a ready prompt for a checking session; they decide.
2. Ask through ONE AskUserQuestion window only what the brief and the code cannot settle.
3. Studio baselines: the video's own `cfg.baseline.<name>-empty` (no rows, for the chapter that
   builds the rows on screen) and `cfg.baseline.<name>` (the same rows ready, for the rest), made
   by copying `cfg.baseline.levels` and replacing its `[auto_figures]` block. The rows must be
   exactly what chapter 1 builds on screen.
4. Scenarios as generators (`scenarios/<NN>-<slug>/01-build-rows.gen.py`, `chapters.gen.py`): copy
   the last video's and change what differs. Control names only from the atlas
   (`private/harvest/out/scenes-controls.json`), `DIRECTOR_NOTES.md`, or the editor's code
   (`panels/auto_figure_edit/fields.rs` → `afe-num-<Field>`); a control the atlas lacks is proved
   by the first take.

Rules for the chapters (videos 12–15):
- **Rows to compare fit one frame.** The wheel zooms about ×2 per notch: a coin opens about an hour
  wide, −3 ≈ 10 h, −5 ≈ a day, −6 ≈ 2.5 days. Pick the rows' depths so the slowest fits a frame the
  fastest is still readable in (video 14: 5m/8h, 15m/16h, 30m/24h, not 1h/40h). Sloped lines are
  compared drawn «Между касаниями» (first to last touch); events need «До правого края» again.
- **Coins: the screener's calculation first** («Рассчитать» + the event filter), then the chart.
  The routine pick (Type → Futures, volume `scr-dvol` 20M, `d24h` twice, Bybit `scr-mkt-1-`) is
  narrated ONCE per video in one line and its clicks run `fast` (the generator does it). An event
  filter lists only coins with that event NOW («Поджим» = pressed squeezes only) and can be empty:
  then lower the volume to 3M (1M at most), or the routine pick with more coins. Squeezes: any venue
  (`scr-mkt-`). Stock perps and tickers like SNDK are never named aloud.
- **A wait on several coins** uses `next_chart` with `wheel_next` equal to the notches the scenario
  turned before it (a next coin opens at its own zoom); the price scale is reset to «Авто» on each
  next coin by the director; a geometry wait stops by itself when the coins run out.
- **A change shown on screen must leave something on the chart.** Compare frames before and after
  each change; a change that left nothing is cut from the take (below), not narrated around.
- **Events only where the frame shows them**, explained by the terminal's rule (guide §10). A
  squeeze BREAKOUT cannot be filmed: the figure leaves the chart on breakout (video 15).
- Dropdowns: aim at `<id>:trigger`. Anything below a dialog's fold is unreachable. Banned names
  (reset, order, stop, close, cancel…) can be hovered with `move`, never pressed; close the
  auto-figure popup by clicking its button again, the row editor by `afe-ok`.
- `fill` changes a number field or a colour picker's hex field (six lowercase hex digits,
  `fill afe-color-pick-*:hex f5c542`), reads it back, and for a colour also reads the picker's
  trigger; a value that did not land is retyped up to three times, then the take stops.
- Nothing on screen names or numbers chapters: their order in a video may change.

## 2. Build the director when the overlay changed

```powershell
cargo build -p moon-ui-gpui --bin moonterminal --target x86_64-pc-windows-msvc --profile inspector --features ui-inspector
```
Copy `target\x86_64-pc-windows-msvc\inspector\moonterminal.exe` to the studio and compare the
hashes (a running studio holds the exe and the copy silently fails). A director change goes through
the targeted tests (`cargo test … -- film::`), clippy and one review agent before the takes.

## 3. Takes

Before the first take tell the developer, in the last message, to keep the LEFT part of the screen clear
and the monitor awake: the capture records the screen region, not the window (a VS Code window over
it spoiled a take), and a sleeping display gives no frames at all.

```powershell
powershell -File private\film\edit\shoot.ps1 -Video <NN>-<slug> -Chapters 01-build-rows,02-…   # in the background
```
It runs the chapters one after another and prints `дубль снят` or why each stopped. Then per take:
`python -I private/film/edit/steps.py <take>` (step, start, length, action, mark, journal note) —
what `pick` chose, what `wait_line` / `wait_sets` found — and frames with ffmpeg at the moments that
matter (the found line, the card, before/after each change) before writing a word.

## 4. Narration, fitted

1. Write `narration.json` in the take folder: `{"<step>": "text"}`, and the same file as
   `scenarios/<NN>/<k>-<name>.narration.json`. Each line goes on the FIRST step of what it describes,
   never on the wait after it. Only what the frames show; numbers from the card, not from memory.
2. A take's own `scenario.json` may be edited after the fact: `"edit": "cut"` on the steps of a
   change that left nothing, or of a routine closing click (the palette), `"edit": "fast"` on routine
   clicks. `sync.py` and `assemble.py` read the take's copy.
3. `python -I private/film/edit/fit_waits.py <take> <chapter.json>` lengthens the waits; reshoot
   ONLY the studio-only chapter (the one that builds rows) with the fitted waits and copy its
   narration over. Market chapters are not reshot: their lines describe what that take showed.
4. After the voice: `python private/film/edit/sync.py <take> …`. Every silence of 2.5 s or more gets
   a short line on the first step of what runs there (one line per routine stretch, not a remark per
   click), every line is read against what starts under it.
5. The rules that bit (guide §10, kept there): no repeats across a chapter seam; no explaining the
   director's choices («на Байбите поджим редкий»); no narrating UI closing («палитру закроем»); no
   references back to a preset («как в готовой строчке»); UI abbreviations in words («совпадение
   таймфреймов»); «строчку», «дельта», «отодвинем».

## 5. Voice

`python -I private/film/edit/voice.py full <take> <take> …` — Egor T, eleven_v4, cached per line
(only new or edited lines cost). The server sometimes drops the connection (`RemoteDisconnected`):
run it in a loop of up to three tries; the cache keeps what was voiced. The key is read from the
registry, never printed.

## 6. Assemble

```powershell
Set-Location <studio>\film
python <repo>\private\film\edit\assemble.py <take1> <take2> … --out <studio>\video\<NN>-<slug> --title "<video title>"
```
(no `-I`: PIL and PyAV are in the user site-packages). ~0.4x the video's length. It cuts
`wait_line` / `wait_sets` and `cut` steps, runs `fast` at ×4 with a badge, holds frames where a line
is longer than its room, dissolves at cuts, adds the logo intro/outro and the series music, normalizes
loudness to −16 LUFS and writes `video.srt`. The music is one 2-minute bed looped under the whole
video (it audibly restarts every ~2 min); the developer keeps it — never regenerate it unless they ask.

Check before handing over: frames across the video (nothing foreign over the terminal), the cut
segments really gone, loudness (`volumedetect`).

## 7. Hand over

The LAST message carries everything: the links (full paths to `video.mp4` and `video.srt`, no
upload unless they ask), what the video shows, what you decided alone, what you could not film and
why, and any question — never "see above". Push the overlay, record decisions and take folders in
memory `youtube-video-plan.md`, the developer's new notes in `youtube-video-review-rules.md` and guide §10.

## Gotchas

- Bash heredocs with quotes break in this shell: write Python patches/scripts to files (Write
  tool) and run them.
- ffmpeg is imageio-ffmpeg's; `voice.ffmpeg()` finds it even under `python -I`.
- Deleting inside `<studio>\video\` is blocked by a hook; outputs are overwritten anyway.
- `git gc`/maintenance is off in moon-terminal (it ate 15 GB after a fetch).
- Costs: about 3 000–5 300 chars of voice per 5–8-minute video; music and card sounds are cached.
