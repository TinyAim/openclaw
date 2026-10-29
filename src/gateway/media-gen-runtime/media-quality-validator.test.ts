import { describe, expect, it } from "vitest";
import { parseMediaQualityGateMode } from "./media-quality-tools.js";
import {
  createMediaQualityValidator,
  mapQualityResultToRuntimeOutcome,
  qualityFailureReason,
} from "./media-quality-validator.js";

describe("parseMediaQualityGateMode", () => {
  it("defaults empty/off aliases to off", () => {
    expect(parseMediaQualityGateMode(undefined)).toBe("off");
    expect(parseMediaQualityGateMode("")).toBe("off");
    expect(parseMediaQualityGateMode("OFF")).toBe("off");
    expect(parseMediaQualityGateMode("0")).toBe("off");
  });

  it("accepts on and required", () => {
    expect(parseMediaQualityGateMode("on")).toBe("on");
    expect(parseMediaQualityGateMode("required")).toBe("required");
  });

  it("rejects invalid tokens (never defaults to on)", () => {
    expect(parseMediaQualityGateMode("requird")).toEqual({
      invalid: true,
      value: "requird",
    });
  });
});

describe("qualityFailureReason / mapQualityResultToRuntimeOutcome", () => {
  it("maps content issues to vendor_rejected and infrastructure to internal", () => {
    expect(qualityFailureReason("black_frame_dominant")).toBe("vendor_rejected");
    expect(qualityFailureReason("undecodable")).toBe("vendor_rejected");
    expect(qualityFailureReason("zero_duration")).toBe("vendor_rejected");
    expect(qualityFailureReason("no_video_stream")).toBe("vendor_rejected");
    expect(qualityFailureReason("tool_missing")).toBe("internal");
    expect(qualityFailureReason("probe_failed")).toBe("internal");
  });

  it("maps canceled to top-level canceled, never failureReason cancelled", () => {
    const mapped = mapQualityResultToRuntimeOutcome({
      ok: false,
      code: "canceled",
      message: "aborted",
    });
    expect(mapped).toEqual({ kind: "canceled", failureMessage: "aborted" });
  });
});

describe("createMediaQualityValidator", () => {
  it("rejects empty image payload", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async () => {
        throw new Error("should not probe images");
      },
    });
    const result = await validate({
      bytes: Buffer.alloc(0),
      mimeType: "image/png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("undecodable");
  });

  it("accepts non-empty image without probing", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async () => {
        throw new Error("should not probe images");
      },
    });
    const result = await validate({
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects zero duration video", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "0";
        return "video\n";
      },
      runFfmpeg: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    const result = await validate({
      bytes: Buffer.from("fake-video"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("zero_duration");
  });

  it("rejects video with no video stream", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "3.5";
        return "audio\n";
      },
      runFfmpeg: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    const result = await validate({
      bytes: Buffer.from("fake-video"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_video_stream");
  });

  it("rejects predominantly black decoded frames, including low-FPS all-black output", async () => {
    const validate = createMediaQualityValidator({
      blackFrameRatioLimit: 0.9,
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "2.0";
        return "video\naudio\n";
      },
      runFfmpeg: async () => ({
        stdout: "",
        stderr: [
          "[Parsed_blackframe] frame:0 pblack:100",
          "[Parsed_blackframe] frame:1 pblack:100",
          "[Parsed_blackframe] frame:2 pblack:100",
          "[Parsed_blackframe] frame:3 pblack:100",
          "[Parsed_blackframe] frame:4 pblack:100",
          "[Parsed_blackframe] frame:5 pblack:100",
          "[Parsed_blackframe] frame:6 pblack:100",
          "[Parsed_blackframe] frame:7 pblack:100",
          "[Parsed_blackframe] frame:8 pblack:100",
          "[Parsed_blackframe] frame:9 pblack:100",
          "frame=   10 fps=0.0",
        ].join("\n"),
        exitCode: 0,
      }),
    });
    const result = await validate({
      bytes: Buffer.from("fake-video"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("black_frame_dominant");
  });

  it("rejects decode errors from non-zero ffmpeg even without black_duration", async () => {
    const validate = createMediaQualityValidator({
      mode: "on",
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "2.0";
        return "video\n";
      },
      runFfmpeg: async () => ({
        stdout: "",
        stderr: "Error while decoding stream #0:0: Invalid data found when processing input",
        exitCode: 1,
      }),
    });
    const result = await validate({
      bytes: Buffer.from("corrupt"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("undecodable");
  });

  it("required mode fails closed when ffmpeg tool is missing", async () => {
    const validate = createMediaQualityValidator({
      mode: "required",
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "2.0";
        return "video\n";
      },
      runFfmpeg: async () => ({
        stdout: "",
        stderr: "ffmpeg not found",
        exitCode: null,
        toolMissing: true,
      }),
    });
    const result = await validate({
      bytes: Buffer.from("fake"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("tool_missing");
  });

  it("on mode soft-skips black-frame tool missing (not quality verified)", async () => {
    const validate = createMediaQualityValidator({
      mode: "on",
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "2.0";
        return "video\n";
      },
      runFfmpeg: async () => ({
        stdout: "",
        stderr: "ffmpeg not found",
        exitCode: null,
        toolMissing: true,
      }),
    });
    const result = await validate({
      bytes: Buffer.from("fake"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blackFrameCheckSkipped).toBe(true);
  });

  it("passes healthy video with audio", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async (args) => {
        if (args.includes("format=duration")) return "4.0";
        return "video\naudio\n";
      },
      runFfmpeg: async () => ({
        stdout: "",
        stderr: "frame=   10 fps=0.0",
        exitCode: 0,
      }),
    });
    const result = await validate({
      bytes: Buffer.from("fake-video"),
      mimeType: "video/mp4",
    });
    expect(result).toMatchObject({ ok: true, durationSec: 4, hasAudio: true });
  });

  it("fails closed on canceled signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const validate = createMediaQualityValidator();
    const result = await validate({
      bytes: Buffer.from("x"),
      mimeType: "video/mp4",
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("canceled");
  });

  it("rejects undecodable probe failures", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async () => {
        throw new Error("Invalid data found when processing input");
      },
    });
    const result = await validate({
      bytes: Buffer.from("not-a-video"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("undecodable");
  });

  it("maps ffprobe ENOENT to tool_missing", async () => {
    const validate = createMediaQualityValidator({
      runFfprobe: async () => {
        const err = new Error("spawn ffprobe ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      },
    });
    const result = await validate({
      bytes: Buffer.from("x"),
      mimeType: "video/mp4",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("tool_missing");
  });
});
