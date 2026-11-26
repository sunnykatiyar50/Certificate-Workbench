// Renders the PWA icons (public/icons/*.png) from the same shield-and-check artwork as public/favicon.svg.
// No dependencies: shapes are rasterised with 4x4 supersampling and written as PNG with zlib.
// Run: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

// Shield outline from favicon.svg (64x64 grid), curves flattened into points.
function bezier(p0, p1, p2, p3, n = 16) {
  const pts = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    ]);
  }
  return pts;
}
const SHIELD = [
  [32, 9], [12, 17], [12, 31],
  ...bezier([12, 31], [12, 43], [20.5, 51.5], [32, 55]),
  ...bezier([32, 55], [43.5, 51.5], [52, 43], [52, 31]),
  [52, 17]
];
const CHECK = [[23, 32], [29.5, 38.5], [42, 25]];
const CHECK_WIDTH = 5.5;

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearSegment(x, y, a, b, half) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)) <= half;
}

const onCheck = (x, y) => nearSegment(x, y, CHECK[0], CHECK[1], CHECK_WIDTH / 2) || nearSegment(x, y, CHECK[1], CHECK[2], CHECK_WIDTH / 2);

function inRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 64 - radius), cy = Math.min(Math.max(y, radius), 64 - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

// scale < 1 shrinks the artwork towards the centre (maskable icons keep it inside the safe zone).
function render(size, { rounded, scale }) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = ((px + (sx + 0.5) / SS) / size) * 64, y = ((py + (sy + 0.5) / SS) / size) * 64;
          if (rounded && !inRoundedSquare(x, y, 14)) continue;
          const gx = (x - 32) / scale + 32, gy = (y - 32) / scale + 32;
          const colour = inPolygon(gx, gy, SHIELD) ? (onCheck(gx, gy) ? BLUE : WHITE) : BLUE;
          r += colour[0]; g += colour[1]; b += colour[2]; a += 255;
        }
      }
      const n = SS * SS, o = py * (size * 4 + 1) + 1 + px * 4;
      const covered = a / 255;
      raw[o] = covered ? Math.round(r / covered) : 0;
      raw[o + 1] = covered ? Math.round(g / covered) : 0;
      raw[o + 2] = covered ? Math.round(b / covered) : 0;
      raw[o + 3] = Math.round((covered / n) * 255);
    }
  }
  return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
function png(size, options) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(render(size, options), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
const ICONS = {
  'icon-192.png': [192, { rounded: true, scale: 1 }],
  'icon-512.png': [512, { rounded: true, scale: 1 }],
  'icon-maskable-512.png': [512, { rounded: false, scale: 0.7 }], // full-bleed; the OS applies its own mask
  'apple-touch-icon.png': [180, { rounded: false, scale: 0.85 }]   // iOS rounds the corners itself
};
for (const [name, [size, options]] of Object.entries(ICONS)) {
  fs.writeFileSync(path.join(out, name), png(size, options));
  console.log('wrote public/icons/' + name);
}
