import { describe, expect, it } from "vitest";
import {
  parseFfprobeCodecAndSampleRate,
  parseFfprobeCsvFields,
  runFfmpeg,
} from "./ffmpeg-exec.js";

describe("parseFfprobeCsvFields", () => {
  it("splits ffprobe csv output across commas and newlines", () => {
    expect(parseFfprobeCsvFields("opus,\n48000\n", 2)).toEqual(["opus", "48000"]);
  });
});

describe("runFfmpeg AbortSignal", () => {
  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runFfmpeg(["-version"], { signal: controller.signal, timeoutMs: 2_000 }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("parseFfprobeCodecAndSampleRate", () => {
  it("parses opus codec and numeric sample rate", () => {
    expect(parseFfprobeCodecAndSampleRate("Opus,48000\n")).toEqual({
      codec: "opus",
      sampleRateHz: 48_000,
    });
  });

  it("returns null sample rate for invalid numeric fields", () => {
    expect(parseFfprobeCodecAndSampleRate("opus,not-a-number")).toEqual({
      codec: "opus",
      sampleRateHz: null,
    });
  });
});
