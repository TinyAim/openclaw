import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import {
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createAgentToolsSandboxContext } from "../../test-helpers/agent-tools-sandbox-context.js";
import { createContainerWorkspaceSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { hydratePromptMediaMessages } from "./images.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const SESSION = "agent:camera:reference-fixture";
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
  "base64",
);
function largePng(): Buffer {
  // A legal ancillary PNG chunk crosses native offload's 2 MB boundary without
  // making the decoded raster large or relying on a real user's reference.
  const type = Buffer.from("tEXt");
  const data = Buffer.concat([Buffer.from("fixture\0"), Buffer.alloc(2_100_000, 97)]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([TINY_PNG.subarray(0, -12), size, type, data, crc, TINY_PNG.subarray(-12)]);
}

describe("current native offloaded image input", () => {
  let root: string, inbound: string, workspace: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-current-image-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    inbound = path.join(root, "state", "media", "inbound");
    workspace = path.join(root, "sandbox");
    await fs.mkdir(inbound, { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  function input(media: MediaFact[]): Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0] {
    return {
      attempt: {
        config: {},
        sessionKey: SESSION,
        model: { input: ["text", "image"] },
        imageOrder: ["offloaded" as const],
        media,
      },
      mediaOwnerAgentId: "camera",
      effectiveFsWorkspaceOnly: true,
      effectiveWorkspace: workspace,
      prompt: "Build the scene from the attached reference.",
      skipPromptSubmission: false,
      sandbox: createAgentToolsSandboxContext({
        workspaceDir: workspace,
        sessionKey: SESSION,
        fsBridge: createContainerWorkspaceSandboxFsBridge(workspace),
        workspaceAccess: "none",
      }),
    };
  }
  function fact(name = "reference.png"): MediaFact {
    return {
      path: path.join(inbound, name),
      url: `media://inbound/${name}`,
      contentType: "image/png",
      kind: "image",
    };
  }
  it("loads a >2 MB original into the prepared sandbox for initial and repair turns", async () => {
    const bytes = largePng();
    expect(bytes.length).toBeGreaterThan(2_000_000);
    await fs.writeFile(path.join(inbound, "reference.png"), bytes);
    const media = [fact()];
    for (let repair = 0; repair < 3; repair++) {
      const result = await prepareEmbeddedAttemptPromptExecution(input(media));
      expect(result.images).toHaveLength(1);
      expect(result.failedMediaCount).toBe(0);
    }
    expect(await fs.readFile(path.join(inbound, "reference.png"))).toEqual(bytes);
    expect(media[0]?.url).toBe("media://inbound/reference.png");
  });
  it("loads canonical URI-only >2 MB media for initial and repair turns without persisting a host path", async () => {
    const bytes = largePng();
    await fs.writeFile(path.join(inbound, "reference.png"), bytes);
    const canonical = {
      url: "media://inbound/reference.png",
      kind: "image" as const,
      contentType: "image/png",
      sizeBytes: bytes.length,
    };
    const params = input([fact("stale-ingress.png")]);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "stale input", media: [fact("stale-recorder.png")] },
      resolveInput: () => ({
        text: "reference scene",
        media: [canonical],
        mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
        timestamp: 123,
      }),
      target: () => {
        throw new Error("image preparation must not persist the transcript");
      },
    });
    params.attempt.userTurnTranscriptRecorder = recorder;
    const message = (await recorder.resolveMessage())!;
    const serialized = JSON.stringify(message);
    const persisted = readPersistedMediaFacts(message);
    expect(persisted?.[0]?.path).toBeUndefined();

    for (let repair = 0; repair < 3; repair++) {
      const result = await prepareEmbeddedAttemptPromptExecution(params);
      expect(result.images).toEqual([
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ]);
      expect(result.failedMediaCount).toBe(0);
      expect(readRuntimePromptMediaFacts(message)?.[0]).toMatchObject({
        staged: true,
        workspaceDir: workspace,
      });
      expect(readPersistedMediaFacts(message)).toEqual(persisted);
      expect(JSON.stringify(message)).toBe(serialized);
    }
    expect(await fs.readFile(path.join(inbound, "reference.png"))).toEqual(bytes);
  });
  it("fails closed for a missing canonical URI-only current image", async () => {
    const media = [{ url: "media://inbound/missing.png", kind: "image" as const }];
    await expect(prepareEmbeddedAttemptPromptExecution(input(media))).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(media[0]).not.toHaveProperty("path");
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("rejects a canonical URI-only image from another admitted session", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    const params = input([{ url: "media://inbound/reference.png", kind: "image" }]);
    params.sandbox!.sessionKey = "agent:sibling:reference-fixture";
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("rejects an escaping URI-only reference before publishing sandbox input", async () => {
    await fs.writeFile(path.join(root, "private.png"), TINY_PNG);
    const params = input([
      { url: "media://inbound/%2e%2e%2fprivate.png", kind: "image", contentType: "image/png" },
    ]);
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("fails before model submission when a required offloaded image is missing", async () => {
    await expect(
      prepareEmbeddedAttemptPromptExecution(input([fact("missing.png")])),
    ).rejects.toMatchObject({ code: "IMAGE_INPUT_UNAVAILABLE" });
  });
  it("stages canonical recorder facts and replays staged aliases without changing transcript bytes", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), largePng());
    const params = input([fact("stale-ingress.png")]);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "stale input", media: [fact("stale-recorder.png")] },
      resolveInput: () => ({
        text: "reference scene",
        media: [fact()],
        mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
        timestamp: 123,
      }),
      target: () => {
        throw new Error("image preparation must not persist the transcript");
      },
    });
    params.attempt.userTurnTranscriptRecorder = recorder;
    const message = (await recorder.resolveMessage())!;
    const serialized = JSON.stringify(message);

    const result = await prepareEmbeddedAttemptPromptExecution(params);
    const runtime = readRuntimePromptMediaFacts(message);
    expect(result.images).toHaveLength(1);
    expect(runtime?.[0]).toMatchObject({ staged: true, workspaceDir: workspace });
    expect(runtime?.[0]?.path).toMatch(
      /^media\/inbound\/openclaw-staged-[^/]+\/input-reference\.png$/,
    );
    expect(runtime?.[0]?.url).toBe(runtime?.[0]?.path);
    expect(JSON.stringify(message)).toBe(serialized);
    expect(readPersistedMediaFacts(message)?.[0]?.url).toBe("media://inbound/reference.png");
    // Runtime replay must use the admitted private copy even if the original
    // managed store entry disappears after preparation.
    await fs.unlink(path.join(inbound, "reference.png"));
    const replayed = await hydratePromptMediaMessages([message], {
      workspaceDir: workspace,
      model: params.attempt.model,
      workspaceOnly: true,
      sandbox: { root: workspace, bridge: params.sandbox!.fsBridge! },
    });
    const replayedUser = replayed.find((candidate) => candidate.role === "user");
    expect(replayedUser?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
    expect(JSON.stringify(message)).toBe(serialized);
  });
  it("rejects a mismatched admitted sandbox session before publishing input files", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    const params = input([fact()]);
    params.sandbox!.sessionKey = "agent:sibling:reference-fixture";
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("requires the sandbox bridge instead of falling back to host image reads", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    const params = input([fact()]);
    params.sandbox!.fsBridge = undefined;
    params.effectiveFsWorkspaceOnly = false;
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("rejects current staged facts owned by another sandbox workspace", async () => {
    const media = [
      {
        path: "media/inbound/reference.png",
        url: "media/inbound/reference.png",
        contentType: "image/png",
        staged: true,
        workspaceDir: path.join(root, "sibling"),
      },
    ];
    await expect(prepareEmbeddedAttemptPromptExecution(input(media))).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("fails the complete current input when only one of two images can be staged", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    const media = [fact(), fact("missing.png")];
    const params = input(media);
    params.attempt.imageOrder = ["offloaded", "offloaded"];
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(media.every((entry) => entry.staged !== true)).toBe(true);
  });
  it("rejects an inbound symlink outside the managed media root", async () => {
    const outside = path.join(root, "private.png");
    await fs.writeFile(outside, TINY_PNG);
    await fs.symlink(outside, path.join(inbound, "reference.png"));
    await expect(prepareEmbeddedAttemptPromptExecution(input([fact()]))).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("rejects an unreadable private copy instead of submitting image-free text", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    const params = input([fact()]);
    params.sandbox!.fsBridge!.readFile = async () => {
      throw new Error("sandbox read denied");
    };
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toMatchObject({
      code: "IMAGE_INPUT_UNAVAILABLE",
    });
  });
  it("rejects a non-equivalent managed URL even when its old sandbox image is readable", async () => {
    const other = createSolidPngBuffer(1, 1, { r: 0, g: 0, b: 255 });
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    await fs.writeFile(path.join(inbound, "other.png"), other);
    await fs.mkdir(path.join(workspace, "media", "inbound"), { recursive: true });
    await fs.writeFile(path.join(workspace, "media", "inbound", "other.png"), other);
    await expect(
      prepareEmbeddedAttemptPromptExecution(
        input([{ ...fact(), url: "media://inbound/other.png" }]),
      ),
    ).rejects.toMatchObject({ code: "IMAGE_INPUT_UNAVAILABLE" });
  });
  it("stages a canonical new offload beside an already available inline image", async () => {
    const bytes = largePng();
    await fs.writeFile(path.join(inbound, "reference.png"), bytes);
    const media = [fact("inline-expired.png"), fact()];
    const params = input(media);
    const inline = {
      type: "image" as const,
      data: TINY_PNG.toString("base64"),
      mimeType: "image/png",
    };
    params.attempt.images = [inline];
    params.attempt.imageOrder = ["inline"];
    params.attempt.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: {
        text: "compare both references",
        media,
        mediaImageLayout: {
          slots: [
            { kind: "inline", factIndex: 0 },
            { kind: "offloaded", factIndex: 1 },
          ],
        },
      },
      target: () => {
        throw new Error("image preparation must not persist the transcript");
      },
    });
    const result = await prepareEmbeddedAttemptPromptExecution(params);
    expect(result.images).toEqual([
      inline,
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ]);
    expect(result.failedMediaCount).toBe(0);
  });
  it("keeps the normal inline small-image path without publishing a private copy", async () => {
    const params = input([fact()]);
    params.attempt.images = [
      { type: "image", data: TINY_PNG.toString("base64"), mimeType: "image/png" },
    ];
    params.attempt.imageOrder = ["inline"];
    const result = await prepareEmbeddedAttemptPromptExecution(params);
    expect(result.images).toEqual(params.attempt.images);
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("keeps canonical layout-suppressed images optional without staging their missing source", async () => {
    const params = input([fact("missing.png")]);
    params.attempt.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
      input: {
        text: "the image was described upstream",
        media: [fact("missing.png")],
        mediaImageLayout: { slots: [], suppressedFactIndexes: [0] },
      },
      target: () => {
        throw new Error("image preparation must not persist the transcript");
      },
    });
    const result = await prepareEmbeddedAttemptPromptExecution(params);
    expect(result.images).toEqual([]);
    expect(result.failedMediaCount).toBe(0);
    expect(await fs.readdir(workspace)).toEqual([]);
  });
  it("preserves cancellation before staging without publishing input files", async () => {
    await fs.writeFile(path.join(inbound, "reference.png"), TINY_PNG);
    const params = input([fact()]);
    const controller = new AbortController();
    const reason = new Error("caller cancelled image input");
    controller.abort(reason);
    params.attempt.abortSignal = controller.signal;
    await expect(prepareEmbeddedAttemptPromptExecution(params)).rejects.toBe(reason);
    expect(await fs.readdir(workspace)).toEqual([]);
  });
});
