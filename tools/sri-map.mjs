#!/usr/bin/env node
/**
 * Generate a `<script type="importmap">` `integrity` block covering the FULL
 * transitive local-file import graph of a browser entry point — not just the
 * entry file itself. A hash on `experience/index.js` alone would let jsDelivr
 * (or a compromised upstream) swap out any file it re-exports from
 * (`session.js`, `wire.js`, `core/safety.js`, …) without the browser ever
 * noticing, since import-map `integrity` only checks the exact URLs listed —
 * so real protection means every file the entry reaches, not one hash for show.
 *
 * Walks only relative (`./`, `../`) import/export specifiers — a bare
 * specifier (e.g. `socket.io-client`) is the CONSUMER's own dependency, not
 * part of this SDK's distributed graph, so it's intentionally left uncovered.
 *
 * Reads every file's content from the git object at `--tag` (`git show
 * <tag>:<path>`), NOT the working tree — jsDelivr serves the tagged commit,
 * so hashing local disk state (which may have uncommitted edits) would
 * silently produce hashes that don't match what ships. This also means the
 * command works from any working-tree state, including a dirty one, and is
 * meant to be run once a release tag has actually been pushed.
 *
 * Usage:
 *   node tools/sri-map.mjs --entry src/experience/index.js --tag v1.4.0
 *   node tools/sri-map.mjs --entry src/experience/genui/index.js --tag v1.4.0 --repo kaltura/intelligent-agents-sdk
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix, relative, resolve, sep } from 'node:path';

const SDK_ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

function parseArgs(argv) {
  const out = { repo: 'kaltura/intelligent-agents-sdk' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--entry') out.entry = argv[++i];
    else if (a === '--tag') out.tag = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
  }
  if (!out.entry || !out.tag) {
    process.stderr.write('Usage: node tools/sri-map.mjs --entry <path/from/repo/root.js> --tag <vX.Y.Z> [--repo org/name]\n');
    process.exit(1);
  }
  return out;
}

/** @param {string} repoRelPosixPath @param {string} tag @returns {Buffer} */
function readAtTag(repoRelPosixPath, tag) {
  return execFileSync('git', ['show', `${tag}:${repoRelPosixPath}`], { cwd: SDK_ROOT, maxBuffer: 16 * 1024 * 1024 });
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g;

/** @param {string} repoRelPosixPath @param {string} tag @returns {string[]} relative-only specifiers found in the file */
function relativeSpecifiers(repoRelPosixPath, tag) {
  const src = readAtTag(repoRelPosixPath, tag).toString('utf8');
  const specs = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('./') || spec.startsWith('../')) specs.push(spec);
  }
  return specs;
}

/** Walk the transitive relative-import graph from `entryRepoRelPosixPath` at `tag`. @returns {Set<string>} repo-relative posix paths (including the entry) */
function walkGraph(entryRepoRelPosixPath, tag) {
  const seen = new Set();
  const stack = [entryRepoRelPosixPath];
  while (stack.length) {
    const path = stack.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    for (const spec of relativeSpecifiers(path, tag)) {
      stack.push(posix.normalize(posix.join(posix.dirname(path), spec)));
    }
  }
  return seen;
}

const { entry, tag, repo } = parseArgs(process.argv.slice(2));
const entryRepoRelPosixPath = relative(SDK_ROOT, resolve(SDK_ROOT, entry)).split(sep).join('/');
const files = [...walkGraph(entryRepoRelPosixPath, tag)].sort();

const integrity = {};
for (const repoRelPath of files) {
  const url = `https://cdn.jsdelivr.net/gh/${repo}@${tag}/${repoRelPath}`;
  const hash = createHash('sha384').update(readAtTag(repoRelPath, tag)).digest('base64');
  integrity[url] = `sha384-${hash}`;
}

process.stdout.write(JSON.stringify({ integrity }, null, 2) + '\n');
process.stderr.write(`# ${files.length} file(s) hashed from ${entry} @ ${tag}\n`);
