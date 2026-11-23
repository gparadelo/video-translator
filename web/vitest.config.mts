import { defineConfig } from "vitest/config";

// Unit tests for the parts that are plain logic (frame selection, sizes, file formats), and checks against ffmpeg.
// They run in Node. The checks against ffmpeg need ffmpeg and ffprobe: test/ffmpeg-check.mjs stops the run without
// them (VT_SKIP_FFMPEG=1 runs the plain unit tests alone) and warns when ffmpeg isn't the version the frozen
// references were made with.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/ffmpeg-check.mjs"],
    testTimeout: 180_000,
  },
});
