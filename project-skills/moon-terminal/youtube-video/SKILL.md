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
5. A row made from a preset renames itself only when its name names a parameter (period,
   timeframe); turning parts off (POC/VAH/VAL) keeps the old name — type a name then («Голые POC»,
   video 17). A preset the Add menu does not offer is made from the nearest one this way.

Rules for the chapters (videos 12–15):
- **Rows to compare fit one frame.** The wheel zooms about ×2 per notch: a coin opens about an hour
  wide, −3 ≈ 10 h, −5 ≈ a day, −6 ≈ 2.5 days. Pick the rows' depths so the slowest fits a frame the
  fastest is still readable in (video 14: 5m/8h, 15m/16h, 30m/24h, not 1h/40h). Sloped lines are
  compared drawn «Между касаниями» (first to last touch); events need «До правого края» again.
- **Coins: the screener's calculation first** («Рассчитать» + the event filter), then the chart.
  The routine pick (Type → Futures, volume `scr-dvol` 20M as a `fill` — the field opens holding «1m»
since #1492 and a plain `type` adds to it —, `d24h` twice, Bybit `scr-mkt-1-`) is
  narrated ONCE per video in one line and its clicks run `fast` (the generator does it). An event
  filter lists only coins with that event NOW («Поджим» = pressed squeezes only) and can be empty:
  then lower the volume to 3M (1M at most), or the routine pick with more coins. Squeezes: any venue
  (`scr-mkt-`). Stock perps and tickers like SNDK are never named aloud.
- **Rows compared, then explained one by one** (video 13, 26.11): `wait_sets` with `card_px` (190 — the
  Ctrl card hangs below the pointer and the chart clips it near the bottom) chooses one line per row apart
  from the others; each row's own `wait_line` then takes `from_sets` and the same `card_px`, so the row is
  explained on the very line the comparison proved apart (MOVE's medium and slow levels were one price).
  Levels only — the scenario check refuses `from_sets` after a sloped `wait_sets`.
- **A wait on several coins** uses `next_chart` with `wheel_next` equal to the notches the scenario
  turned before it (a next coin opens at its own zoom); the price scale is reset to «Авто» on each
  next coin by the director; a geometry wait stops by itself when the coins run out.
- **Several kinds of one family (formations) are searched one kind per chapter**, the other rows
  hidden, `wait_line` with that row's title; a kind not found in the wait drops its chapter (video 18:
  channel, wedge and double top found, no flag).
- **Only the row being explained is on screen** (the developer, 22.11, video 18): before a line, a card or
  a setting is talked about, every other row is hidden by its eye (cut steps); a frame with all rows
  on is for the comparison only.
- **A settings chapter is filmed closer** (wheel about −3) than a comparison: six notches out squeezed
  a coin's price scale into a thin band and no change could be seen (video 16).
- **A change shown on screen must leave something on the chart.** Compare frames before and after
  each change; a change that left nothing is cut from the take (below), not narrated around.
- **An event on a fast row is waited WITHOUT `widen` / `touches_visible`** (video 13, 26.11): the
  widening turned the wheel twice more and set the price scale to 20/50 %, and the levels shrank into
  a band. Wheel −1 at most, the chart's end, `card_px` 190. One `pick` per event, the very coin the
  screener listed; if the filter lists nothing at 20M volume, 3M. A chapter whose second event never
  came can be split: the events as separate scenarios (`04a-approach`), takes joined in `assemble.py`.
- **A figure the narration explains is filmed big and part by part** (the developer, 26.11, video 15:
  squeezes found by widening sat in one strip, «практически в одну строчку»). Never `widen` for it:
  `wait_line` with `next_chart` and no `widen` (8 s per coin at the scenario's own view, wheel −2) and
  `band_px` 110–130 for a squeeze. Then one `spot` step per part (`level`, `slope`, `zone`, `apex`), each
  with its own line that fits the spot's `ms`: the edit draws a cyan mark on that part (`preview.py`).
- **Events only where the frame shows them**, explained by the terminal's rule (guide §10). A
  squeeze BREAKOUT cannot be filmed: the figure leaves the chart on breakout (video 15).
- Dropdowns: aim at `<id>:trigger`. Anything below a dialog's fold is unreachable. Banned names
  (reset, order, stop, close, cancel…) can be hovered with `move`, never pressed; close the
  auto-figure popup by clicking its button again, the row editor by `afe-ok`.
- `fill` changes a number field or a colour picker's hex field (six lowercase hex digits,
  `fill afe-color-pick-*:hex f5c542`) and reads it back. A colour fill ends by closing the picker
  with its trigger (that is the commit — no separate close step after it) and is judged by the
  colour the trigger shows; a value that did not land is retyped up to three times, then the take stops.
- Nothing on screen names or numbers chapters: their order in a video may change.

Rules from 22–23.11 (videos 9, 11, 12, 21, 22):
- **A video about one settings window covers EVERY field of it**, each changed with a visible
  result and put back; more than 3–5 minutes → one video per window (mini-series 11.1 «Свечи и
  трейды», 11.2 «Графика чарта», 11.3 «Объёмы», 11.4 «Подписи и раскладка»). Fields whose effect the
  frame cannot show (no orders on the coin, a mode that needs volumes off) are hovered and named,
  never narrated as if seen.
- **Clean frame, prepared off screen**: a window video runs on the studio baseline `display`
  (auto figures off), never with an on-screen step turning things off. What the voice explains must
  be in the frame: the crosshair and its captions need the `hover` step (a still pointer shows none).
- **Segment cells are not stretched over their row**: `part [i, n]` divides the row's whole rect.
  Before shooting a window, run a probe take (`move` to every control; the journal's `focus` gives
  each rect, a frame shows the cell labels) and compute the parts («Толщина контура» = `[0..2, 9]`).
  Menu item indices are found the same way (screener «Все ядра»: groups first, BB1 = 7).
- **Chapter seams go straight to the subject**: a later chapter's preparation (coin reopened,
  window opened) is `cut`, the transition line sits on the first visible step; `assemble.py` then
  cuts the empty start screen before a cut first step too.
