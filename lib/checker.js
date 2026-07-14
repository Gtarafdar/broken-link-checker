import { shouldSkipLinkHref, isHttpCheckableUrl, shouldSkipResolvedUrl } from './link-skip.js';

const BROKEN_STATUSES = new Set(['broken', 'error', 'timeout']);

export function isBroken(result) {
  return BROKEN_STATUSES.has(result?.status);
}

export function classifyStatus(statusCode, error, checkType) {
  if (checkType === 'hash') {
    return error ? 'broken' : 'ok';
  }
  if (error) {
    if (error === 'timeout') return 'timeout';
    if (error === 'rate_limited') return 'rate_limited';
    return 'error';
  }
  if (!statusCode) return 'error';
  if (statusCode >= 200 && statusCode < 300) return 'ok';
  if (statusCode >= 300 && statusCode < 400) return 'ok';
  if (statusCode === 429 || statusCode === 503) return 'rate_limited';
  if (statusCode >= 400) return 'broken';
  return 'unknown';
}

function getHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '_unknown';
  }
}

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class LinkChecker {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.perHostDelay = options.perHostDelay || 500;
    this.maxRetries = options.maxRetries || 3;
    this.rateLimitRetries = options.rateLimitRetries ?? 8;
    this.timeout = options.timeout || 12000;
    this.cache = new Map();
    this.abortController = null;
    this.hostLastRequest = new Map();
    this.hostDelay = new Map();
    this.globalSlowUntil = 0;
  }

  cancel() {
    this.abortController?.abort();
    this.abortController = null;
  }

  clearRateLimitedCache() {
    for (const [key, value] of this.cache.entries()) {
      if (value?.status === 'rate_limited') this.cache.delete(key);
    }
  }

  _hostDelayMs(host) {
    return this.hostDelay.get(host) || this.perHostDelay;
  }

  _bumpHostDelay(host, retryAfterSec = 0) {
    const cur = this._hostDelayMs(host);
    const fromHeader = retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    const next = Math.max(fromHeader, Math.min(25000, Math.max(cur * 2, this.perHostDelay * 3)));
    this.hostDelay.set(host, next);
    this.globalSlowUntil = Date.now() + Math.min(next, 8000);
  }

  _easeHostDelay(host) {
    const cur = this._hostDelayMs(host);
    if (cur <= this.perHostDelay) return;
    this.hostDelay.set(host, Math.max(this.perHostDelay, Math.floor(cur * 0.8)));
  }

  async _throttleHost(host) {
    const now = Date.now();
    if (now < this.globalSlowUntil) {
      await sleep(this.globalSlowUntil - now);
    }
    const delay = this._hostDelayMs(host);
    const last = this.hostLastRequest.get(host) || 0;
    const wait = delay - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    this.hostLastRequest.set(host, Date.now());
  }

  async checkUrl(url, signal, meta = {}) {
    if (meta.checkType !== 'hash') {
      if (shouldSkipLinkHref(url) || !isHttpCheckableUrl(url)) {
        return {
          url,
          statusCode: 0,
          status: 'skipped',
          error: null,
          checkType: 'skipped',
          checkedAt: Date.now()
        };
      }
    }

    const cacheKey = meta.checkType === 'hash' ? `hash:${url}` : stripHash(url);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (!(cached.status === 'rate_limited' && meta.forceRetry)) {
        return { ...cached };
      }
    }

    if (meta.checkType === 'hash') {
      return this._checkHashLink(url, meta, cacheKey);
    }

    return this._checkHttpLink(stripHash(url), signal, cacheKey, meta);
  }

  async _checkHashLink(url, meta, cacheKey) {
    const fragment = meta.hash || (() => {
      try { return new URL(url).hash.slice(1); } catch { return ''; }
    })();

    const result = {
      url,
      statusCode: 200,
      status: 'ok',
      error: null,
      checkType: 'hash',
      checkedAt: Date.now()
    };

    if (!fragment) {
      result.status = 'ok';
      this.cache.set(cacheKey, result);
      return result;
    }

    const decoded = decodeURIComponent(fragment);
    const found = meta.anchorExists === true ||
      (typeof meta.anchorExists === 'function' && meta.anchorExists(decoded));

    if (!found && meta.anchorExists === undefined) {
      result.status = 'ok';
      result.note = 'hash_not_verified';
      this.cache.set(cacheKey, result);
      return result;
    }

    if (!found) {
      result.statusCode = 404;
      result.status = 'broken';
      result.error = 'Anchor not found on page';
    }

    this.cache.set(cacheKey, result);
    return result;
  }

  _parseRetryAfter(res) {
    const raw = res.headers?.get?.('retry-after');
    if (!raw) return 0;
    const asInt = parseInt(raw, 10);
    if (!Number.isNaN(asInt)) return Math.min(60, Math.max(1, asInt));
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) {
      return Math.min(60, Math.max(1, Math.ceil((when - Date.now()) / 1000)));
    }
    return 0;
  }

  async _checkHttpLink(url, signal, cacheKey, meta = {}) {
    const host = getHost(url);
    const maxAttempts = Math.max(this.maxRetries, this.rateLimitRetries);

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) break;
      await this._throttleHost(host);

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) break;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        // Prefer light HEAD first; fall back to partial GET
        let res = await fetch(url, {
          method: attempt === 0 && !meta.forceGet ? 'HEAD' : 'GET',
          signal: controller.signal,
          redirect: 'follow',
          headers: attempt === 0 && !meta.forceGet
            ? { Accept: '*/*' }
            : {
                Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
              }
        });

        // Some hosts reject HEAD — retry once as GET on same attempt budget
        if ((res.status === 405 || res.status === 501) && (attempt === 0 && !meta.forceGet)) {
          res = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'follow',
            headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
          });
        }

        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);

        const statusCode = res.status;

        if (statusCode === 416) {
          const classified = {
            url,
            finalUrl: res.url || url,
            statusCode: 200,
            status: 'ok',
            error: null,
            checkType: 'http',
            checkedAt: Date.now()
          };
          this._easeHostDelay(host);
          this.cache.set(cacheKey, classified);
          return classified;
        }

        if (statusCode === 429 || statusCode === 503) {
          const retryAfter = this._parseRetryAfter(res);
          this._bumpHostDelay(host, retryAfter);
          if (attempt < maxAttempts) {
            const waitMs = Math.max(
              retryAfter * 1000,
              1000 * Math.pow(2, Math.min(attempt, 5))
            );
            await sleep(Math.min(waitMs, 20000));
            continue;
          }
          // Exhausted — do not hard-cache as rate_limited forever within resolve passes
          const classified = {
            url,
            finalUrl: res.url || url,
            statusCode,
            status: 'rate_limited',
            error: 'rate_limited',
            checkType: 'http',
            checkedAt: Date.now()
          };
          this.cache.set(cacheKey, classified);
          return classified;
        }

        const classified = {
          url,
          finalUrl: res.url || url,
          statusCode,
          status: classifyStatus(statusCode, null),
          error: null,
          checkType: 'http',
          checkedAt: Date.now()
        };

        this._easeHostDelay(host);
        this.cache.set(cacheKey, classified);
        return classified;
      } catch (err) {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (err.name === 'AbortError') {
          if (signal?.aborted) {
            return {
              url,
              statusCode: 0,
              status: 'error',
              error: 'cancelled',
              checkType: 'http',
              checkedAt: Date.now()
            };
          }
          if (attempt < this.maxRetries) {
            await sleep(1000 * Math.pow(2, attempt));
            continue;
          }
          const classified = {
            url,
            statusCode: 0,
            status: 'timeout',
            error: 'timeout',
            checkType: 'http',
            checkedAt: Date.now()
          };
          this.cache.set(cacheKey, classified);
          return classified;
        }
        if (attempt < this.maxRetries) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        const classified = {
          url,
          statusCode: 0,
          status: 'error',
          error: err.message || 'Network error',
          checkType: 'http',
          checkedAt: Date.now()
        };
        this.cache.set(cacheKey, classified);
        return classified;
      }
    }

    const classified = {
      url,
      statusCode: 429,
      status: 'rate_limited',
      error: 'rate_limited',
      checkType: 'http',
      checkedAt: Date.now()
    };
    this.cache.set(cacheKey, classified);
    return classified;
  }

  async checkMany(links, onProgress, externalSignal) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const uniqueMap = new Map();
    for (const link of links) {
      const href = typeof link === 'string' ? link : link.href;
      if (typeof link !== 'string' && link.checkType !== 'hash') {
        if (shouldSkipLinkHref(href) || !isHttpCheckableUrl(href)) continue;
      }
      const key = link.checkType === 'hash' ? `hash:${href}` : stripHash(href);
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, typeof link === 'string' ? { href, checkType: 'http' } : link);
      }
    }

    const items = [...uniqueMap.values()];
    const results = new Map();
    let completed = 0;

    const queue = [...items];
    const workers = Array.from({ length: this.concurrency }, async () => {
      while (queue.length > 0) {
        if (signal.aborted || externalSignal?.aborted) break;
        const link = queue.shift();
        if (!link) break;

        const result = await this.checkUrl(link.href, signal, link);
        const resultKey = link.checkType === 'hash' ? `hash:${link.href}` : stripHash(link.href);
        results.set(resultKey, result);
        completed++;
        onProgress?.({ completed, total: items.length, url: link.href, result });
      }
    });

    await Promise.all(workers);
    return results;
  }

  /**
   * Second pass for URLs that still look rate-limited.
   * Slows concurrency and forces GET with fresh attempts.
   */
  async resolveRateLimited(links, onProgress, externalSignal) {
    const targets = links.filter((l) => {
      const href = typeof l === 'string' ? l : l.href;
      if (typeof l !== 'string' && l.checkType === 'hash') return false;
      return true;
    });
    if (!targets.length) return new Map();

    const prevConcurrency = this.concurrency;
    const prevDelay = this.perHostDelay;
    this.concurrency = 1;
    this.perHostDelay = Math.max(this.perHostDelay, 1200);
    this.clearRateLimitedCache();

    const withForce = targets.map((l) => {
      if (typeof l === 'string') return { href: l, checkType: 'http', forceRetry: true, forceGet: true };
      return { ...l, forceRetry: true, forceGet: true };
    });

    try {
      return await this.checkMany(withForce, onProgress, externalSignal);
    } finally {
      this.concurrency = prevConcurrency;
      this.perHostDelay = prevDelay;
    }
  }

  clearCache() {
    this.cache.clear();
    this.hostLastRequest.clear();
    this.hostDelay.clear();
    this.globalSlowUntil = 0;
  }

  lookupResult(link, results) {
    const key = link.checkType === 'hash' ? `hash:${link.href}` : stripHash(link.href);
    return results.get(key);
  }
}

