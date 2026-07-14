import { normalizeUrl, isHttpUrl, shouldSkipUrl } from './utils.js';
import { extractLinksFromHtml } from './checker.js';

export async function fetchPageHtml(url, signal) {
  const res = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function fetchSitemapUrls(origin, signal) {
  const urls = new Set();
  const sitemapUrls = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const res = await fetch(sitemapUrl, { signal });
      if (!res.ok) continue;
      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/xml');

      const sitemaps = doc.querySelectorAll('sitemap > loc');
      if (sitemaps.length) {
        for (const loc of sitemaps) {
          const childUrl = loc.textContent.trim();
          try {
            const childRes = await fetch(childUrl, { signal });
            if (!childRes.ok) continue;
            const childText = await childRes.text();
            const childDoc = parser.parseFromString(childText, 'text/xml');
            childDoc.querySelectorAll('url > loc').forEach((l) => {
              urls.add(l.textContent.trim());
            });
          } catch { /* skip child sitemap */ }
        }
      } else {
        doc.querySelectorAll('url > loc').forEach((l) => {
          urls.add(l.textContent.trim());
        });
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
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const nofollowHrefs = new Set();

  if (respectNofollow) {
    doc.querySelectorAll('a[rel*="nofollow"]').forEach((a) => {
      try {
        nofollowHrefs.add(new URL(a.getAttribute('href'), origin).href);
      } catch { /* skip */ }
    });
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

export async function crawlDomain(options, callbacks) {
  const {
    startUrl,
    maxPages = 200,
    settings = {},
    mode = 'domain',
    categoryOptions = {},
    signal
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
  const queue = [];
  const pages = [];
  let pageOrder = 0;

  const seedUrl = (url) => {
    const norm = normalizeUrl(url, origin);
    if (norm && urlFilter(norm) && !queue.includes(norm)) queue.push(norm);
  };

  if (mode === 'category' && categoryOptions.categoryType === 'sitemap' && sitemapUrls.length) {
    for (const u of sitemapUrls.slice(0, maxPages)) seedUrl(u);
  } else if (mode === 'category' && categoryOptions.categoryType === 'nav' && categoryOptions.sectionUrls?.length) {
    for (const u of categoryOptions.sectionUrls) seedUrl(u);
  } else {
    const start = normalizeUrl(startUrl, origin);
    if (start && urlFilter(start)) {
      queue.push(start);
    } else if (mode === 'category' && categoryOptions.categoryPrefix) {
      seedUrl(origin + categoryOptions.categoryPrefix);
    } else {
      queue.push(normalizeUrl(startUrl, origin));
    }
  }

  if (!queue.length) {
    queue.push(normalizeUrl(startUrl, origin));
  }

  while (queue.length > 0 && pages.length < maxPages) {
    if (signal?.aborted) break;

    const pageUrl = queue.shift();
    if (!pageUrl || visited.has(pageUrl)) continue;
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
      callbacks.onPage?.(page, pages.length, maxPages);

      const crawlLinks = filterCrawlLinks(
        pageLinks,
        origin,
        urlFilter,
        settings.respectNofollow,
        html
      );

      for (const link of crawlLinks) {
        const norm = normalizeUrl(link, origin);
        if (norm && !visited.has(norm) && !queue.includes(norm)) {
          queue.push(norm);
        }
      }
    } catch (err) {
      callbacks.onPageError?.(pageUrl, err.message);
    }
  }

  return pages;
}
