import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../../src/management/paginate.js';

// ── offset style (Agentic: 0-indexed, {offset, limit}) ───────────────────────

test('paginate offset: collects all items across two pages', async () => {
  const page1 = ['a', 'b', 'c'];
  const page2 = ['d', 'e'];
  const calls = [];

  const result = paginate({
    style: 'offset',
    pageSize: 3,
    fetchPage(pager) {
      calls.push({ ...pager });
      if (pager.offset === 0) return Promise.resolve({ objects: page1, totalCount: 5 });
      return Promise.resolve({ objects: page2, totalCount: 5 });
    },
  });

  const items = await result.all();

  assert.deepEqual(items, ['a', 'b', 'c', 'd', 'e']);
  // Two fetchPage calls: page 0 (offset 0) and page 1 (offset 3)
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { offset: 0, limit: 3 });
  assert.deepEqual(calls[1], { offset: 3, limit: 3 });
});

test('paginate offset: short second page terminates without extra fetch', async () => {
  const calls = [];
  const result = paginate({
    style: 'offset',
    pageSize: 3,
    fetchPage(pager) {
      calls.push(pager.offset);
      if (pager.offset === 0) return Promise.resolve({ objects: [1, 2, 3] });
      return Promise.resolve({ objects: [4] }); // short page
    },
  });

  await result.all();
  assert.equal(calls.length, 2);
});

// ── index style (Genie: 1-indexed, {pageIndex, pageSize}) ────────────────────

test('paginate index: collects all items across two pages', async () => {
  const page1 = ['x', 'y', 'z'];
  const page2 = ['w'];
  const calls = [];

  const result = paginate({
    style: 'index',
    pageSize: 3,
    fetchPage(pager) {
      calls.push({ ...pager });
      if (pager.pageIndex === 1) return Promise.resolve({ objects: page1, totalCount: 4 });
      return Promise.resolve({ objects: page2, totalCount: 4 });
    },
  });

  const items = await result.all();

  assert.deepEqual(items, ['x', 'y', 'z', 'w']);
  // pageIndex must be 1-based (not 0-based)
  assert.deepEqual(calls[0], { pageIndex: 1, pageSize: 3 });
  assert.deepEqual(calls[1], { pageIndex: 2, pageSize: 3 });
});

test('paginate index: short second page terminates without extra fetch', async () => {
  const calls = [];
  const result = paginate({
    style: 'index',
    pageSize: 3,
    fetchPage(pager) {
      calls.push(pager.pageIndex);
      if (pager.pageIndex === 1) return Promise.resolve({ objects: ['a', 'b', 'c'] });
      return Promise.resolve({ objects: ['d', 'e'] }); // short page
    },
  });

  await result.all();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls, [1, 2]); // 1-indexed, not 0-indexed
});

// ── for-await iterator surface ────────────────────────────────────────────────

test('paginate offset: for-await yields items in order across pages', async () => {
  const result = paginate({
    style: 'offset',
    pageSize: 2,
    fetchPage(pager) {
      if (pager.offset === 0) return Promise.resolve({ objects: [10, 20], totalCount: 3 });
      return Promise.resolve({ objects: [30], totalCount: 3 });
    },
  });

  const collected = [];
  for await (const item of result) collected.push(item);
  assert.deepEqual(collected, [10, 20, 30]);
});