- **`drag_set`** drags the nth chart of the active set/comparison tab (the leader pulls the others —
  video 10), same checks as `drag`, plain only. **`drag_tab`** moves a dock tab onto another by their
  drawn labels and verifies the move (video 2).
- **`drag`** pans only on pause («Live» → pause first; in Live a drag waits for a flick), and only
  on a coin with no live core orders (bot coins carry entries — use BTC by the search); press point
  in the tile middle (x 0.25–0.60, y 0.30–0.75). Ctrl drag = drawing (needs drawing mode, refuses an
  armed-alert figure on the chart).
- **Never pressed, by design**: anything named `apply` («применить к вкладкам» — hover and say it),
  a blacklist item (writes to the core — hover), a figure's alert (core command: video 20 waits for a
  decision on a core-write step).
- Voice pitfalls, all forms: «строчка» never «строка»; no plural «свечи» («свечей», «тела свечей»,
  «окно свечей и трейдов»); MoonShot → «Мун Шот», Moonbot → «Мунбот» (Cyrillic in narration); no «стоит» («держит»). No stock line repeated video
  to video («каждая монета ложится на Main…»); a sort is explained by its rule; end simply, no «Ну вот:
  … — всё в окне …».
- Screener: column menu and «Все ядра» close only by a click outside (`scr-coin`); Listed is empty for
  a minute after the cores connect; `scr-af-pct` shows a placeholder `fill` mistakes for content
  (click + type). Details: `DIRECTOR_NOTES.md`.
- **A change must differ from the current state enough to see**: set a value far from what the frame
  already shows («Ширина Fit 500» when the charts were ~480 wide showed nothing — 300 did), and a
  field that only acts together with another is shown together (layout «Рядов» needs «Точно»).
- **Check the data a window draws before filming it**: on BTC one 1.5 t$ volume bar flattened the
  whole volume band (23.11, reported); a window covering the right part hides the freshest data —
  pick a coin whose effect shows left of the window.
- Draft narration from the steps' `about` (they are written as spoken lines), then fix each line
  against the frames.
