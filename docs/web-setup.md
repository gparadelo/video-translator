# Web app setup

The web app has three parts: the site in [web/](../web) (Next.js), a Supabase project (login and database),
and a Cloudflare R2 bucket (the videos). A worker on a Mac does the actual translating; it comes later.

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
     "AllowedHeaders": ["content-type"],
     "ExposeHeaders": ["ETag"],
     "MaxAgeSeconds": 3600
   }]
   ```
3. **Auto-delete:** bucket -> Settings -> Object lifecycle rules -> delete objects 30 days after they were
   uploaded. Outputs are 100-450 MB each, so storage fills quickly otherwise.
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

## 4. The worker (on the Mac that renders)
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
  language reuses the voice audio. The 4K outputs are deleted from the Mac once uploaded.
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

## How a video moves through it
1. `POST /api/jobs` creates the job and returns a signed link; the browser uploads the video straight to R2.
2. `POST /api/jobs/<id>/submit` checks the upload arrived and queues the job.
3. The worker prepares it (transcript); the person reviews it and approves (`approve_job`).
4. The worker produces each language and uploads the 4K file and a small preview.
5. `GET /api/jobs/<id>/files/<lang>` downloads the 4K file; add `?kind=preview` to play the small one.
