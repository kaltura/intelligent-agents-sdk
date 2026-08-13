/**
 * @kaltura/intelligent-agents — umbrella re-export.
 *
 * Two fronts, two import paths (prefer the sub-path imports so a headless or
 * server app never pulls the other front's code):
 *   - `@kaltura/intelligent-agents/management` — provision/configure/measure (server-side).
 *   - `@kaltura/intelligent-agents/experience`  — the live interactive runtime (client-side).
 *
 * This umbrella is a convenience for environments that want both at once.
 */
export { Management, Sessions, inspectKs, summarizeReport, parseCsv } from './management/index.js';
export { KalturaAvatarSession, TranscriptTracker } from './experience/index.js';
export { Presenter } from './experience/presenter.js';
export { parseSlideNumber } from './experience/slidenav.js';
export { KalturaError } from './core/errors.js';
export { redact } from './core/redact.js';
export { uuidv4, randId, meta } from './core/ids.js';
export { collectConverse, parseConverseStream, parseToolCall, parseToolResponseName, segmentKind } from './core/stream.js';
