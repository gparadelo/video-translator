# Web app setup

The web app has three parts: the site in [web/](../web) (Next.js), a Supabase project (login and database),
and a Cloudflare R2 bucket (the videos). A worker on a Mac transcribes, translates and voices each video; it
comes later. The videos themselves are rendered in each person's browser (desktop Chrome or Edge).

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
   settings (below). The secret (service role) key is only for the worker: never put it in the web app.

A free project pauses after about a week without any activity. The worker checks in every 30 seconds, which
keeps it awake; if the Mac was off for longer, un-pause the project in the Supabase dashboard.

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
   The browser reads the uploaded video in pieces to render it (`range`, `Content-Range`), and uploads the
   previews it makes (`PUT`).
3. **Auto-delete:** bucket -> Settings -> Object lifecycle rules -> delete objects 30 days after they were
   uploaded. The uploaded videos are the big files (up to several GB in 4K); each language adds about 10 MB
   per minute of video (its voice track) and its preview.
4. **Keys:** R2 -> Manage API tokens -> create one with Object Read & Write on this bucket only. You get an
   access key ID and a secret; the account ID is on the R2 overview page.

## 2b. Everyone's own API keys
Each person enters their own ElevenLabs API key, Claude API key and ElevenLabs voice ID on the app's
**Settings** page. Their videos are spoken in their voice and billed to their accounts, and title translations
use their Claude key. Until they have, the app asks them to and won't start a project. You do the same for
your own account.

