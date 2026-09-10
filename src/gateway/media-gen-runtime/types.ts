import type {
  MediaGenReferenceRole,
  MediaGenRuntimeDispatch,
  MediaGenRuntimeResult,
  MediaGenRuntimeSpatialInputAcceptance,
  MediaGenRuntimeSpatialInputEnvelope,
} from "../media-gen-runtime-http.js";
import type { MediaGenRuntimeFrozenPlanV2 } from "./frozen-plan.js";
import type { MediaGenProviderRuntimeObservation } from "./provider-observation.js";

export type MediaGenFailureReason = NonNullable<MediaGenRuntimeResult["failureReason"]>;

export type MediaGenRuntimeByteSource = {
  bytes: Buffer;
  providerRef?: never;
  mimeType: string;
  sha256?: string;
};

export type MediaGenRuntimeSource =
  | MediaGenRuntimeByteSource
  | { bytes?: never; providerRef: string; mimeType: string; sha256?: string };

// CP3 resolved multi-slot source (Multi_Asset_Reference_Design_CP3.md §3.3): a single
// reference slot AFTER its scoped grant has been redeemed to bytes, tagged with the
// role/ordinal the vendor mapper uses to place it (e.g. subject → Vidu images[]).
export type MediaGenRuntimeSourceSlot = {
  role: MediaGenReferenceRole;
  ordinal: number;
  /** Control-plane artifact identity retained for exact native Spatial binding. */
  artifactId?: string;
  source: MediaGenRuntimeSource;
};

export type MediaGenRuntimeVendorInput = {
  taskId: string;
  presetId: string;
  mode: MediaGenRuntimeDispatch["mode"];
  prompt?: string;
  durationSec?: number;
  resolution?: string;
  params?: Record<string, unknown>;
  source?: MediaGenRuntimeSource;
  /**
   * CP3 multi-asset reference — the role-tagged, already-redeemed source set for a
   * multi-slot dispatch. Mutually exclusive with `source`. Only populated for a vendor
   * that declares `supportsMultiReference`; single-reference vendors keep using `source`.
   */
  sources?: MediaGenRuntimeSourceSlot[];
  frozenPlan?: MediaGenRuntimeFrozenPlanV2;
  executionAttempt?: number;
  frozenPlanDigest?: string;
  spatialInputEnvelope?: MediaGenRuntimeSpatialInputEnvelope;
};

export type MediaGenRuntimeVendorOutput = {
  mediaRef: string;
  mimeType: string;
  durationSec?: number;
  resolution?: string;
  /** Runtime-private download headers. Finalization must strip these before Artifact handoff. */
  contentHeaders?: Readonly<Record<string, string>>;
  /** Runtime-private opt-in for plain HTTP only when `mediaRef` is loopback. */
  allowInsecureLoopback?: boolean;
};

export type MediaGenRuntimeVendorJob =
  | {
      state: "processing";
      vendorJobId: string;
      providerRequestDigest?: string;
      providerObservation?: MediaGenProviderRuntimeObservation;
      spatialInputAcceptance?: MediaGenRuntimeSpatialInputAcceptance;
    }
  | {
      state: "succeeded";
      vendorJobId: string;
      output: MediaGenRuntimeVendorOutput;
      providerRequestDigest?: string;
      providerObservation?: MediaGenProviderRuntimeObservation;
      spatialInputAcceptance?: MediaGenRuntimeSpatialInputAcceptance;
    }
  | {
      state: "failed";
      vendorJobId?: string;
      reason: MediaGenFailureReason;
      message: string;
      providerRequestDigest?: string;
      providerObservation?: MediaGenProviderRuntimeObservation;
      /** Only explicit provider terminal failure may create a replacement job. */
      retryDisposition?: "replacement_allowed" | "reconcile_only";
    }
  | {
      state: "submission_unknown";
      message: string;
      providerRequestDigest: string;
      providerObservation?: MediaGenProviderRuntimeObservation;
    }
  | {
      state: "canceled";
      vendorJobId: string;
      providerRequestDigest?: string;
      providerObservation?: MediaGenProviderRuntimeObservation;
    };

export type MediaGenRuntimeVendorCancelResult = {
  state: "confirmed" | "requested" | "failed" | "unknown";
  providerObservation?: MediaGenProviderRuntimeObservation;
};

export type MediaGenRuntimeProviderRouteRef = {
  schemaVersion: 1;
  routeId: string;
  providerId: string;
  modelId: string;
  endpointId: string;
  region: string;
  accountTier: string;
};

export type MediaGenRuntimeCapabilityRouteClaim = {
  presetId: string;
  mode: MediaGenRuntimeDispatch["mode"];
  route: MediaGenRuntimeProviderRouteRef;
  adapterRevision: string;
};