- **A click back to the starting value is silent** (23.11, 11.x): never «Вернём…», «как было»,
  «обратно». Generators use `back()` → `"quiet": true` (the line before ends there, not over the
  click) and a ~1.2 s hold; in an already-shot take mark the click `quiet` and its wait `"keep_s": 0.6`
  (assemble cuts the rest). The line before ends with a full stop, not a dangling comma.
- **A change hidden under the settings window is shown with the window closed**: pick the value,
  close the popup, hold, reopen (cut). Read in the code WHAT a field moves before filming it
  (11.3 «Подписи» moves the Cancel Buy / Panic Sell buttons, under the popup — not the scale).
- «Скрыть подписи окна» and similar: the voice reads «Окна» for «окнА» — describe, do not quote.
  No sentence opening on «Все …» («Все три отмечены» came out badly stressed) — «Три монеты отмечены».
- **A core write is undone by the very next press** (24.11): a take that armed a figure alert and
  stopped on a later step left the alert on the core while the studio forgot the figure. Arm, then
  disarm at once; hovers and the rest come after. Press the exact `al-arm-<core>-<id>`.
- **Not BTC** (the developer, 24.11): its search and charts drown in quarterly contracts. Lessons run on SOL
  (on all three studio exchanges); XRP/NEAR as extra coins.
- Menus with groups count their separators as items (`:menu:item:N`): the labels zone menu is
  0 Чарт верх · 1 Чарт низ · 2 separator · 3 Стакан верх · 4 Стакан низ (11.5 picked 3 and the module
  went to the top). Check a dropdown's frame in the first take before trusting an index; a
  checkbox's state too (the prefix tick was already off — a press turned it on).
- A tick whose effect needs data the studio does not have (order-line captions, no orders on the
  studio coins) is hovered and described, never pressed: a click that changes nothing is noise.
- This file is updated in the same turn whenever a take teaches something new (the developer,
  23.11).

## 2. Build the director when the overlay changed

