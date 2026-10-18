/**
 * GenUI YAML subset (pure, zero-dep, internal): the string-body reader behind
 * `parseContent`. Not exported from any entry point.
 *
 * Reads a block mapping whose values are: plain, single-quoted and double-quoted
 * scalars (multi-line ones fold), `|` and `>` block scalars (clip, strip and
 * keep chomping, explicit indent), nested block maps, block lists (indentless
 * lists under a key included, `- key: v` items, `- - x` nesting) and flow
 * `[]` / `{}` collections. A key with nothing after it is `null`.
 *
 * Plain scalars use no YAML 1.1 coercions: only `true`, `false`, `null`,
 * integers and decimals are typed; `yes`, `off`, `~`, `1_000`, `0x1F`, `1:30`
 * and `1_aaaaaaaa` stay strings. The keys `__proto__`, `constructor` and
 * `prototype` are dropped at every level. Nodes deeper than `MAX_DEPTH` read as
 * plain text. A quote that never closes stays literal, so a stream cut mid-value
 * keeps everything before it.
 *
 * @internal
 */

const KEY_RE = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*)|)$/;
const DASH_RE = /^-(?:[ \t]|$)/;
const BLOCK_RE = /^([|>])([+-]?)([1-9]?)([+-]?)$/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DEPTH = 64;
const HEX_LEN = Object.freeze({ __proto__: null, x: 2, u: 4, U: 8 });
const ESC = Object.freeze({
  __proto__: null,
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ',
});

/**
 * @typedef {object} YamlState
 * @property {string[]} lines Private copy of the input lines (an item line is rewritten in place to be re-read at its own column).
 * @property {number} i Index of the next line to read.
 * @property {string[]} leftover Lines no node could place.
 */

/**
 * Parse a YAML-subset block mapping into a plain object. Lines it cannot place are returned in `leftover`.
 * A body indented as a whole is dedented first, and the first line's own indentation is ignored.
 * @param {string} text Fence-stripped body with no leading blank lines or trailing whitespace.
 * @returns {{map: Record<string, unknown>, leftover: string[]}}
 */
export function parseYamlBlock(text) {
  const lines = text.split(/\r?\n/);
  let min = Infinity;
  for (const l of lines) if (!isBlank(l)) min = Math.min(min, indentOf(l));
  if (min > 0 && min < Infinity) for (let k = 0; k < lines.length; k++) lines[k] = lines[k].slice(Math.min(min, indentOf(lines[k])));
  lines[0] = lines[0].trimStart();
  /** @type {YamlState} */
  const st = { lines, i: 0, leftover: [] };
  /** @type {Record<string, unknown>} */
  const map = {};
  parseMap(st, 0, map, 0);
  return { map, leftover: st.leftover };
}

/** @param {string} l */
const indentOf = (l) => { let n = 0; while (l.charCodeAt(n) === 32) n++; return n; };
/** @param {string} l */
const isBlank = (l) => !/\S/.test(l);

/**
 * Read `key: value` lines at `indent` into `map`; a shallower line ends the map.
 * @param {YamlState} st @param {number} indent @param {Record<string, unknown>} map @param {number} depth
 * @returns {Record<string, unknown>}
 */
function parseMap(st, indent, map, depth) {
  const { lines } = st;
  while (st.i < lines.length) {
    const line = lines[st.i];
    if (isBlank(line)) { st.i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) return map;
    const m = ind === indent ? KEY_RE.exec(line.slice(ind)) : null;
    if (!m) { st.leftover.push(line.trim()); st.i++; continue; }
    st.i++;
    const value = parseValue(st, m[2] ?? '', indent, true, depth + 1);
    if (!PROTO_KEYS.has(m[1])) map[m[1]] = value;
  }
  return map;
}

/**
 * Read `- item` lines at `indent` into a list; a shallower or non-dash line ends it.
 * @param {YamlState} st @param {number} indent @param {number} depth
 * @returns {unknown[]}
 */
