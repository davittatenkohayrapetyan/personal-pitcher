/**
 * Generates Davo's avatar: an abstract animated orb in the site palette
 * (slate-950 base -> violet -> sky), plus a matching still frame used as the
 * prefers-reduced-motion fallback.
 *
 *   node scripts/generate-davo-avatar.mjs           # write gif + still png
 *   node scripts/generate-davo-avatar.mjs --preview # dump a few frames as png
 *
 * Everything is computed per pixel from a loop-periodic field, so the animation
 * is seamless by construction: every term is a function of sin/cos(2*pi*t*k)
 * with integer k, and the one non-periodic term (the ring pulse) is amplitude-
 * faded to zero at both ends of the cycle.
 *
 * No image tooling is available on this machine (no sharp/PIL/ffmpeg), hence the
 * hand-rolled GIF (LZW) and PNG (zlib) writers at the bottom.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SIZE = 144;
export const FRAMES = 32;
const STILL_FRAME = 6; // the frame used for the static fallback

/**
 * The sprite sheet carries one extra tile — a copy of frame 0 — purely to make
 * the CSS arithmetic exact.
 *
 * A percentage `background-position-y` resolves against (container - image), so
 * with N+1 tiles stacked vertically and `background-size: 100% (N+1)00%`, the
 * animated value k/N * 100% lands on offset -k * tileHeight for k = 0..N-1:
 * every step is exactly one tile. With only N tiles the denominator is N-1 and
 * every frame after the first is offset by a fraction of a tile, which shows up
 * as a sliver of the neighbouring frame. The extra tile is never displayed.
 */
export const SPRITE_TILES = FRAMES + 1;

/**
 * Ramp through the colours the site actually uses: the page background, the
 * violet the assistant panel is trimmed in, and the sky/cyan its gradients end
 * on. Palette index i is exactly ramp(i / 255), so the field value below *is*
 * the colour index — there is no quantisation step.
 */
const RAMP = [
  [0.0, [9, 13, 28]], // ~ #0b1120, the body background
  [0.15, [24, 20, 66]],
  [0.32, [67, 33, 150]], // violet-900
  [0.48, [124, 58, 237]], // violet-600
  [0.62, [155, 110, 248]],
  [0.74, [139, 145, 252]], // violet handing over to sky
  [0.84, [99, 180, 250]],
  [0.92, [125, 211, 252]], // sky-300
  [0.97, [186, 230, 253]], // sky-200
  [1.0, [240, 249, 255]],
];

