/** Authenticated ACK-only Spatial reference render relay. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendGatewayAuthFailure,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { getBearerToken, getHeader } from "./http-utils.js";

export const MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH =
  "/v1/runtime/media-studio/spatial-reference/render" as const;
export const MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH =
  "/v1/runtime/media-studio/spatial-reference/render/cancel" as const;
export const SPATIAL_REFERENCE_RENDER_CONTRACT_V1 = "spatial_reference_render/v1" as const;
export const SPATIAL_REFERENCE_RENDER_CONTRACT_V2 = "spatial_reference_render/v2" as const;
type ContractVersion =
  | typeof SPATIAL_REFERENCE_RENDER_CONTRACT_V1
  | typeof SPATIAL_REFERENCE_RENDER_CONTRACT_V2;
const MAX_BODY_BYTES = 1024 * 1024;

type Vector3 = { x: number; y: number; z: number };
type ArtifactGrant = {
  grantToken: string;
  purpose: "source_download" | "output_upload";
  artifactId?: string;
  expiresAt?: string;
  sha256?: string;
  mimeType?: string;
  slot?: string;
  ordinal?: number;
  sourceTimeMs?: number;
};

type SpatialReferenceRelayDispatchBase = {
  kind: "media_studio.spatial_reference_render";
  contractVersion: ContractVersion;
  workspaceId: string;
  runtimeId: string;
  projectId: string;
  shotId: string;
  taskId: string;
  materializationId: string;
  runtimeIdempotencyKey: string;
  requestId: string;
  attempt: number;
  dispatchAttemptId: string;
  sequence: number;
  leaseExpiresAt: string;
  intentFingerprint: string;
  executionFingerprint: string;
  blueprint: {
    blueprintId: string;
    version: number;
    blueprintDigest: string;
    frameAspectRatio: number;
    camera: {
      position: Vector3;
      targetPoint: Vector3;
      focalLengthMm: number;
      sensorWidthMm: number;
    };
    nodes: Array<{
      nodeId: string;
      kind: string;
      label?: string;
      primitiveType?: string;
      propType?: string;
      appearance?: { colorToken?: string; materialPreset?: string };
      position: Vector3;
      orientationQuaternion?: Vector3 & { w: number };
      scale?: Vector3;
    }>;
    environmentCrop?: { x: number; y: number; width: number; height: number };
  };
  renderIntent: {
    profile: "proxy_previs" | "reference_composite";
    width: number;
    height: number;
    fitMode?: "cover" | "contain";
    backgroundPolicy: "environment_plate" | "neutral_studio" | "transparent";
    rendererContractVersion: string;
    rendererBuildDigest: string;
    renderSpecDigest: string;
  };
  environmentRevisionId?: string;
  environmentRevisionChecksum?: string;
  sourceGrants: ArtifactGrant[];
  /** Required only by legacy v1; v2 can terminal-handoff finalized output. */
  outputUploadGrant?: ArtifactGrant;
  callback: { path: string; controlApiBaseUrl?: string };
};

type SpatialReferenceExpectedOutput = {
  slot:
    | "composition_frame"
    | "motion_reference_video"
    | "start_frame"
    | "end_frame"
    | "topdown_frame"
    | "keyframe";
  ordinal: number;
  artifactId: string;
  mimeType: "image/png" | "video/mp4";
  sourceTimeMs?: number;
};

type SpatialReferenceKnownFinalizedReceipt = SpatialReferenceExpectedOutput & {
  size: number;
  sha256Hex: string;
  storageKey: string;
};

export type SpatialReferenceRelayMotionFrame = {
  timeMs: number;
  snapshotDigest: string;
  camera: SpatialReferenceRelayDispatchBase["blueprint"]["camera"];
  nodes: SpatialReferenceRelayDispatchBase["blueprint"]["nodes"];
};

