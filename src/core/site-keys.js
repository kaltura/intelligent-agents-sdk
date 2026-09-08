/**
 * site-keys — the compact site-map contract shared by the site build, the
 * provisioning side (`management/site-nav`) and the browser plugin
 * (`experience/site-nav`). Pure functions, zero dependencies, isomorphic.
 *
 * A site map is rendered into the intellect prompt as one line per page:
 *
 *     /guides/pause-resume/: what-is, edge-case-dont, salesforce-example
 *
 * Each word after the colon is a **section key**: 2–3 content words of a
 * heading, stop words removed, lower-cased, hyphen-joined. Keys are short so the
 * whole map costs ~25 tokens per page, and they are what the brain passes back
 * in `go_to({ path, section })`. The browser resolves that pair against the
 * same manifest (`resolvePath` / `resolveSection`), so a slightly wrong key or
 * path still lands on the right element.
 *
 * Every function here is deterministic: the same input produces the same keys,
 * so a docs change re-keys only the page it touched.
 *
 * Unicode: words are split on any run that is not a letter or a number
 * (`\p{L}` / `\p{N}`), after NFKC normalization, so Hebrew, CJK, accented Latin
 * and emoji-laden headings all yield usable keys. Stop-word lists are per
 * language and opt-in (`en` ships; pass `stopWords` for others).
 */

import { sanitizeJson } from './safety.js';
import { KalturaError } from './errors.js';

/**
 * Per-language stop words dropped from section keys. Only `en` ships; add a
 * language by passing `{ stopWords: { xx: new Set([...]) } }` to the builders.
 * @type {Readonly<Record<string, ReadonlySet<string>>>}
 */
export const STOP_WORDS = Object.freeze({
  en: Object.freeze(new Set('the a an and or of to for your you in on with is it its how what do i vs that this from by at as be are was'.split(' '))),
});

/**
 * GitHub-style heading ids that appear on every page and carry no navigation
 * signal. Headings whose id (or derived probe key) matches are left out of the
 * manifest so the model never targets them.
 * @type {ReadonlySet<string>}
 */
export const BOILERPLATE_IDS = Object.freeze(new Set([
  'related-docs', 'contents', 'table-of-contents', 'on-this-page', 'next-steps', 'where-to-go-next', 'whats-next',
]));

/** Current manifest format version. {@link validateSectionsManifest} rejects anything else. */
export const MANIFEST_VERSION = 1;

/** @param {string} detail @returns {KalturaError} */
function badManifest(detail) {
  return new KalturaError({ type: 'about:blank', title: 'bad manifest', code: 'bad_manifest', detail });
}

const DEFAULT_KEY_WORDS = 3;
/** A key must survive the SITE MAP line format (`path: key1, key2`) unambiguously: no whitespace, comma or colon. */
const SAFE_KEY_RE = /^[^\s,:]+$/u;
const NUMERIC_RE = /^\p{N}+$/u;
const INNER_PUNCT_RE = /(?<=[\p{L}\p{N}])[.'’](?=[\p{L}\p{N}])/gu;
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]]+/giu;

/**
 * Split text into words the way keys are built: NFKC, URLs removed, apostrophes
 * and dots inside a word dropped (`don't` → `dont`, `v2.3` → `v23`), split on
 * any run of non letter/number characters. Case is preserved so callers can
 * inspect it; use `.toLowerCase()` on each word for comparisons.
 *
 * @param {unknown} text Heading text, id or free-form phrase.
 * @returns {string[]} Words in order, never empty strings.
 */
export function normalizeWords(text) {
  if (text == null) return [];
  return String(text).normalize('NFKC').replace(URL_RE, ' ').replace(INNER_PUNCT_RE, '').split(SPLIT_RE).filter(Boolean);
}

/** Lower-cased word list, the comparison form used by the resolvers. @param {unknown} text @returns {string[]} */
function lowerWords(text) {
  return normalizeWords(text).map((w) => w.toLowerCase());
}

/**
 * Content words of a heading for a language: stop words dropped (single
 * upper-case letters like "Recipe A" survive), pure numbers dropped when at
 * least two other words remain, full word list when fewer than two remain,
 * `['section']` when nothing is left.
 * @param {string} text @param {ReadonlySet<string>} stop @returns {string[]}
 */
