// Emits a 1024x1024 solid blue PNG at src-tauri/icons/source.png.
// Run via `node scripts/make-source-icon.mjs` then `npx tauri icon src-tauri/icons/source.png`.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "src-tauri", "icons", "source.png");
mkdirSync(dirname(out), { recursive: true });

const SIZE = 1024;
const RGB = [37, 99, 235]; // tailwind blue-600

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = (crcTable[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 2;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const rowLen = 1 + SIZE * 3;
const raw = Buffer.alloc(rowLen * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * rowLen] = 0;
  for (let x = 0; x < SIZE; x++) {
    const off = y * rowLen + 1 + x * 3;
    raw[off] = RGB[0];
    raw[off + 1] = RGB[1];
    raw[off + 2] = RGB[2];
  }
}
const idat = deflateSync(raw);

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(out, png);
console.log(`wrote ${png.length} bytes to ${out}`);