function ramp(t) {
  const v = Math.min(1, Math.max(0, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (v <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      const k = (v - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * k),
        Math.round(c0[1] + (c1[1] - c0[1]) * k),
        Math.round(c0[2] + (c1[2] - c0[2]) * k),
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

const smoothstep = (a, b, x) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/**
 * Orbiting energy centres. Speeds are integers so the orbits close on the loop.
 * They are kept small and close in: they are there to make the light move, not
 * to break the circular silhouette.
 */
const BLOBS = [
  { speed: 1, phase: 0.0, orbit: 0.28, sigma: 0.2, amp: 0.24 },
  { speed: -1, phase: 2.09, orbit: 0.36, sigma: 0.17, amp: 0.2 },
  { speed: 2, phase: 4.19, orbit: 0.2, sigma: 0.14, amp: 0.16 },
];

/**
 * Field value in [0,1] at normalised coords x,y in [-1,1] and loop phase t in
 * [0,1).
 *
 * The orb is one monotonic centre-out falloff whose *shape* is warped, rather
 * than a sum of glows: adding bright terms on top of each other saturated the
 * middle to white and left the gaps between them reading as cracks. Warping the
 * radius keeps the brightness gradient intact — so the ramp is traversed in
 * order, cyan core through sky and violet to the page background — while the
 * silhouette and the internal banding still move.
 */
function field(x, y, t) {
  const tau = 2 * Math.PI * t;
  const r = Math.hypot(x, y);
  const a = Math.atan2(y, x);

  // Angular waves. Integer multipliers on `a` keep them continuous across the
  // seam at +/-pi; integer multipliers on tau close the loop.
  const warp =
    0.055 * Math.sin(3 * a + 4.5 * r - tau) +
    0.055 * Math.sin(-2 * a + 7.0 * r + 2 * tau) +
    0.045 * Math.sin(5 * a - 6.0 * r - 3 * tau + 1.7);

  // Energy centres pull the falloff outward where they sit, so the orb bulges
  // and brightens around them as they drift.
  let pull = 0;
  for (const b of BLOBS) {
    const ang = b.speed * tau + b.phase;
    const dx = x - b.orbit * Math.cos(ang);
    const dy = y - b.orbit * Math.sin(ang);
    pull += b.amp * Math.exp(-((dx * dx + dy * dy) / (b.sigma * b.sigma)));
  }

  // Breathing: the whole orb swells and settles once per loop.
  const breath = 0.94 + 0.05 * Math.sin(tau);

  const rEff = r * (1 + warp) - 0.26 * pull;
  let v = 1 - smoothstep(0.0, breath, rEff);
  v = v ** 1.35;

  // A thin bright rim, brightest where the angular waves crest — this is what
  // reads as an iris and keeps the orb from looking like a plain gradient.
  const rim = Math.exp(-(((rEff - 0.56) / 0.16) ** 2));
  v += 0.13 * rim * (0.45 + 0.55 * Math.sin(3 * a - tau));

  // A pulse travelling outward once per loop, faded in and out so it does not
  // pop at the wrap point.
  const ringR = 0.15 + 0.75 * t;
  const fade = Math.sin(Math.PI * t) ** 2;
  v += 0.14 * fade * Math.exp(-(((rEff - ringR) / 0.09) ** 2));

  // The orb sits in the dark page background; nothing survives past the edge.
  v *= 1 - smoothstep(0.82, 1.15, r);

  return Math.min(1, Math.max(0, v));
}

/** Renders one frame as a Uint8Array of palette indices (0-255). */
export function renderFrame(t) {
  const out = new Uint8Array(SIZE * SIZE);
  const half = (SIZE - 1) / 2;
  for (let py = 0; py < SIZE; py++) {
    const y = (py - half) / half;
    for (let px = 0; px < SIZE; px++) {
      const x = (px - half) / half;
      // 2x2 supersample keeps the swirl edges from crawling when the avatar is
      // drawn at 32px.
      const s = 0.35 / half;
      const v =
        (field(x - s, y - s, t) +
          field(x + s, y - s, t) +
          field(x - s, y + s, t) +
          field(x + s, y + s, t)) /
        4;
      out[py * SIZE + px] = Math.round(255 * v ** 1.05);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Per-scanline filter choice, using the standard minimum-sum-of-absolute-
 * differences heuristic over None/Sub/Up. The orb is a smooth gradient, so Up
 * usually wins by a wide margin and the sheet compresses to well under what the
 * equivalent GIF cost.
 */
function filterScanline(cur, prev, out, at) {
  const n = cur.length;
  const cands = [
    [0, (i) => cur[i]],
    [1, (i) => cur[i] - (i > 0 ? cur[i - 1] : 0)],
    [2, (i) => cur[i] - prev[i]],
  ];
  let best = null;
  let bestScore = Infinity;
  for (const [type, f] of cands) {
    let score = 0;
    for (let i = 0; i < n; i++) {
      const v = f(i) & 0xff;
      score += v < 128 ? v : 256 - v; // treat as signed
    }
    if (score < bestScore) {
      bestScore = score;
      best = [type, f];
    }
  }
  out[at] = best[0];
  for (let i = 0; i < n; i++) out[at + 1 + i] = best[1](i) & 0xff;
}

/** The sprite sheet: every frame stacked vertically as one indexed-colour PNG. */
function buildSpritePng(frames) {
  const tiles = [...frames, frames[0]];
  if (tiles.length !== SPRITE_TILES) throw new Error('sprite tile count mismatch');
  const height = SIZE * tiles.length;

  const raw = Buffer.alloc(height * (SIZE + 1));
  const zero = new Uint8Array(SIZE);
  let prev = zero;
  for (let t = 0; t < tiles.length; t++) {
    for (let y = 0; y < SIZE; y++) {
      const row = tiles[t].subarray(y * SIZE, (y + 1) * SIZE);
      filterScanline(row, prev, raw, (t * SIZE + y) * (SIZE + 1));
      prev = row;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const plte = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = ramp(i / 255);
    plte[i * 3] = r;
    plte[i * 3 + 1] = g;
    plte[i * 3 + 2] = b;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildPng(indices) {
  const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  let p = 0;
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = ramp(indices[y * SIZE + x] / 255);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------- main

function main() {
  const frames = [];
  for (let i = 0; i < FRAMES; i++) frames.push(renderFrame(i / FRAMES));

  if (process.argv.includes('--preview')) {
    for (const i of [0, 6, 12, 20, 28]) {
      const out = join(ROOT, `preview-${i}.png`);
      writeFileSync(out, buildPng(frames[i]));
      console.log('wrote', out);
    }
    return;
  }

  const sprite = buildSpritePng(frames);
  const still = buildPng(frames[STILL_FRAME]);
  writeFileSync(join(ROOT, 'public/photos/davo-avatar-sprite.png'), sprite);
  writeFileSync(join(ROOT, 'public/photos/davo-avatar-still.png'), still);
  console.log(
    `sprite  ${SIZE}x${SIZE * SPRITE_TILES}  ${SPRITE_TILES} tiles  ${(sprite.length / 1024).toFixed(0)} KB`,
  );
  console.log(`still   ${SIZE}x${SIZE}${' '.repeat(String(SIZE * SPRITE_TILES).length - 3)}          ${(still.length / 1024).toFixed(0)} KB`);
}

// Importable (scripts/verify-davo-avatar.mjs re-renders the frames to check the
// encoder) — only write files when run directly.
if (process.argv[1] && process.argv[1].endsWith('generate-davo-avatar.mjs')) main();
