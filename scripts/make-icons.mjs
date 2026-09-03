/**
 * PWA アイコン生成（依存なし・Node 組込み zlib のみ）
 *   node scripts/make-icons.mjs
 * 出力: public/icons/icon-192.png, icon-512.png, icon-512-maskable.png
 * デザイン: 濃紺の角丸背景 + 3本の波（アクセント #1f8aa8）+ 上部に白い「岸」線
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [15, 23, 42];       // #0f172a
const WAVE = [31, 138, 168];   // #1f8aa8
const WAVE2 = [125, 211, 252]; // #7dd3fc
const SHORE = [248, 250, 252]; // #f8fafc

function render(size, { maskable }) {
  const px = Buffer.alloc(size * size * 4);
  const r = maskable ? 0 : size * 0.22; // 角丸半径（maskable は全面塗り）
  const pad = maskable ? size * 0.1 : 0; // maskable は safe zone を意識して内側に描く
  const put = (x, y, [R, G, B], a = 255) => {
    const i = (y * size + x) * 4;
    px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 角丸判定
      let inside = true;
      if (r > 0) {
        const cx = x < r ? r : x > size - r - 1 ? size - r - 1 : x;
        const cy = y < r ? r : y > size - r - 1 ? size - r - 1 : y;
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      }
      if (!inside) { put(x, y, [0, 0, 0], 0); continue; }
      put(x, y, BG);
      const nx = (x - pad) / (size - pad * 2);
      const ny = (y - pad) / (size - pad * 2);
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) continue;
      // 上部: 岸（白い斜面）
      const shoreY = 0.32 + 0.1 * Math.sin(nx * Math.PI);
      if (ny < shoreY && ny > shoreY - 0.045) put(x, y, SHORE);
      // 波 3 本
      for (let k = 0; k < 3; k++) {
        const base = 0.5 + k * 0.15;
        const amp = 0.035;
        const wy = base + amp * Math.sin((nx * 2 + k * 0.35) * Math.PI * 2);
        const thick = 0.05;
        if (ny > wy && ny < wy + thick) put(x, y, k === 1 ? WAVE2 : WAVE);
      }
    }
  }
  return encodePng(size, px);
}

writeFileSync(join(outDir, 'icon-192.png'), render(192, { maskable: false }));
writeFileSync(join(outDir, 'icon-512.png'), render(512, { maskable: false }));
writeFileSync(join(outDir, 'icon-512-maskable.png'), render(512, { maskable: true }));
console.log('icons written to', outDir);
