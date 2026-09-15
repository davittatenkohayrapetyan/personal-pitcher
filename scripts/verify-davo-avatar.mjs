/**
 * Decodes public/photos/davo-avatar-sprite.png and checks every tile against a
 * fresh render.
 *
 * The sprite's whole job is that tile k sits at exactly y = k * SIZE, because
 * the CSS steps() animation indexes into it by arithmetic. A half-pixel drift
 * or an off-by-one in the tile count shows up as a sliver of the neighbouring
 * frame at 32px — small enough to miss by eye and obvious once pointed out, so
 * it is worth asserting rather than trusting.
 *
 *   node scripts/verify-davo-avatar.mjs
 */
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SIZE, FRAMES, SPRITE_TILES, renderFrame } from './generate-davo-avatar.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const buf = readFileSync(join(ROOT, 'public/photos/davo-avatar-sprite.png'));

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
if (!SIG.every((b, i) => buf[i] === b)) throw new Error('not a PNG');

// Walk the chunk list.
const chunks = new Map();
const idat = [];
let p = 8;
while (p < buf.length) {
  const len = buf.readUInt32BE(p);
  const type = buf.subarray(p + 4, p + 8).toString('ascii');
  const data = buf.subarray(p + 8, p + 8 + len);
  if (type === 'IDAT') idat.push(data);
  else chunks.set(type, data);
  p += 12 + len;
}

const ihdr = chunks.get('IHDR');
const width = ihdr.readUInt32BE(0);
const height = ihdr.readUInt32BE(4);
if (width !== SIZE) throw new Error(`width ${width}, expected ${SIZE}`);
if (height !== SIZE * SPRITE_TILES) {
  throw new Error(`height ${height}, expected ${SIZE * SPRITE_TILES}`);
}
if (ihdr[8] !== 8 || ihdr[9] !== 3) throw new Error('expected 8-bit indexed colour');
if (!chunks.has('PLTE')) throw new Error('missing palette');

// Undo the per-scanline filters. bpp is 1 byte for 8-bit indexed.
const raw = inflateSync(Buffer.concat(idat));
const stride = width;
const out = new Uint8Array(height * stride);
const paeth = (a, b, c) => {
  const pp = a + b - c;
  const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};
let rp = 0;
for (let y = 0; y < height; y++) {
  const type = raw[rp++];
  for (let x = 0; x < stride; x++) {
    const cur = raw[rp++];
    const a = x > 0 ? out[y * stride + x - 1] : 0;
    const b = y > 0 ? out[(y - 1) * stride + x] : 0;
    const c = x > 0 && y > 0 ? out[(y - 1) * stride + x - 1] : 0;
    let v;
    switch (type) {
      case 0: v = cur; break;
      case 1: v = cur + a; break;
      case 2: v = cur + b; break;
      case 3: v = cur + ((a + b) >> 1); break;
      case 4: v = cur + paeth(a, b, c); break;
      default: throw new Error(`unknown filter ${type} on row ${y}`);
    }
    out[y * stride + x] = v & 0xff;
  }
}

const tile = (k) => out.subarray(k * SIZE * stride, (k + 1) * SIZE * stride);

for (let k = 0; k < FRAMES; k++) {
  const expected = renderFrame(k / FRAMES);
  const got = tile(k);
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== got[i]) {
      const row = Math.floor(i / SIZE);
      throw new Error(`tile ${k} differs at row ${row}, col ${i % SIZE}: ${got[i]} != ${expected[i]}`);
    }
  }
}

// The trailing tile exists only to make the CSS step arithmetic exact.
const first = tile(0);
const last = tile(SPRITE_TILES - 1);
if (!first.every((v, i) => v === last[i])) throw new Error('trailing tile is not a copy of frame 0');

// A sheet of identical tiles would pass everything above.
let moved = 0;
for (let k = 1; k < FRAMES; k++) if (tile(k).some((v, i) => v !== first[i])) moved++;
if (moved !== FRAMES - 1) throw new Error(`${FRAMES - 1 - moved} tile(s) identical to frame 0`);

console.log(
  `ok: ${FRAMES} frames + 1 pad tile at ${SIZE}x${SIZE}, all aligned and distinct (sheet ${width}x${height})`,
);
