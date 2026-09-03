/** Deterministic first-party proxy-previs rasterizer with a tiny PNG encoder. */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

type V3 = { x: number; y: number; z: number };

export type SpatialReferenceRenderInput = {
  requestId: string;
  workspaceId: string;
  taskId: string;
  materializationId: string;
  runtimeIdempotencyKey: string;
  profile: "proxy_previs" | "reference_composite";
  width: number;
  height: number;
  camera: {
    position: V3;
    targetPoint: V3;
    focalLengthMm: number;
    sensorWidthMm: number;
    frameAspectRatio: number;
  };
  nodes: Array<{
    nodeId: string;
    kind: string;
    position: V3;
    scale?: V3;
    label?: string;
  }>;
  backgroundPolicy: "environment_plate" | "neutral_studio" | "transparent";
  rendererContractVersion: string;
  rendererBuildDigest: string;
  environmentCrop?: { x: number; y: number; width: number; height: number };
  fitMode?: "cover" | "contain";
};

type RenderResult =
  | {
      ok: true;
      png: Buffer;
      byteLength: number;
      sha256Hex: string;
      pixelDigest: string;
      width: number;
      height: number;
      profile: SpatialReferenceRenderInput["profile"];
      rendererContractVersion: string;
      rendererBuildDigest: string;
      usedProxySilhouettes: boolean;
    }
  | { ok: false; code: string; message: string };

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, data: Buffer): Buffer {
  const type = Buffer.from(kind, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scanlines = Buffer.allocUnsafe(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    scanlines[row] = 0;
    rgba.copy(scanlines, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sub(a: V3, b: V3): V3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: V3, b: V3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: V3, b: V3): V3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalized(value: V3): V3 {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 1e-8
    ? { x: value.x / length, y: value.y / length, z: value.z / length }
    : { x: 0, y: 0, z: -1 };
}

function paintRect(
  pixels: Buffer,
  width: number,
  height: number,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  color: readonly [number, number, number, number],
): void {
  const minX = Math.max(0, Math.floor(cx - halfW));
  const maxX = Math.min(width - 1, Math.ceil(cx + halfW));
  const minY = Math.max(0, Math.floor(cy - halfH));
  const maxY = Math.min(height - 1, Math.ceil(cy + halfH));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = color[3];
    }
  }
}

/**
 * Projects blocking nodes with the frozen Shot Camera. This is deliberately a
 * proxy-previs renderer, not a claim that bound media or environment pixels
 * were reconstructed.
 */
export async function renderSpatialReferenceComposition(
  input: SpatialReferenceRenderInput,
): Promise<RenderResult> {
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < 16 ||
    input.height < 16 ||
    input.width * input.height > 33_554_432 ||
    !(input.camera.focalLengthMm > 0) ||
    !(input.camera.sensorWidthMm > 0)
  ) {
    return {
      ok: false,
      code: "invalid_render_intent",
      message: "Invalid proxy render dimensions or camera.",
    };
  }
  const alpha = input.backgroundPolicy === "transparent" ? 0 : 255;
  const background =
    input.backgroundPolicy === "environment_plate"
      ? ([64, 79, 92, alpha] as const)
      : ([35, 42, 52, alpha] as const);
  const pixels = Buffer.alloc(input.width * input.height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = background[0];
    pixels[offset + 1] = background[1];
    pixels[offset + 2] = background[2];
    pixels[offset + 3] = background[3];
  }
  const forward = normalized(sub(input.camera.targetPoint, input.camera.position));
  const worldUp = Math.abs(forward.y) > 0.98 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const right = normalized(cross(forward, worldUp));
  const up = normalized(cross(right, forward));
  const focalPixels = input.camera.focalLengthMm * (input.width / input.camera.sensorWidthMm);
  const ordered = [...input.nodes].sort((a, b) => {
    const da = dot(sub(a.position, input.camera.position), forward);
    const db = dot(sub(b.position, input.camera.position), forward);
    return db - da;
  });
  for (const node of ordered) {
    const relative = sub(node.position, input.camera.position);
    const depth = dot(relative, forward);
    if (!(depth > 0.02)) continue;
    const x = input.width / 2 + (dot(relative, right) / depth) * focalPixels;
    const y = input.height / 2 - (dot(relative, up) / depth) * focalPixels;
    const scale = node.scale ?? { x: 1, y: 1, z: 1 };
    const halfW = Math.max(2, (Math.abs(scale.x) * focalPixels * 0.45) / depth);
    const halfH = Math.max(3, (Math.abs(scale.y) * focalPixels * 0.55) / depth);
    const color = node.kind.includes("character")
      ? ([64, 174, 220, 255] as const)
      : node.kind.includes("camera")
        ? ([241, 164, 58, 255] as const)
        : ([183, 192, 205, 255] as const);
    paintRect(pixels, input.width, input.height, x, y, halfW, halfH, color);
  }
  const png = encodePng(input.width, input.height, pixels);
  return {
    ok: true,
    png,
    byteLength: png.length,
    sha256Hex: createHash("sha256").update(png).digest("hex"),
    pixelDigest: `sha256:${createHash("sha256").update(pixels).digest("hex")}`,
    width: input.width,
    height: input.height,
    profile: input.profile,
    rendererContractVersion: input.rendererContractVersion,
    rendererBuildDigest: input.rendererBuildDigest,
    usedProxySilhouettes: true,
  };
}
