import type {
  MediaGenReferenceRole,
  MediaGenRuntimeDispatch,
  MediaGenRuntimeResult,
} from "../media-gen-runtime-http.js";

export type MediaGenFailureReason = NonNullable<MediaGenRuntimeResult["failureReason"]>;

export type MediaGenRuntimeSource = {
  bytes: Buffer;
  mimeType: string;
  sha256?: string;
};

// CP3 resolved multi-slot source (Multi_Asset_Reference_Design_CP3.md §3.3): a single
// reference slot AFTER its scoped grant has been redeemed to bytes, tagged with the
// role/ordinal the vendor mapper uses to place it (e.g. subject → Vidu images[]).
export type MediaGenRuntimeSourceSlot = {
  role: MediaGenReferenceRole;
  ordinal: number;
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
};

export type MediaGenRuntimeVendorOutput = {
  mediaRef: string;
  mimeType: string;
  durationSec?: number;
  resolution?: string;
};

export type MediaGenRuntimeVendorJob =
  | { state: "processing"; vendorJobId: string }
  | { state: "succeeded"; vendorJobId: string; output: MediaGenRuntimeVendorOutput }
  | {
      state: "failed";
      vendorJobId?: string;
      reason: MediaGenFailureReason;
      message: string;
    };

export type MediaGenRuntimeVendor = {
  presetId: string;
  isConfigured(): boolean;
  /**
   * CP3 §8 honesty gate — true only for a vendor that actually maps a multi-slot
   * `input.sources[]` onto its API (e.g. Vidu subject images[]). The factory advertises
   * `supportsMultiReference` to the control plane from this bit; a vendor MUST NOT set it
   * until the multi-source mapping is real, never optimistically.
   */
  supportsMultiReference?: boolean;
  submit(input: MediaGenRuntimeVendorInput): Promise<MediaGenRuntimeVendorJob>;
  poll(vendorJobId: string): Promise<MediaGenRuntimeVendorJob>;
  cancel?(vendorJobId: string): Promise<void>;
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
  applyLabel(input: MediaGenRuntimeVendorOutput): Promise<
    MediaGenRuntimeVendorOutput & { applied: boolean }
  >;
};

export type MediaGenRuntimeArtifactRef = {
  artifactId: string;
  sha256?: string;
  durationSec?: number;
  resolution?: string;
  mimeType: string;
};

export type MediaGenRuntimeBridge = {
  runtimeId: string;
  register(input: {
    workspaceId: string;
    supportedPresetIds: string[];
    enforcesModeration: boolean;
    appliesLabeling: boolean;
    supportsMultiReference?: boolean;
  }): Promise<void>;
  resolveArtifactReference(input: {
    dispatch: MediaGenRuntimeDispatch;
    artifactId: string;
    role?: MediaGenReferenceRole;
  }): Promise<MediaGenRuntimeSource>;
  handoffArtifact(input: {
    dispatch: MediaGenRuntimeDispatch;
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
