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
    this.perHostDelay = options.perHostDelay || 350;
    this.maxRetries = options.maxRetries || 3;
    this.timeout = options.timeout || 12000;
    this.cache = new Map();
    this.abortController = null;
    this.hostLastRequest = new Map();
    this.hostQueues = new Map();
  }

  cancel() {
    this.abortController?.abort();
    this.abortController = null;
  }

  async _throttleHost(host) {
    const last = this.hostLastRequest.get(host) || 0;
    const wait = this.perHostDelay - (Date.now() - last);
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
    if (cached) return { ...cached };

    if (meta.checkType === 'hash') {
      return this._checkHashLink(url, meta, cacheKey);
    }

    return this._checkHttpLink(stripHash(url), signal, cacheKey);
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

  async _checkHttpLink(url, signal, cacheKey) {
    const host = getHost(url);
    await this._throttleHost(host);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) break;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            Range: 'bytes=0-0',
            Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
          }
        });

        clearTimeout(timeoutId);

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
          this.cache.set(cacheKey, classified);
          return classified;
        }

        if ((statusCode === 429 || statusCode === 503) && attempt < this.maxRetries) {
          await sleep(1000 * Math.pow(2, attempt));
          await this._throttleHost(host);
          continue;
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

        if (statusCode === 405 || statusCode === 501) {
          const headRes = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
          classified.statusCode = headRes.status;
          classified.status = classifyStatus(headRes.status, null);
          classified.finalUrl = headRes.url || url;
        }

        this.cache.set(cacheKey, classified);
        return classified;
      } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
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

  clearCache() {
    this.cache.clear();
    this.hostLastRequest.clear();
  }

  lookupResult(link, results) {
    const key = link.checkType === 'hash' ? `hash:${link.href}` : stripHash(link.href);
    return results.get(key);
  }
}

export function extractLinksFromHtml(html, pageUrl, settings = {}) {
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

  const addLink = (href, text, type) => {
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
        const baseWithoutHash = parsed.href.split('#')[0];
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

  if (types.anchors) {
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
