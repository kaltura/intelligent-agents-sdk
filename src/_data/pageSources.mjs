// Where each page is edited on GitHub, keyed by its URL. Generated pages come
// from a file in the SDK repo (main); hand-authored ones live in this branch.
import { manifest } from '../../scripts/docs-manifest.mjs';

const SDK_EDIT = 'https://github.com/kaltura/intelligent-agents-sdk/edit/main';
const SITE_EDIT = 'https://github.com/kaltura/intelligent-agents-sdk/edit/gh-pages-src/src';

export default Object.fromEntries(
  manifest.map((e) => [e.url ?? '/', e.generated ? `${SDK_EDIT}/${e.source}` : `${SITE_EDIT}/${e.target}`])
);
