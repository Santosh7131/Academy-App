// Renames the product everywhere its name is set, in one go, or checks that every copy agrees.
//
//   node tools/rename-product.mjs "New Name"   sets the name in both apps, both launcher labels, the API's messages,
//                                              the website's pages and the README
//   node tools/rename-product.mjs --check      fails (exit 1) when the copies differ; says so while the stand-in is in
//
// The name lives in app/lib/core/brand.dart (both apps show it, and both android/app/build.gradle.kts read their
// launcher label from it), in its copy admin/lib/core/brand.dart (made by tools/sync-admin-ui.mjs), in
// api/src/lib/brand.ts (the server's messages), and in the pages in website/ and README.md, where every copy of the old name is
// replaced. The Android app ids are changed separately (they can never change once phones have the app).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const APP = 'app/lib/core/brand.dart';
const ADMIN = 'admin/lib/core/brand.dart';
const API = 'api/src/lib/brand.ts';
const SITE = 'website';
const README = 'README.md'; // the repository's front page names the product too
const DART = /^const appName = '([^']+)';(\r?)$/m;
const TS = /^export const APP_NAME = '([^']+)';(\r?)$/m;
const STAND_IN = /^\/\/\/ STAND-IN:.*\r?\n/m;
const read = (f) => fs.readFileSync(f, 'utf8');
const pages = () => (fs.existsSync(SITE) ? fs.readdirSync(SITE).filter((f) => f.endsWith('.html')).map((f) => `${SITE}/${f}`) : []);
// In HTML a name's & is written &amp;.
const html = (s) => s.replaceAll('&', '&amp;');

function check() {
  const names = [[APP, read(APP).match(DART)?.[1]], [ADMIN, read(ADMIN).match(DART)?.[1]], [API, read(API).match(TS)?.[1]]];
  for (const [f, n] of names) console.log(`${f}: ${n ?? '(not found)'}`);
  let same = names.every(([, n]) => n && n === names[0][1]);
  if (!same) console.log('The copies differ: run node tools/rename-product.mjs "Name" (or node tools/sync-admin-ui.mjs).');
  for (const p of names[0][1] ? pages() : []) {
    if (!read(p).includes(html(names[0][1]))) {
      console.log(`${p}: does not mention ${names[0][1]}`);
      same = false;
    }
  }
  if (names[0][1] && fs.existsSync(README) && !read(README).includes(names[0][1])) {
    console.log(`${README}: does not mention ${names[0][1]}`);
    same = false;
  }
  if (same && STAND_IN.test(read(APP))) console.log('This is still the stand-in name: no name has been chosen, and releases are refused.');
  return same;
}

const arg = process.argv[2];
if (arg === '--check') process.exit(check() ? 0 : 1);
if (!arg) {
  console.error('usage: node tools/rename-product.mjs "New Name" | --check');
  process.exit(2);
}
const name = arg.trim();
// Letters in any script (with their marks), digits, spaces, dots, hyphens and &; nothing that would end a quoted string.
if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} .&-]{0,28}[\p{L}\p{M}\p{N}]$/u.test(name)) {
  throw new Error('Use 2 to 30 letters, numbers, spaces, dots, hyphens or &, starting and ending with a letter or number.');
}
const old = read(APP).match(DART)?.[1];
fs.writeFileSync(APP, read(APP).replace(DART, `const appName = '${name}';$2`).replace(STAND_IN, ''));
fs.writeFileSync(API, read(API).replace(TS, `export const APP_NAME = '${name}';$2`));
if (old && old !== name) {
  for (const p of pages()) fs.writeFileSync(p, read(p).replaceAll(html(old), html(name)));
  if (fs.existsSync(README)) fs.writeFileSync(README, read(README).replaceAll(old, name));
}
execFileSync(process.execPath, ['tools/sync-admin-ui.mjs'], { stdio: 'inherit' });
if (!check()) process.exit(1);
console.log(`Renamed to ${name}, website and README included. The app ids change separately.`);
