import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createPng(width, height) {
  // 8-byte PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 6; // color type 6: RGBA
  ihdrData[10] = 0; // compression method 0
  ihdrData[11] = 0; // filter method 0
  ihdrData[12] = 0; // interlace method 0
  const ihdr = makeChunk('IHDR', ihdrData);

  // Raw image data with filter byte 0 at start of each scanline
  const scanlineLength = 1 + width * 4;
  const rawData = Buffer.alloc(height * scanlineLength);

  const cx = width / 2;
  const cy = height / 2;
  const rOuter = width * 0.45;

  for (let y = 0; y < height; y++) {
    const lineOffset = y * scanlineLength;
    rawData[lineOffset] = 0; // Filter: None

    for (let x = 0; x < width; x++) {
      const pixelOffset = lineOffset + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Base background: #0b0f17
      let r = 11;
      let g = 15;
      let b = 23;
      let a = 255;

      // Squircle / rounded box
      const nx = Math.abs(dx) / (width * 0.44);
      const ny = Math.abs(dy) / (height * 0.44);
      const inBox = Math.pow(nx, 4) + Math.pow(ny, 4) <= 1.0;

      if (!inBox) {
        a = 0; // Transparent corners
      } else {
        // Gradient lightning core in center
        const t = (x + y) / (width + height); // gradient 0 to 1
        const gradR = Math.round(0 * (1 - t) + 16 * t);
        const gradG = Math.round(242 * (1 - t) + 185 * t);
        const gradB = Math.round(254 * (1 - t) + 129 * t);

        // Simple lightning polygon approximation
        const inBolt = (
          (dx > -width * 0.18 && dx < width * 0.18 && dy > -height * 0.35 && dy < height * 0.35) &&
          (dy < -dx * 1.5 + height * 0.05 || dy > -dx * 1.5 - height * 0.05)
        );

        if (dist < width * 0.22) {
          // Central glow and icon
          r = gradR;
          g = gradG;
          b = gradB;
        }
      }

      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressedData);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBuf, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(calculateCrc32(payload), 0);

  return Buffer.concat([len, payload, crc]);
}

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function calculateCrc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const targets = [
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/icon-512.png', size: 512 },
  { file: 'public/icon-maskable-512.png', size: 512 },
  { file: 'public/apple-touch-icon.png', size: 180 },
  { file: 'assets/icon-only.png', size: 512 },
  { file: 'assets/icon-foreground.png', size: 512 },
  { file: 'assets/icon.png', size: 512 },
  { file: 'assets/splash.png', size: 512 }
];

for (const t of targets) {
  const dir = path.dirname(t.file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(t.file, createPng(t.size, t.size));
  console.log(`Generated ${t.file} (${t.size}x${t.size})`);
}