export function extractLinksFromHtml(html, pageUrl, settings = {}) {
  if (typeof DOMParser !== 'undefined') {
    try {
      return extractLinksWithDom(html, pageUrl, settings);
    } catch {
      /* fall through to regex parser (service worker / broken parser) */
    }
  }
  return extractLinksWithRegex(html, pageUrl, settings);
}

function extractLinksWithDom(html, pageUrl, settings = {}) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const links = [];
  const seen = new Set();
  const maxLinks = settings.maxLinksPerPage || 500;
  const types = settings.linkTypes || { anchors: true, images: true };
  const pageOrigin = new URL(pageUrl).origin;
  const pagePath = new URL(pageUrl).pathname;

  const anchorExistsInDoc = (fragment) => {
    if (!fragment) return true;
    const decoded = decodeURIComponent(fragment);
    return !!(
      doc.getElementById(decoded) ||
      doc.querySelector(`[name="${CSS.escape(decoded)}"]`) ||
      doc.querySelector(`a[name="${CSS.escape(decoded)}"]`)
    );
  };

  const addLink = makeAddLink(links, seen, maxLinks, pageUrl, pageOrigin, pagePath, anchorExistsInDoc);

  if (types.anchors !== false) {
    doc.querySelectorAll('a[href]').forEach((a) => {
      addLink(a.getAttribute('href'), (a.textContent || '').trim().slice(0, 200), 'anchor');
    });
  }
  if (types.images) {
    doc.querySelectorAll('img[src]').forEach((img) => {
      addLink(img.getAttribute('src'), img.getAttribute('alt') || 'image', 'image');
    });
  }
  if (types.scripts) {
    doc.querySelectorAll('script[src]').forEach((s) => {
      addLink(s.getAttribute('src'), 'script', 'script');
    });
  }
  if (types.iframes) {
    doc.querySelectorAll('iframe[src]').forEach((f) => {
      addLink(f.getAttribute('src'), 'iframe', 'iframe');
    });
  }

  const pageLinks = [];
  doc.querySelectorAll('a[href]').forEach((a) => {
    try {
      const absolute = stripHash(new URL(a.getAttribute('href'), pageUrl).href);
      if (new URL(absolute).origin === pageOrigin) {
        pageLinks.push(absolute);
      }
    } catch { /* skip */ }
  });

  return { links, pageLinks, title: doc.title || pageUrl };
}