function contentWords(text, stop) {
  const raw = normalizeWords(text);
  const lower = raw.map((w) => w.toLowerCase());
  let content = lower.filter((w, i) => !stop.has(w) || (raw[i].length === 1 && raw[i] !== raw[i].toLowerCase()));
  const nonNumeric = content.filter((w) => !NUMERIC_RE.test(w));
  if (nonNumeric.length >= 2) content = nonNumeric;
  if (content.length < 2) content = lower;
  return content.length ? content : ['section'];
}

/**
 * Derive one section key and reserve it in `used`. Collisions within a page
 * extend the key word by word, then suffix `-2`, `-3`, …
 * @param {string} text Heading text.
 * @param {ReadonlySet<string>} stop Stop words for the page language.
 * @param {Set<string>} used Keys already taken on this page (mutated).
 * @param {number} maxWords Preferred key length in words.
 * @returns {string}
 */
function keyFor(text, stop, used, maxWords) {
  const content = contentWords(text, stop);
  let n = Math.min(maxWords, content.length);
  let key = content.slice(0, n).join('-');
  while (used.has(key) && n < content.length) { n += 1; key = content.slice(0, n).join('-'); }
  if (used.has(key)) {
    let i = 2;
    while (used.has(`${key}-${i}`)) i += 1;
    key = `${key}-${i}`;
  }
  used.add(key);
  return key;
}

/**
 * Resolve the stop-word set for a language: caller-supplied lists win, then the
 * shipped `STOP_WORDS`, then an empty set (no filtering).
 * @param {string} lang @param {Record<string, ReadonlySet<string>|Iterable<string>>|undefined} stopWords @returns {ReadonlySet<string>}
 */
function stopSetFor(lang, stopWords) {
  const custom = stopWords && stopWords[lang];
  if (custom) return custom instanceof Set ? custom : new Set(custom);
  return STOP_WORDS[lang] || new Set();
}

/**
 * Key options shared by {@link pageSectionKeys} and {@link buildSectionsManifest}.
 * @typedef {object} KeyOptions
 * @property {string} [lang='en'] Language code selecting the stop-word list.
 * @property {Record<string, ReadonlySet<string>|Iterable<string>>} [stopWords] Extra or replacement stop-word lists keyed by language.
 * @property {Record<string, string>} [overrides] Hand-fixed keys: heading `id` (or text) → key. An override wins over the derived key.
 * @property {number} [maxWords=3] Preferred key length in words.
 */

/**
 * Section keys for the ordered headings of ONE page. Returns an array aligned
 * with `headings`: `null` for boilerplate headings, else `{ key }`.
 *
 * @param {Array<string|{id?:string,text:string}>} headings Heading texts, or `{id, text}` objects (the id enables boilerplate detection and `overrides` by id).
 * @param {KeyOptions} [opts]
 * @returns {Array<{key:string}|null>}
 * @example
 * pageSectionKeys(['What it is', 'The edge case: don\'t leave the avatar stuck paused', 'Related docs'])
 * // → [{ key: 'what-it' }, { key: 'edge-case-dont' }, null]
 */
export function pageSectionKeys(headings, opts = {}) {
  const { lang = 'en', stopWords, overrides, maxWords = DEFAULT_KEY_WORDS } = opts;
  const stop = stopSetFor(lang, stopWords);
  const used = new Set();
  const out = [];
  for (const h of Array.isArray(headings) ? headings : []) {
    const text = typeof h === 'string' ? h : String(h?.text ?? '');
    const id = typeof h === 'string' ? undefined : h?.id;
    const probe = keyFor(id || text, stop, new Set(), maxWords);
    if ((id && BOILERPLATE_IDS.has(id)) || BOILERPLATE_IDS.has(probe) || BOILERPLATE_IDS.has(keyFor(text, new Set(), new Set(), 6))) { out.push(null); continue; }
    const override = overrides && (overrides[id] ?? overrides[text]);
    if (override) { used.add(override); out.push({ key: override }); continue; }
    out.push({ key: keyFor(text, stop, used, maxWords) });
  }
  return out;
}

/**
 * One page as fed to {@link buildSectionsManifest}.
 * @typedef {object} PageInput
 * @property {string} path Site-relative path, prefix-free, with leading slash (`/guides/pause-resume/`).
 * @property {string} [title] Page title. Rendered as the title line of the SITE MAP so the model can match what a visitor calls a page to its path.
 * @property {Array<{id:string,text:string,level?:number}>} [headings] Headings in document order. `level` (2, 3, …) enables the `depth` filter.
 * @property {Array<{id:string,text?:string}>} [targets] Extra hand-placed anchors (e.g. `data-nova-target` elements). Their id doubles as key when it is not taken.
 */