export type SpatialReferenceRelayDispatch =
  | (SpatialReferenceRelayDispatchBase & {
      contractVersion: typeof SPATIAL_REFERENCE_RENDER_CONTRACT_V1;
      outputUploadGrant: ArtifactGrant;
      motionReference?: never;
      motionReferenceUploadGrant?: never;
      outputUploadGrants?: never;
      expectedOutputs?: never;
      knownFinalizedReceipts?: never;
    })
  | (SpatialReferenceRelayDispatchBase & {
      contractVersion: typeof SPATIAL_REFERENCE_RENDER_CONTRACT_V2;
      motionReference: {
        schemaVersion: 1;
        fps: 12;
        sourceDurationMs: number;
        encodedDurationMs: number;
        evaluatorVersion: string;
        frames: SpatialReferenceRelayMotionFrame[];
        referenceFrames?: Array<{
          slot: "start_frame" | "end_frame" | "topdown_frame" | "keyframe";
          ordinal: number;
          sourceTimeMs?: number;
          snapshotDigest: string;
          camera: SpatialReferenceRelayMotionFrame["camera"];
          nodes: SpatialReferenceRelayMotionFrame["nodes"];
        }>;
      };
      /** Full frozen set, including outputs that already have a final receipt. */
      expectedOutputs: SpatialReferenceExpectedOutput[];
      /** Sparse: grants exist only for outputs currently missing. */
      outputUploadGrant?: ArtifactGrant;
      motionReferenceUploadGrant?: ArtifactGrant;
      outputUploadGrants?: ArtifactGrant[];
      /** Server-read-back receipt subset, never a bearer capability. */
      knownFinalizedReceipts?: SpatialReferenceKnownFinalizedReceipt[];
    });

export type SpatialReferenceRelayDispatchAck = {
  ok: true;
  accepted: true;
  deferredSettlement: true;
  runtimeId: string;
  executionId: string;
  taskId: string;
  materializationId: string;
  attempt: number;
  dispatchAttemptId: string;
  sequence: number;
  leaseExpiresAt: string;
  intentFingerprint: string;
  executionFingerprint: string;
  blueprintDigest: string;
  environmentRevisionId?: string;
  environmentRevisionChecksum?: string;
};

export interface MediaStudioSpatialReferenceRenderHttpExecutor {
  dispatch(
    input: SpatialReferenceRelayDispatch,
  ): SpatialReferenceRelayDispatchAck | Promise<SpatialReferenceRelayDispatchAck>;
  cancel(input: { runtimeIdempotencyKey: string; dispatchAttemptId: string }):
    | {
        acknowledged: boolean;
        terminal: boolean;
      }
    | Promise<{ acknowledged: boolean; terminal: boolean }>;
}

export type MediaStudioSpatialReferenceRenderHttpOptions = {
  auth: ResolvedGatewayAuth;
  executor: MediaStudioSpatialReferenceRenderHttpExecutor;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  maxBodyBytes?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function vector(value: unknown): Vector3 | undefined {
  const raw = record(value);
  const x = number(raw?.x);
  const y = number(raw?.y);
  const z = number(raw?.z);
  return x === undefined || y === undefined || z === undefined ? undefined : { x, y, z };
}

function quaternion(value: unknown): (Vector3 & { w: number }) | undefined {
  const raw = record(value);
  const xyz = vector(raw);
  const w = number(raw?.w);
  return xyz && w !== undefined ? { ...xyz, w } : undefined;
}

function appearance(value: unknown): { colorToken?: string; materialPreset?: string } | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const colorToken = text(raw.colorToken);
  const materialPreset = text(raw.materialPreset);
  return colorToken || materialPreset
    ? { ...(colorToken ? { colorToken } : {}), ...(materialPreset ? { materialPreset } : {}) }
    : undefined;
}