function parseSeq(st, indent, depth) {
  const { lines } = st;
  const list = [];
  while (st.i < lines.length) {
    const line = lines[st.i];
    if (isBlank(line)) { st.i++; continue; }
    const ind = indentOf(line);
    if (ind < indent) break;
    const text = line.slice(ind);
    if (ind > indent) { st.leftover.push(line.trim()); st.i++; continue; }
    if (!DASH_RE.test(text)) break;
    const after = text.slice(1);
    const item = after.trimStart();
    const col = ind + 1 + (after.length - item.length);
    if (item && depth < MAX_DEPTH && (DASH_RE.test(item) || KEY_RE.test(item))) {
      lines[st.i] = ' '.repeat(col) + item;   // re-read the item as a nested node at its own column
      list.push(DASH_RE.test(item) ? parseSeq(st, col, depth + 1) : parseMap(st, col, {}, depth + 1));
    } else {
      st.i++;
      list.push(parseValue(st, item, indent, false, depth + 1));
    }
  }
  return list;
}

/**
 * Read the value that follows a `key:` or `- ` marker: a nested node on the next lines, a block scalar, a quoted scalar, a flow collection or a plain scalar.
 * @param {YamlState} st @param {string} rest Text after the marker. @param {number} indent Column of the marker's line. @param {boolean} mapValue True after `key:`, where an indentless list may follow. @param {number} depth
 * @returns {unknown}
 */
function parseValue(st, rest, indent, mapValue, depth) {
  const v = rest.trim();
  const { lines } = st;
  if (depth > MAX_DEPTH) return plain(st, v, indent);
  if (!v) {
    let j = st.i;
    while (j < lines.length && isBlank(lines[j])) j++;
    if (j >= lines.length) return null;
    const ind = indentOf(lines[j]);
    const text = lines[j].slice(ind);
    if (ind > indent) {
      st.i = j;
      if (DASH_RE.test(text)) return parseSeq(st, ind, depth);
      if (KEY_RE.test(text)) return parseMap(st, ind, {}, depth);
      st.i = j + 1;
      return parseValue(st, text, indent, false, depth);
    }
    if (mapValue && ind === indent && DASH_RE.test(text)) { st.i = j; return parseSeq(st, ind, depth); }
    return null;
  }
  const b = BLOCK_RE.exec(v);
  if (b) return blockScalar(st, indent, b[1], b[2] || b[4], Number(b[3]) || 0);
  if (v[0] === '"' || v[0] === "'") {
    const q = quoted(st, v, indent);
    if (q !== undefined) return q;
    return plain(st, v, indent);
  }
  if (v[0] === '[' || v[0] === '{') {
    const save = st.i;
    const text = gather(st, v, indent).join(' ');
    const f = parseFlow(text);
    if (f !== undefined) return f;
    st.i = save;
  }
  return plain(st, v, indent);
}

/**
 * Collect the continuation lines (indented deeper than `indent`) of a multi-line scalar. Blank lines come back as `''`.
 * @param {YamlState} st @param {string} first @param {number} indent
 * @returns {string[]}
 */
function gather(st, first, indent) {
  const { lines } = st;
  const out = [first];
  let j = st.i;
  const pending = [];
  while (j < lines.length) {
    const l = lines[j];
    if (isBlank(l)) { pending.push(''); j++; continue; }
    if (indentOf(l) <= indent) break;
    out.push(...pending, l.trim());
    pending.length = 0;
    j++;
    st.i = j;
  }
  return out;
}

/**
 * Fold plain-scalar lines: one break becomes a space, each blank line a `\n`.
 * @param {string[]} parts
 * @returns {string}
 */
function fold(parts) {
  let s = parts[0];
  let blanks = 0;
  for (let k = 1; k < parts.length; k++) {
    if (parts[k] === '') { blanks++; continue; }
    s += blanks ? '\n'.repeat(blanks) : ' ';
    s += parts[k];
    blanks = 0;
  }
  return s;
}

/**
 * Read a plain scalar: one line is typed by `coerceScalar`, several lines fold into a string.
 * @param {YamlState} st @param {string} v @param {number} indent
 * @returns {unknown}
 */
function plain(st, v, indent) {
  const parts = gather(st, v, indent);
  return parts.length === 1 ? coerceScalar(v) : fold(parts);
}

