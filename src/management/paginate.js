/**
 * Pagination — the two backends disagree on pager shape (Agentic uses
 * `{offset,limit}` 0-indexed; Genie uses `{pageIndex,pageSize}` 1-indexed). The
 * SDK sends each host its native pager but exposes ONE async-iterator surface
 * to callers (`for await (const x of agents.list(ks))`), normalizing the
 * difference.
 *
 * Returns a {@link Page}: thenable (await it for the first page's array) AND
 * async-iterable (iterate to walk every page). So both styles work:
 *   const first = await client.agents.list(ks);          // array (first page)
 *   for await (const a of client.agents.list(ks)) {…}     // every page
 */

/** @typedef {{offset:number,limit:number}} OffsetPager */
/** @typedef {{pageIndex:number,pageSize:number}} IndexPager */

/**
 * @template T
 * @param {object} cfg
 * @param {'offset'|'index'} cfg.style
 * @param {number} [cfg.pageSize]
 * @param {(pager:OffsetPager|IndexPager)=>Promise<{objects:T[], totalCount?:number}>} cfg.fetchPage
 * @returns {Page<T>}
 */
export function paginate(cfg) {
  const pageSize = cfg.pageSize ?? 30;
  const mkPager = (n) => cfg.style === 'offset'
    ? { offset: n * pageSize, limit: pageSize }
    : { pageIndex: n + 1, pageSize };

  let firstPage;
  function getFirst() { return firstPage || (firstPage = cfg.fetchPage(mkPager(0))); }

  /** Walk every page lazily. */
  async function* iterate() {
    let n = 0, seen = 0, total = Infinity;
    while (seen < total) {
      const res = await (n === 0 ? getFirst() : cfg.fetchPage(mkPager(n)));
      const objects = Array.isArray(res?.objects) ? res.objects : [];
      if (typeof res?.totalCount === 'number') total = res.totalCount;
      for (const o of objects) { yield o; seen++; }
      if (objects.length < pageSize) break; // short page ⇒ done
      n++;
    }
  }

  const page = /** @type {Page<T>} */ ({
    [Symbol.asyncIterator]: iterate,
    /** First page as a plain array. */
    then(resolve, reject) {
      return getFirst()
        .then((r) => (Array.isArray(r?.objects) ? r.objects : []))
        .then(resolve, reject);
    },
    /** Collect ALL pages into one array (use with care on large sets). */
    async all() { const out = []; for await (const x of iterate()) out.push(x); return out; },
  });
  return page;
}

/**
 * @template T
 * @typedef {{
 *   [Symbol.asyncIterator]():AsyncGenerator<T>,
 *   then(resolve:(v:T[])=>any, reject?:(e:any)=>any):Promise<any>,
 *   all():Promise<T[]>
 * }} Page
 */
