// One extractor for every SLA page, used both when a card is written and in the nightly change check,
// so "the text changed" always means the vendor's page changed, never that our extraction did.
import zlib from 'node:zlib';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™', le: '≤', ge: '≥' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  let t = html;
  // Some pages embed the legal text as escaped HTML inside JSON; unescape that first.
  t = t.replace(/\\r\\n|\\n/g, ' ').replace(/\\"/g, '"').replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\u0026/gi, '&');
  t = t.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<\/?[a-zA-Z][^<>]*>/g, ' '); // real tags only; a literal "< 99.9%" in text is &lt; until decoded below
  t = decodeEntities(decodeEntities(t));
  return t.replace(/\s+/g, ' ').trim();
}

export function docxToText(buf) {
  // Minimal .docx reader: find word/document.xml in the zip and keep paragraph text.
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8');
  const paras = xml.split(/<\/w:p>/).map((p) => decodeEntities(p.replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, '')));
  return paras.join(' ').replace(/\s+/g, ' ').trim();
}

function unzipEntry(buf, name) {
  // Walk the central directory.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const cdOff = buf.readUInt32LE(eocd + 16), n = buf.readUInt16LE(eocd + 10);
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const fname = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    if (fname === name) {
      const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
      const data = buf.slice(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
      return method === 8 ? zlib.inflateRawSync(data) : data;
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error(`${name} not found in zip`);
}

export function toText(buf, kind) {
  let b = buf;
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return kind === 'docx' ? docxToText(b) : htmlToText(b.toString('utf8'));
}
