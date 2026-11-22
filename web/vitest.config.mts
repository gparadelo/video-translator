import { defineConfig } from "vitest/config";

// Unit tests for the parts that are plain logic (frame selection, sizes, file formats). They run in Node;
// test/ffmpeg-frames.test.ts also needs ffmpeg and uv, and is skipped without them.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