/**
 * A resolvable section of a page.
 * @typedef {object} ManifestSection
 * @property {string} key Compact key the model uses.
 * @property {string} id Real DOM id (the element to scroll to).
 * @property {string} text Human heading text (also used by the fuzzy resolver).
 * @property {'heading'|'target'|string} [kind] Defaults to `heading` when absent.
 */

/**
 * @typedef {object} ManifestPage
 * @property {string} path
 * @property {string} [title]
 * @property {ManifestSection[]} sections
 */

/**
 * The `sections.json` contract. Public data only: paths and headings.
 * @typedef {object} SectionsManifest
 * @property {number} version Always {@link MANIFEST_VERSION}.
 * @property {string} lang
 * @property {string} generatedAt ISO timestamp.
 * @property {ManifestPage[]} pages Sorted by path.
 */

/**
 * Build a `sections.json` manifest from any page source: built HTML, a
 * markdown tree, a SPA route table, a CMS export. Only `path` is mandatory per
 * page. Pages are sorted by path so the output is stable across build orders.
 *
 * @param {PageInput[]} pages
 * @param {KeyOptions & {depth?:number, generatedAt?:string}} [opts] `depth` (default 2) keeps headings with `level <= depth`; headings without a `level` are always kept. `generatedAt` defaults to now.
 * @returns {SectionsManifest}
 */
export function buildSectionsManifest(pages, opts = {}) {
  const { lang = 'en', depth = 2, generatedAt = new Date().toISOString() } = opts;
  const out = [];
  for (const p of Array.isArray(pages) ? pages : []) {
    const path = normalizePath(p?.path);
    if (!path) continue;
    const headings = (Array.isArray(p.headings) ? p.headings : []).filter((h) => h && h.id && (h.level == null || h.level <= depth));
    const keyed = pageSectionKeys(headings.map((h) => ({ id: h.id, text: h.text ?? h.id })), opts);
    const sections = [];
    const taken = new Set();
    headings.forEach((h, i) => {
      if (!keyed[i]) return;
      taken.add(keyed[i].key);
      sections.push({ key: keyed[i].key, id: String(h.id), text: String(h.text ?? h.id) });
    });
    for (const t of Array.isArray(p.targets) ? p.targets : []) {
      if (!t || !t.id || sections.some((s) => s.id === t.id)) continue;
      const key = taken.has(t.id) ? keyFor(t.text || t.id, stopSetFor(lang, opts.stopWords), taken, opts.maxWords ?? DEFAULT_KEY_WORDS) : t.id;
      taken.add(key);
      sections.push({ key, id: String(t.id), text: String(t.text || t.id), kind: 'target' });
    }
    const page = { path, sections };
    if (p.title) page.title = String(p.title);
    out.push(page);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: MANIFEST_VERSION, lang, generatedAt, pages: out };
}

/**
 * Render a manifest as the prompt text the model reads. Each page is a block
 * of two lines: the page title, then `path: key1, key2`. Pages without a
 * title render the path line alone; pages without sections render the bare
 * path. Blocks are separated by a blank line.
 *
 * The path line carries nothing but the path and the keys. Any label placed on
 * that line next to the path gets copied into `go_to` as part of the path, so
 * the title lives on its own line above it.
 * @param {SectionsManifest|{pages:ManifestPage[]}} manifest
 * @returns {string}
 */
export function renderSiteMap(manifest) {
  const pages = manifest && Array.isArray(manifest.pages) ? manifest.pages : [];
  return pages
    .map((p) => {
      const line = p.sections && p.sections.length ? `${p.path}: ${p.sections.map((s) => s.key).join(', ')}` : String(p.path);
      const title = p.title ? String(p.title).replace(/\s+/g, ' ').trim() : '';
      return title ? `${title}\n${line}` : line;
    })
    .join('\n\n');
}

/**
 * Canonical path form: trimmed, exactly one leading slash, a trailing slash
 * unless the last segment has an extension, no query or hash, no `//`
 * authority. Returns `''` for anything that is not a plain site path.
 * @param {unknown} path
 * @returns {string}
 */
