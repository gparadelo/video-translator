This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Settings

Copy `.env.example` to `.env.local` and fill it in (see [docs/web-setup.md](../docs/web-setup.md)); set the same
variables in Vercel. Each person saves their own ElevenLabs key, Claude key and voice on `/settings`
(`app/api/settings/route.ts`); keys are encrypted with `SECRETS_KEY` (`lib/secrets.ts`) and never sent back to
the browser. A project's title is translated with the person's own Claude key
(`app/api/jobs/[id]/title/route.ts`, `lib/translate-title.ts`) into the project's languages as plain
ASCII titles of at most 60 characters. A project has a video, a title, or both.

## Preparing a video

A video is checked as soon as it's picked (`lib/prepare/checks.ts`: can this browser decode it; HDR, no sound,
too long and the like are refused with what to do). The project's page uploads it and, at the same time, measures
it in the browser (`lib/prepare/local.ts`): its length and frame rate as ffprobe reports them, the cuts (a port of
ffmpeg's `scale=270:-2,select=gt(scene,0.2)` scene score, `lib/prepare/scenes.ts`, run in Web Workers), the
loudness, and the voiceover's sound. Then short routes on the person's own keys
(`app/api/jobs/[id]/prepare/{media,transcribe,names,align}`, `lib/prepare/steps.ts`) transcribe it (ElevenLabs),
check the spelling of names (Claude), time every word (ElevenLabs forced alignment) and write `analysis.json`, a
port of the old Python pipeline's prepare (`test/prepare-parity.test.ts`, `test/scenes.test.ts`).

## Translating and voicing

After the person approves the transcript, the job page makes each language (`components/ProduceOutput.tsx`,
`lib/produce/run.ts`) through short routes that run on the person's own keys
(`app/api/jobs/[id]/produce/[lang]/{translate,tts,fit}`, `lib/produce/steps.ts`): Claude translates and rewrites
the beats that don't fit, ElevenLabs voices one beat per call, every step is saved in R2, and a closed tab
carries on where it stopped. It's a port of the old Python pipeline's produce loop (same prompts, request bodies and
cache keys; `test/produce-parity.test.ts`). Then the page builds the timing plan and the voice track
(`lib/pipeline`) and renders.

## Rendering in the browser

The video is rendered on the job
page, in the person's browser (`lib/render`, WebCodecs + [Mediabunny](https://mediabunny.dev)). The source
is read from R2 in pieces, one decoded frame is held at a time, and each clip gets exactly the frames
ffmpeg's retiming command would give it (`lib/render/frames.ts`). The page first makes a 720p preview
(uploaded, so it plays on the page), then the full quality on Download (saved on the computer). Desktop
Chrome and Edge work best; other browsers are told so. Files and formats: "Files in storage" in
[docs/web-setup.md](../docs/web-setup.md).

## Tests

```bash
pnpm test   # unit tests + checks against ffmpeg, with fake Claude/ElevenLabs
pnpm e2e    # in headless Chrome: checks, measures and prepares test videos, produces, builds and renders them,
            # and compares everything with ffmpeg and the frozen references
```

Both need `ffmpeg` and `ffprobe` on the PATH (`brew install ffmpeg`); `pnpm e2e` also needs Google Chrome
(`CHROME_PATH` or `--chrome`). No Python. The tests that need ffmpeg are skipped without it.

What the tests compare against:

- **ffmpeg itself**, run from the tests (`test/reference.mjs`, `test/videos.mjs`): frame selection against
  ffmpeg's clip retiming command, scene scores and cuts against `scale=270:-2,select,metadata=print`, loudness
  against `ebur128`, length, frame rate and size against `ffprobe -show_streams`, the voice track against the one
  ffmpeg makes from the same plan (`atrim`, `atempo`, `volume`, `alimiter`), and renders against ffmpeg's render
  of the same plan.
- **Frozen references** in `test/fixtures/` for what only the old Python pipeline (removed in phase 5)
  computed: the timing plans and reports (`pipeline-cases.json`), the analyses, transcripts and requests of the
  prepare half (`prepare-parity.json`), the translations, voice requests and plan inputs of the produce half
  (`produce-parity.json`), and the jobs of `pnpm e2e` (`e2e.json`). They were made once by running the Python
  pipeline against the fakes in `test/mocks.mjs`, and can't be made again. If a deliberate change makes the web
  app differ from them, update the fixture by hand in the same commit and say why.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