function artifactGrant(
  value: unknown,
  purpose: ArtifactGrant["purpose"],
): ArtifactGrant | undefined {
  const raw = record(value);
  const grantToken = text(raw?.grantToken);
  const artifactId = text(raw?.artifactId);
  if (!raw || raw.purpose !== purpose || !grantToken) return undefined;
  return {
    grantToken,
    purpose,
    ...(artifactId ? { artifactId } : {}),
    ...(text(raw.expiresAt) ? { expiresAt: text(raw.expiresAt) } : {}),
    ...(text(raw.sha256) ? { sha256: text(raw.sha256) } : {}),
    ...(text(raw.mimeType) ? { mimeType: text(raw.mimeType) } : {}),
    ...(text(raw.slot) ? { slot: text(raw.slot) } : {}),
    ...(Number.isInteger(raw.ordinal) ? { ordinal: raw.ordinal as number } : {}),
    ...(Number.isInteger(raw.sourceTimeMs) ? { sourceTimeMs: raw.sourceTimeMs as number } : {}),
  };
}

export function parseSpatialReferenceRelayDispatch(
  value: unknown,
): SpatialReferenceRelayDispatch | null {
  const raw = record(value);
  if (
    !raw ||
    raw.kind !== "media_studio.spatial_reference_render" ||
    (raw.contractVersion !== SPATIAL_REFERENCE_RENDER_CONTRACT_V1 &&
      raw.contractVersion !== SPATIAL_REFERENCE_RENDER_CONTRACT_V2) ||
    "png" in raw ||
    "pngBase64" in raw ||
    "bytes" in raw
  ) {
    return null;
  }
  const blueprint = record(raw.blueprint);
  const camera = record(blueprint?.camera);
  const renderIntent = record(raw.renderIntent);
  const callback = record(raw.callback);
  const sourceValues = Array.isArray(raw.sourceGrants) ? raw.sourceGrants : null;
  const sourceGrants = sourceValues
    ?.map((grant) => artifactGrant(grant, "source_download"))
    .filter((grant): grant is ArtifactGrant => Boolean(grant));
  let outputUploadGrant =
    raw.outputUploadGrant === undefined
      ? undefined
      : artifactGrant(raw.outputUploadGrant, "output_upload");
  const parseNodes = (
    rawNodes: unknown,
  ): SpatialReferenceRelayDispatchBase["blueprint"]["nodes"] | null => {
    if (!Array.isArray(rawNodes)) return null;
    const nodes = rawNodes.map((value) => {
      const node = record(value);
      const position = vector(node?.position);
      const scale = vector(node?.scale);
      const orientationQuaternion = quaternion(node?.orientationQuaternion);
      const nodeAppearance = appearance(node?.appearance);
      return node && text(node.nodeId) && text(node.kind) && position
        ? {
            nodeId: text(node.nodeId),
            kind: text(node.kind),
            ...(text(node.label) ? { label: text(node.label) } : {}),
            ...(text(node.primitiveType) ? { primitiveType: text(node.primitiveType) } : {}),
            ...(text(node.propType) ? { propType: text(node.propType) } : {}),
            ...(nodeAppearance ? { appearance: nodeAppearance } : {}),
            position,
            ...(orientationQuaternion ? { orientationQuaternion } : {}),
            ...(scale ? { scale } : {}),
          }
        : undefined;
    });
    return nodes.some((node) => !node)
      ? null
      : (nodes as SpatialReferenceRelayDispatchBase["blueprint"]["nodes"]);
  };
  const nodes = parseNodes(blueprint?.nodes);
  const position = vector(camera?.position);
  const targetPoint = vector(camera?.targetPoint);
  const focalLengthMm = number(camera?.focalLengthMm);
  const sensorWidthMm = number(camera?.sensorWidthMm);
  const crop = record(blueprint?.environmentCrop);
  const cropValue =
    crop &&
    number(crop.x) !== undefined &&
    number(crop.y) !== undefined &&
    number(crop.width) !== undefined &&
    number(crop.height) !== undefined
      ? {
          x: number(crop.x)!,
          y: number(crop.y)!,
          width: number(crop.width)!,
          height: number(crop.height)!,
        }
      : undefined;
  const requiredText = [
    raw.workspaceId,
    raw.runtimeId,
    raw.projectId,
    raw.shotId,
    raw.taskId,
    raw.materializationId,
    raw.runtimeIdempotencyKey,
    raw.requestId,
    raw.dispatchAttemptId,
    raw.leaseExpiresAt,
    raw.intentFingerprint,
    raw.executionFingerprint,
    blueprint?.blueprintId,
    blueprint?.blueprintDigest,
    renderIntent?.rendererContractVersion,
    renderIntent?.rendererBuildDigest,
    renderIntent?.renderSpecDigest,
    callback?.path,
  ].map(text);
  if (
    requiredText.some((item) => !item) ||
    !Number.isInteger(raw.attempt) ||
    !Number.isInteger(raw.sequence) ||
    !Number.isInteger(blueprint?.version) ||
    number(blueprint?.frameAspectRatio) === undefined ||
    !position ||
    !targetPoint ||
    focalLengthMm === undefined ||
    sensorWidthMm === undefined ||
    !nodes ||
    !sourceValues ||
    sourceGrants?.length !== sourceValues.length ||
    (renderIntent?.profile !== "proxy_previs" && renderIntent?.profile !== "reference_composite") ||
    !Number.isInteger(renderIntent.width) ||
    !Number.isInteger(renderIntent.height) ||
    (renderIntent.backgroundPolicy !== "environment_plate" &&
      renderIntent.backgroundPolicy !== "neutral_studio" &&
      renderIntent.backgroundPolicy !== "transparent")
  ) {
    return null;
  }
  // The predicate above is the only place that accepts a wire contract
  // version. Keep the narrowed value rather than carrying `unknown` into the
  // v2-only parser below.
  const contractVersion = raw.contractVersion as ContractVersion;
  if (contractVersion === SPATIAL_REFERENCE_RENDER_CONTRACT_V1 && !outputUploadGrant?.artifactId) {
    return null;
  }
  if (
    contractVersion === SPATIAL_REFERENCE_RENDER_CONTRACT_V1 &&
    ("motionReference" in raw ||
      "motionReferenceUploadGrant" in raw ||
      "outputUploadGrants" in raw ||
      "expectedOutputs" in raw ||
      "knownFinalizedReceipts" in raw)
  ) {
    return null;
  }
  let motionReference: SpatialReferenceRelayDispatch["motionReference"];
  let motionReferenceUploadGrant: ArtifactGrant | undefined;
  let outputUploadGrants: ArtifactGrant[] | undefined;
  let expectedOutputs: SpatialReferenceExpectedOutput[] | undefined;
  let knownFinalizedReceipts: SpatialReferenceKnownFinalizedReceipt[] | undefined;
  if (contractVersion === SPATIAL_REFERENCE_RENDER_CONTRACT_V2) {
    const rawPlan = record(raw.motionReference);
    const rawFrames = Array.isArray(rawPlan?.frames) ? rawPlan.frames : null;
    const fps = number(rawPlan?.fps);
    const sourceDurationMs = number(rawPlan?.sourceDurationMs);
    const encodedDurationMs = number(rawPlan?.encodedDurationMs);
    if (
      rawPlan?.schemaVersion !== 1 ||
      fps !== 12 ||
      !Number.isInteger(sourceDurationMs) ||
      !Number.isInteger(encodedDurationMs) ||
      !text(rawPlan?.evaluatorVersion) ||
      !rawFrames ||
      rawFrames.length < 1 ||
      rawFrames.length > 120
    ) {
      return null;
    }
    const validSourceDurationMs = sourceDurationMs!;
    const validEncodedDurationMs = encodedDurationMs!;
    const frames: SpatialReferenceRelayMotionFrame[] = [];
    let previousTime = -1;
    for (const rawFrame of rawFrames) {
      const frame = record(rawFrame);
      const frameCamera = record(frame?.camera);
      const framePosition = vector(frameCamera?.position);
      const frameTarget = vector(frameCamera?.targetPoint);
      const frameNodes = parseNodes(frame?.nodes);
      const timeMs = number(frame?.timeMs);
      if (
        !frame ||
        timeMs === undefined ||
        !Number.isInteger(timeMs) ||
        timeMs <= previousTime ||
        !text(frame.snapshotDigest) ||
        !framePosition ||
        !frameTarget ||
        number(frameCamera?.focalLengthMm) === undefined ||
        number(frameCamera?.sensorWidthMm) === undefined ||
        !frameNodes
      ) {
        return null;
      }
      previousTime = timeMs;
      frames.push({
        timeMs,
        snapshotDigest: text(frame.snapshotDigest),
        camera: {
          position: framePosition,
          targetPoint: frameTarget,
          ...(vector(frameCamera?.worldAimTarget)
            ? { worldAimTarget: vector(frameCamera?.worldAimTarget) }
            : {}),
          focalLengthMm: number(frameCamera?.focalLengthMm)!,
          sensorWidthMm: number(frameCamera?.sensorWidthMm)!,
        },
        nodes: frameNodes,
      });
    }
    const rawReferenceFrames = rawPlan?.referenceFrames;
    if (!Array.isArray(rawReferenceFrames) || rawReferenceFrames.length < 3) {
      return null;
    }
    type V2ReferenceFrame = {
      slot: "start_frame" | "end_frame" | "topdown_frame" | "keyframe";
      ordinal: number;
      sourceTimeMs?: number;
      snapshotDigest: string;
      camera: SpatialReferenceRelayMotionFrame["camera"];
      nodes: SpatialReferenceRelayMotionFrame["nodes"];
    };
    const referenceFrames: V2ReferenceFrame[] = [];
    const identities = new Set<string>();
    for (const rawReference of rawReferenceFrames) {
      const reference = record(rawReference);
      const slot = text(reference?.slot);
      const ordinal = number(reference?.ordinal);
      const frameCamera = record(reference?.camera);
      const framePosition = vector(frameCamera?.position);
      const frameTarget = vector(frameCamera?.targetPoint);
      const frameNodes = parseNodes(reference?.nodes);
      const sourceTimeMs = number(reference?.sourceTimeMs);
      if (
        !reference ||
        (slot !== "start_frame" &&
          slot !== "end_frame" &&
          slot !== "topdown_frame" &&
          slot !== "keyframe") ||
        ordinal === undefined ||
        !Number.isInteger(ordinal) ||
        ordinal < 0 ||
        (sourceTimeMs !== undefined &&
          (!Number.isInteger(sourceTimeMs) ||
            sourceTimeMs < 0 ||
            sourceTimeMs > validSourceDurationMs)) ||
        !text(reference.snapshotDigest) ||
        !framePosition ||
        !frameTarget ||
        number(frameCamera?.focalLengthMm) === undefined ||
        number(frameCamera?.sensorWidthMm) === undefined ||
        !frameNodes ||
        identities.has(`${slot}:${ordinal}`)
      )
        return null;
      if (
        (slot === "start_frame" || slot === "end_frame" || slot === "keyframe") &&
        sourceTimeMs === undefined
      )
        return null;
      identities.add(`${slot}:${ordinal}`);
      referenceFrames.push({
        slot,
        ordinal,
        ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
        snapshotDigest: text(reference.snapshotDigest),
        camera: {
          position: framePosition,
          targetPoint: frameTarget,
          ...(vector(frameCamera?.worldAimTarget)
            ? { worldAimTarget: vector(frameCamera?.worldAimTarget) }
            : {}),
          focalLengthMm: number(frameCamera?.focalLengthMm)!,
          sensorWidthMm: number(frameCamera?.sensorWidthMm)!,
        },
        nodes: frameNodes,
      });
    }
    const keyframes = referenceFrames.filter((frame) => frame.slot === "keyframe");
    if (
      keyframes.length > 16 ||
      !referenceFrames.some(
        (frame) => frame.slot === "start_frame" && frame.ordinal === 0 && frame.sourceTimeMs === 0,
      ) ||
      !referenceFrames.some(
        (frame) =>
          frame.slot === "end_frame" &&
          frame.ordinal === 0 &&
          frame.sourceTimeMs === validSourceDurationMs,
      ) ||
      !referenceFrames.some((frame) => frame.slot === "topdown_frame" && frame.ordinal === 0)
    )
      return null;
    const expectedShape: Array<
      Pick<SpatialReferenceExpectedOutput, "slot" | "ordinal" | "mimeType" | "sourceTimeMs">
    > = [
      { slot: "composition_frame", ordinal: 0, mimeType: "image/png" },
      { slot: "motion_reference_video", ordinal: 0, mimeType: "video/mp4" },
      ...referenceFrames.map((frame) => ({
        slot: frame.slot,
        ordinal: frame.ordinal,
        mimeType: "image/png" as const,
        ...(frame.sourceTimeMs === undefined ? {} : { sourceTimeMs: frame.sourceTimeMs }),
      })),
    ];
    const sameOutputIdentity = (
      left: Pick<SpatialReferenceExpectedOutput, "slot" | "ordinal" | "sourceTimeMs">,
      right: Pick<SpatialReferenceExpectedOutput, "slot" | "ordinal" | "sourceTimeMs">,
    ) =>
      left.slot === right.slot &&
      left.ordinal === right.ordinal &&
      left.sourceTimeMs === right.sourceTimeMs;
    const outputFor = (
      candidate: Pick<SpatialReferenceExpectedOutput, "slot" | "ordinal" | "sourceTimeMs">,
    ) => expectedShape.find((expected) => sameOutputIdentity(candidate, expected));
    const rawExpectedOutputs = raw.expectedOutputs;
    if (!Array.isArray(rawExpectedOutputs) || rawExpectedOutputs.length !== expectedShape.length)
      return null;
    const parsedExpectedOutputs: SpatialReferenceExpectedOutput[] = [];
    const expectedKeys = new Set<string>();
    for (const value of rawExpectedOutputs) {
      const candidate = record(value);
      const slot = text(candidate?.slot);
      const ordinal = number(candidate?.ordinal);
      const artifactId = text(candidate?.artifactId);
      const sourceTimeMs =
        candidate?.sourceTimeMs === undefined ? undefined : number(candidate.sourceTimeMs);
      if (
        !candidate ||
        ordinal === undefined ||
        !Number.isInteger(ordinal) ||
        ordinal < 0 ||
        (candidate.sourceTimeMs !== undefined &&
          (!Number.isInteger(sourceTimeMs) || sourceTimeMs! < 0)) ||
        !artifactId ||
        (candidate.mimeType !== "image/png" && candidate.mimeType !== "video/mp4")
      )
        return null;
      const matched = outputFor({
        slot: slot as SpatialReferenceExpectedOutput["slot"],
        ordinal,
        ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
      });
      const key = `${slot}:${ordinal}`;
      if (!matched || matched.mimeType !== candidate.mimeType || expectedKeys.has(key)) return null;
      expectedKeys.add(key);
      parsedExpectedOutputs.push({
        slot: matched.slot,
        ordinal,
        artifactId,
        mimeType: matched.mimeType,
        ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
      });
    }
    if (
      expectedShape.some(
        (expected) => !parsedExpectedOutputs.some((output) => sameOutputIdentity(expected, output)),
      )
    )
      return null;
    const rawOutputGrants = raw.outputUploadGrants === undefined ? [] : raw.outputUploadGrants;
    if (!Array.isArray(rawOutputGrants)) return null;
    const parsedOutputUploadGrants = rawOutputGrants.map((value) =>
      artifactGrant(value, "output_upload"),
    );
    const grantKeys = new Set<string>();
    if (
      parsedOutputUploadGrants.some((grant) => {
        if (
          !grant?.artifactId ||
          !grant.slot ||
          !Number.isInteger(grant.ordinal) ||
          (grant.ordinal ?? -1) < 0
        )
          return true;
        const expected = parsedExpectedOutputs.find((output) =>
          sameOutputIdentity(grant as SpatialReferenceExpectedOutput, output),
        );
        const key = `${grant.slot}:${grant.ordinal}`;
        return (
          !expected ||
          expected.artifactId !== grant.artifactId ||
          expected.mimeType !== grant.mimeType ||
          grant.sourceTimeMs !== expected.sourceTimeMs ||
          grantKeys.has(key) ||
          !grantKeys.add(key)
        );
      })
    )
      return null;
    const namedGrant = (value: unknown, output: { slot: string; ordinal: number }) => {
      if (value === undefined) return undefined;
      const grant = artifactGrant(value, "output_upload");
      const matched = parsedOutputUploadGrants.find(
        (item) =>
          item?.slot === output.slot &&
          item.ordinal === output.ordinal &&
          item.grantToken === grant?.grantToken,
      );
      return grant?.artifactId && matched ? grant : null;
    };
    const parsedCompositionGrant = namedGrant(raw.outputUploadGrant, {
      slot: "composition_frame",
      ordinal: 0,
    });
    const parsedMotionGrant = namedGrant(raw.motionReferenceUploadGrant, {
      slot: "motion_reference_video",
      ordinal: 0,
    });
    if (parsedCompositionGrant === null || parsedMotionGrant === null) return null;
    const rawReceipts = raw.knownFinalizedReceipts === undefined ? [] : raw.knownFinalizedReceipts;
    if (!Array.isArray(rawReceipts)) return null;
    const receiptKeys = new Set<string>();
    const parsedReceipts: SpatialReferenceKnownFinalizedReceipt[] = [];
    for (const value of rawReceipts) {
      const receipt = record(value);
      const slot = text(receipt?.slot);
      const ordinal = number(receipt?.ordinal);
      const artifactId = text(receipt?.artifactId);
      const storageKey = text(receipt?.storageKey);
      const sha256Hex = text(receipt?.sha256Hex).toLowerCase();
      const size = number(receipt?.size);
      const sourceTimeMs =
        receipt?.sourceTimeMs === undefined ? undefined : number(receipt.sourceTimeMs);
      if (
        !receipt ||
        ordinal === undefined ||
        !Number.isInteger(ordinal) ||
        ordinal < 0 ||
        !artifactId ||
        !storageKey ||
        !Number.isSafeInteger(size) ||
        size! < 1 ||
        !/^[a-f0-9]{64}$/.test(sha256Hex) ||
        (receipt.sourceTimeMs !== undefined &&
          (!Number.isInteger(sourceTimeMs) || sourceTimeMs! < 0)) ||
        (receipt.mimeType !== "image/png" && receipt.mimeType !== "video/mp4")
      )
        return null;
      const expected = parsedExpectedOutputs.find((output) =>
        sameOutputIdentity(
          {
            slot: slot as SpatialReferenceExpectedOutput["slot"],
            ordinal,
            ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
          },
          output,
        ),
      );
      const key = `${slot}:${ordinal}`;
      if (
        !expected ||
        expected.artifactId !== artifactId ||
        expected.mimeType !== receipt.mimeType ||
        receiptKeys.has(key) ||
        grantKeys.has(key)
      )
        return null;
      receiptKeys.add(key);
      parsedReceipts.push({
        slot: expected.slot,
        ordinal,
        artifactId,
        mimeType: expected.mimeType,
        size: size!,
        sha256Hex,
        storageKey,
        ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
      });
    }
    outputUploadGrant = parsedCompositionGrant ?? undefined;
    motionReferenceUploadGrant = parsedMotionGrant ?? undefined;
    motionReference = {
      schemaVersion: 1,
      fps: 12,
      sourceDurationMs: validSourceDurationMs,
      encodedDurationMs: validEncodedDurationMs,
      evaluatorVersion: text(rawPlan.evaluatorVersion),
      frames,
      referenceFrames,
    };
    expectedOutputs = parsedExpectedOutputs;
    outputUploadGrants = parsedOutputUploadGrants as ArtifactGrant[];
    knownFinalizedReceipts = parsedReceipts;
  }
  const parsedBase = {
    ...(raw as unknown as SpatialReferenceRelayDispatch),
    blueprint: {
      ...(blueprint as unknown as SpatialReferenceRelayDispatch["blueprint"]),
      camera: {
        position,
        targetPoint,
        focalLengthMm: focalLengthMm!,
        sensorWidthMm: sensorWidthMm!,
      },
      nodes,
      ...(cropValue ? { environmentCrop: cropValue } : {}),
    },
    sourceGrants: sourceGrants!,
    outputUploadGrant,
  };
  if (contractVersion === SPATIAL_REFERENCE_RENDER_CONTRACT_V2) {
    if (!motionReference || !expectedOutputs || !outputUploadGrants) return null;
    return {
      ...parsedBase,
      contractVersion: SPATIAL_REFERENCE_RENDER_CONTRACT_V2,
      motionReference,
      expectedOutputs,
      outputUploadGrants,
      ...(motionReferenceUploadGrant ? { motionReferenceUploadGrant } : {}),
      ...(knownFinalizedReceipts?.length ? { knownFinalizedReceipts } : {}),
    } as Extract<
      SpatialReferenceRelayDispatch,
      { contractVersion: typeof SPATIAL_REFERENCE_RENDER_CONTRACT_V2 }
    >;
  }
  return {
    ...parsedBase,
    contractVersion: SPATIAL_REFERENCE_RENDER_CONTRACT_V1,
  } as Extract<
    SpatialReferenceRelayDispatch,
    { contractVersion: typeof SPATIAL_REFERENCE_RENDER_CONTRACT_V1 }
  >;
}

