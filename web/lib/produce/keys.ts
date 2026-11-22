// Where a job's files are in R2 (see "Files in storage" in docs/web-setup.md). The database builds the same keys
// (save_plan, save_preview, mark_voiced, worker_prepared); the app builds them from the row, never from what a
// browser sends.

/**
 * One run (generation) of a language: u/<user>/<job>/out/<lang>/g<generation>/<file> (inputs.json, tts/<clip>,
 * plan.json, voice.wav, preview.mp4).
 */
export const outputKey = (userId: string, jobId: string, lang: string, generation: number, file: string) =>
  `u/${userId}/${jobId}/out/${lang}/g${generation}/${file}`;

/**
 * What the produce steps keep for a language across its runs: u/<user>/<job>/work/<lang>/<file> (script.json, the
 * translation; ask.json, a Claude conversation waiting for its next try; tts/<clip>, every clip ever voiced).
 */
export const workKey = (userId: string, jobId: string, lang: string, file: string) =>
  `u/${userId}/${jobId}/work/${lang}/${file}`;
