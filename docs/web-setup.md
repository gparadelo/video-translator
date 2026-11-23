# Web app setup

The web app has three parts: the site in [web/](../web) (Next.js, on Vercel), a Supabase project (login and
database), and a Cloudflare R2 bucket (the videos). Everything happens in the web app and the person's browser
(desktop Chrome or Edge): the browser checks and measures each new video, the app's routes transcribe it,
translate and voice it with the person's own ElevenLabs and Claude keys, and the browser drives them, builds the
voice track and renders the videos.

Coming from a setup that still runs the worker on a Mac: see [Upgrading from the worker setup](#upgrading-from-the-worker-setup).

## 1. Supabase
1. Create a project at supabase.com (the free plan is enough).
2. **Database:** open SQL Editor and run each file in [supabase/migrations/](../supabase/migrations), oldest
   first: paste all of it, run, then the next one.
3. **Login links:** Authentication -> URL Configuration. Set Site URL to the app's address, and add
   `http://localhost:3000/auth/confirm` and `https://YOUR-APP/auth/confirm` to Redirect URLs.
4. **People:** Authentication -> Users -> Add user, once per person (their email). The login page only
   signs in people who already exist; it never creates accounts.
5. **Approve them:** Table Editor -> `profiles` -> set `approved` to true for each person. Without it they
   can sign in but not create jobs.
6. **Keys:** Project Settings -> API. The project URL and the publishable key go in the web app's
   settings (below). Nothing needs the secret (service role) key: never put it in the web app.

A free project pauses after about a week without any activity; un-pause it in the Supabase dashboard when that
happens.

## 2. Cloudflare R2
1. Create a bucket, e.g. `video-translator`.
2. **Browser access:** bucket -> Settings -> CORS policy:
   ```json
   [{
     "AllowedOrigins": ["http://localhost:3000", "https://YOUR-APP"],
     "AllowedMethods": ["PUT", "GET", "HEAD"],
     "AllowedHeaders": ["content-type", "range"],
     "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
     "MaxAgeSeconds": 3600
   }]
   ```
   The browser reads the uploaded video in pieces to render it (`range`, `Content-Range`), and uploads what it
   makes (`PUT`): the voiceover's sound and the video's measurements while preparing it, and the previews.
3. **Auto-delete:** bucket -> Settings -> Object lifecycle rules -> delete objects 30 days after they were
   uploaded. The uploaded videos are the big files (up to several GB in 4K); each language adds about 10 MB
   per minute of video (its voice track) and its preview.
4. **Keys:** R2 -> Manage API tokens -> create one with Object Read & Write on this bucket only. You get an
   access key ID and a secret; the account ID is on the R2 overview page.

## 2b. Everyone's own API keys
Each person enters their own ElevenLabs API key, Claude API key and ElevenLabs voice ID on the app's
**Settings** page. Their videos are transcribed, translated and spoken in their voice and billed to their
accounts, and title translations use their Claude key. Until they have, the app asks them to and won't start a
project (or a translation). You do the same for your own account.

The keys are checked when saved, then encrypted (AES-256-GCM) before they go into the database (table
`user_secrets`, which people can't read). Settings only ever shows a key's last 4 characters. The encryption
key is `SECRETS_KEY`: create one with `openssl rand -base64 32` and set the same value in `web/.env.local`,
in Vercel (Settings -> Environment Variables, never with `NEXT_PUBLIC_`). Keep it
secret. If you change it, every saved key stops working and everyone has to save theirs again.

## 3. Run the site
```
cd web
cp .env.example .env.local     # fill in the values from steps 1, 2 and 2b
pnpm install
pnpm dev                       # http://localhost:3000
```
To put it online: import the repository in Vercel, set Root Directory to `web`, and add the same settings
as environment variables. Keep **Fluid compute** on (Settings -> Functions; it is on for new projects): the
translation route waits for Claude, and the transcription and alignment routes for ElevenLabs, which for a long
script or video can take a few minutes; they ask for up to 300 seconds (`maxDuration`). Without Fluid compute the
Hobby plan stops every function after 60 seconds, and a long one would fail with "the server answered 504" after
its tries.

## 4. Preparing a video (the job page)
A new video is prepared in the person's browser and short routes of the web app
(`app/api/jobs/<id>/prepare/...`, [web/lib/prepare](../web/lib/prepare)).
**Browsers:** desktop Chrome and Edge (Windows or Mac). Other browsers are told so when they pick a video; phones
and tablets are told it works best on a computer.

1. **Checks, as soon as a video is picked** (`lib/prepare/checks.ts`, before anything is uploaded). The file's index
   is read (Mediabunny) and WebCodecs is asked whether this browser decodes its picture and its sound. Refused,
   each with what to do instead: a file that isn't a video, no picture, a picture or sound codec this browser can't
   decode (e.g. MPEG-4 Part 2, ProRes, AC-3), **HDR** (PQ or HLG, e.g. an iPhone's default) and wide colour
   (BT.2020), no sound track, shorter than 1 second or longer than 10 minutes, bigger than 8K or smaller than 64
   pixels, more than 120 frames a second. HDR is refused rather than converted: the browser can only make the
   translated videos in SDR, and its canvas turns HDR into flat, wrong colours without tone mapping; the message
   says how to export SDR (or share an iPhone video as "Most Compatible"). Accepted with a note: a rotated phone
   video (shown upright), a variable frame rate (the translations are made at a steady rate: ffprobe's
   `r_frame_rate`), an odd size.
2. **Upload and measure at once.** The project's page uploads the video straight to R2, and meanwhile reads it in
   the browser (`lib/prepare/local.ts`, decoded with WebCodecs):
   - its length and frame rate as ffprobe reports them, and the size it's shown at (`probe.ts`, `timing.ts`);
   - the loudness of its sound, as `ffmpeg -af ebur128` measures it (`LoudnessMeter`);
   - the voiceover for speech-to-text, as `ffmpeg -vn -ac 1 -c:a aac -b:a 128k` makes it: mono (stereo mixed down
     as ffmpeg does), AAC 128 kb/s in MP4, or WAV in a browser without an AAC encoder;
   - the cuts: ffmpeg's scene score ported (below), in a few Web Workers. On a recent Mac in Chrome, two minutes
     of 1080p take about 7 seconds, two minutes of 4K about 20 (`pnpm e2e --bench`), while the upload runs.
   If the tab doesn't have the file any more (closed and opened again), it reads the upload back from R2.
3. **The routes**, each one paid call at most, each saving its result in R2 before answering (`prep/` below):
   `media` (signed upload links for the voiceover and `prep/media.json`, then checks what arrived), `transcribe`
   (ElevenLabs speech-to-text, `scribe_v2`, word timestamps; the route reads the voiceover from R2, it's never
   sent through the app), `names` (Claude checks the spelling of names, with the project's "Names in the video" as
   the reference), `align` (ElevenLabs forced alignment of the checked transcript, then the analysis:
   `analysis.json`, below). Then the transcript is ready for review (`save_prepared`). The names are checked
   before the alignment, so a name fix costs no second alignment.
4. **An edited transcript** is timed again when it's approved (`aligning`, the `align` route again): if the edits
   made the transcript stop matching the voiceover (the analysis warns where it didn't before), the project goes
   back to the review with the reason (`save_aligned`); otherwise the job page starts translating.

As for translating: the page keeps the screen awake and asks before the tab closes; a closed tab carries on from
what's saved, nothing is paid twice; one browser prepares a project at a time (`hold_prepare`, `jobs.runner`,
renewed every 20 s; the routes answer only the holder; another device takes over a minute after the first stops);
passing problems are tried again with growing pauses, and a problem the person has to fix (a key, no credits, no
speech in the video) fails the project with the reason (`fail_prepare`); **Try again** (`retry_job`) carries on
from what was made. What each call cost goes to `usage_events`: `elevenlabs_stt` and `elevenlabs_alignment` with
the video's `seconds`, `claude` with tokens.

## 5. Translating and voicing (the job page)
Once a transcript is approved, the job page makes every language itself, with the person's own keys, through
short routes of the web app (`app/api/jobs/<id>/produce/<lang>/...`, [web/lib/produce](../web/lib/produce)):
Claude translates (and is asked again when markers got lost), ElevenLabs voices each beat, the timing plan is
made from the recorded beats, and Claude rewrites the beats that don't fit (up to 3 rounds). Then the language is
`voiced`, and the page builds its voice track and renders it.
- **The tab has to stay open** while a language is made (a few minutes): the page keeps the screen awake and asks
  before closing. If it's closed anyway, nothing is lost: every step is saved in R2, and the next time the page
  is opened it carries on from the first missing piece. Beats already voiced, and the translation, are reused,
  so nothing is paid twice.
- **One browser makes a language at a time.** The page holds the run in the database (`hold_run`, renewed every
  20 s, `job_outputs.runner`), and the produce routes answer only that browser, so opening the project on a
  second device doesn't pay twice: it says "Being made on another device or browser" and takes over about a
  minute after the first one stops (closed, asleep). Inside one browser, one tab at a time (Web Locks).
- Offline (wifi gone, laptop asleep), the page waits for the connection without using up its tries.
- ElevenLabs or Claude being busy, a dropped connection or a function that ran out of time are tried again with
  growing pauses (the page says "Trying again in 10 s"). A problem the person has to fix (a key without the
  Text to Speech permission, a rejected key, no credits left, a voice that isn't in the account) stops the
  language with the reason; **Try again** starts a new run that reuses everything already made.
- Each language keeps the voice it had when the project's first run started (`jobs.voices`, pinned for all of
  the project's languages then): retries and new translations of it use that voice. Changing the voice in
  Settings applies to new projects, and to languages added to a project later.
- One language failing doesn't stop the others. The project is done when every language is voiced or failed
  (failed when all of them failed).
- At most 2 beats are voiced at a time (ElevenLabs' cheaper plans allow 2-3 requests at once) and 2 Claude calls,
  over all languages in the tab.
- What each call cost is recorded in `usage_events`: `claude` (tokens), `elevenlabs_tts` (characters), and, while
  preparing, `elevenlabs_stt` and `elevenlabs_alignment` (the video's seconds). The route writes it with the
  person's own session (`log_usage`): it's informational, since everyone pays with their own keys. `log_usage` only
  takes the person's own projects, these four services, each with its own amounts (`model`, `input_tokens`,
  `output_tokens`; `characters`; `seconds`), whole token and character counts below 10 million, seconds below a
  day.
- A function that runs out of time after Claude or ElevenLabs answered but before the answer was saved (rare:
  translate, transcribe, names and align allow 300 s, tts 60 s) is tried again, and that call is paid twice.
- The analysis, like every file, is deleted from R2 after 30 days: after that a project can't get new
  languages; upload the video again as a new project.

## Upgrading from the worker setup
This is the path from `main` as it was with the worker on a Mac (migrations up to `20261122000000_user_keys.sql`,
per-person keys already working) to the web app alone. It takes the five pull requests of the browser pipeline,
#2 to #6, in one go. Pick a quiet moment: the site may show errors for the few minutes between the migrations and
the last deploy.

> **Stop the worker and remove its service before you merge #6.** #6 deletes `worker/install-service.sh`, the
> script that removes the launchd service. Run `worker/install-service.sh remove` on the Mac first (step 1), from a
> checkout that still has it.

1. **Stop the worker for good.** Wait until no project is "Transcribing", "Translating" or "Rendering" on the
   worker, then on the Mac, in the repository: `worker/install-service.sh remove` (or Ctrl-C if it runs in a
   terminal). Check it's gone: `launchctl list | grep videotranslator` prints nothing. (Already merged and pulled?
   The same by hand: `launchctl bootout gui/$(id -u)/com.videotranslator.worker` and
   `rm ~/Library/LaunchAgents/com.videotranslator.worker.plist`.)
2. **R2 CORS:** replace the bucket's CORS policy with the one in step 2 above (it adds the `range` header and the
   exposed headers the browser needs to read the video in pieces).
3. **Vercel:** make sure Fluid compute is on (Settings -> Functions; step 3 above). `SECRETS_KEY` stays as it is.
4. **Database:** in the Supabase SQL Editor, run these, in this order, each in full:
   1. `supabase/migrations/20261123000000_browser_render.sql` (#2)
   2. `supabase/migrations/20261124000000_browser_plan.sql` (#3)
   3. `supabase/migrations/20261125000000_browser_produce.sql` (#4)
   4. `supabase/migrations/20261126000000_browser_prepare.sql` (#5)
   5. `supabase/migrations/20261127000000_remove_worker.sql` (#6)
5. **Merge and deploy,** straight after: merge #2 into `main`, then #3, #4, #5 and #6, each into `main` once the
   one before is merged (GitHub moves the next one's base to `main` when the branch below it is deleted; otherwise
   change it by hand). Vercel deploys each merge; the last one, with #6, is the one that has to be live. Check it
   in Vercel's Deployments, then open the site and a project.
6. **Clean up the Mac and the keys:** delete `worker/.env` from the Mac (or the whole checkout), and the Supabase
   secret (service role) key from anywhere it was kept; nothing uses it any more, and you can roll it in
   Supabase (Project Settings -> API) to be sure.

What happens to projects that were in the middle of something: a video waiting to be transcribed is prepared the
next time its page is opened; an approved transcript is timed there; a language the worker was translating is
made by the job page, reusing what the worker voiced. A project the worker prepared is timed with its own
`analysis.json`; only its voiceover is read again from the uploaded video, so that works while the video is
still in R2 (30 days). Videos the worker rendered still play and download until R2 deletes them.

**30 days later** (after 2026-12-23, if this was deployed on 2026-11-23): no project from the worker is left in
R2, and the code and columns kept for them can go in a new change: `job_outputs.output_key` and `output_bytes`,
the `done` status of an output, the full-size download of `GET /api/jobs/<id>/files/<lang>`, and the
`from: "analysis"` path of `mediaStep` (`lib/prepare/steps.ts`, `Media.from`). Each is marked "remove after
2026-12-23".

## How a video moves through it
1. `POST /api/jobs` creates the job and returns a signed link; the project's page uploads the video straight to
   R2 and, meanwhile, measures it in the browser (section 4).
2. `POST /api/jobs/<id>/submit` checks the upload arrived; the job is `preparing` (`submit_job`).
3. The job page prepares it (section 4): `hold_prepare`, then `POST /api/jobs/<id>/prepare/media`, `.../transcribe`,
   `.../names` and `.../align`, which writes `analysis.json` and calls `save_prepared`: the job is `needs_review`.
   The person reviews it and approves (`approve_job`), which asks for each language (a `pending` row). An
   unchanged transcript goes straight to `producing`; an edited one is timed again on the job page first
   (`aligning`, `.../align`, `save_aligned`) and then goes to `producing`, or back to `needs_review` with the reason.
4. The job page makes each language (section 5): `start_run` starts a run (a new generation; it checks the
   person's keys and voice with `missing_setup` and pins the voices), then the page calls
   `POST /api/jobs/<id>/produce/<lang>/translate`, `.../tts` (once per beat) and `.../fit` until the fit route has
   written the plan inputs (below) and marked the language `voiced` (`mark_voiced`). A problem that needs the
   person ends the run with `fail_run`. When the last language of the project settles, the project is `done`.
5. On the job page the browser builds the timing plan and the voice track from them
   ([web/lib/pipeline](../web/lib/pipeline)) with the links from `GET /api/jobs/<id>/plan/<lang>`, uploads both
   (`POST /api/jobs/<id>/plan/<lang>`, which checks them, reads the plan and calls `save_plan`); the language is
   then `ready`. This starts by itself whenever the page is open and takes a few seconds; if the tab is closed
   part way, it starts again the next time the page is opened. A failure shows its reason and Try again.
6. The browser renders it ([web/lib/render](../web/lib/render)), with the links from
   `GET /api/jobs/<id>/render/<lang>`: first a 720p preview, uploaded with `POST /api/jobs/<id>/preview/<lang>`
   so it plays on the page (`GET /api/jobs/<id>/files/<lang>?kind=preview`); then, on Download, the chosen
   quality (Original, 1080p or 720p, never more than the source), saved on the person's computer and never
   uploaded. The render needs the tab to stay open; if it's closed, nothing half-made is kept.

## Files in storage
Everything for a job is under `u/<user id>/<job id>/` in R2. Each run of a language (`job_outputs.generation`,
one more every time the language is translated again) has its own folder `out/<lang>/g<generation>/`, so files
of an older run, or a browser tab still busy with one, can never mix with the new run's:

| Key | Written by | What it is |
|---|---|---|
| `source` | browser (upload) | the original video |
| `prep/media.json` | browser (prepare) | what the browser measured of the video (below) |
| `prep/audio.m4a` or `prep/audio.wav` | browser (prepare) | the voiceover sent to ElevenLabs: mono AAC 128 kb/s (WAV without an AAC encoder) |
| `prep/transcript.json` | prepare route (transcribe) | ElevenLabs' speech-to-text answer, as it came |
| `prep/names.json` | prepare route (names) | the transcript after Claude's name check: `script`, `names_fixed`, `base_lang` |
| `prep/alignment.json` | prepare route (align) | ElevenLabs' forced alignment, plus `_text`: the transcript it was for |
| `prep/align-check.json` | prepare route (align) | while an edited transcript is timed: whether the analysis before had warnings |
| `analysis.json` | prepare route (align); the old worker | the original video and voiceover as analyzed (below); what every language is made from |
| `work/<lang>/script.json` | produce route (translate) | the translation (below), across runs: a new run starts from it |
| `work/<lang>/ask.json` | produce route (translate) | while Claude is asked again: the conversation so far; removed when done |
| `work/<lang>/tts/<clip>.mp3`, `.json` | produce route (tts) | every beat ever voiced for this language: a run copies from here instead of paying again |
| `out/<lang>/g<n>/tts/<clip>.mp3` | produce route (tts) | one beat's ElevenLabs voice, as the API returned it (`mp3_44100_128`) |
| `out/<lang>/g<n>/tts/<clip>.json` | produce route (tts) | that clip's text and per-character timing |
| `out/<lang>/g<n>/inputs.json` | produce route (fit) | the plan inputs: what the plan and the voice track are built from; written last |
| `out/<lang>/g<n>/plan.json` | browser | how to cut and retime the source for this language |
| `out/<lang>/g<n>/voice.wav` | browser | the finished voice track |
| `out/<lang>/g<n>/preview.mp4` | browser | the 720p preview (H.264 + AAC) |
| `out/<lang>/plan.json`, `voice.wav`, `preview.mp4` | the old worker | the same, from before runs had folders |
| `out/<lang>.mp4`, `out/<lang>_preview.mp4` | the old worker | rendered videos of projects made before browser rendering |

The database rows (`jobs`, `job_outputs`) hold the keys; the app and the database build them from the rows
(`save_prepared`, `save_aligned`, `mark_voiced`, `save_plan`, `save_preview`,
[web/lib/produce/keys.ts](../web/lib/produce/keys.ts), [web/lib/prepare/steps.ts](../web/lib/prepare/steps.ts)),
never from what a browser sends.

### Measurements (prep/media.json, format 1)
What the analysis takes from the video itself, measured in the browser
([web/lib/prepare/media.ts](../web/lib/prepare/media.ts) checks it on the server): `format` (1), `dur` (ffprobe's
format duration, whole microseconds), `fps` (`r_frame_rate` as a float), `width`, `height` (shown size, rotation
applied), `base_lufs` (ffmpeg's `ebur128` integrated loudness, one decimal as it prints it), `cuts` (seconds on
the frame grid, sorted, not within 0.05 s of either end), `audio` (`audio.m4a` or `audio.wav`), `audio_bytes`,
`from` (`browser`, or `analysis` when it was taken from the old worker's `analysis.json`), and for information
`frames` and `variable_fps`.

### Scene cut parity
The cuts are ffmpeg's `-vf "scale=270:-2,select='gt(scene,0.2)'"`, ported from ffmpeg 9 itself
([web/lib/prepare/scenes.ts](../web/lib/prepare/scenes.ts)), each cut's time snapped to the frame grid. Each frame's
luma plane, as the browser's decoder gives it (H.264 and HEVC decoding is exact, so these are ffmpeg's pictures),
is rotated as ffmpeg's autorotate does, scaled to 270 pixels wide with swscale's default bicubic filter in its own
fixed-point arithmetic (filter coefficients from `initFilter`, the 15-bit horizontal pass and the rounded vertical
one), and scored as `get_scene_score` does: min(MAFD, |MAFD - previous MAFD|) / 100 in single precision, MAFD being
the mean absolute difference from the previous picture. On the test videos every scaled picture is ffmpeg's to the
bit, every score is ffmpeg's to its 6 printed decimals, and the cuts are ffmpeg's exactly, borderline ones included
(a still picture brightened by 19, 20, 21 and 30 levels, fades, 24/25/29.97/30/60 fps, several time bases, rotated
videos). Where it can differ: ffmpeg's filter alignment depends on its build (the port uses that of the x86 and
arm64 builds people run; a plain C build drops a few tiny coefficients), and x86's vertical pass without
`accurate_rnd` rounds a little differently (a pixel by up to 2 levels, a score by far less than 0.001): only a
frame scoring within about 0.001 of the threshold could then fall on the other side. 10-bit SDR videos are scored
on 8 bits (ffmpeg scores 10), and a decoder that only gives RGB frames gets luma worked out from RGB: both close,
not exact. The frame rate of a video whose rate really varies is ffprobe's guess (`timing.ts`) worked out over
every frame, where ffprobe looks at the first ones.

### Analysis (format 1)
`analysis.json` is written by the align route ([web/lib/prepare/analyze.ts](../web/lib/prepare/analyze.ts);
[web/lib/produce/analysis.ts](../web/lib/produce/analysis.ts) reads it and refuses other formats), in the format
the old worker wrote: `format` (1), `base_lang`, `video`, `source`, `speech_start`, `speech_end`, `base_lufs`,
`tokens` and `anchors` as in the plan inputs below, `beats` (`id`, `text`, `marked`: the text with a `{n}` marker
in front of the word each cut lands on, `dur`, `pause_after`) and `warnings`. `jobs.analysis_script` is the
transcript it was made from: `approve_job` sends a different (edited) transcript to be timed again first
(`aligning`).

### The translation
`work/<lang>/script.json` has `lang` and `beats` (`id`, `text` with the markers, `speed` only where Claude set
one, within 0.7-1.2 and rounded to 2 decimals), plus `format` (1), `base` (which analysis it translates: a hash
of its marked beats; another one means a new translation), and `generation` and `round` (the run it was last
used in, and how many times Claude rewrote it in that run). The prompts, the schema, the model and the checks
are in [web/lib/produce/translate.ts](../web/lib/produce/translate.ts) (`TRANSLATE_SYSTEM`, `SCRIPT_SCHEMA`,
`checkScript`, `refitPrompt`). Each clip's name is its cache key (12 hex digits of the SHA-1 of the voice, the
format and the request body as Python's `json.dumps` writes them, as the old worker named them), so the same
request always gives the same file.

### Plan inputs (format 1)
`inputs.json` is written by the fit route ([web/lib/produce/steps.ts](../web/lib/produce/steps.ts))
([web/lib/pipeline/inputs.ts](../web/lib/pipeline/inputs.ts) reads it and refuses other formats; a change older
inputs can't satisfy raises `format`):
- `format` (1), `lang`, `voice_id` (the ElevenLabs voice the clips were made with)
- `analysis`: the original video and voiceover, from the analysis: `video` (`dur` seconds, `fps` = ffprobe's
  `r_frame_rate` as a float), `source` (`width`, `height`: the size ffmpeg shows the video at, rotation
  applied), `speech_start`, `speech_end` (seconds), `base_lufs` (integrated loudness of the original, one
  decimal as ffmpeg's `ebur128` prints it), `beats` (`id`, `dur`, `pause_after`), `tokens` (per word of the
  script: `beat`, its beat's index), `anchors` (every cut: `id`, `t`, `kind` `lead`/`tail`/`in`/`gap`, and
  `frac`, `off` or `token`)
- `fit`: the fitting limits the plan is built with (`FIT` in [web/lib/pipeline/config.ts](../web/lib/pipeline/config.ts))
- `script`: the translation, per beat `id`, `text` (with the `{n}` cut markers) and optional `speed`
- `clips`: per beat, in beat order, `beat` (its id), `file` (the clip's name in `tts/`, letters, digits, `-`,
  `_` and `.mp3` only) and `speed` (the TTS speed it was voiced at)

Each `tts/<clip>.json` has `text` (what was voiced, markers removed), `speed`, and `alignment` from ElevenLabs'
`with-timestamps` endpoint (`characters`, `character_start_times_seconds`, `character_end_times_seconds`;
`normalized_alignment` is kept but unused). A clip's length is its decoded samples (MP3 encoder delay and padding
removed, as ffmpeg does) in whole microseconds, as ffprobe reports it. The browser reads the delay and padding
from the clip's LAME header itself ([web/lib/pipeline/mp3.ts](../web/lib/pipeline/mp3.ts)), so a decoder that
doesn't cut them gives the same samples as Chrome's and ffmpeg's. The fit route reads the same length from the
header without decoding (`mp3Samples`); a clip without that header (ElevenLabs' have one) is counted frame by
frame instead.

`plan.json` ([web/lib/pipeline/plan.ts](../web/lib/pipeline/plan.ts), `"format": 1`;
[web/lib/render/plan.ts](../web/lib/render/plan.ts) refuses other formats). The browser uses `fps` (the
source's frame rate; the output has the same), `total_frames`, and per clip in `segments`: `src_start` and
`src_len` (seconds of the source), `speed` and `frames` (exactly how many output frames). Each clip is retimed
exactly as ffmpeg's `-ss <src_start> -t <src_len + 0.1> -vf "setpts=(PTS-STARTPTS)/<speed>,fps=<fps>,scale,tpad"
-frames:v <frames>` would (see [web/lib/render/frames.ts](../web/lib/render/frames.ts)), the last frame held for
as long as the clip needs when it runs past the end of the footage. `source` (`width`, `height`) is the size
ffmpeg shows the source at (rotation applied): the browser renders at that size, and stops with a message if it
reads the rotation the other way. `voice` (`file`, `sample_rate`, `channels`) describes `voice.wav`, which must
match it and be as long as the video. `beats`, `anchors` and `flags` are there for information.

`voice.wav` is 16-bit PCM, 44.1 kHz, stereo, loudness matched to the original voiceover and limited, exactly
`total_frames / fps` long (cut like ffmpeg's `-t` with four decimals). These are the samples the AAC encoder gets.

The database row for each language (`job_outputs`) has `generation`; `status` `pending` (asked for), `running`
(a run of the job page), `voiced` with `inputs_key`, then `ready` with `plan_key`, `voice_key`, `seconds`,
`flags` and `report`, and once the browser made the preview, `preview_key` and `preview_bytes`; or `failed`
with the reason in `flags`. (`done` with `output_key` is a video the old worker rendered.)

### Voice track parity
The timing plan is a port of the old Python pipeline's: integers (frames, ids) exactly, floats to the last bit or
so, flags and report word for word, against its plans frozen in `web/test/fixtures/`. The voice track is checked
against the one ffmpeg makes from the same plan (`atrim` at exact samples, `atempo`, `ebur128`, `volume`,
`alimiter=limit=0.95:level=0`, `-ac 2`; `web/test/reference.mjs`):
- every beat at tempo 1 (the usual case: the plan only changes the tempo where a cut can't be placed): sample for
  sample, within 2 of 32768 (Chrome's MP3 decoder and ffmpeg's differ in the last bit). The loudness meter is
  ffmpeg `ebur128`'s integrated loudness to 0.002 LU, rounded to 0.1 LU as ffmpeg prints it, so the gain is the
  same.
- a beat with another tempo: stretched with WSOLA ([web/lib/pipeline/wsola.ts](../web/lib/pipeline/wsola.ts))
  instead of ffmpeg's atempo, so not sample for sample: the same length to the sample (`round(length / tempo)`;
  atempo loses up to ~15 ms at the end), words within 3 ms of where the tempo puts them (atempo moves onsets
  ~20 ms early), the same level within 0.5 dB, and as clean a tone as atempo's. atempo keeps about 0.1-0.2 dB
  more energy in a stretched beat than WSOLA, so the loudness measured before the gain can round to another
  0.1 LU step: then the whole track is 0.1 dB (with most of it stretched, up to 0.2 dB) louder or quieter than
  ffmpeg's.
- the limiter ([web/lib/pipeline/limiter.ts](../web/lib/pipeline/limiter.ts)): the same 219-sample delay as
  `alimiter`, untouched audio identical; where it acts, within 0.3% (relative error) of alimiter's output, never
  above the limit.

## Tests
In `web/`, with `ffmpeg` and `ffprobe` 9.0 installed (no Python; another version runs with a warning, see
"Tests" in [web/README.md](../web/README.md)): `pnpm test` runs the unit tests and the checks
against ffmpeg and the frozen references (see "Tests" in [web/README.md](../web/README.md)), with fake Claude and
ElevenLabs (`test/mocks.mjs`: deterministic, so the same request gets the same answer):
- the browser's frame selection against ffmpeg's clip retiming command (`test/ffmpeg-frames.test.ts`);
- the timing plan and voice track on 33 synthetic jobs, one-beat scripts and videos without cuts among them
  (`test/pipeline-parity.test.ts`): plans as the old pipeline's, voice tracks as ffmpeg's;
- the loudness meter, time stretch and limiter against ffmpeg (`test/voice-dsp.test.ts`), and the MP3 delay and
  padding cut against ffmpeg's (`test/mp3.test.ts`);
- the produce steps (`test/produce-parity.test.ts`): the same requests as the old pipeline's (every Claude request
  body in order, the same ElevenLabs bodies) and the same translation, clip names, bytes and plan inputs; Claude
  asking again, rewrite rounds (one language uses all three), a translation that never gets its markers right,
  stopping and carrying on without paying twice, a second run that pays nothing, the retries with their pauses,
  and the message for each key problem; single functions (`check_script`, the cache key, Python's `json.dumps`,
  the prompts) against the old pipeline's answers;
- the prepare steps (`test/prepare-parity.test.ts`) on test videos (`test/videos.mjs`, made with ffmpeg: cuts,
  near-threshold brightness steps, fades, 24 to 60 fps at several time bases, rotated): the same requests,
  `analysis.json`, transcript, names and warnings as the old pipeline's; an edited transcript timed again (a
  spelling fix passes, changed words go back to review); asking again pays nothing;
- every scaled picture, scene score and cut against ffmpeg (`test/scenes.test.ts`), and the length, frame rate,
  size, HDR and loudness against ffprobe and `ebur128`, and the file checks' decisions (`test/probe.test.ts`).

`pnpm e2e` (headless Google Chrome) builds two fake jobs' plans and voice tracks from their plan inputs, compares
them with the frozen plans and ffmpeg's voice tracks, renders one and compares every frame and the voice with
ffmpeg's render of the same plan; then it makes an approved job's language in Chrome with the job page's produce
code through the produce steps, checks the requests and the plan inputs, builds and renders it. Last, a new video
all the way: the file checks on every test video (HDR, variable frame rate, rotated, no sound, codecs Chrome
can't decode, too short), what the browser measures of them against ffprobe and ffmpeg (length, frame rate,
size, cuts, loudness, the voiceover), then one is uploaded, prepared through the prepare steps, edited and timed
again, produced, built and rendered, each step compared with the frozen results and ffmpeg's render. No test
calls ElevenLabs or Claude.
