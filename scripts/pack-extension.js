// Zip the browser extension into static/ for download (stored, no compression; no zip tool needed).
import fs from 'node:fs';
import zlib from 'node:zlib';
const FILES = ['manifest.json', 'background.js', 'content.js', 'parse.js', 'icon128.png'];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const local = [], central = []; let off = 0;
for (const name of FILES) {
  const data = fs.readFileSync(new URL(`../extension/${name}`, import.meta.url));
  const comp = zlib.deflateRawSync(data);
  const n = Buffer.from(name), crc = crc32(data);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(0, 10);
  h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
  local.push(h, n, comp);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(0, 12);
  c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
  central.push(c, n);
  off += 30 + n.length + comp.length;
}
const cd = Buffer.concat(central);
const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(FILES.length, 8); end.writeUInt16LE(FILES.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
fs.writeFileSync(new URL('../static/moneyowed-extension.zip', import.meta.url), Buffer.concat([...local, cd, end]));
console.log('static/moneyowed-extension.zip', FILES.length, 'files');
