// Gera public/icons/icon-192.png e icon-512.png ("HX" pixelado) sem dependências
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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size, pixelAt) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filtro none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      raw.writeUInt32BE(((r << 24) | (g << 16) | (b << 8) | a) >>> 0, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// "HX" em fonte 5x7
const GLYPHS = {
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
};
const TEXT = ['H', 'X'];
const TEXT_W = 5 * TEXT.length + (TEXT.length - 1); // 1px de espaço
const TEXT_H = 7;

const BG = [0x1e, 0x1f, 0x22, 255]; // fundo escuro
const GLYPH_COLORS = { H: [255, 255, 255, 255], X: [0xf2, 0x3f, 0x43, 255] }; // H branco, X vermelho

function iconPixel(size) {
  const scale = Math.floor((size * 0.62) / TEXT_W);
  const w = TEXT_W * scale;
  const h = TEXT_H * scale;
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  return (x, y) => {
    const gx = Math.floor((x - ox) / scale);
    const gy = Math.floor((y - oy) / scale);
    if (gx >= 0 && gx < TEXT_W && gy >= 0 && gy < TEXT_H) {
      const glyph = Math.floor(gx / 6);
      const col = gx % 6;
      if (col < 5 && GLYPHS[TEXT[glyph]][gy][col] === '#') return GLYPH_COLORS[TEXT[glyph]];
    }
    return BG;
  };
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makePng(size, iconPixel(size)));
  console.log(`icon-${size}.png OK`);
}
