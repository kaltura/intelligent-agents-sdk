#!/usr/bin/env node
/**
 * Pack the showroom example as a static site you can put on any file host. Writes only into <outDir>.
 *
 *   node scripts/pack-showroom.mjs <outDir> --partner=<partnerId> --widget=<widgetId>
 *
 * <outDir> must be missing or empty. The folder keeps the repo layout (`examples/showroom/` and `src/`),
 * adds a root `index.html` that opens the app, and writes `examples/showroom/config.json` with the two public ids.
 * The page then starts its session from the browser, so no server and no secret are needed.
 * Only the phone-size body (`guide-lite`) ships, which keeps the site near 11 MB. Needs no ffmpeg.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../examples/showroom/js/init.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outDir, ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const config = parseConfig({ partnerId: flag('partner'), widgetId: flag('widget') });
if (!outDir || !config) {
  console.error('usage: pack-showroom.mjs <outDir> --partner=<partnerId> --widget=<widgetId>');
  process.exit(2);
}
const out = path.resolve(outDir);
if (out === REPO || out.startsWith(REPO + path.sep)) { console.error('<outDir> must be outside the repository.'); process.exit(2); }
if (existsSync(out) && readdirSync(out).length) { console.error(`${out} is not empty.`); process.exit(2); }

// Dotfiles never ship. The provisioning script and the saved agent ids stay home. The full-size body is too big for most hosts.
const skip = (src) => {
  const parts = path.relative(REPO, src).split(path.sep);
  if (parts.some((seg) => seg.startsWith('.'))) return false;
  const [top, app, a, b] = parts;
  return !(top === 'examples' && app === 'showroom' && (a === 'agent' || (a === 'bodies' && b === 'guide')));
};
mkdirSync(path.join(out, 'examples'), { recursive: true });
cpSync(path.join(REPO, 'examples', 'showroom'), path.join(out, 'examples', 'showroom'), { recursive: true, filter: skip });
cpSync(path.join(REPO, 'src'), path.join(out, 'src'), { recursive: true, filter: skip });
writeFileSync(path.join(out, 'examples', 'showroom', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(path.join(out, 'index.html'), '<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=examples/showroom/index.html">\n<title>Showroom</title>\n<a href="examples/showroom/index.html">Open the Showroom</a>\n');
console.log(`Packed to ${out}`);
