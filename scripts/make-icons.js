// Gera public/icons/icon-192.png e icon-512.png: "HX" em PIXEL ART (H branco, X vermelho)
// com sombra 3D de 1 pixel e fundo escuro com leve gradiente. Sem dependências (PNG à mão).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw.writeUInt32BE(((r << 24) | (g << 16) | (b << 8) | a) >>> 0, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Glifos pixel art bold (7 col x 9 linhas)
const H = ['##...##', '##...##', '##...##', '##...##', '#######', '##...##', '##...##', '##...##', '##...##'];
const X = ['##...##', '##...##', '.##.##.', '..###..', '..###..', '..###..', '.##.##.', '##...##', '##...##'];
const GW = 7, GH = 9, GAP = 2, TW = GW + GAP + GW; // 16 de largura

// Retorna { c: 'H'|'X'|null, on: bool } para a célula (gx,gy) do grid do texto
function cell(gx, gy) {
  if (gy < 0 || gy >= GH || gx < 0 || gx >= TW) return null;
  if (gx < GW) return { c: 'H', on: H[gy][gx] === '#' };
  if (gx < GW + GAP) return { c: null, on: false };
  return { c: 'X', on: X[gy][gx - GW - GAP] === '#' };
}

const COLOR = { H: [238, 240, 243], X: [242, 63, 67] };     // H quase-branco, X vermelho
const SHADOW = { H: [9, 9, 12], X: [92, 16, 20] };          // sombra 3D (down-right)
const lerp = (a, b, t) => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const BG_TOP = [34, 36, 41], BG_BOT = [22, 23, 26];        // fundo com leve gradiente

function pixelAt(size) {
  const scale = Math.floor((size * 0.74) / TW);
  const w = TW * scale, h = GH * scale;
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2);
  return (x, y) => {
    const gx = Math.floor((x - ox) / scale), gy = Math.floor((y - oy) / scale);
    const cur = cell(gx, gy);
    if (cur && cur.on) { const c = COLOR[cur.c]; return [c[0], c[1], c[2], 255]; }
    const sh = cell(gx - 1, gy - 1); // sombra de 1 célula para baixo-direita
    if (sh && sh.on) { const c = SHADOW[sh.c]; return [c[0], c[1], c[2], 255]; }
    const bg = lerp(BG_TOP, BG_BOT, y / size);
    return [bg[0], bg[1], bg[2], 255];
  };
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makePng(size, pixelAt(size)));
  console.log(`icon-${size}.png OK`);
}