/**
 * Read a quoted scalar that may span continuation lines.
 * @param {YamlState} st @param {string} v First line, starting with the opening quote. @param {number} indent
 * @returns {string | undefined} `undefined` when the quote never closes cleanly (the caller keeps the text literal).
 */
function quoted(st, v, indent) {
  const { lines } = st;
  const dq = v[0] === '"';
  let text = v.slice(1);
  let pos = 0;
  let j = st.i;
  for (;;) {
    const { close, next } = findClose(text, pos, dq);
    if (close >= 0) {
      const tail = text.slice(close + 1).trim();
      if (tail) return undefined;
      st.i = j;
      return foldQuoted(text.slice(0, close), dq);
    }
    if (j >= lines.length) return undefined;
    const l = lines[j];
    if (!isBlank(l) && indentOf(l) <= indent) return undefined;
    pos = next;   // resume where the scan stopped (a trailing backslash is re-read with the line break)
    text += '\n' + l;
    j++;
  }
}

/**
 * Find the closing quote at or after `from`.
 * @param {string} s @param {number} from @param {boolean} dq True for a double-quoted scalar.
 * @returns {{close: number, next: number}} `close` is the quote index or -1; `next` is where to resume scanning.
 */
function findClose(s, from, dq) {
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (dq) {
      if (c === '\\') { if (k + 1 >= s.length) return { close: -1, next: k }; k++; continue; }
      if (c === '"') return { close: k, next: k };
    } else if (c === "'") {
      if (s[k + 1] === "'") { k++; continue; }
      return { close: k, next: k };
    }
  }
  return { close: -1, next: s.length };
}

/**
 * Decode the inside of a quoted scalar: fold line breaks (one break is a space, n blank lines are n `\n`), then apply escapes (double quotes) or `''` (single quotes).
 * @param {string} s @param {boolean} dq
 * @returns {string}
 */
function foldQuoted(s, dq) {
  let out = '';
  let ws = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === ' ' || c === '\t') { ws += c; continue; }
    if (c === '\n') {
      ws = '';
      let breaks = 0;
      while (k + 1 < s.length && (s[k + 1] === ' ' || s[k + 1] === '\t' || s[k + 1] === '\n')) { k++; if (s[k] === '\n') breaks++; }
      out += breaks ? '\n'.repeat(breaks) : ' ';
      continue;
    }
    out += ws; ws = '';
    if (dq && c === '\\') {
      const n = s[k + 1];
      if (n === '\n') {   // escaped line break: join with no space, skip the next line's indentation
        k++;
        while (k + 1 < s.length && (s[k + 1] === ' ' || s[k + 1] === '\t')) k++;
        continue;
      }
      if (n !== undefined && ESC[n] !== undefined) { out += ESC[n]; k++; continue; }
      const len = HEX_LEN[n];
      if (len) {
        const hex = s.slice(k + 2, k + 2 + len);
        if (hex.length === len && /^[0-9a-fA-F]+$/.test(hex)) {
          const cp = parseInt(hex, 16);
          if (cp <= 0x10ffff) { out += String.fromCodePoint(cp); k += 1 + len; continue; }
        }
      }
      out += c;   // unknown escape: keep it literally
      continue;
    }
    if (!dq && c === "'" && s[k + 1] === "'") { out += "'"; k++; continue; }
    out += c;
  }
  return out + ws;
}

/**
 * Read a `|` (literal) or `>` (folded) block scalar that starts on the next line.
 * @param {YamlState} st @param {number} indent @param {string} style `|` or `>`. @param {string} chomp `-` (strip), `+` (keep) or `''` (clip). @param {number} explicit Explicit indent indicator, 0 for auto.
 * @returns {string}
 */