Takes run on a terminal built from fresh `main` (the developer, 26.11: «скринер мог измениться» —
#1492 had just changed the screener): pull, leak-review any foreign commit first, then build.

```powershell
cargo build -p moon-ui-gpui --bin moonterminal --target x86_64-pc-windows-msvc --profile inspector --features ui-inspector
```
Copy `target\x86_64-pc-windows-msvc\inspector\moonterminal.exe` to the studio and compare the
hashes (a running studio holds the exe and the copy silently fails). A director change goes through
the targeted tests (`cargo test … -- film::`), clippy and one review agent before the takes.

## 3. Takes

Before the first take tell the developer, in the last message, to keep the LEFT part of the screen clear
and the monitor awake: the capture records the screen region, not the window, and a sleeping display
gives no frames at all. A window brought over the frame anyway holds the director's steps until it
is gone (5 min at most, then the take stops); the journal marks the stretch `covered` and the edit
cuts it (26.11: Telegram and VS Code went out in video 15 before the director watched for them).

```powershell
& 'private\film\edit\shoot.ps1' -Video <NN>-<slug> -Chapters '01-build-rows','02-…'   # in the background; not via -File
```
It runs the chapters one after another and prints `дубль снят` or why each stopped. Then per take:
`python -I private/film/edit/steps.py <take>` (step, start, length, action, mark, journal note) —
what `pick` chose, what `wait_line` / `wait_sets` found — and frames with ffmpeg at the moments that
matter (the found line, the card, before/after each change) before writing a word.

## 4. Narration, fitted

1. Write `narration.json` in the take folder: `{"<step>": "text"}`, and the same file as
   `scenarios/<NN>/<k>-<name>.narration.json`. Each line goes on the FIRST step of what it describes,
   never on the wait after it. Only what the frames show; numbers from the card, not from memory.
   A card near the plot's bottom edge is cut off: name only the fields the frame shows. A chapter
   whose market event never came (no coin had it in the wait) is dropped and said so in the hand-over.
2. A take's own `scenario.json` may be edited after the fact: `"edit": "cut"` on the steps of a
   change that left nothing, or of a routine closing click (the palette), `"edit": "fast"` on routine
   clicks. `sync.py` and `assemble.py` read the take's copy. Never cut the typing of a coin search:
   a coin appearing without it is a jump — say it («в поиске монет набираем SOL и жмём Enter») and
   trim only the load after Enter with `keep_s` (the developer, 25.11).
   A line about something the CHART draws (a label module, a line, a chart button) gets a frame
   around it like a control's: the director journals no control there, so put it by hand in the
   take's `marks.json` — `{"<step>": {"rect": [x, y, w, h], "from": "start"|"end", "until":
   "click"|"next"}}` in take pixels, measured from a frame and checked on a frame drawn with
   `preview.Overlay` — and copy it beside the scenario as `<k>-<name>.marks.json` (the developer, 25.11).
3. `python -I private/film/edit/fit_waits.py <take> <chapter.json>` lengthens the waits; reshoot
   ONLY the studio-only chapter (the one that builds rows) with the fitted waits and copy its
   narration over. Market chapters are not reshot: their lines describe what that take showed.
   Never regenerate a chapter's JSON after fit_waits: it drops the fitted waits, and a changed
   scenario shifts the step numbers the narration is keyed to — reshoot, move the lines to the new
   numbers, fit again, reshoot (video 16).
4. After the voice: `python private/film/edit/sync.py <take> …`. `assemble.py` itself starts a line
   on a pointer step 0.8 s before the press (not at the glide's start) and cuts every plain wait down
   to its line's end (keeping 0.5 s for what the action opened): a still frame with no voice is a
   pause, and the developer asked «зачем там эти 2,5 с» (26.11). What stays silent is action — glides,
   fast clicks; a silent stretch of 2 s or more still gets a short line on the first step of what
   runs there (one line per routine stretch, not a remark per click), every line is read against
   what starts under it.
5. The rules that bit (guide §10, kept there): no repeats across a chapter seam; no explaining the
   director's choices («на Байбите поджим редкий»); no narrating UI closing («палитру закроем»); no
   references back to a preset («как в готовой строчке»); UI abbreviations in words («совпадение
   таймфреймов»); «строчку», «дельта», «отодвинем»; never «уже» (the voice confuses «уже» and
   «ужЕ» — say «меньше», «теснее», «к этому моменту»). The same for «стоят» (read «стОят») and
   «стоит» (read «стОит»): «разнесены», «лежат», «находится» (video 13, 26.11). «Уровень держит»
   sounds as if the level holds something — «уровень держится». A chapter never opens by repeating
   the previous chapter's last line («найдём монету, где видны все три» → «нужна монета, где видны
   все три», video 13): read the seam, cut the second one with its wait (`"edit": "cut"`).
   One word is not repeated through a chapter's lines: «алерт» sounded in every line of the «Фигуры»
   tab (video 19, 26.11) — name it once, then «галка», «линия», «такая карточка», «её звук».
   Never list which row is which colour («треугольники — жёлтые, каналы — синие») or walk the
   pointer over the rows to say it: the colours are on screen (video 18) — cut such a hover segment.
   Say a procedure once per video, never again in each chapter («остальные строчки выключены» was
   said in three chapters of video 18): what the viewer sees needs no restating.

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
`wait_line` / `wait_sets` / `wait_for` and `cut` steps, runs `fast` at ×4 with a badge, holds frames where a line
is longer than its room, dissolves at cuts, adds the logo intro/outro and the series music, normalizes
loudness to −16 LUFS and writes `video.srt`. The music is one 2-minute bed looped under the whole
video (it audibly restarts every ~2 min); the developer keeps it — never regenerate it unless they ask.

Check before handing over: frames across the video (nothing foreign over the terminal), the cut
segments really gone, loudness (`volumedetect`).

Thumbnail, for every video: `python edit/thumb.py --title "1–3 слова" --subtitle "остальное"
--out <video folder>` → `thumb.jpg` (1280x720, ≤ 2 MB) and `thumb-telegram.png` (the preview check)
there. The style, the font and the size rule are in §8. Look at both before handing over. The channel's
watermark (the mark, bottom-right, whole video) is already set on the channel — nothing per video.

## 7. Hand over

The LAST message carries everything: the links (full paths to `video.mp4` and `video.srt`, no
upload unless they ask), what the video shows, what you decided alone, what you could not film and
why, and any question — never "see above". Push the overlay, record decisions and take folders in
memory `youtube-video-plan.md`, the developer's new notes in `youtube-video-review-rules.md` and guide §10.

## 8. YouTube: thumbnail, meta, private upload (when they say the video is ready)

Only on their word («готов для выкладки», «выкладывай»). Everything for one video lives in its
folder `<studio>\video\<NN>-<slug>\`, next to `video.mp4` / `video.srt`:

1. **Thumbnail** — `thumb.jpg`, one per video (the developer 24.11: «к каждому ролику в папку»):
   ```powershell
   Set-Location <repo>\private\film\edit
   python thumb.py --title "Экран терминала" --subtitle "режимы, шапка, ядро и панели" --out <studio>\video\<NN>-<slug>
   ```
   (no `-I`: PIL is in the user site-packages). Style chosen 24.11 by the developer (replaces the yellow
   caps «B»): his reference picture as the background (`<studio>\voice\brand\thumb-background.jpg`, its
   baked-in text removed), small logo top-left, the title **bottom-left** in **Montserrat SemiBold**
   (`<studio>\voice\brand\fonts\montserrat`, OFL), sentence case, warm white; subtitle Montserrat
   Regular; a short blue rule. **The title is 1–3 words at ONE size, 88 px** (the size «Автофигуры» got;
   the developer 24.11) — the rest of the name goes into the subtitle in small type («Скринер» + «уровни по
   всем монетам»); 4+ words are refused. A title line at the height of the play button Telegram draws
   over a link preview ends left of it (≈7 letters), lines below may be `COLUMN` wide (840 px) — so a
   two-word title sits on one line when the subtitle is one line (a 2-line subtitle lifts the title to
   the button's height), and a longer one becomes one word + subtitle («Арбитраж» + «и сравнение монеты
   на разных биржах», «Раскладка», «Рисование»). The titles of every assembled video (24.11) are in
   their folders' `thumb.jpg`; take the same wording when uploading.
   Writes `thumb.jpg` and `thumb-telegram.png` (the preview check) — look at both before uploading.
   No frame from the video, no lesson number.
2. **`meta.json`** — the README's flat format: title with the keywords («Экран терминала MoonTerminal:
   …»), description whose first lines carry the keywords, then the chapters, then «в отдельных
   роликах» pointers and the site `https://moonterminal.pro`; 20–25 tags (below), `category_id` 27,
   `default_language`/`default_audio_language` ru, `privacy` private, `made_for_kids` false.
   **Chapters** = the parts of `parts.txt` joined end to end: the intro card belongs to the first
   chapter, so it starts at `0:00`; each next one at the sum of the durations before it
   (`ffmpeg -i <part>` → Duration). At least 3, each ≥ 10 s. Names say what the chapter shows, not
   a number. Nothing in the description the video does not show.
   **Moonbot ↔ MoonTerminal link** (the developer 24.11, advice they got: «тегов больше, чтобы YouTube понимал
   связку»): the title says «… MoonTerminal для Moonbot: …»; the first line «MoonTerminal — торговый терминал
   для Moonbot: …» — no «(Мунбот, MoonBot)» asides, never «MoonBot» with a capital B (the developer 24.11:
   «не надо 500 раз повторять»); Moonbot 2–3 times in the whole description; links «Сайт MoonTerminal: https://moonterminal.pro» and «Сайт Moonbot: https://moonbot.pro и
   https://moonbot.eu» (both Moonbot sites, the developer 24.11); `#MoonTerminal #Moonbot`
   last (the first three hashtags show above the title). Tags 20–25, up to ~450 of 500 chars:
   the fixed core (MoonTerminal, Moonbot, Мунбот, Moon Bot, мун бот, MoonTerminal Moonbot,
   терминал для Moonbot, терминал для Мунбота, Moonbot терминал, Moonbot terminal, Мунбот терминал,
   Moonbot обучение, Мунбот обучение, торговый терминал, криптотерминал, торговый бот, криптобот)
   plus the video's own subject and the exchanges in frame. An `en` localization of title and
   description (Moonbot terminal in English search). Video 2's `meta.json` is the template. YouTube
   returns the OLD tags for a minute after an update — read back again before calling it failed.
