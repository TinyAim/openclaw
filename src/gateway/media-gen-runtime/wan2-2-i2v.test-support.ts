import { createHash } from "node:crypto";

export function wanTestPng(width: number, height: number, colorType = 2): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = colorType;
  const chunk = (name: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(name, "ascii"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdrData),
    chunk("IDAT", Buffer.from([0])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function wanTestJpeg(width: number, height: number): Buffer {
  const frame = Buffer.alloc(17);
  frame.writeUInt16BE(frame.length, 0);
  frame[2] = 8;
  frame.writeUInt16BE(height, 3);
  frame.writeUInt16BE(width, 5);
  frame[7] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), frame, Buffer.from([0xff, 0xd9])]);
}

export function wanTestSha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