export function normalizePath(path) {
  if (path == null) return '';
  let s = String(path).trim();
  if (!s) return '';
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /^[/\\]{2}/.test(s)) return '';
  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  if (s === '/') return s;
  const last = s.slice(s.lastIndexOf('/') + 1);
  if (last && !/\.[a-z0-9]+$/i.test(last)) s += '/';
  return s;
}

/**
 * Find the manifest page a model-supplied path refers to.
 * Order: exact → normalized (slashes, case) → last-segment word overlap ≥ 0.5
 * when exactly one page qualifies → `null`. Only manifest pages are ever
 * returned, so an invented path can never navigate anywhere.
 *
 * @param {SectionsManifest|{pages:ManifestPage[]}} manifest
 * @param {unknown} path Path as the model sent it.
 * @returns {ManifestPage|null}
 */
export function resolvePath(manifest, path) {
  const pages = manifest && Array.isArray(manifest.pages) ? manifest.pages : [];
  if (!pages.length || typeof path !== 'string') return null;
  const literal = pageByPath(pages, path);
  if (literal) return literal;
  const norm = normalizePath(path).toLowerCase();
  if (!norm) return null;
  const want = new Set(lowerWords(lastSegment(norm)));
  if (!want.size) return null;
  let best = null; let bestScore = 0; let ties = 0;
  for (const p of pages) {
    const have = new Set(lowerWords(lastSegment(p.path)));
    if (!have.size) continue;
    const score = overlap(want, have);
    if (score > bestScore) { best = p; bestScore = score; ties = 0; } else if (score === bestScore && score > 0) ties += 1;
  }
  return bestScore >= 0.5 && ties === 0 ? best : null;
}

/**
 * Page whose path equals `path` exactly or after normalization (slashes, case). No fuzzy matching.
 * @param {ManifestPage[]} pages @param {string} path @returns {ManifestPage|null}
 */
function pageByPath(pages, path) {
  const exact = pages.find((p) => p.path === path);
  if (exact) return exact;
  const norm = normalizePath(path).toLowerCase();
  if (!norm) return null;
  return pages.find((p) => normalizePath(p.path).toLowerCase() === norm) || null;
}

/**
 * Resolve a whole `go_to` call (path + optional section) to a page and a section match.
 *
 * `resolvePath` answers first. When it has no page, the last path segment is
 * tried as a section of the page named by the rest of the path. Brains fuse the
 * two arguments into one URL-like string: `{ path: '/', section: 'license' }`
 * arrives as `{ path: '/license' }`. The parent must be a manifest page by exact
 * or normalized path (never fuzzy) and the segment must resolve as one of its
 * sections, so every accepted piece is still a manifest literal and an invented
 * path still resolves to nothing.
 *
 * `match` is the `section` argument resolved on the page when it resolves there,
 * else the split-off segment's match, else `null` (page top). `split` is `null`
 * when the path resolved as a page on its own.
 *
 * @param {SectionsManifest|{pages:ManifestPage[]}} manifest
 * @param {unknown} path Path as the model sent it.
 * @param {unknown} [section] Section as the model sent it.
 * @returns {{page:ManifestPage, match:{section:ManifestSection, by:SectionMatch}|null, split:{segment:string, by:SectionMatch}|null}|null}
 */
export function resolveTarget(manifest, path, section) {
  const page = resolvePath(manifest, path);
  if (page) return { page, match: resolveSection(page, section), split: null };
  const pages = manifest && Array.isArray(manifest.pages) ? manifest.pages : [];
  if (!pages.length || typeof path !== 'string') return null;
  const parts = normalizePath(path).split('/').filter(Boolean);
  if (!parts.length) return null;
  const segment = parts.pop();
  const parent = pageByPath(pages, parts.length ? `/${parts.join('/')}/` : '/');
  if (!parent) return null;
  const fromSegment = resolveSection(parent, segment);
  if (!fromSegment) return null;
  const fromArg = resolveSection(parent, section);
  return { page: parent, match: fromArg || fromSegment, split: { segment, by: fromSegment.by } };
}

/** Last non-empty path segment, or `home` for the root. @param {string} path @returns {string} */
function lastSegment(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : 'home';
}

/** |a ∩ b| / |a|. @param {Set<string>} a @param {Set<string>} b @returns {number} */
function overlap(a, b) {
  let hit = 0;
  for (const w of a) if (b.has(w)) hit += 1;
  return hit / a.size;
}

