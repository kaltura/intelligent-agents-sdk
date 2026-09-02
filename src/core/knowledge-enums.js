/**
 * Knowledge / RAG indexer enums + a pure modality validator.
 *
 * These are the per-modality embed primitives (chapter type + embedding
 * strategy) for the three linkable content modalities:
 *
 *   ChapterType  : CAPTION=1 / OCR=2 / DOCUMENT=3   (+ a Genie-internal SUMMARY)
 *   StrategyEnum : EmbedCaptionV1 / EmbedOcrV1 / EmbedDocumentV1
 *
 * SCOPE — what the indexer actually reads (verified against the live
 * backend indexer): it reads ONLY `indexer.categoryInfo[].{categoryId,
 * language}` + indexer-level `indexer.chunkSize` for a `categoryEntry`
 * link — it does NOT read a
 * per-category `objects[]`/`indexPosition`/`strategy` array.
 * {@link buildIndexerObjects} VALIDATES a caller's `modalities` (rejects an
 * unknown/duplicate modality with a typed `bad_request` before any wire call)
 * and returns the documented `{indexPosition,type,strategy}` per-modality
 * mapping, for callers/tooling that build or inspect indexer objects directly.
 *
 * This is a PURE module — no network, no KS, no side effects. It throws a
 * {@link KalturaError} (`code:'bad_request'`) on invalid input so callers fail
 * with the SDK's one stable error contract before any wire call.
 */
import { KalturaError } from './errors.js';

/**
 * Chapter types the indexer can embed (the backend's `ChapterType`).
 * Numeric on the wire. `SUMMARY` is Genie-internal (produced server-side, not
 * a self-serve embed modality) so it is intentionally NOT a linkable modality
 * in {@link EMBED} / {@link MODALITIES}.
 * @type {{CAPTION:1, OCR:2, DOCUMENT:3}}
 */
export const CHAPTER_TYPE = Object.freeze({ CAPTION: 1, OCR: 2, DOCUMENT: 3 });

/**
 * Embedding strategy string for each chapter type (the backend's `StrategyEnum`).
 * @type {{CAPTION:'EmbedCaptionV1', OCR:'EmbedOcrV1', DOCUMENT:'EmbedDocumentV1'}}
 */
export const STRATEGY = Object.freeze({
  CAPTION: 'EmbedCaptionV1',
  OCR: 'EmbedOcrV1',
  DOCUMENT: 'EmbedDocumentV1',
});

/**
 * Convenience map pairing each modality (lowercase name) to its `{type,
 * strategy}` pair — the two fields that, plus an `indexPosition`, form one
 * entry of `objects[]`. Keyed by the lowercase modality name callers pass in
 * `modalities`/`documentTypes` (`'caption'`/`'ocr'`/`'document'`).
 * @type {Readonly<{caption:{type:1, strategy:'EmbedCaptionV1'}, ocr:{type:2, strategy:'EmbedOcrV1'}, document:{type:3, strategy:'EmbedDocumentV1'}}>}
 */
export const EMBED = Object.freeze({
  caption: Object.freeze({ type: CHAPTER_TYPE.CAPTION, strategy: STRATEGY.CAPTION }),
  ocr: Object.freeze({ type: CHAPTER_TYPE.OCR, strategy: STRATEGY.OCR }),
  document: Object.freeze({ type: CHAPTER_TYPE.DOCUMENT, strategy: STRATEGY.DOCUMENT }),
});

/**
 * The modalities that can be linked self-serve, in their canonical index order
 * (document first, then caption, then OCR). Used as the default set when a
 * caller asks to link without naming modalities.
 * @type {ReadonlyArray<'document'|'caption'|'ocr'>}
 */
export const MODALITIES = Object.freeze(['document', 'caption', 'ocr']);

/** @param {string} detail @returns {KalturaError} */
function badRequest(detail) {
  return new KalturaError({
    type: 'https://docs.kaltura.com/agentic/errors/bad_request',
    title: 'bad request',
    code: 'bad_request',
    detail,
  });
}

/**
 * Normalize a single modality token to its canonical lowercase key. Accepts
 * the lowercase modality name (`'caption'`/`'ocr'`/`'document'`), the
 * UPPERCASE {@link CHAPTER_TYPE} key, or the numeric ChapterType (1/2/3).
 * Throws `bad_request` on anything else.
 * @param {string|number} token
 * @returns {'caption'|'ocr'|'document'}
 */
export function normalizeModality(token) {
  if (typeof token === 'number') {
    const hit = /** @type {const} */ (['caption', 'ocr', 'document']).find((k) => EMBED[k].type === token);
    if (!hit) {
      throw badRequest(`unknown ChapterType ${token} — valid: 1 (CAPTION), 2 (OCR), 3 (DOCUMENT).`);
    }
    return hit;
  }
  if (typeof token === 'string') {
    const key = token.trim().toLowerCase();
    if (key === 'caption' || key === 'ocr' || key === 'document') return key;
  }
  throw badRequest(
    `unknown modality ${JSON.stringify(token)} — valid: 'caption', 'ocr', 'document' (or ChapterType 1/2/3).`,
  );
}

/**
 * Build the indexer `objects[]` array for one `categoryInfo` entry from a list
 * of modalities. Each entry is `{indexPosition, type, strategy}` with
 * `indexPosition` assigned by order (0-based) — the CORRECT camelCase wire
 * field (fixes the `index_position` bug) and the full OCR-capable mapping.
 *
 * Pure: no network, no KS. Duplicate modalities are rejected (the indexer
 * would otherwise embed the same chapter type twice at different positions);
 * an empty/missing list defaults to {@link MODALITIES} (document, caption,
 * ocr). Throws `bad_request` on an unknown or duplicate modality.
 *
 * @param {ReadonlyArray<string|number>} [types] modality tokens — names
 *   (`'caption'`/`'ocr'`/`'document'`), CHAPTER_TYPE keys, or numeric
 *   ChapterTypes. Defaults to all three.
 * @returns {Array<{indexPosition:number, type:number, strategy:string}>}
 */
export function buildIndexerObjects(types) {
  let list;
  if (types === undefined || types === null) {
    list = MODALITIES;
  } else if (Array.isArray(types)) {
    list = types;
  } else {
    throw badRequest('buildIndexerObjects(types): types must be an array of modalities.');
  }
  if (list.length === 0) list = MODALITIES;

  const seen = new Set();
  return list.map((token) => {
    const key = normalizeModality(token);
    if (seen.has(key)) {
      throw badRequest(`duplicate modality '${key}' — each modality may appear at most once in objects[].`);
    }
    seen.add(key);
    const embed = EMBED[key];
    return { indexPosition: seen.size - 1, type: embed.type, strategy: embed.strategy };
  });
}