/** Service-worker-safe HTML extraction (no DOMParser). */
function extractLinksWithRegex(html, pageUrl, settings = {}) {
  const links = [];
  const seen = new Set();
  const maxLinks = settings.maxLinksPerPage || 500;
  const types = settings.linkTypes || { anchors: true, images: true };
  const pageOrigin = new URL(pageUrl).origin;
  const pagePath = new URL(pageUrl).pathname;
  const addLink = makeAddLink(links, seen, maxLinks, pageUrl, pageOrigin, pagePath, () => true);

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 300) || pageUrl
    : pageUrl;

  const collect = (tag, attr, type, textAttr) => {
    const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    let m;
    while ((m = re.exec(html)) !== null && links.length < maxLinks) {
      const attrs = m[1] || '';
      const hrefMatch = attrs.match(new RegExp(`${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
      if (!hrefMatch) continue;
      const href = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '';
      let text = type;
      if (textAttr) {
        const tm = attrs.match(new RegExp(`${textAttr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
        if (tm) text = (tm[2] ?? tm[3] ?? tm[4] ?? text).slice(0, 200);
      }
      addLink(href, text, type);
    }
  };

  if (types.anchors !== false) {
    // Prefer reading anchor text when the tag is simple; fall back to href
    const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = aRe.exec(html)) !== null && links.length < maxLinks) {
      const attrs = am[1] || '';
      const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      if (!hrefMatch) continue;
      const href = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '';
      const text = am[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
      addLink(href, text || href, 'anchor');
    }
  }
  if (types.images) collect('img', 'src', 'image', 'alt');
  if (types.scripts) collect('script', 'src', 'script', null);
  if (types.iframes) collect('iframe', 'src', 'iframe', null);

  const pageLinks = [];
  const pageSeen = new Set();
  for (const link of links) {
    if (link.type !== 'anchor' || link.checkType === 'hash') continue;
    try {
      const absolute = stripHash(link.href);
      if (new URL(absolute).origin === pageOrigin && !pageSeen.has(absolute)) {
        pageSeen.add(absolute);
        pageLinks.push(absolute);
      }
    } catch { /* skip */ }
  }

  // Also catch same-origin hrefs that might only appear as bare anchors in pageLinks path
  const hrefOnly = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let hm;
  while ((hm = hrefOnly.exec(html)) !== null) {
    const href = hm[2] ?? hm[3] ?? hm[4] ?? '';
    try {
      if (!href || href.startsWith('#') || shouldSkipLinkHref(href)) continue;
      const absolute = stripHash(new URL(href, pageUrl).href);
      if (new URL(absolute).origin === pageOrigin && !pageSeen.has(absolute)) {
        pageSeen.add(absolute);
        pageLinks.push(absolute);
      }
    } catch { /* skip */ }
  }

  return { links, pageLinks, title };
}