function connectAuth(req: IncomingMessage) {
  const token = getBearerToken(req);
  const password = getHeader(req, "x-wisclaw-gateway-password");
  return token ? { token } : password ? { password } : null;
}

export async function handleMediaStudioSpatialReferenceRenderHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: MediaStudioSpatialReferenceRenderHttpOptions,
): Promise<boolean> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (
    path !== MEDIA_STUDIO_SPATIAL_REFERENCE_RENDER_PATH &&
    path !== MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH
  ) {
    return false;
  }
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  const authResult = await authorizeHttpGatewayConnect({
    auth: options.auth,
    connectAuth: connectAuth(req),
    req,
    trustedProxies: options.trustedProxies,
    allowRealIpFallback: options.allowRealIpFallback,
    rateLimiter: options.rateLimiter,
  });
  if (!authResult.ok) {
    sendGatewayAuthFailure(res, authResult);
    return true;
  }
  const body = await readJsonBodyOrError(req, res, options.maxBodyBytes ?? MAX_BODY_BYTES);
  if (body === undefined) return true;
  if (path === MEDIA_STUDIO_SPATIAL_REFERENCE_CANCEL_PATH) {
    const raw = record(body);
    const runtimeIdempotencyKey = text(raw?.runtimeIdempotencyKey);
    const dispatchAttemptId = text(raw?.dispatchAttemptId);
    if (!runtimeIdempotencyKey || !dispatchAttemptId) {
      sendInvalidRequest(res, "Invalid Spatial cancel request");
      return true;
    }
    try {
      sendJson(
        res,
        200,
        await options.executor.cancel({ runtimeIdempotencyKey, dispatchAttemptId }),
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "SPATIAL_REFERENCE_CANCEL_IDENTITY_CONFLICT"
      )
        throw error;
      sendJson(res, 409, { error: { code: error.message } });
    }
    return true;
  }
  const dispatch = parseSpatialReferenceRelayDispatch(body);
  if (!dispatch) {
    sendInvalidRequest(res, "Invalid Spatial reference render request");
    return true;
  }
  try {
    sendJson(res, 202, await options.executor.dispatch(dispatch));
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "SPATIAL_REFERENCE_IDEMPOTENCY_CONFLICT")
      throw error;
    sendJson(res, 409, { error: { code: error.message } });
  }
  return true;
}
