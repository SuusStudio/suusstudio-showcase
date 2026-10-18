#!/usr/bin/env node
// SuusStudio™ Showcase QA: documentation links and embedded asset integrity only.
// This check DOES NOT assert image rights, consent, accuracy of private proof,
// GitHub Pages/Vercel visual rendering, or independent human acceptance.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markdownFiles = readdirSync(root).filter(name => name.endsWith('.md')).sort();
const failures = [];
let localLinks = 0;
let imageChecks = 0;
let externalLinks = 0;

function error(file, message) {
  failures.push(`${file}: ${message}`);
}
function readablePath(p) {
  return relative(root, p).split(sep).join('/');
}
// A JPEG can have intact SOI/EOI bytes but broken segments and no valid image scan.
// This validates the marker/segment chain through the first SOS. It is NOT a
// full image decoder, rendering test or license/consent check.
function hasJpegFrameAndScan(data) {
  if (data.length < 16 || data[0] !== 0xff || data[1] !== 0xd8 ||
      data.at(-2) !== 0xff || data.at(-1) !== 0xd9) return false;
  let position = 2;
  let hasFrame = false;
  while (position + 3 < data.length) {
    if (data[position++] !== 0xff) return false;
    while (position < data.length && data[position] === 0xff) position++;
    if (position >= data.length) return false;
    const marker = data[position++];
    if (marker === 0xd9) return false; // no scan before end
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (position + 2 > data.length) return false;
    const length = data.readUInt16BE(position);
    if (length < 2 || position + length > data.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)) hasFrame = true;
    if (marker === 0xda) return hasFrame;
    position += length;
  }
  return false;
}
const quarantinedImages = new Set([
  'assets/roblox-signal.jpg',
  'assets/defence-v5-dashboard.jpg',
]);
function embeddedAssetCheck(file, target) {
  imageChecks++;
  const readable = readablePath(target);
  if (quarantinedImages.has(readable)) {
    error(file, `previously invalid image embedded without verified replacement: ${readable}`);
  }
  const suffix = extname(target).toLowerCase();
  const data = readFileSync(target);
  if (suffix === '.jpg' || suffix === '.jpeg') {
    if (!hasJpegFrameAndScan(data)) {
      error(file, `embedded JPEG has missing/corrupt SOI, EOI, frame or scan: ${readable}`);
    }
  } else if (suffix === '.png') {
    if (!(data.length > 20 && data.subarray(0, 8).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.subarray(-8, -4).toString('ascii') === 'IEND')) {
      error(file, `embedded PNG missing signature/IEND: ${readablePath(target)}`);
    }
  } else if (suffix === '.svg') {
    const txt = data.toString('utf8');
    if (!/<svg(?:\s|>)/.test(txt) || !/<\/svg>/.test(txt)) {
      error(file, `embedded SVG has no outer SVG element: ${readablePath(target)}`);
    }
  }
}
for (const name of markdownFiles) {
  const full = resolve(root, name);
  const contents = readFileSync(full, 'utf8');
  // Keep the source scan narrow to Markdown inline image + link syntax.
  // Remote URLs are excluded from offline pass/fail, and are browser-QA HOLD.
  const pattern = /(!?)\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']+["'])?\)/g;
  for (const m of contents.matchAll(pattern)) {
    const isImage = m[1] === '!';
    const href = (m[2] ?? m[3]).trim();
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) {
      if (isImage) error(name, `remote or fragment-only image not checked: ${href}`);
      else externalLinks++;
      continue;
    }
    const rawPath = href.split(/[?#]/)[0];
    if (!rawPath) { error(name, 'empty local link'); continue; }
    let uri;
    try { uri = decodeURIComponent(rawPath); }
    catch { error(name, `invalid URI encoding: ${href}`); continue; }
    const target = resolve(dirname(full), uri);
    if (target !== root && !target.startsWith(root + sep)) {
      error(name, `relative link escapes repository: ${href}`);
      continue;
    }
    localLinks++;
    if (!existsSync(target) || !statSync(target).isFile()) {
      error(name, `missing local destination: ${href}`);
      continue;
    }
    if (isImage) embeddedAssetCheck(name, target);
  }
}
// Incomplete images are preserved as evidence but disallowed from Markdown embeds.
// To clear quarantine, first re-export, validate and obtain human rights signoff.
console.log(`SHOWCASE_QA markdown_files=${markdownFiles.length} local_links=${localLinks} embedded_images=${imageChecks} offline_external_links=${externalLinks}`);
for (const problem of failures) console.error(`FAIL: ${problem}`);
if (failures.length) {
  console.error(`SHOWCASE_QA=FAIL failures=${failures.length}`);
  process.exit(1);
}
console.log('SHOWCASE_QA=PASS (static links and embedded JPEG structure only; rights and browser HOLD)');
