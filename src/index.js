/**
 * @kaltura/intelligent-agents — umbrella re-export.
 *
 * Two fronts, two import paths (prefer the sub-path imports so a headless or
 * server app never pulls the other front's code):
 *   - `@kaltura/intelligent-agents/management` — provision/configure/measure (server-side).
 *   - `@kaltura/intelligent-agents/experience`  — the live interactive runtime (client-side).
 *
 * This umbrella is a convenience for environments that want both at once. It
 * deliberately does NOT re-export any of the optional plugins (`Presenter`,
 * GenUI, the noise-suppressor, analytics) — each is its own subpath
 * (`./experience/presenter`, `./experience/genui`, `./experience/noise-suppressor`,
 * `./experience/analytics`) so a raw-ESM/CDN load of this umbrella (no bundler
 * tree-shaking) never fetches a plugin's module graph for an app that doesn't
 * construct it.
 */
export { Management, Sessions, inspectKs, summarizeReport, parseCsv } from './management/index.js';
export { KalturaAvatarSession, TranscriptTracker } from './experience/index.js';
export { parseSlideNumber } from './experience/slidenav.js';
export { KalturaError } from './core/errors.js';
export { redact } from './core/redact.js';
export { uuidv4, randId, meta } from './core/ids.js';
export { collectConverse, parseConverseStream, parseToolCall, parseToolResponseName, segmentKind } from './core/stream.js';