3. **Upload, private** (the developer 24.11: «скрытым пока», «в черновик»):
   ```powershell
   Set-Location <repo>\private\film\youtube
   python yt.py status                      # the token must resolve to MoonTerminal UCQvRLYAOQUoxY1qqz47Awog
   python yt.py upload <folder>\video.mp4 --meta <folder>\meta.json --thumbnail <folder>\thumb.jpg --captions <folder>\video.srt --captions-lang ru
   ```
   The video id prints first; a failed thumbnail/captions step exits 2 and is redone alone
   (`yt.py thumbnail <id> thumb.jpg`, `yt.py captions upload <id> video.srt --lang ru`). Thumbnails
   need a phone-verified channel (youtube.com/verify). Right after an upload YouTube may answer 403
   «can't be set for the specified video» (still processing): retry that one alone a few minutes
   later. Thumbnails have their own rate limit (429 uploadRateLimitExceeded after ~a dozen in a day,
   24.11): never re-set a thumbnail that took, retry only the failed ones, and record each video's
   `thumbnail` state in its `youtube.json` (set | pending). Write the id into the folder as
   `youtube.json` (`{"id": …, "url": "https://youtu.be/<id>", "privacy": "private", "uploaded": <date>}`)
   and into memory `youtube-video-plan.md`; a re-cut of an uploaded video is a new upload — ask
   whether to replace (delete) the old one.
