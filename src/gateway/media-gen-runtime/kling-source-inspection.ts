import { createImageProcessor } from "../../media/image-processor.js";
import type { MediaGenRuntimeVendorInput } from "./types.js";

/** Inspect redeemed bytes before preparation; a file extension or supplied dimensions is not evidence. */
export async function inspectKlingSourceFrames(
  input: MediaGenRuntimeVendorInput,
): Promise<
  | { ok: true; frames: ReadonlyMap<string, { width: number; height: number; byteLength: number }> }
  | { ok: false }
> {
  const frames = new Map<string, { width: number; height: number; byteLength: number }>();
  const processor = createImageProcessor();
  for (const slot of input.sources ?? []) {
    const bytes = slot.source.bytes;
    if (!bytes || bytes.length === 0 || bytes.length > 50_000_000) return { ok: false };
    const mime = slot.source.mimeType.toLowerCase();
    let metadata;
    try {
      metadata = await processor.probe(bytes);
    } catch {
      return { ok: false };
    }
    if (
      !metadata ||
      (mime === "image/jpeg"
        ? metadata.format !== "jpeg"
        : mime === "image/png"
          ? metadata.format !== "png"
          : true) ||
      metadata.width < 300 ||
      metadata.height < 300 ||
      metadata.width / metadata.height < 0.4 ||
      metadata.width / metadata.height > 2.5
    )
      return { ok: false };
    const key = `${slot.role}:${slot.ordinal}`;
    if (frames.has(key)) return { ok: false };
    frames.set(key, { width: metadata.width, height: metadata.height, byteLength: bytes.length });
  }
  return { ok: true, frames };
}
