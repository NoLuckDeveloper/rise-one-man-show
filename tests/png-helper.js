'use strict';
// Minimal truecolor PNG encoder (Node built-ins only) for tests: builds real
// PNG bytes so data-URL validation (magic bytes, size floors) is exercised
// with genuine images instead of hand-written base64.
const zlib = require('node:zlib');

// CRC-32 (IEEE) for PNG chunks.
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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// paint(x, y) => [r, g, b].
function makePng(width, height, paint) {
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = () => [255, 255, 255];
const BLACK = () => [0, 0, 0];

// A scribbled signature: several crossing strokes on white, 420x160 like
// the proposal page's signature pad.
function signaturePng() {
  return makePng(420, 160, (x, y) => {
    const onStroke =
      (Math.abs(y - (20 + x * 0.18)) < 2 && x > 30 && x < 200) ||
      (Math.abs(y - (120 - x * 0.25)) < 2 && x > 60 && x < 260) ||
      (Math.abs(y - (70 + Math.sin(x / 18) * 22)) < 2 && x > 120 && x < 380) ||
      (Math.abs(x - (300 + Math.sin(y / 9) * 8)) < 2 && y > 40 && y < 130);
    return onStroke ? BLACK() : WHITE();
  });
}

// A blank (all-white) 420x160 canvas — what an untouched signature pad
// encodes to. Must stay well under the server's signature size floor.
function blankPng() {
  return makePng(420, 160, WHITE);
}

// Small logo image for the company-profile upload test.
function logoPng() {
  return makePng(48, 24, (x) => (x < 24 ? [124, 58, 237] : [255, 255, 255]));
}

function dataUrl(buf) {
  return 'data:image/png;base64,' + buf.toString('base64');
}

module.exports = { makePng, signaturePng, blankPng, logoPng, dataUrl };
