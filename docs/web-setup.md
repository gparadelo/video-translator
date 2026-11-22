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
  language reuses the voice audio. The worker doesn't render: it uploads each language's plan and voice track,
  and the person's browser makes the video.
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

## How a video moves through it
1. `POST /api/jobs` creates the job and returns a signed link; the browser uploads the video straight to R2.
2. `POST /api/jobs/<id>/submit` checks the upload arrived and queues the job.
3. The worker prepares it (transcript); the person reviews it and approves (`approve_job`).
4. The worker produces each language up to the timing plan and uploads `plan.json` and `voice.wav` (below);
   the language is then `ready`.
5. On the job page the browser renders it ([web/lib/render](../web/lib/render)), with the links from
   `GET /api/jobs/<id>/render/<lang>`: first a 720p preview, uploaded with `POST /api/jobs/<id>/preview/<lang>`
   so it plays on the page (`GET /api/jobs/<id>/files/<lang>?kind=preview`); then, on Download, the chosen
   quality (Original, 1080p or 720p, never more than the source), saved on the person's computer and never
   uploaded. The render needs the tab to stay open; if it's closed, nothing half-made is kept.

## Files in storage
Everything for a job is under `u/<user id>/<job id>/` in R2:

| Key | Written by | What it is |
|---|---|---|
| `source` | browser (upload) | the original video |
| `out/<lang>/plan.json` | worker | how to cut and retime the source for this language |
| `out/<lang>/voice.wav` | worker | the finished voice track |
| `out/<lang>/preview.mp4` | browser | the 720p preview (H.264 + AAC) |
| `out/<lang>.mp4`, `out/<lang>_preview.mp4` | older workers | rendered videos of projects made before browser rendering |

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

`voice.wav` is `vt.build_voice_track`: 16-bit PCM, 44.1 kHz, stereo, loudness matched to the original
voiceover and limited, exactly `total_frames / fps` long. These are the samples the AAC encoder gets, in the
browser and in the CLI render alike.

The database row for each language (`job_outputs`) has `status` `ready`, `plan_key`, `voice_key`, and once
the browser made the preview, `preview_key` and `preview_bytes`.

## Tests
In `web/`: `pnpm test` runs the unit tests, including a check of the browser's frame selection against ffmpeg
running `vt.segment_cmd` (needs ffmpeg and uv; skipped without them). `pnpm e2e` renders a fake job in
headless Google Chrome and compares every frame and the voice with the CLI render (`--size 2160x3840` for 4K,
`--rate 30000/1001`). No test calls ElevenLabs or Claude.
