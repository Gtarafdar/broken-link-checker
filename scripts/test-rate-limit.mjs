#!/usr/bin/env node
/**
 * Rate-limit handling tests. Run: node scripts/test-rate-limit.mjs
 */
import assert from 'node:assert/strict';

const scenario = {
  'https://example.com/busy': (() => {
    let n = 0;
    return () => {
      n++;
      if (n <= 3) {
        return {
          ok: false,
          status: 429,
          url: 'https://example.com/busy',
          headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '1' : null) }
        };
      }
      return {
        ok: true,
        status: 200,
        url: 'https://example.com/busy',
        headers: { get: () => null }
      };
    };
  })(),
  'https://example.com/ok': () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/ok',
    headers: { get: () => null }
  }),
  'https://example.com/gone': () => ({
    ok: false,
    status: 404,
    url: 'https://example.com/gone',
    headers: { get: () => null }
  }),
  'https://example.com/always429': () => ({
    ok: false,
    status: 429,
    url: 'https://example.com/always429',
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? '0' : null) }
  })
};

globalThis.fetch = async (url) => {
  const factory = scenario[String(url)];
  if (!factory) throw new Error('unexpected url ' + url);
  return factory();
};

const { LinkChecker, classifyStatus, isBroken } = await import('../lib/checker.js');

assert.equal(classifyStatus(429), 'rate_limited');
assert.equal(isBroken({ status: 'rate_limited' }), false);
assert.equal(isBroken({ status: 'broken' }), true);
console.log('✓ classifyStatus / isBroken');

{
  const c = new LinkChecker({ concurrency: 1, perHostDelay: 10, timeout: 5000, rateLimitRetries: 6 });
  c._throttleHost = async () => {};
  c._bumpHostDelay = function () { this.hostDelay.set('example.com', 20); };
  const result = await c.checkUrl('https://example.com/busy', null, { forceGet: true });
  assert.equal(result.status, 'ok');
  console.log('✓ 429 then succeeds → ok');
}

{
  const c = new LinkChecker({ concurrency: 1, perHostDelay: 10, timeout: 3000, rateLimitRetries: 2, maxRetries: 1 });
  c._throttleHost = async () => {};
  c._bumpHostDelay = function () { this.hostDelay.set('example.com', 10); };
  const result = await c.checkUrl('https://example.com/always429', null, { forceGet: true });
  assert.equal(result.status, 'rate_limited');
  assert.equal(isBroken(result), false);
  console.log('✓ persistent 429 not broken');
}

{
  const c = new LinkChecker({ concurrency: 1, perHostDelay: 10, timeout: 3000, rateLimitRetries: 2 });
  c._throttleHost = async () => {};
  c._bumpHostDelay = function () { this.hostDelay.set('example.com', 10); };
  c.cache.set('https://example.com/busy', {
    url: 'https://example.com/busy',
    statusCode: 429,
    status: 'rate_limited',
    error: 'rate_limited',
    checkType: 'http',
    checkedAt: Date.now()
  });
  scenario['https://example.com/busy'] = () => ({
    ok: true, status: 200, url: 'https://example.com/busy', headers: { get: () => null }
  });
  const results = await c.resolveRateLimited([{ href: 'https://example.com/busy', checkType: 'http' }]);
  assert.equal(results.get('https://example.com/busy').status, 'ok');
  console.log('✓ resolveRateLimited pass');
}

{
  const c = new LinkChecker({ concurrency: 2, perHostDelay: 10, timeout: 3000 });
  c._throttleHost = async () => {};
  const results = await c.checkMany([
    { href: 'https://example.com/ok', checkType: 'http' },
    { href: 'https://example.com/gone', checkType: 'http' }
  ]);
  assert.equal(results.get('https://example.com/ok').status, 'ok');
  assert.equal(results.get('https://example.com/gone').status, 'broken');
  console.log('✓ checkMany');
}

console.log('\nAll rate-limit tests passed.');
