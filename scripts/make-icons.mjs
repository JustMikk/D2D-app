// Generates the app icons (a door-hanger on Interstate blue) as PNGs with no image dependencies:
// shapes are rasterized with 4x4 supersampling and encoded with zlib. Run: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BLUE = [0x15, 0x65, 0xc0];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c, crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// The hanger, in unit coordinates (0..1): a card with rounded corners and a round hole near the top.
function inHanger(u, v) {
  const cx = 0.5, w = 0.44, top = 0.2, bottom = 0.8, r = 0.07;
  const dx = Math.abs(u - cx) - (w / 2 - r);
  const dy = Math.abs(v - (top + bottom) / 2) - ((bottom - top) / 2 - r);
  const inside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= r;
  const hole = Math.hypot(u - cx, v - (top + 0.1)) <= 0.055;
  return inside && !hole;
}

function icon(size) {
  const SS = 4;
  return png(size, (x, y) => {
    let covered = 0;
    for (let i = 0; i < SS; i++) for (let j = 0; j < SS; j++) if (inHanger((x + (i + 0.5) / SS) / size, (y + (j + 0.5) / SS) / size)) covered++;
    const a = covered / (SS * SS);
    return BLUE.map((c, k) => Math.round(c * (1 - a) + WHITE[k] * a));
  });
}

mkdirSync("public/icons", { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(`public/icons/${name}`, icon(size));
  console.log(`public/icons/${name}`);
}
