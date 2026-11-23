import { defineConfig } from "vitest/config";

// Unit tests for the parts that are plain logic (frame selection, sizes, file formats), and checks against ffmpeg.
// They run in Node; the checks against ffmpeg need ffmpeg and ffprobe, and are skipped without them.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
