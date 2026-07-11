#!/usr/bin/env node
/**
 * Generate OmniAPI desktop icons.
 * Concept: 银月灵狐猫 · Omni Guardian
 * - anime / xianxia-inspired silver fox-cat avatar
 * - moon ring as Omni "O"
 * - API nodes as small stars
 *
 * No native image dependencies: writes PNG/ICO directly via zlib.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconDir = resolve(__dirname, '..', 'src-tauri', 'icons');
mkdirSync(iconDir, { recursive: true });

const W = 1024;
const H = 1024;
const data = new Uint8ClampedArray(W * H * 4);

const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => Math.round(a + (b - a) * t);
const hex = (s) => {
  const v = s.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 255];
};

function blendPx(x, y, color) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  const a = color[3] / 255;
  const ia = 1 - a;
  data[i] = color[0] * a + data[i] * ia;
  data[i + 1] = color[1] * a + data[i + 1] * ia;
  data[i + 2] = color[2] * a + data[i + 2] * ia;
  data[i + 3] = 255 * (a + (data[i + 3] / 255) * ia);
}

function roundedRectContains(x, y, rx, ry, rw, rh, r) {
  const x2 = rx + rw;
  const y2 = ry + rh;
  if (x < rx || y < ry || x > x2 || y > y2) return false;
  const cx = x < rx + r ? rx + r : x > x2 - r ? x2 - r : x;
  const cy = y < ry + r ? ry + r : y > y2 - r ? y2 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function fillRoundedGradient() {
  const pad = 56, rw = W - pad * 2, rh = H - pad * 2, r = 210;
  const c1 = hex('#1E1B4B');
  const c2 = hex('#4F46E5');
  const c3 = hex('#06B6D4');
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!roundedRectContains(x, y, pad, pad, rw, rh, r)) continue;
      const t = (x * 0.55 + y * 0.45) / W;
      const u = Math.max(0, 1 - Math.hypot(x - 800, y - 220) / 720);
      const base = [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t), 255];
      const col = [mix(base[0], c3[0], u * 0.55), mix(base[1], c3[1], u * 0.55), mix(base[2], c3[2], u * 0.55), 255];
      blendPx(x, y, col);
    }
  }
}

function ellipseAlpha(x, y, cx, cy, rx, ry) {
  const v = ((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2);
  const edge = 1 - v;
  return clamp(edge * 7, 0, 1);
}

function fillEllipse(cx, cy, rx, ry, color) {
  const x0 = Math.floor(cx - rx - 2), x1 = Math.ceil(cx + rx + 2);
  const y0 = Math.floor(cy - ry - 2), y1 = Math.ceil(cy + ry + 2);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const a = ellipseAlpha(x, y, cx, cy, rx, ry);
      if (a > 0) blendPx(x, y, [color[0], color[1], color[2], color[3] * a]);
    }
  }
}

function strokeEllipse(cx, cy, rx, ry, width, color) {
  const x0 = Math.floor(cx - rx - width - 3), x1 = Math.ceil(cx + rx + width + 3);
  const y0 = Math.floor(cy - ry - width - 3), y1 = Math.ceil(cy + ry + width + 3);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const v = Math.sqrt(((x - cx) ** 2) / (rx ** 2) + ((y - cy) ** 2) / (ry ** 2));
      const d = Math.abs(v - 1) * Math.max(rx, ry);
      if (d < width) {
        const a = clamp((width - d) / 3, 0, 1);
        blendPx(x, y, [color[0], color[1], color[2], color[3] * a]);
      }
    }
  }
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = ((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function fillPoly(pts, color) {
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // 2x2 subpixel coverage for softer edges
      let c = 0;
      for (const ox of [0.25, 0.75]) for (const oy of [0.25, 0.75]) if (pointInPoly(x + ox, y + oy, pts)) c++;
      if (c) blendPx(x, y, [color[0], color[1], color[2], color[3] * c / 4]);
    }
  }
}

function line(x0, y0, x1, y1, width, color) {
  const minX = Math.floor(Math.min(x0, x1) - width), maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width), maxY = Math.ceil(Math.max(y0, y1) + width);
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const t = clamp(((x - x0) * dx + (y - y0) * dy) / len2, 0, 1);
    const px = x0 + t * dx, py = y0 + t * dy;
    const d = Math.hypot(x - px, y - py);
    if (d < width) blendPx(x, y, [color[0], color[1], color[2], color[3] * clamp((width - d) / 2, 0, 1)]);
  }
}

function star(cx, cy, r, color) {
  fillEllipse(cx, cy, r, r, color);
  line(cx - r * 2.2, cy, cx + r * 2.2, cy, r * 0.34, [color[0], color[1], color[2], color[3] * 0.55]);
  line(cx, cy - r * 2.2, cx, cy + r * 2.2, r * 0.34, [color[0], color[1], color[2], color[3] * 0.55]);
}

function draw() {
  fillRoundedGradient();

  // Ambient moon glow
  fillEllipse(512, 500, 380, 380, [125, 211, 252, 30]);
  fillEllipse(512, 500, 300, 300, [199, 210, 254, 26]);

  // Omni moon ring and API nodes
  strokeEllipse(512, 500, 350, 334, 21, [226, 232, 255, 92]);
  strokeEllipse(512, 500, 306, 294, 5, [34, 211, 238, 80]);
  for (const [a, rr] of [[-55, 11], [-20, 7], [28, 10], [84, 7], [142, 9], [210, 6]]) {
    const rad = a * Math.PI / 180;
    const x = 512 + Math.cos(rad) * 350;
    const y = 500 + Math.sin(rad) * 334;
    star(x, y, rr, [224, 242, 254, 210]);
  }

  // Tail-like moon ribbon behind face
  strokeEllipse(514, 566, 244, 192, 14, [167, 139, 250, 76]);

  // Outer ears shadow/glow
  fillPoly([[254, 410], [352, 136], [460, 420]], [49, 46, 129, 115]);
  fillPoly([[770, 410], [672, 136], [564, 420]], [49, 46, 129, 115]);

  // Ears
  fillPoly([[282, 398], [362, 148], [468, 430], [390, 392]], [238, 246, 255, 246]);
  fillPoly([[742, 398], [662, 148], [556, 430], [634, 392]], [238, 246, 255, 246]);
  fillPoly([[327, 372], [367, 228], [426, 390]], [196, 181, 253, 210]);
  fillPoly([[697, 372], [657, 228], [598, 390]], [196, 181, 253, 210]);
  fillPoly([[344, 350], [370, 262], [405, 374]], [125, 211, 252, 95]);
  fillPoly([[680, 350], [654, 262], [619, 374]], [125, 211, 252, 95]);

  // Head shadow then head
  fillEllipse(512, 592, 275, 238, [15, 23, 42, 95]);
  fillEllipse(512, 556, 262, 232, [248, 251, 255, 248]);
  fillEllipse(512, 578, 240, 208, [226, 240, 255, 126]);

  // Cheek fur
  fillPoly([[288, 584], [214, 668], [334, 672], [384, 748], [444, 646]], [239, 246, 255, 238]);
  fillPoly([[736, 584], [810, 668], [690, 672], [640, 748], [580, 646]], [239, 246, 255, 238]);

  // Forehead silver/moon marks
  fillPoly([[512, 356], [456, 472], [512, 430], [568, 472]], [191, 219, 254, 115]);
  fillEllipse(512, 412, 37, 37, [224, 242, 254, 230]);
  fillEllipse(526, 405, 33, 33, [79, 70, 229, 205]);
  fillEllipse(497, 423, 7, 7, [34, 211, 238, 180]);

  // Face mask / muzzle
  fillEllipse(512, 626, 158, 104, [255, 255, 255, 218]);
  fillEllipse(512, 620, 22, 14, [79, 70, 229, 210]);
  line(512, 633, 512, 666, 3, [79, 70, 229, 155]);
  line(512, 666, 474, 690, 3, [79, 70, 229, 135]);
  line(512, 666, 550, 690, 3, [79, 70, 229, 135]);

  // Eyes with anime highlights
  fillEllipse(416, 535, 48, 56, [14, 165, 233, 225]);
  fillEllipse(608, 535, 48, 56, [129, 140, 248, 225]);
  fillEllipse(416, 548, 25, 33, [15, 23, 42, 165]);
  fillEllipse(608, 548, 25, 33, [15, 23, 42, 165]);
  fillEllipse(400, 514, 11, 11, [255, 255, 255, 230]);
  fillEllipse(592, 514, 11, 11, [255, 255, 255, 230]);
  fillEllipse(430, 526, 6, 6, [224, 242, 254, 180]);
  fillEllipse(622, 526, 6, 6, [224, 242, 254, 180]);

  // Soft outline and whiskers
  strokeEllipse(512, 556, 266, 234, 5, [224, 242, 254, 110]);
  line(365, 628, 284, 606, 4, [199, 210, 254, 130]);
  line(363, 657, 274, 670, 4, [199, 210, 254, 120]);
  line(659, 628, 740, 606, 4, [199, 210, 254, 130]);
  line(661, 657, 750, 670, 4, [199, 210, 254, 120]);

  // Sparkles foreground
  star(250, 278, 7, [224, 242, 254, 185]);
  star(770, 282, 8, [224, 242, 254, 185]);
  star(266, 786, 5, [165, 243, 252, 160]);
  star(758, 786, 5, [165, 243, 252, 160]);
}

draw();

function pngEncode(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunks = [];
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, payload) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(Buffer.concat([t, payload])));
    chunks.push(len, t, payload, cr);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', deflateSync(raw, { level: 9 }));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ...chunks]);
}

function downsample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = Math.floor(x * sx), x1 = Math.floor((x + 1) * sx);
    const y0 = Math.floor(y * sy), y1 = Math.floor((y + 1) * sy);
    let r=0,g=0,b=0,a=0,n=0;
    for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) {
      const i = (yy * sw + xx) * 4;
      r += src[i]; g += src[i+1]; b += src[i+2]; a += src[i+3]; n++;
    }
    const o = (y * dw + x) * 4;
    out[o] = r / n; out[o+1] = g / n; out[o+2] = b / n; out[o+3] = a / n;
  }
  return out;
}

const png1024 = pngEncode(W, H, data);
writeFileSync(join(iconDir, 'icon.png'), png1024);
writeFileSync(join(iconDir, '512x512.png'), pngEncode(512, 512, downsample(data, W, H, 512, 512)));
writeFileSync(join(iconDir, '128x128.png'), pngEncode(128, 128, downsample(data, W, H, 128, 128)));
writeFileSync(join(iconDir, '32x32.png'), pngEncode(32, 32, downsample(data, W, H, 32, 32)));

function trayVariant(statusColor) {
  const size = 64;
  const img = downsample(data, W, H, size, size);
  const cx = 49;
  const cy = 49;
  const outer = 13;
  const inner = 9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const i = (y * size + x) * 4;
      if (d <= outer) {
        img[i] = 255;
        img[i + 1] = 255;
        img[i + 2] = 255;
        img[i + 3] = 255;
      }
      if (d <= inner) {
        img[i] = statusColor[0];
        img[i + 1] = statusColor[1];
        img[i + 2] = statusColor[2];
        img[i + 3] = 255;
      }
    }
  }
  return pngEncode(size, size, img);
}

writeFileSync(join(iconDir, 'tray-ok.png'), trayVariant([16, 185, 129]));
writeFileSync(join(iconDir, 'tray-warn.png'), trayVariant([245, 158, 11]));
writeFileSync(join(iconDir, 'tray-bad.png'), trayVariant([239, 68, 68]));
writeFileSync(join(iconDir, 'tray-idle.png'), trayVariant([148, 163, 184]));

function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const payloads = [];
  entries.forEach((e, idx) => {
    const sizeByte = e.size >= 256 ? 0 : e.size;
    dir[idx*16] = sizeByte;
    dir[idx*16+1] = sizeByte;
    dir[idx*16+2] = 0;
    dir[idx*16+3] = 0;
    dir.writeUInt16LE(1, idx*16+4);
    dir.writeUInt16LE(32, idx*16+6);
    dir.writeUInt32LE(e.buf.length, idx*16+8);
    dir.writeUInt32LE(offset, idx*16+12);
    payloads.push(e.buf);
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir, ...payloads]);
}
const icoEntries = [16, 24, 32, 48, 64, 128, 256].map(size => ({
  size,
  buf: pngEncode(size, size, downsample(data, W, H, size, size)),
}));
writeFileSync(join(iconDir, 'icon.ico'), makeIco(icoEntries));

// Keep the legacy odd path in tauri.conf valid if present.
writeFileSync(join(iconDir, 'henry.w@example.net'), pngEncode(512, 512, downsample(data, W, H, 512, 512)));

console.log(`[generate-icon] wrote Omni Guardian icons to ${iconDir}`);
