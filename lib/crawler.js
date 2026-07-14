import { normalizeUrl, isHttpUrl } from './utils.js';
import { extractLinksFromHtml } from './checker.js';

export async function fetchPageHtml(url, signal) {
  const timeoutMs = 15000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype && !ctype.includes('html') && !ctype.includes('xml') && !ctype.includes('text/plain')) {
      throw new Error(`Not HTML (${ctype.split(';')[0]})`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function fetchSitemapUrls(origin, signal) {
  const urls = new Set();
  const sitemapUrls = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  const collectLocs = (text, tagPath) => {
    const found = [];
    // Prefer DOM when available; regex works in service workers
    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        doc.querySelectorAll(tagPath).forEach((l) => {
          const v = (l.textContent || '').trim();
          if (v) found.push(v);
        });
        return found;
      } catch { /* fall through */ }
    }
    const re = /<loc[^>]*>\s*([^<]+?)\s*<\/loc>/gi;
    let m;
    while ((m = re.exec(text)) !== null) found.push(m[1].trim());
    return found;
  };

  const hasSitemapIndex = (text) => /<sitemapindex[\s>]/i.test(text) || /<sitemap[\s>]/i.test(text);

  for (const sitemapUrl of sitemapUrls) {
    try {
      const res = await fetch(sitemapUrl, { signal });
      if (!res.ok) continue;
      const text = await res.text();

      if (hasSitemapIndex(text) && /<sitemap[\s>]/i.test(text)) {
        const childLocs = collectLocs(text, 'sitemap > loc');
        // If DOM path returned nothing, regex locs are mixed — treat all as potential children when index
        const children = childLocs.length ? childLocs : collectLocs(text, 'loc');
        for (const childUrl of children) {
          try {
            const childRes = await fetch(childUrl, { signal });
            if (!childRes.ok) continue;
            const childText = await childRes.text();
            collectLocs(childText, 'url > loc').forEach((u) => urls.add(u));
            if (!urls.size) collectLocs(childText, 'loc').forEach((u) => urls.add(u));
          } catch { /* skip child sitemap */ }
        }
      } else {
        collectLocs(text, 'url > loc').forEach((u) => urls.add(u));
        if (!urls.size) collectLocs(text, 'loc').forEach((u) => urls.add(u));
      }
    } catch { /* skip */ }
  }

  return [...urls];
}

export function createUrlFilter(mode, options = {}) {
  const origin = options.origin || '';
  const prefix = options.categoryPrefix || '';
  const sectionUrls = options.sectionUrls || [];
  const sitemapUrls = options.sitemapUrls || [];

  if (mode === 'category') {
    const categoryType = options.categoryType || 'prefix';

    if (categoryType === 'prefix' && prefix) {
      return (url) => {
        try {
          const p = new URL(url);
          return p.origin === origin && p.pathname.startsWith(prefix);
        } catch {
          return false;
        }
      };
    }

    if (categoryType === 'nav' && sectionUrls.length) {
      const normalized = new Set(sectionUrls.map((u) => normalizeUrl(u, origin)).filter(Boolean));
      return (url) => {
        const norm = normalizeUrl(url, origin);
        if (!norm) return false;
        for (const s of normalized) {
          if (norm === s || norm.startsWith(s)) return true;
        }
        return false;
      };
    }

    if (categoryType === 'sitemap' && sitemapUrls.length) {
      const sitemapSet = new Set(sitemapUrls.map((u) => normalizeUrl(u, origin)).filter(Boolean));
      return (url) => sitemapSet.has(normalizeUrl(url, origin));
    }
  }

  return (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
}

export function filterCrawlLinks(links, origin, urlFilter, respectNofollow, html) {
  const result = [];
  const nofollowHrefs = new Set();

  if (respectNofollow && html) {
    if (typeof DOMParser !== 'undefined') {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        doc.querySelectorAll('a[rel*="nofollow"]').forEach((a) => {
          try {
            nofollowHrefs.add(new URL(a.getAttribute('href'), origin).href);
          } catch { /* skip */ }
        });
      } catch { /* ignore */ }
    } else {
      const re = /<a\b([^>]*)>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const attrs = m[1] || '';
        if (!/\brel\s*=\s*("[^"]*nofollow[^"]*"|'[^']*nofollow[^']*'|[^\s>]*nofollow)/i.test(attrs)) continue;
        const hrefMatch = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
        if (!hrefMatch) continue;
        const href = hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '';
        try {
          nofollowHrefs.add(new URL(href, origin).href);
        } catch { /* skip */ }
      }
    }
  }

  for (const link of links) {
    const norm = normalizeUrl(link, origin);
    if (!norm || !isHttpUrl(norm)) continue;
    if (!urlFilter(norm)) continue;
    if (respectNofollow && nofollowHrefs.has(norm)) continue;
    result.push(norm);
  }
  return result;
}