/** |a ∩ b| / |a ∪ b|. @param {Set<string>} a @param {Set<string>} b @returns {number} */
function jaccard(a, b) {
  let hit = 0;
  for (const w of a) if (b.has(w)) hit += 1;
  const union = a.size + b.size - hit;
  return union ? hit / union : 0;
}

/**
 * How a section was matched, most to least exact.
 * @typedef {'key'|'id'|'text'|'subset'|'jaccard'} SectionMatch
 */

/**
 * Find the section of a page a model-supplied `section` refers to.
 * Order: key → id → normalized text equality → the request's words are a
 * subset of one section's words → Jaccard ≥ 0.5 when exactly one section
 * qualifies → `null`. Callers fall back to the page top on `null`; a wrong
 * section never fails the navigation.
 *
 * @param {ManifestPage|null|undefined} page
 * @param {unknown} section Key, id or phrase as the model sent it.
 * @returns {{section:ManifestSection, by:SectionMatch}|null}
 */
export function resolveSection(page, section) {
  const sections = page && Array.isArray(page.sections) ? page.sections : [];
  if (!sections.length || typeof section !== 'string' || !section.trim()) return null;
  const s = section.trim();
  const byKey = sections.find((x) => x.key === s);
  if (byKey) return { section: byKey, by: 'key' };
  const byId = sections.find((x) => x.id === s);
  if (byId) return { section: byId, by: 'id' };
  const want = lowerWords(s);
  if (!want.length) return null;
  const wantJoined = want.join(' ');
  const byText = sections.find((x) => lowerWords(x.key).join(' ') === wantJoined || lowerWords(x.id).join(' ') === wantJoined || lowerWords(x.text).join(' ') === wantJoined);
  if (byText) return { section: byText, by: 'text' };
  const wantSet = new Set(want);
  const wordSets = sections.map((x) => new Set([...lowerWords(x.text), ...lowerWords(x.id)]));
  const subset = sections.filter((_, i) => [...wantSet].every((w) => wordSets[i].has(w)));
  if (subset.length === 1) return { section: subset[0], by: 'subset' };
  let best = null; let bestScore = 0; let ties = 0;
  sections.forEach((x, i) => {
    const score = jaccard(wantSet, wordSets[i]);
    if (score > bestScore) { best = x; bestScore = score; ties = 0; } else if (score === bestScore && score > 0) ties += 1;
  });
  return bestScore >= 0.5 && ties === 0 && best ? { section: best, by: 'jaccard' } : null;
}

/**
 * Validate a parsed manifest object: `version`, `pages` array, per-page `path`
 * string starting with `/` and `sections` array of `{key, id}`. Prototype
 * keys, functions and over-deep values are dropped first (`sanitizeJson`).
 * Throws `KalturaError` (`code: 'bad_manifest'`) on the first problem.
 *
 * @param {unknown} raw Parsed JSON.
 * @returns {SectionsManifest}
 */
export function validateSectionsManifest(raw) {
  const m = sanitizeJson(raw);
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw badManifest('sections manifest must be a JSON object');
  if (m.version !== MANIFEST_VERSION) throw badManifest(`sections manifest version ${JSON.stringify(m.version)} not supported (want ${MANIFEST_VERSION})`);
  if (!Array.isArray(m.pages)) throw badManifest('sections manifest needs a pages array');
  m.pages.forEach((p, i) => {
    if (!p || typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.startsWith('//') || /[\s,:]/u.test(p.path)) {
      throw badManifest(`sections manifest page ${i}: path must be a string starting with a single "/" and free of whitespace, "," and ":"`);
    }
    if (!Array.isArray(p.sections)) throw badManifest(`sections manifest page ${p.path}: sections must be an array`);
    const keys = new Set();
    for (const s of p.sections) {
      if (!s || typeof s.key !== 'string' || typeof s.id !== 'string') throw badManifest(`sections manifest page ${p.path}: every section needs string key and id`);
      if (!SAFE_KEY_RE.test(s.key)) throw badManifest(`sections manifest page ${p.path}: key ${JSON.stringify(s.key)} must be non-empty and free of whitespace, "," and ":"`);
      if (keys.has(s.key)) throw badManifest(`sections manifest page ${p.path}: duplicate key ${JSON.stringify(s.key)}`);
      keys.add(s.key);
    }
  });
  return m;
}
