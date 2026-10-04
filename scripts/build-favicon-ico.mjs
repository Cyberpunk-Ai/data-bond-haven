// Rebuild `public/favicon.ico` as a multi-size icon.
//
// Why this exists: a browser tab is 16–32px at 1x but 32–64px at 2x, and the
// committed favicon.ico held exactly one 32×32 4-bit bitmap. Every retina tab,
// every Windows taskbar pin and every feed reader that ignores `<link rel="icon">`
// was upscaling that one image. The fix is not a bigger single image — it is one
// .ico carrying several sizes so each reader picks its own.
//
// An .ico is a directory of images, and a modern one may hold PNG payloads
// instead of bitmaps. So this keeps the legacy 32×32 bitmap (maximum
// compatibility: everything that has ever read .ico can read that entry) and
// appends the real PNG brand marks from the same folder. No resampling happens
// here and no artwork is invented — the entries are the existing files.
//
// Idempotent: the legacy entry is taken from whichever sub-48px bitmap is
// already in the file, so re-running only refreshes the PNG entries.
//
// Usage: npm run favicon:build

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICO = path.join(root, "public", "favicon.ico");
const PNGS = [
  // The set PWA validators ask an .ico to carry: 16, 48 and the 256 slot, next
  // to the legacy 32 bitmap the builder keeps from the existing file. The old
  // build embedded the 192/512 marks, which the audit flagged as *extra* sizes —
  // the .ico is for small classic slots, the declared PNG `<link>`s and the
  // manifest are what should carry 192/512.
  { file: "public/favicon-16x16.png", declared: 16 },
  { file: "public/favicon-48x48.png", declared: 48 },
  // A 256px payload must still be declared as 0: sizes of 256+ cannot be
  // expressed in the one-byte directory fields, so the spec says to write 0 and
  // let the reader take the real width from the PNG header. Chrome, Firefox and
  // Windows all honour that, and the validator reports the entry as 256x256.
  { file: "public/favicon-256x256.png", declared: 0 },
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read an .ico and return its directory entries with their payloads. */
function readIco(buf) {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error("Not an .ico (cursor/bitmap) file");
  }
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    const payload = buf.subarray(offset, offset + size);
    if (payload.length !== size) throw new Error(`Entry ${i} is truncated`);
    entries.push({
      width: buf[at],
      height: buf[at + 1],
      colorCount: buf[at + 2],
      reserved: buf[at + 3],
      planes: buf.readUInt16LE(at + 4),
      bitCount: buf.readUInt16LE(at + 6),
      payload,
    });
  }
  return entries;
}

/** Square dimensions of a PNG, straight out of the IHDR chunk. */
function pngSize(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function buildIco(entries) {
  const directorySize = 6 + entries.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = directorySize;
  const parts = [header];
  for (const [i, entry] of entries.entries()) {
    const at = 6 + i * 16;
    header[at] = entry.width;
    header[at + 1] = entry.height;
    header[at + 2] = entry.colorCount;
    header[at + 3] = entry.reserved ?? 0;
    header.writeUInt16LE(entry.planes ?? 1, at + 4);
    header.writeUInt16LE(entry.bitCount ?? 32, at + 6);
    header.writeUInt32LE(entry.payload.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    parts.push(entry.payload);
    offset += entry.payload.length;
  }
  return Buffer.concat(parts);
}

const existing = existsSync(ICO) ? readIco(readFileSync(ICO)) : [];
// The compatibility entry: the first small bitmap already in the file. A PNG
// payload is skipped because a modern reader will get the PNG entries anyway,
// and the point of this entry is the readers that do not.
const legacy = existing.find(
  (e) => e.width > 0 && e.width <= 48 && !e.payload.subarray(0, 8).equals(PNG_SIGNATURE),
);

const entries = [];
if (legacy) {
  entries.push(legacy);
  console.log(
    `keeping legacy entry  ${legacy.width}×${legacy.width} bitmap (${legacy.payload.length} B)`,
  );
} else {
  console.warn(`no sub-48px bitmap found in ${path.relative(root, ICO)} — building from PNGs only`);
}

for (const { file, declared } of PNGS) {
  const abs = path.join(root, file);
  if (!existsSync(abs)) throw new Error(`Missing ${file}; the icon set is incomplete.`);
  const payload = readFileSync(abs);
  const { width, height } = pngSize(payload);
  if (width !== height) throw new Error(`${file} is ${width}×${height}; icons must be square.`);
  entries.push({
    width: declared,
    height: declared,
    colorCount: 0,
    reserved: 0,
    planes: 1,
    bitCount: 32,
    payload,
  });
  console.log(`adding PNG entry    ${width}×${height} from ${file} (${payload.length} B)`);
}

const out = buildIco(entries);
writeFileSync(ICO, out);
console.log(`wrote ${path.relative(root, ICO)} — ${entries.length} sizes, ${out.length} bytes`);
