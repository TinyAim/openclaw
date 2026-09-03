import type { MediaGenRuntimeCapabilityRouteClaim, MediaGenRuntimeVendorInput } from "./types.js";
import {
  WAN22_FIRST_LAST_ADAPTER_REVISION,
  WAN22_FIRST_LAST_ENDPOINT_ID,
  WAN22_FIRST_LAST_MODEL_ID,
  WAN22_FIRST_LAST_ROUTE_ID,
} from "./wan2-2-first-last-frame-compiler.js";
import {
  WAN22_I2V_ADAPTER_REVISION,
  WAN22_I2V_ENDPOINT_ID,
  WAN22_I2V_MODEL_ID,
  WAN22_I2V_ROUTE_ID,
} from "./wan2-2-i2v-compiler.js";
import {
  WAN22_T2V_ADAPTER_REVISION,
  WAN22_T2V_ENDPOINT_ID,
  WAN22_T2V_MODEL_ID,
  WAN22_T2V_ROUTE_ID,
} from "./wan2-2-t2v-compiler.js";

export const WAN22_I2V_JOB_PREFIX = "wan2.2-i2v:";
export const WAN22_FIRST_LAST_JOB_PREFIX = "wan2.2-kf2v:";

export type WanRuntimeRoute = {
  mode: "text2video" | "image2video";
  routeId: string;
  adapterRevision: string;
  modelId: string;
  endpointId: string;
  submitPath: string;
  jobPrefix?: string;
};

export const WAN22_T2V_RUNTIME_ROUTE: WanRuntimeRoute = {
  mode: "text2video",
  routeId: WAN22_T2V_ROUTE_ID,
  adapterRevision: WAN22_T2V_ADAPTER_REVISION,
  modelId: WAN22_T2V_MODEL_ID,
  endpointId: WAN22_T2V_ENDPOINT_ID,
  submitPath: "/services/aigc/video-generation/video-synthesis",
};

export const WAN22_I2V_RUNTIME_ROUTE: WanRuntimeRoute = {
  mode: "image2video",
  routeId: WAN22_I2V_ROUTE_ID,
  adapterRevision: WAN22_I2V_ADAPTER_REVISION,
  modelId: WAN22_I2V_MODEL_ID,
  endpointId: WAN22_I2V_ENDPOINT_ID,
  submitPath: "/services/aigc/video-generation/video-synthesis",
  jobPrefix: WAN22_I2V_JOB_PREFIX,
};

export const WAN22_FIRST_LAST_RUNTIME_ROUTE: WanRuntimeRoute = {
  mode: "image2video",
  routeId: WAN22_FIRST_LAST_ROUTE_ID,
  adapterRevision: WAN22_FIRST_LAST_ADAPTER_REVISION,
  modelId: WAN22_FIRST_LAST_MODEL_ID,
  endpointId: WAN22_FIRST_LAST_ENDPOINT_ID,
  submitPath: "/services/aigc/image2video/video-synthesis",
  jobPrefix: WAN22_FIRST_LAST_JOB_PREFIX,
};

const ROUTES = [
  WAN22_T2V_RUNTIME_ROUTE,
  WAN22_I2V_RUNTIME_ROUTE,
  WAN22_FIRST_LAST_RUNTIME_ROUTE,
] as const;
const PROVIDER_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,299}$/u;

export function wanProviderJobIdValid(value: string): boolean {
  return PROVIDER_JOB_ID.test(value);
}

export function routeForWanInput(input: MediaGenRuntimeVendorInput): WanRuntimeRoute | null {
  const routeId = input.frozenPlan?.providerRouteRef.routeId;
  return ROUTES.find((route) => route.mode === input.mode && route.routeId === routeId) ?? null;
}

export function encodeWanJobReceipt(route: WanRuntimeRoute, providerJobId: string): string {
  return route.jobPrefix ? `${route.jobPrefix}${providerJobId}` : providerJobId;
}

export function routeForWanReceipt(receipt: string): WanRuntimeRoute {
  if (receipt.startsWith(WAN22_FIRST_LAST_JOB_PREFIX)) {
    return WAN22_FIRST_LAST_RUNTIME_ROUTE;
  }
  if (receipt.startsWith(WAN22_I2V_JOB_PREFIX)) {
    return WAN22_I2V_RUNTIME_ROUTE;
  }
  return WAN22_T2V_RUNTIME_ROUTE;
}

export function decodeWanJobReceipt(receipt: string): {
  route: WanRuntimeRoute;
  providerJobId: string;
} | null {
  const route = routeForWanReceipt(receipt);
  const providerJobId = route.jobPrefix ? receipt.slice(route.jobPrefix.length) : receipt;
  return wanProviderJobIdValid(providerJobId) ? { route, providerJobId } : null;
}

export function wanCapabilityRouteClaims(): MediaGenRuntimeCapabilityRouteClaim[] {
  // Keep executable-but-unpinned I2V/KF2V routes private to frozen historical
  // receipts. Runtime registration may advertise only the content-pinned T2V
  // seam; otherwise Control API correctly rejects the complete claim set.
  return [WAN22_T2V_RUNTIME_ROUTE].map((route) => ({
    presetId: "wan",
    mode: route.mode,
    route: {
      schemaVersion: 1,
      routeId: route.routeId,
      providerId: "dashscope",
      modelId: route.modelId,
      endpointId: route.endpointId,
      region: "cn-beijing",
      accountTier: "api_key",
    },
    adapterRevision: route.adapterRevision,
  }));
}
