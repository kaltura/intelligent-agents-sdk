// Typecheck-only fixture (never imported, never shipped). `npm run typecheck`
// fails if `region` stops being a closed union: each `@ts-expect-error` line
// then has no error to expect.
import { Management } from '../src/management/index.js';
import { KalturaChatSession } from '../src/experience/index.js';

new Management({ partnerId: 1, region: 'nvp1' });
new Management({ partnerId: 1, region: 'frp2' });
// @ts-expect-error 'xx' is not a KalturaRegion
new Management({ partnerId: 1, region: 'xx' });
// @ts-expect-error 'eu' is not a KalturaRegion
new KalturaChatSession({ token: 'ks', region: 'eu' });
