#!/usr/bin/env node
/**
 * Batch crawl tests (mock fetch). Run: node scripts/test-batch-crawl.mjs
 */
import assert from 'node:assert/strict';

const pages = {
  'https://example.com/': `<html><head><title>Home</title></head><body>
    <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="/d">D</a>
    <a href="/e">E</a><a href="/f">F</a><a href="https://other.com/x">Ext</a>
  </body></html>`,
  'https://example.com/a': `<html><title>A</title><body><a href="/g">G</a><a href="/b">B</a></body></html>`,
  'https://example.com/b': `<html><title>B</title><body><a href="/h">H</a></body></html>`,
  'https://example.com/c': `<html><title>C</title><body><a href="/i">I</a></body></html>`,
  'https://example.com/d': `<html><title>D</title><body></body></html>`,
  'https://example.com/e': `<html><title>E</title><body></body></html>`,
  'https://example.com/f': `<html><title>F</title><body></body></html>`,
  'https://example.com/g': `<html><title>G</title><body></body></html>`,
  'https://example.com/h': `<html><title>H</title><body></body></html>`,
  'https://example.com/i': `<html><title>I</title><body></body></html>`,
};

globalThis.fetch = async (url) => {
  const key = String(url);
  const html = pages[key];
  if (!html) {
    return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => '' };
  }
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    text: async () => html
  };
};

const { crawlDomain } = await import('../lib/crawler.js');
const { extractLinksFromHtml } = await import('../lib/checker.js');
const { normalizeUrl } = await import('../lib/utils.js');

{
  const r = extractLinksFromHtml(pages['https://example.com/'], 'https://example.com/', {
    linkTypes: { anchors: true, images: false },
    maxLinksPerPage: 100
  });
  assert.ok(r.pageLinks.length >= 4);
  console.log('✓ extractLinksFromHtml');
}

{
  const found = [];
  await crawlDomain({
    startUrl: 'https://example.com/',
    maxPages: 3,
    crawlConcurrency: 2,
    batchPick: 'bfs',
    seededInBatch: 0,
    excludeUrls: new Set(),
    seedQueue: [],
    settings: { linkTypes: { anchors: true, images: false }, maxLinksPerPage: 100 }
  }, { onPage: (p) => found.push(normalizeUrl(p.url)) });
  assert.equal(found.length, 3);
  console.log('✓ maxPages cap');
}

{
  const prior = new Set(
    ['https://example.com/', 'https://example.com/a', 'https://example.com/b']
      .map((u) => normalizeUrl(u))
      .filter(Boolean)
  );
  const found = [];
  await crawlDomain({
    startUrl: 'https://example.com/',
    maxPages: 3,
    crawlConcurrency: 2,
    batchPick: 'bfs',
    seededInBatch: 0,
    excludeUrls: prior,
    seedQueue: [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d',
      'https://example.com/e',
      'https://example.com/f'
    ],
    settings: { linkTypes: { anchors: true, images: false }, maxLinksPerPage: 100 }
  }, { onPage: (p) => found.push(normalizeUrl(p.url)) });
  for (const u of found) assert.ok(!prior.has(u));
  assert.equal(found.length, 3);
  console.log('✓ skip prior + next batch');
}

{
  const allKnown = new Set(Object.keys(pages).map((u) => normalizeUrl(u)).filter(Boolean));
  const found = [];
  await crawlDomain({
    startUrl: 'https://example.com/',
    maxPages: 50,
    crawlConcurrency: 2,
    batchPick: 'bfs',
    seededInBatch: 0,
    excludeUrls: allKnown,
    seedQueue: [...allKnown],
    settings: { linkTypes: { anchors: true, images: false }, maxLinksPerPage: 100 }
  }, { onPage: (p) => found.push(p.url) });
  assert.equal(found.length, 0);
  console.log('✓ all excluded → 0');
}

{
  const prior = new Set([normalizeUrl('https://example.com/'), normalizeUrl('https://example.com/a')].filter(Boolean));
  for (let i = 0; i < 5; i++) {
    const found = [];
    await crawlDomain({
      startUrl: 'https://example.com/',
      maxPages: 2,
      crawlConcurrency: 2,
      batchPick: 'random',
      seededInBatch: 0,
      excludeUrls: prior,
      seedQueue: [
        'https://example.com/b',
        'https://example.com/c',
        'https://example.com/d',
        'https://example.com/e',
        'https://example.com/f'
      ],
      settings: { linkTypes: { anchors: true, images: false }, maxLinksPerPage: 100 }
    }, { onPage: (p) => found.push(normalizeUrl(p.url)) });
    assert.equal(found.length, 2);
    for (const u of found) assert.ok(!prior.has(u));
  }
  console.log('✓ random batch');
}

{
  const found = [];
  await crawlDomain({
    startUrl: 'https://example.com/',
    maxPages: 3,
    crawlConcurrency: 2,
    batchPick: 'bfs',
    seededInBatch: 2,
    excludeUrls: new Set([normalizeUrl('https://example.com/')]),
    seedQueue: [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
      'https://example.com/d'
    ],
    settings: { linkTypes: { anchors: true, images: false }, maxLinksPerPage: 100 }
  }, { onPage: (p) => found.push(normalizeUrl(p.url)) });
  assert.equal(found.length, 1);
  console.log('✓ seededInBatch toward cap');
}

console.log('\nAll batch crawl tests passed.');