The keys are checked when saved, then encrypted (AES-256-GCM) before they go into the database (table
`user_secrets`, which people can't read). Settings only ever shows a key's last 4 characters. The encryption
key is `SECRETS_KEY`: create one with `openssl rand -base64 32` and set the same value in `web/.env.local`,
in Vercel (Settings -> Environment Variables, never with `NEXT_PUBLIC_`) and in `worker/.env`. Keep it
secret. If you change it, every saved key stops working and everyone has to save theirs again.

## 3. Run the site
```
cd web
cp .env.example .env.local     # fill in the values from steps 1, 2 and 2b
pnpm install
pnpm dev                       # http://localhost:3000
```
To put it online: import the repository in Vercel, set Root Directory to `web`, and add the same settings
as environment variables.

## 4. The worker (on a Mac)
The worker asks the database for jobs, downloads the video, runs the pipeline and uploads the results.
It only makes outgoing connections, so nothing on the Mac is exposed to the internet.

1. `cp worker/.env.example worker/.env` and fill it in: the Supabase URL and **secret** key, the same R2
   values as the web app, and the same `SECRETS_KEY`. It has no ElevenLabs or Claude keys of its own: each job
   runs on its owner's keys from Settings, and any such keys left in `worker/.env` are ignored.
2. Try it in a terminal first: `uv run worker/worker.py` (stop it with Ctrl-C).
3. Make it start at login and restart if it stops: `worker/install-service.sh`
   (`worker/install-service.sh remove` undoes it). Its log is `~/Library/Logs/video-translator-worker.log`.

Things to know:
- While a job runs the worker keeps the Mac awake. It can't wake a sleeping Mac: to pick up jobs while you're
  away, set the Mac to stay awake when plugged in (System Settings -> Battery -> Options, or Energy).
- Job folders live in `~/Library/Application Support/Video Translator Worker` for 7 days, so re-running a
  language reuses the voice audio. The worker stops once a language is voiced: it uploads the recorded voice
  (the plan inputs, below), and the person's browser builds the timing plan and the voice track and makes the
  video.
- Each language keeps the voice it had when the worker first started producing it in that project
  (`jobs.voices`, pinned for all of the project's languages at the start of the run): retries and new
  translations of it use that voice. Changing the voice in Settings applies to new projects, and to languages
  added to a project later.
- If the worker dies mid-job, the job goes back to the queue after two minutes; after three such tries it
  is marked failed.
- One language failing doesn't stop the others: it is marked failed with the reason, and the job finishes.

## Upgrading an existing setup to per-person keys
Do it in this order. Vercel only applies new settings to new deployments, and a new worker against an old
database fails every job.
1. Set `SECRETS_KEY` in Vercel (Settings -> Environment Variables).
2. Run the new migration (`supabase/migrations/20261122000000_user_keys.sql`).
3. Merge and deploy, or redeploy if the code is already there. Then remove `ANTHROPIC_API_KEY` from Vercel.
4. On the Mac, straight away: `git pull`, put the same `SECRETS_KEY` in `worker/.env`, remove the ElevenLabs
   and Claude keys from it, and restart the worker (`worker/install-service.sh`, or Ctrl-C and start it again).
   Until it restarts, the old worker still has your keys in memory and every job is billed to you.
5. Everyone, you included, opens Settings and saves their keys and voice.

## Upgrading an existing setup to browser rendering
1. Run the migration `supabase/migrations/20261123000000_browser_render.sql`.
2. Update the R2 CORS policy (step 2 above: `range` and the exposed headers).
3. Deploy the web app.
4. On the Mac: `git pull` and restart the worker. A worker from before this keeps working against the new
   database (it renders and uploads the full video as before), but a new worker needs the new database.

Projects made before keep their videos: they still play and download as before.

## Upgrading to building the plan and the voice in the browser
Do it in this order, one step straight after the other:
1. Run the migration `supabase/migrations/20261124000000_browser_plan.sql`.
2. Deploy the web app. Until it's deployed, the old pages can't save previews (`save_preview` now needs the
   run number): a "Make preview" in that gap fails with a message, and works again after the deploy.
3. On the Mac: `git pull` and restart the worker. An older worker keeps working against the new database (it
   uploads `plan.json` and `voice.wav` itself, and the language is `ready` as before), but a new worker needs
   the new database: started before the migration, every language fails.

Nothing changes in R2's CORS policy. Languages already `ready` keep their files and render as before.

## How a video moves through it
1. `POST /api/jobs` creates the job and returns a signed link; the browser uploads the video straight to R2.
2. `POST /api/jobs/<id>/submit` checks the upload arrived and queues the job.
3. The worker prepares it (transcript); the person reviews it and approves (`approve_job`).
4. The worker produces each language up to the recorded voice (translation, TTS, and Claude's rewrites of
   beats that don't fit, for which it still makes the timing plan with `vt.py`) and uploads the plan inputs
   (below); the language is then `voiced`.
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
| `out/<lang>/g<n>/tts/<clip>.mp3` | worker (phase 3: the TTS route) | one beat's ElevenLabs voice, as the API returned it (`mp3_44100_128`) |
| `out/<lang>/g<n>/tts/<clip>.json` | worker (phase 3: the TTS route) | that clip's text and per-character timing |
| `out/<lang>/g<n>/inputs.json` | worker (phase 3: the TTS route) | the plan inputs: what the plan and the voice track are built from; written last |
| `out/<lang>/g<n>/plan.json` | browser | how to cut and retime the source for this language |
| `out/<lang>/g<n>/voice.wav` | browser | the finished voice track |
| `out/<lang>/g<n>/preview.mp4` | browser | the 720p preview (H.264 + AAC) |
| `out/<lang>/plan.json`, `voice.wav`, `preview.mp4` | phase 1 workers and pages | the same, from before runs had folders |
| `out/<lang>.mp4`, `out/<lang>_preview.mp4` | older workers | rendered videos of projects made before browser rendering |

The database row (`job_outputs`) holds the keys; the app and the database build them from the row (`worker_output`,
`save_plan`, `save_preview`), never from what a browser sends.

### Plan inputs (format 1)
`inputs.json` is `vt.plan_inputs` ([web/lib/pipeline/inputs.ts](../web/lib/pipeline/inputs.ts) reads it and
refuses other formats; a change older inputs can't satisfy raises `format` in both):
- `format` (1), `lang`, `voice_id` (the ElevenLabs voice the clips were made with)
- `analysis`: the original video and voiceover, from `vt analyze`: `video` (`dur` seconds, `fps` = ffprobe's
  `r_frame_rate` as a float), `source` (`width`, `height`: the size ffmpeg shows the video at, rotation
  applied), `speech_start`, `speech_end` (seconds), `base_lufs` (integrated loudness of the original, one
  decimal as `vt.lufs` reads it), `beats` (`id`, `dur`, `pause_after`), `tokens` (per word of the script: `beat`,
  its beat's index), `anchors` (every cut: `id`, `t`, `kind` `lead`/`tail`/`in`/`gap`, and `frac`, `off` or
  `token` as `vt analyze` writes them)
- `fit`: the fitting limits the plan is built with (`config.default.toml` [fit] unless a config overrode them)
- `script`: the translation, per beat `id`, `text` (with the `{n}` cut markers) and optional `speed`
- `clips`: per beat, in beat order, `beat` (its id), `file` (the clip's name in `tts/`, letters, digits, `-`,
  `_` and `.mp3` only) and `speed` (the TTS speed it was voiced at)

Each `tts/<clip>.json` is what `vt.tts_beat` keeps: `text` (what was voiced, markers removed), `speed`, and
`alignment` from ElevenLabs' `with-timestamps` endpoint (`characters`, `character_start_times_seconds`,
`character_end_times_seconds`; `normalized_alignment` is kept but unused). A clip's length is its decoded
samples (MP3 encoder delay and padding removed, as ffmpeg does) in whole microseconds, as ffprobe reports it.
The browser reads the delay and padding from the clip's LAME header itself
([web/lib/pipeline/mp3.ts](../web/lib/pipeline/mp3.ts)), so a decoder that doesn't cut them gives the same
samples as Chrome's and ffmpeg's.

`plan.json` is `scripts/vt.py`'s plan (`build_plan`) as `vt.portable_plan` writes it, with `"format": 1`
([web/lib/render/plan.ts](../web/lib/render/plan.ts) refuses other formats). The browser uses `fps` (the
source's frame rate; the output has the same), `total_frames`, and per clip in `segments`: `src_start` and
`src_len` (seconds of the source), `speed` and `frames` (exactly how many output frames). Each clip is retimed
exactly as `vt.segment_cmd`'s ffmpeg command would (see [web/lib/render/frames.ts](../web/lib/render/frames.ts)),
the last frame held for as long as the clip needs when it runs past the end of the footage. `source`
(`width`, `height`) is the size ffmpeg shows the source at (rotation applied, `vt.video_size`): the browser
renders at that size, like the CLI, and stops with a message if it reads the rotation the other way. `voice`
(`file`, `sample_rate`, `channels`) describes `voice.wav`, which must match it and be as long as the video.
`beats`, `anchors` and `flags` are there for information.

`voice.wav` is what `vt.build_voice_track` makes: 16-bit PCM, 44.1 kHz, stereo, loudness matched to the
original voiceover and limited, exactly as long as `vt.py`'s (`total_frames / fps`, cut like `-t` with four
decimals). These are the samples the AAC encoder gets, in the browser and in the CLI render alike.

The database row for each language (`job_outputs`) has `generation`; `status` `voiced` with `inputs_key`, then
`ready` with `plan_key`, `voice_key`, `seconds`, `flags` and `report`, and once the browser made the preview,
`preview_key` and `preview_bytes`.

### Voice track parity
`scripts/vt.py` stays the reference until the Python pipeline is removed. The browser's plan is `vt.py`'s plan:
integers (frames, ids) exactly, floats to the last bit or so, flags and report word for word. Its voice track:
- every beat at tempo 1 (the usual case: the plan only changes the tempo where a cut can't be placed): sample for
  sample, within 2 of 32768 (Chrome's MP3 decoder and ffmpeg's differ in the last bit). The loudness meter is
  ffmpeg `ebur128`'s integrated loudness to 0.002 LU, rounded to 0.1 LU as `vt.lufs` reads it, so the gain is the
  same.
- a beat with another tempo: stretched with WSOLA ([web/lib/pipeline/wsola.ts](../web/lib/pipeline/wsola.ts))
  instead of ffmpeg's atempo, so not sample for sample: the same length to the sample (`round(length / tempo)`;
  atempo loses up to ~15 ms at the end), words within 3 ms of where the tempo puts them (atempo moves onsets
  ~20 ms early), the same level within 0.5 dB, and as clean a tone as atempo's. atempo keeps about 0.1-0.2 dB
  more energy in a stretched beat than WSOLA, so the loudness measured before the gain can round to another
  0.1 LU step: then the whole track is 0.1 dB (with most of it stretched, up to 0.2 dB) louder or quieter than
  `vt.py`'s.
- the limiter (`alimiter=limit=0.95` in `vt.py`, [web/lib/pipeline/limiter.ts](../web/lib/pipeline/limiter.ts)
  here): the same 219-sample delay, untouched audio identical; where it acts, within 0.3% (relative error) of
  alimiter's output, never above the limit.
- `vt.py` itself changed with this: it decodes each clip whole and trims it at exact samples (an MP3 seek
  garbled the first ~25 ms of every beat), and leaves a tempo of exactly 1 alone (atempo still re-cut it).

## Tests
In `web/`: `pnpm test` runs the unit tests, including a check of the browser's frame selection against ffmpeg
running `vt.segment_cmd`, the timing plan and voice track against `vt.py` on 33 synthetic jobs, one-beat
scripts and videos without cuts among them (`test/pipeline-parity.test.ts`, made by `test/pipeline_fixture.py`),
the loudness meter, time stretch and limiter against ffmpeg (`test/voice-dsp.test.ts`), and the MP3 delay and
padding cut against ffmpeg's (`test/mp3.test.ts`); these need ffmpeg (and uv) and are skipped without them.
`pnpm e2e` builds two fake jobs' plans and voice tracks from their plan inputs in headless Google Chrome,
compares them with `vt.py`'s, renders one and compares every frame and the voice with the CLI render
(`--size 2160x3840` for 4K, `--rate 30000/1001`). No test calls ElevenLabs or Claude.