function makeAddLink(links, seen, maxLinks, pageUrl, pageOrigin, pagePath, anchorExistsInDoc) {
  return (href, text, type) => {
    if (!href || links.length >= maxLinks) return;
    try {
      const raw = href.trim();
      if (shouldSkipLinkHref(raw)) return;

      if (raw.startsWith('#')) {
        const fragment = raw.slice(1);
        const absolute = new URL(raw, pageUrl).href;
        const key = 'hash:' + absolute;
        if (seen.has(key)) return;
        seen.add(key);
        links.push({
          href: absolute,
          text: text || `#${fragment}`,
          type,
          selector: null,
          checkType: 'hash',
          hash: fragment,
          anchorExists: anchorExistsInDoc(fragment)
        });
        return;
      }

      const absolute = new URL(raw, pageUrl).href;
      if (shouldSkipResolvedUrl(absolute)) return;
      const parsed = new URL(absolute);

      if (parsed.hash) {
        const fragment = parsed.hash.slice(1);
        const samePage = parsed.origin === pageOrigin && parsed.pathname === pagePath;
        const key = samePage ? `hash:${absolute}` : `http:${stripHash(absolute)}`;
        if (seen.has(key)) return;
        seen.add(key);

        if (samePage) {
          links.push({
            href: absolute,
            text: text || absolute,
            type,
            selector: null,
            checkType: 'hash',
            hash: fragment,
            anchorExists: anchorExistsInDoc(fragment)
          });
        } else {
          links.push({
            href: stripHash(absolute),
            text: text || absolute,
            type,
            selector: null,
            checkType: 'http',
            hash: fragment
          });
        }
        return;
      }

      const key = 'http:' + stripHash(absolute);
      if (seen.has(key)) return;
      seen.add(key);
      links.push({ href: stripHash(absolute), text: text || absolute, type, selector: null, checkType: 'http' });
    } catch { /* skip invalid */ }
  };
}
