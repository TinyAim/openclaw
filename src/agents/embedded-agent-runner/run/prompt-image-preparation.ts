import path from "node:path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import {
  isImageMediaFact,
  readPersistedMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { resolveInboundMediaReference } from "../../../media/media-reference.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { detectAndLoadPromptImages } from "./images.js";
import { resolveMediaFactLocalRef } from "./images.media-refs.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type PromptExecutionAttempt = Pick<
  RunEmbeddedAgentParams,
  | "config"
  | "imageOrder"
  | "images"
  | "media"
  | "userTurnTranscriptRecorder"
  | "workspaceDir"
  | "sessionKey"
  | "sandboxSessionKey"
  | "abortSignal"
> & { model: { input?: string[] } };
type PromptImageResult = Awaited<ReturnType<typeof detectAndLoadPromptImages>>;

/** Prepares ordered prompt images using the admitted media and filesystem policy. */
export async function prepareEmbeddedAttemptPromptExecution(input: {
  attempt: PromptExecutionAttempt;
  /** Prepared run owner; scopes media roots without re-resolving session identity. */
  mediaOwnerAgentId: string;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  prompt: string;
  sandbox?: SandboxContext | null;
  skipPromptSubmission: boolean;
  pluginHarness?: boolean;
}): Promise<
  PromptImageResult & {
    imageOrder?: PromptExecutionAttempt["imageOrder"];
    media?: PromptExecutionAttempt["media"];
  }
> {
  if (input.skipPromptSubmission) {
    return {
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  const { attempt } = input;
  let hasCurrentImages =
    Boolean(attempt.images?.length) ||
    Boolean(
      attempt.media?.some((fact) => isImageMediaFact(fact) && fact.hydrationSuppressed !== true),
    );
  const prepareCurrentMedia = async (
    media: readonly MediaFact[],
    missingImageFactIndexes: ReadonlySet<number>,
  ) => {
    hasCurrentImages = Boolean(attempt.images?.length) || missingImageFactIndexes.size > 0;
    const sandbox = input.sandbox;
    // Existing inline bytes need no host copy. Only managed offloads cross
    // from the Gateway store into the exact already-admitted sandbox.
    if (!sandbox?.enabled) {
      return media;
    }
    for (const [index, fact] of media.entries()) {
      if (
        isImageMediaFact(fact) &&
        missingImageFactIndexes.has(index) &&
        fact.staged === true &&
        fact.workspaceDir &&
        path.resolve(fact.workspaceDir) !== path.resolve(sandbox.workspaceDir)
      ) {
        throw currentImageUnavailable();
      }
    }
    const entries = media.flatMap((fact, index) =>
      isImageMediaFact(fact) &&
      missingImageFactIndexes.has(index) &&
      [fact.path, fact.url].some((value) => value?.startsWith("media://inbound/"))
        ? [{ index, fact }]
        : [],
    );
    if (entries.length === 0) {
      return media;
    }
    for (const { fact } of entries) {
      if (fact.path && fact.url?.startsWith("media://inbound/")) {
        const [pathRef, urlRef] = await Promise.all([
          resolveInboundMediaReference(fact.path).catch(() => null),
          resolveInboundMediaReference(fact.url).catch(() => null),
        ]);
        if (!pathRef || !urlRef || pathRef.id !== urlRef.id) {
          throw currentImageUnavailable();
        }
      }
    }
    const expectedSession = attempt.sandboxSessionKey ?? attempt.sessionKey;
    if (
      !expectedSession ||
      expectedSession !== sandbox.sessionKey ||
      !sandbox.fsBridge ||
      !attempt.config
    ) {
      throw currentImageUnavailable();
    }
    attempt.abortSignal?.throwIfAborted();
    // Keep the staging runtime lazy for the common inline/text-only path.
    const { stageSandboxMedia } = await import("../../../auto-reply/reply/stage-sandbox-media.js");
    // Canonical persisted facts may omit host paths. Adapt only this transient
    // context to the path-based staging helper; existing paths retain ownership.
    const ctx = {
      media: entries.map(({ fact }) =>
        fact.path === undefined && fact.url?.startsWith("media://inbound/")
          ? { ...fact, path: fact.url }
          : fact,
      ),
    };
    try {
      const result = await stageSandboxMedia({
        ctx,
        sessionCtx: ctx,
        cfg: attempt.config,
        agentId: input.mediaOwnerAgentId,
        sessionKey: expectedSession,
        workspaceDir: sandbox.agentWorkspaceDir,
        preparedSandbox: sandbox,
        abortSignal: attempt.abortSignal,
      });
      attempt.abortSignal?.throwIfAborted();
      if (result.staged.size !== entries.length) {
        throw currentImageUnavailable();
      }
      const prepared = [...media];
      for (const [i, entry] of entries.entries()) {
        const fact = ctx.media[i];
        const stagedPath = result.staged.get(i);
        if (
          !fact ||
          !stagedPath ||
          fact.staged !== true ||
          fact.workspaceDir !== sandbox.workspaceDir ||
          fact.path !== stagedPath ||
          resolveMediaFactLocalRef(fact)?.resolved !== stagedPath
        ) {
          throw currentImageUnavailable();
        }
        prepared[entry.index] = { ...fact, url: stagedPath };
      }
      return prepared;
    } catch (error) {
      attempt.abortSignal?.throwIfAborted();
      throw currentImageUnavailable(error);
    }
  };
  const result = await detectAndLoadPromptImages({
    prompt: input.prompt,
    workspaceDir: input.effectiveWorkspace,
    agentWorkspaceDir: attempt.workspaceDir,
    model: attempt.model,
    existingImages: attempt.images,
    imageOrder: attempt.imageOrder,
    media: attempt.media,
    prepareCurrentMedia,
    userTurnTranscriptRecorder: attempt.userTurnTranscriptRecorder,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
    workspaceOnly: input.effectiveFsWorkspaceOnly,
    localRoots: input.effectiveFsWorkspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(attempt.config ?? {}, input.mediaOwnerAgentId),
    sandbox:
      input.sandbox?.enabled && input.sandbox.fsBridge
        ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
        : undefined,
  });
  if (!input.pluginHarness && hasCurrentImages && result.failedMediaCount > 0) {
    throw currentImageUnavailable();
  }
  if (!input.pluginHarness) {
    return result;
  }
  if (result.failedMediaCount) {
    throw new Error(
      `failed to hydrate ${result.failedMediaCount} structured image attachment(s) for plugin harness input`,
    );
  }
  const message = await attempt.userTurnTranscriptRecorder?.resolveMessage();
  const media = ((message ? readPersistedMediaFacts(message) : undefined) ?? attempt.media)?.filter(
    (fact) => !isImageMediaFact(fact),
  );
  return {
    ...result,
    imageOrder: result.images.length ? result.images.map(() => "inline" as const) : undefined,
    // Images are already inline; native harnesses still need admitted file sources.
    media: media?.length ? media : undefined,
  };
}

function currentImageUnavailable(cause?: unknown): Error {
  return Object.assign(
    new Error("Current image input could not be loaded; model submission was not started.", {
      cause,
    }),
    { code: "IMAGE_INPUT_UNAVAILABLE" },
  );
}
