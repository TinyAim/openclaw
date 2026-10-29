import type { Vec3 } from "./types.js";

function pad4(buffer: Buffer, fill = 0): Buffer {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding, fill)]);
}

function extrema(values: readonly Vec3[]): { minimum: Vec3; maximum: Vec3 } {
  const minimum = { x: Infinity, y: Infinity, z: Infinity };
  const maximum = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const value of values) {
    minimum.x = Math.min(minimum.x, value.x);
    minimum.y = Math.min(minimum.y, value.y);
    minimum.z = Math.min(minimum.z, value.z);
    maximum.x = Math.max(maximum.x, value.x);
    maximum.y = Math.max(maximum.y, value.y);
    maximum.z = Math.max(maximum.z, value.z);
  }
  return { minimum, maximum };
}

export function buildTexturedGridGlb(input: {
  positions: readonly Vec3[];
  uvs: readonly { x: number; y: number }[];
  indices: Uint16Array;
  sourceImage: Buffer;
  sourceMimeType: "image/png" | "image/jpeg";
}): Buffer {
  if (input.positions.length !== input.uvs.length || input.positions.length < 4) {
    throw new Error("invalid_grid_attributes");
  }
  const positionBytes = Buffer.allocUnsafe(input.positions.length * 12);
  input.positions.forEach((position, index) => {
    const offset = index * 12;
    positionBytes.writeFloatLE(position.x, offset);
    positionBytes.writeFloatLE(position.y, offset + 4);
    positionBytes.writeFloatLE(position.z, offset + 8);
  });
  const uvBytes = Buffer.allocUnsafe(input.uvs.length * 8);
  input.uvs.forEach((uv, index) => {
    const offset = index * 8;
    uvBytes.writeFloatLE(uv.x, offset);
    uvBytes.writeFloatLE(uv.y, offset + 4);
  });
  const indexBytes = Buffer.from(
    input.indices.buffer,
    input.indices.byteOffset,
    input.indices.byteLength,
  );
  const chunks = [pad4(positionBytes), pad4(uvBytes), pad4(indexBytes), pad4(input.sourceImage)];
  const offsets: number[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    offsets.push(cursor);
    cursor += chunk.length;
  }
  const bounds = extrema(input.positions);
  const json = {
    asset: { version: "2.0", generator: "wisclaw.deterministic_layered_depth_mesh/v1" },
    extensionsUsed: ["KHR_materials_unlit"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "WisclawDepthSurface" }],
    meshes: [
      {
        name: "WisclawDepthSurface",
        primitives: [
          {
            attributes: { POSITION: 0, TEXCOORD_0: 1 },
            indices: 2,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    materials: [
      {
        name: "SourceLockedOpaqueTexture",
        doubleSided: true,
        alphaMode: "OPAQUE",
        extensions: { KHR_materials_unlit: {} },
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: [
      {
        bufferView: 3,
        mimeType: input.sourceMimeType,
        name: "AuthorizedSourceImage",
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: input.positions.length,
        type: "VEC3",
        min: [bounds.minimum.x, bounds.minimum.y, bounds.minimum.z],
        max: [bounds.maximum.x, bounds.maximum.y, bounds.maximum.z],
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: input.uvs.length,
        type: "VEC2",
        min: [0, 0],
        max: [1, 1],
      },
      {
        bufferView: 2,
        componentType: 5123,
        count: input.indices.length,
        type: "SCALAR",
        min: [0],
        max: [input.positions.length - 1],
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: uvBytes.length, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: indexBytes.length, target: 34963 },
      { buffer: 0, byteOffset: offsets[3], byteLength: input.sourceImage.length },
    ],
    buffers: [{ byteLength: cursor }],
  };
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const binChunk = Buffer.concat(chunks);
  const output = Buffer.allocUnsafe(12 + 8 + jsonChunk.length + 8 + binChunk.length);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(jsonChunk.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(output, 20);
  const binHeader = 20 + jsonChunk.length;
  output.writeUInt32LE(binChunk.length, binHeader);
  output.writeUInt32LE(0x004e4942, binHeader + 4);
  binChunk.copy(output, binHeader + 8);
  return output;
}
