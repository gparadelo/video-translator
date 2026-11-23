# Video Translator

A web app that turns one finished short-form video (voiceover only, usually under two minutes) into versions in
other languages, spoken in each person's own ElevenLabs voice, with the clips re-timed so every cut still lands on
the right word.

## How it works
1. **Upload a video.** The browser checks it, uploads it to storage and measures it at the same time: length,
   frame rate, cuts and loudness.
2. **Check the transcript.** The voiceover is transcribed (ElevenLabs), Claude fixes the spelling of names, and
   every word is timed. The person reads the transcript and approves it, or fixes a spelling first.
3. **Translations.** For each language, Claude translates each beat to fit the original timing, ElevenLabs voices
   it, and a timing plan fits each clip between its cuts: the pauses between beats, a small voice tempo change
   (up to 7%), the clip's speed (90 to 110%), and trimming the end of a clip. Beats that still don't fit go back to
   Claude to be rewritten (up to 3 rounds).
4. **Render.** The browser builds the voice track and renders the video (WebCodecs): a 720p preview to watch on
   the page, then the full quality to download.

Everything runs in the web app and the person's browser. There is no server-side media processing and no
worker machine.

## What you need
- **Supabase** (login and database; the free plan is enough).
- **Cloudflare R2** (the videos; files are deleted after 30 days).
- **Vercel** for the site, with **Fluid compute** on (the transcription, alignment and translation routes can
  take a few minutes).
- **Per person:** an ElevenLabs API key (permissions: Text to Speech, Speech to Text, Forced Alignment), a
  Claude API key, and an ElevenLabs voice ID, entered on the app's Settings page. Each person's videos are billed
  to their own accounts.

Setup, step by step: [docs/web-setup.md](docs/web-setup.md). Coming from the setup with the worker on a Mac:
[Upgrading from the worker setup](docs/web-setup.md#upgrading-from-the-worker-setup).

## Videos it takes
- **Browsers:** desktop Chrome or Edge. Other browsers are told so; phones and tablets are told it works best on
  a computer.
- **Limits:** 1 second to 10 minutes long, up to 8K, up to 120 frames a second, with a sound track, in a picture
  and sound format the browser can decode (H.264 or HEVC with AAC is the usual).
- **HDR is refused** (an iPhone's default): the translations can only be made in SDR, and HDR would come out with
  washed-out colours. Export the video as SDR, or share it from the iPhone as "Most Compatible".
- Rotated phone videos and variable frame rates are fine.

## Repository
- [web/](web): the Next.js app (pages, API routes, and the browser code in `web/lib`); see
  [web/README.md](web/README.md) for how it's built and tested.
- [supabase/migrations/](supabase/migrations): the database, one file per change, run oldest first.
- [docs/web-setup.md](docs/web-setup.md): setup, upgrading, and the files the app keeps in storage.

## Development
```
cd web
cp .env.example .env.local     # see docs/web-setup.md
pnpm install
pnpm dev                       # http://localhost:3000
pnpm test                      # needs ffmpeg and ffprobe
pnpm e2e                       # needs ffmpeg and Google Chrome
```