/**
 * Operator-supplied serving identity for a private model endpoint. These claims
 * describe the process that is actually serving on this runtime; they are not
 * provider credentials and are still subject to Control API admission.
 */
export type MediaGenRuntimeModelServingClaim = {
  modelId: string;
  variant: string;
  servingEngine: string;
  servingEngineVersion: string;
  servingProtocol: "sglang_video_v1" | "custom";
  checkpointRevision: string;
  checkpointDigest: string;
  precision?: string;
  status: "ready" | "loading" | "error" | "unknown";
  maxConcurrentJobs?: number;
};

export type MediaGenRuntimeVendor = {
  presetId: string;
  isConfigured(): boolean;
  /** Exact vendor-owned output origins that the shared downloader may trust. */
  trustedOutputHosts?: readonly string[];
  /** Exact default routes implemented by this runtime vendor. */
  capabilityRouteClaims?: readonly MediaGenRuntimeCapabilityRouteClaim[];
  /** Private serving identity reported by this vendor, never a secret. */
  modelServingClaims?: readonly MediaGenRuntimeModelServingClaim[];
  /**
   * Re-sample live serving readiness immediately before a heartbeat. Static
   * process-start configuration is never sufficient for a private model route.
   */
  registrationSnapshot?(): Promise<{
    capabilityRouteClaims?: readonly MediaGenRuntimeCapabilityRouteClaim[];
    modelServingClaims?: readonly MediaGenRuntimeModelServingClaim[];
  }>;
  /**
   * CP3 §8 honesty gate — true only for a vendor that actually maps a multi-slot
   * `input.sources[]` onto its API (e.g. Vidu subject images[]). The factory advertises
   * `supportsMultiReference` to the control plane from this bit; a vendor MUST NOT set it
   * until the multi-source mapping is real, never optimistically.
   */
  supportsMultiReference?: boolean;
  /** Exact Adapter V2 vendors refuse submit/retry without a frozen receipt. */
  requiresFrozenPlan?: boolean;
  submit(input: MediaGenRuntimeVendorInput): Promise<MediaGenRuntimeVendorJob>;
  poll(vendorJobId: string): Promise<MediaGenRuntimeVendorJob>;
  /** Poll-first recovery seam used before retry can create a replacement job. */
  reconcile?(vendorJobId: string): Promise<MediaGenRuntimeVendorJob>;
  cancel?(vendorJobId: string): Promise<MediaGenRuntimeVendorCancelResult | void>;
};

export type MediaGenRuntimeModeration = {
  screenInput(input: {
    mode: MediaGenRuntimeDispatch["mode"];
    prompt?: string;
    hasSource: boolean;
    consentAuthorized: boolean;
  }): Promise<{ allowed: boolean; reason?: string }>;
  screenOutput(input: {
    mediaRef: string;
    mimeType: string;
  }): Promise<{ allowed: boolean; reason?: string }>;
};

export type MediaGenRuntimeLabeler = {
  applyLabel(
    input: MediaGenRuntimeVendorOutput,
  ): Promise<MediaGenRuntimeVendorOutput & { applied: boolean }>;
};

export type MediaGenRuntimeArtifactRef = {
  artifactId: string;
  sha256?: string;
  durationSec?: number;
  resolution?: string;
  mimeType: string;
};

/**
 * Shared identity for the Artifact callback.  Image dispatches deliberately do
 * not fabricate a legacy video `mode` just to settle their bytes.
 */
export type MediaGenRuntimeArtifactHandoffIdentity = {
  taskId: string;
  workspaceId: string;
  presetId: string;
  /** Exact image attempt coordinates; omitted by legacy video/render callers. */
  executionAttempt?: number;
  frozenPlanDigest?: string;
};

export type MediaGenRuntimeBridge = {
  runtimeId: string;
  register(input: {
    workspaceId: string;
    supportedPresetIds: string[];
    enforcesModeration: boolean;
    appliesLabeling: boolean;
    supportsMultiReference?: boolean;
    capabilityRouteClaims?: readonly MediaGenRuntimeCapabilityRouteClaim[];
    modelServingClaims?: readonly MediaGenRuntimeModelServingClaim[];
  }): Promise<void>;
  resolveArtifactReference(input: {
    dispatch: MediaGenRuntimeDispatch;
    artifactId: string;
    role?: MediaGenReferenceRole;
    ordinal?: number;
  }): Promise<MediaGenRuntimeSource>;
  handoffArtifact(input: {
    dispatch: MediaGenRuntimeArtifactHandoffIdentity;
    runtimeJobId: string;
    output: MediaGenRuntimeVendorOutput;
    bytes: Buffer;
    sha256: string;
  }): Promise<MediaGenRuntimeArtifactRef>;
};

export class MediaGenRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaGenRuntimeConfigError";
  }
}

export type MediaGenRuntimeFetch = typeof fetch;