/**
 * Parallel same-origin crawl.
 * Fetches up to `crawlConcurrency` pages at once; stops after `maxPages` new pages
 * in this batch (seededInBatch already counts toward the cap).
 * `excludeUrls` are never fetched again (batch skip / already-seeded tab URL).
 */
export async function crawlDomain(options, callbacks) {
  const {
    startUrl,
    maxPages = 50,
    settings = {},
    mode = 'domain',
    categoryOptions = {},
    signal,
    crawlConcurrency = 3,
    excludeUrls = null,
    seededInBatch = 0,
    seedQueue = [],
    batchPick = 'bfs'
  } = options;

  const origin = new URL(startUrl).origin;
  let sitemapUrls = [];

  if (mode === 'category' && categoryOptions.categoryType === 'sitemap') {
    sitemapUrls = await fetchSitemapUrls(origin, signal);
    categoryOptions.sitemapUrls = sitemapUrls;
    categoryOptions.origin = origin;
  }

  const urlFilter = createUrlFilter(mode, { origin, ...categoryOptions });
  const visited = new Set();
  const queued = new Set();
  const queue = [];
  const pages = [];
  let pageOrder = seededInBatch;
  let inFlight = 0;
  let reserved = 0;
  const pickRandom = batchPick === 'random';

  if (excludeUrls) {
    for (const u of excludeUrls) {
      const norm = normalizeUrl(u, origin);
      if (norm) visited.add(norm);
    }
  }

  const batchCount = () => seededInBatch + pages.length;

  const enqueue = (url) => {
    const norm = normalizeUrl(url, origin);
    if (!norm || !urlFilter(norm)) return;
    if (visited.has(norm) || queued.has(norm)) return;
    queued.add(norm);
    if (pickRandom && queue.length > 0) {
      const idx = Math.floor(Math.random() * (queue.length + 1));
      queue.splice(idx, 0, norm);
    } else {
      queue.push(norm);
    }
  };

  const takeNext = () => {
    if (!queue.length) return null;
    if (pickRandom) {
      const idx = Math.floor(Math.random() * queue.length);
      const [url] = queue.splice(idx, 1);
      return url;
    }
    return queue.shift();
  };

  const tryReserve = () => {
    if (batchCount() + reserved >= maxPages) return false;
    reserved++;
    return true;
  };

  const releaseReserve = () => {
    reserved = Math.max(0, reserved - 1);
  };

  if (mode === 'category' && categoryOptions.categoryType === 'sitemap' && sitemapUrls.length) {
    const list = [...sitemapUrls];
    if (pickRandom) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    for (const u of list) enqueue(u);
  } else if (mode === 'category' && categoryOptions.categoryType === 'nav' && categoryOptions.sectionUrls?.length) {
    for (const u of categoryOptions.sectionUrls) enqueue(u);
  } else {
    const seeds = [...(seedQueue || [])];
    if (pickRandom) {
      for (let i = seeds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [seeds[i], seeds[j]] = [seeds[j], seeds[i]];
      }
    }
    for (const u of seeds) enqueue(u);
    const start = normalizeUrl(startUrl, origin);
    if (start && !visited.has(start)) enqueue(start);
    else if (mode === 'category' && categoryOptions.categoryPrefix) {
      enqueue(origin + categoryOptions.categoryPrefix);
    } else if (!seeds.length && !seededInBatch) {
      enqueue(startUrl);
    }
  }

  if (!queue.length && !seededInBatch) enqueue(startUrl);

  const concurrency = Math.max(1, Math.min(crawlConcurrency, 5));

  async function fetchOne(pageUrl) {
    if (signal?.aborted) {
      releaseReserve();
      return;
    }

    visited.add(pageUrl);

    try {
      const html = await fetchPageHtml(pageUrl, signal);
      const { links, pageLinks, title } = extractLinksFromHtml(html, pageUrl, settings);
      const page = {
        url: pageUrl,
        title,
        order: pageOrder++,
        links
      };
      pages.push(page);
      releaseReserve();
      callbacks.onPage?.(page, batchCount(), maxPages);

      if (batchCount() >= maxPages) return;

      const crawlLinks = filterCrawlLinks(
        pageLinks,
        origin,
        urlFilter,
        settings.respectNofollow,
        html
      );

      for (const link of crawlLinks) enqueue(link);
    } catch (err) {
      releaseReserve();
      callbacks.onPageError?.(pageUrl, err.message);
    }
  }

  const workers = [];
  const pump = async () => {
    while (!signal?.aborted) {
      if (batchCount() >= maxPages) break;
      if (!queue.length) {
        if (inFlight === 0 && reserved === 0) break;
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }

      if (!tryReserve()) {
        if (inFlight === 0 && reserved === 0) break;
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }

      const pageUrl = takeNext();
      if (!pageUrl || visited.has(pageUrl)) {
        releaseReserve();
        continue;
      }

      inFlight++;
      try {
        await fetchOne(pageUrl);
      } finally {
        inFlight--;
      }
    }
  };

  for (let i = 0; i < concurrency; i++) workers.push(pump());
  await Promise.all(workers);

  return pages;
}
