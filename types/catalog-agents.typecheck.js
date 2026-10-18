// Typecheck-only fixture (never imported, never shipped). `npm run typecheck`
// fails if the catalog and agents option types stop being closed unions: each
// `@ts-expect-error` line then has no error to expect, and each plain line
// must compile clean.
import { Management } from '../src/management/index.js';

const mgmt = new Management({ partnerId: 1 });
const ks = 'ks';
const png = /** @type {Blob} */ (/** @type {unknown} */ ({}));

mgmt.catalog.list(ks, { type: 'Face', filter: { idsIn: ['a'], languageEqual: 'en' }, orderBy: '-createdAt', agentScope: 's' });
mgmt.agents.list(ks, { filter: {}, orderBy: '-updatedAt' });
mgmt.catalog.createVisual(png, { name: 'n', genderPresentation: 'Feminine', skinTone: 'Light', hairColor: 'Gray', ageGroup: 'OlderAdult', background: 'Color' }, ks);

// @ts-expect-error 'Dark' is not a skinTone
mgmt.catalog.createVisual(png, { name: 'n', genderPresentation: 'Feminine', skinTone: 'Dark' }, ks);
// @ts-expect-error 'createdAt' is not an orderBy value
mgmt.catalog.list(ks, { orderBy: 'createdAt' });
// @ts-expect-error 'bogusKey' is not a filter key
mgmt.catalog.list(ks, { filter: { bogusKey: 1 } });
// @ts-expect-error 'updatedAt' is not an orderBy value
mgmt.agents.list(ks, { orderBy: 'updatedAt' });