4. **Public** is their separate word: `python yt.py video publish <id>` (or `--at <ISO time>`).
   **Playlists = the SERIES.md sections, one each, no common one** (the developer 24.11): «Старт» (А)
   `PLEs0_06edco8`; «График» (Б), «Автофигуры» (В), «Поиск монет» (Г), «Стратегии и результат» (Д),
   «Торговля и удалённо» (Е) are created private (`yt.py playlist create --title … --privacy private
   --lang ru`) when their first video is uploaded, and their ids written here. Upload with
   `--playlist <id>` or `yt.py playlist add <id> <video>`. Chapters in the description are what
   YouTube turns into the clickable segments on the progress bar.

The channel is bound once by `connect.cmd` (README there); secrets live only in Windows Credential
Manager — never write the client JSON or a token into the repo, the studio or a log. The bound
channel `MoonTerminal` (UCQvRLYAOQUoxY1qqz47Awog) is the **Russian** channel. Ask before the first
English upload: English may get its own channel, and videos cannot be moved between channels
afterwards. Watermark and channel links are set by hand in Studio (the API's watermark call answers
204 and does nothing). Quota: 100 uploads/day per project.

## Gotchas

- The «Отчёт» panel is on screen in most takes: ALWAYS make its total positive (the developer, 24.11) — cut
  steps at the take's start switch its period to a green day (`rep-period:trigger` →
  `rep-period:menu:item:1` «Вчера»; other days if that one is red), and check it in the frames.
  Lessons film on studio baseline `clean` (no auto figures, arbitrage, strategy-filter captions).
- Another session's terminal window over the capture region spoils a take (24.11: a neighbour's
  `--fixture` bench opened over video 11.4 twice). Before a take, `Get-CimInstance Win32_Process
  -Filter "Name='moonterminal.exe'"`; while a take runs, ask the busy moon-terminal sessions
  (ListAgents → SendMessage) not to open terminal windows. Check every take's frames for it.
- The layout window's divider («Колонок»/«Рядов») without «Точно» is the SMALLEST count that keeps a
  chart at «Мин. высота/ширина» — on a short Main, «2» alone already splits four charts; show the
  difference with a count above what is needed (11.4: «3» gives two, «Точно» three).
- Bash heredocs with quotes break in this shell: write Python patches/scripts to files (Write
  tool) and run them.
- ffmpeg is imageio-ffmpeg's; `voice.ffmpeg()` finds it even under `python -I`.
- Deleting inside `<studio>\video\` is blocked by a hook; outputs are overwritten anyway.
- `git gc`/maintenance is off in moon-terminal (it ate 15 GB after a fetch).
- Costs: about 3 000–5 300 chars of voice per 5–8-minute video; music and card sounds are cached.
