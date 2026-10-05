import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

/** Bare-bones RGB PNG writer: these plans only ever need one filter and no palette. */
export const writePng = (path: string, width: number, height: number, rgb: Uint8Array) => {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 3 + 1)] = 0;
    rgb.subarray(row * width * 3, (row + 1) * width * 3).forEach((value, i) => {
      raw[row * (width * 3 + 1) + 1 + i] = value;
    });
  }

  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buffer: Buffer) => {
    let c = -1;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const tagged = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(tagged));
    return Buffer.concat([head, tagged, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
};

export type Canvas = { width: number; height: number; rgb: Uint8Array };

export const createCanvas = (width: number, height: number): Canvas => ({
  width,
  height,
  rgb: new Uint8Array(width * height * 3),
});

export const dot = (canvas: Canvas, px: number, py: number, radius: number, color: [number, number, number]) => {
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = Math.round(px + dx);
      const y = Math.round(py + dy);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const at = (y * canvas.width + x) * 3;
      canvas.rgb[at] = color[0];
      canvas.rgb[at + 1] = color[1];
      canvas.rgb[at + 2] = color[2];
    }
  }
};

export const line = (
  canvas: Canvas,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
  color: [number, number, number]
) => {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    dot(canvas, ax + (bx - ax) * t, ay + (by - ay) * t, radius, color);
  }
};

export const ring = (canvas: Canvas, px: number, py: number, radius: number, color: [number, number, number]) => {
  const steps = Math.max(32, Math.ceil(radius * 6));
  for (let i = 0; i < steps; i += 1) {
    const turn = (i / steps) * Math.PI * 2;
    dot(canvas, px + Math.cos(turn) * radius, py + Math.sin(turn) * radius, 1, color);
  }
};