function blockScalar(st, indent, style, chomp, explicit) {
  const { lines } = st;
  let ci = explicit ? indent + explicit : -1;
  const body = [];
  while (st.i < lines.length) {
    const l = lines[st.i];
    if (isBlank(l)) { body.push(''); st.i++; continue; }
    const ind = indentOf(l);
    if (ci < 0) { if (ind <= indent) break; ci = ind; }
    if (ind < ci) break;
    body.push(l.slice(ci));
    st.i++;
  }
  let trailing = 0;
  while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
  let s;
  if (style === '|') s = body.join('\n');
  else {
    s = '';
    let blanks = 0;
    let prev = null;   // 'n' normal line, 'm' more-indented line
    for (const l of body) {
      if (l === '') { blanks++; continue; }
      const kind = /^[ \t]/.test(l) ? 'm' : 'n';
      if (prev === null) s += '\n'.repeat(blanks);
      else if (prev === 'n' && kind === 'n') s += blanks ? '\n'.repeat(blanks) : ' ';
      else s += '\n'.repeat(blanks + 1);
      s += l; blanks = 0; prev = kind;
    }
  }
  if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
  // The last content line has no line break when it ends the (trimmed) input.
  const eol = st.i < lines.length || trailing > 0 ? 1 : 0;
  if (chomp === '-') return s;
  if (chomp === '+') return s + '\n'.repeat(trailing + eol);
  return s + '\n'.repeat(eol);
}

/**
 * Parse a flow collection (`[...]` or `{...}`) held on one logical line.
 * @param {string} s
 * @returns {unknown[] | Record<string, unknown> | undefined} `undefined` when `s` is not one valid flow collection.
 */
function parseFlow(s) {
  let p = 0;
  const ws = () => { while (p < s.length && /\s/.test(s[p])) p++; };
  /** @param {number} depth @param {boolean} inMap @returns {unknown} */
  const node = (depth, inMap) => {
    if (depth > MAX_DEPTH) throw new RangeError('flow too deep');
    ws();
    const c = s[p];
    if (c === '[') {
      p++;
      const arr = [];
      for (;;) {
        ws();
        if (s[p] === ']') { p++; return arr; }
        arr.push(node(depth + 1, false));
        ws();
        if (s[p] === ',') { p++; continue; }
        if (s[p] === ']') { p++; return arr; }
        throw new SyntaxError('flow list');
      }
    }
    if (c === '{') {
      p++;
      /** @type {Record<string, unknown>} */
      const obj = {};
      for (;;) {
        ws();
        if (s[p] === '}') { p++; return obj; }
        const k = node(depth + 1, true);
        ws();
        let val = null;
        if (s[p] === ':') { p++; ws(); val = (s[p] === ',' || s[p] === '}') ? null : node(depth + 1, true); }
        const key = String(k);
        if (!PROTO_KEYS.has(key)) obj[key] = val;
        ws();
        if (s[p] === ',') { p++; continue; }
        if (s[p] === '}') { p++; return obj; }
        throw new SyntaxError('flow map');
      }
    }
    if (c === '"' || c === "'") {
      const dq = c === '"';
      const { close } = findClose(s, p + 1, dq);
      if (close < 0) throw new SyntaxError('flow quote');
      const inner = s.slice(p + 1, close);
      p = close + 1;
      return foldQuoted(inner, dq);
    }
    const start = p;
    while (p < s.length) {
      const ch = s[p];
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (inMap && ch === ':' && (p + 1 >= s.length || /[\s,}\]]/.test(s[p + 1]))) break;
      p++;
    }
    const tok = s.slice(start, p).trim();
    if (!tok) throw new SyntaxError('flow scalar');
    return coerceScalar(tok);
  };
  try {
    const v = node(0, false);
    ws();
    return p === s.length && v !== null && typeof v === 'object' ? /** @type {unknown[] | Record<string, unknown>} */ (v) : undefined;
  } catch { return undefined; }
}

/**
 * Coerce a bare scalar token: `true`/`false`/`null`, integers and decimals become typed values; anything else stays a string. Also strips one matching pair of surrounding quotes (for example a quoted `show-link` URL such as `"https://example.com/page"`), so the literal quote characters never leak into the value. A lone leading or trailing quote is left as is.
 * @param {string} v
 * @returns {string | number | boolean | null}
 */
function coerceScalar(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.\d+$/.test(v)) return Number(v);
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return v.slice(1, -1);
  }
  return v;
}
