import { MSG } from '../lib/messages.js';
import { LinkChecker, isBroken, extractLinksFromHtml } from '../lib/checker.js';
import { crawlDomain } from '../lib/crawler.js';
import {
  createScan, updateScan, addPage, addLinks, updateLink,
  getScanWithDetails, BatchedWriter, getScannedPageUrlsForDomain
} from '../lib/storage.js';
import { uuid, getDomain, DEFAULT_SETTINGS, normalizeUrl } from '../lib/utils.js';
import { shouldSkipLinkHref, isHttpCheckableUrl } from '../lib/link-skip.js';

let activeScan = null;
let checker = null;
let abortController = null;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  merged.linkTypes = { ...DEFAULT_SETTINGS.linkTypes, ...settings?.linkTypes };
  merged.copyPrefs = {
    includeHeader: settings?.copyPrefs?.includeHeader ?? DEFAULT_SETTINGS.copyPrefs.includeHeader,
    columns: { ...DEFAULT_SETTINGS.copyPrefs.columns, ...settings?.copyPrefs?.columns }
  };
  return merged;
}

function broadcast(msg) {
  if (msg?.type === MSG.SCAN_PROGRESS || msg?.type === MSG.SCAN_ERROR) {
    if (!msg.mode && activeScan?.mode) msg.mode = activeScan.mode;
  }
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function extractFromTab(tabId, settings) {
  return chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_LINKS', settings });
}

async function highlightOnTab(tabId, links) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MSG.HIGHLIGHT_BROKEN,
      links
    });
  } catch { /* tab may not have content script */ }
}

async function processPage(scanId, pageData, settings, tabId) {
  const pageId = uuid();
  const page = {
    id: pageId,
    scanId,
    url: pageData.url || pageData.pageUrl,
    title: pageData.title || pageData.pageTitle || pageData.url,
    order: pageData.order ?? 0
  };
  await addPage(page);

  const urls = pageData.links;
  const linkRecords = [];
  const writer = new BatchedWriter(async (batch) => addLinks(batch));

  const checkableLinks = pageData.links.filter((l) => {
    if (l.checkType === 'hash') return true;
    return !shouldSkipLinkHref(l.href) && isHttpCheckableUrl(l.href);
  });

  const results = await checker.checkMany(checkableLinks, (progress) => {
    if (activeScan?.mode === 'page') {
      broadcast({
        type: MSG.SCAN_PROGRESS,
        scanId,
        progress: {
          phase: 'checking',
          checked: progress.completed,
          total: progress.total,
          currentUrl: progress.url,
          pagesScanned: 1,
          totalPages: 1
        }
      });
      return;
    }

    // Domain / category: keep global totals so the bar doesn't jump per page
    const base = activeScan?.linksCheckedBase || 0;
    broadcast({
      type: MSG.SCAN_PROGRESS,
      scanId,
      progress: {
        phase: 'checking',
        crawling: false,
        checked: Math.min(
          activeScan?.uniqueTotal || Infinity,
          base + progress.completed
        ),
        total: activeScan?.uniqueTotal || progress.total,
        uniqueTotal: activeScan?.uniqueTotal,
        currentUrl: progress.url,
        pagesScanned: activeScan?.pagesProcessed || 0,
        totalPages: activeScan?.totalPages || 0,
        maxPages: activeScan?.maxPages,
        broken: activeScan?.brokenSoFar || 0
      }
    });
  }, abortController?.signal);

  for (const linkData of pageData.links) {
    const result = checker.lookupResult(linkData, results);
    if (result?.status === 'skipped') continue;

    const record = {
      id: uuid(),
      scanId,
      pageId,
      href: linkData.href,
      text: linkData.text,
      type: linkData.type,
      selector: linkData.selector,
      checkType: linkData.checkType || 'http',
      hash: linkData.hash || null,
      statusCode: result?.statusCode || 0,
      status: result?.status || 'error',
      error: result?.error || null,
      checkedAt: result?.checkedAt || Date.now()
    };
    linkRecords.push(record);
    writer.add(record);
  }
  await writer.flush();

  const broken = linkRecords.filter(isBroken);
  if (tabId && normalizeUrl(pageData.url || pageData.pageUrl) === normalizeUrl(activeScan?.startUrl)) {
    await highlightOnTab(tabId, linkRecords);
  }

  return { page, linkRecords, brokenCount: broken.length };
}

function makeChecker(settings) {
  return new LinkChecker({
    concurrency: settings.concurrency || 3,
    perHostDelay: settings.perHostDelay || 500,
    timeout: settings.timeout || 12000,
    rateLimitRetries: settings.rateLimitRetries ?? 8
  });
}

async function resolveRateLimitedForScan(scanId, settings) {
  if (settings.autoRetryRateLimited === false) return 0;
  if (!checker || abortController?.signal?.aborted) return 0;

  const details = await getScanWithDetails(scanId);
  if (!details?.links?.length) return 0;

  const limited = details.links.filter((l) => l.status === 'rate_limited');
  if (!limited.length) return 0;

  broadcast({
    type: MSG.SCAN_PROGRESS,
    scanId,
    progress: {
      phase: 'resolving',
      checked: 0,
      total: limited.length,
      pagesScanned: details.pages?.length || 0,
      totalPages: details.pages?.length || 0
    }
  });

  // Brief cool-down so the host can recover before the slow pass
  await new Promise((r) => setTimeout(r, 1500));

  const results = await checker.resolveRateLimited(
    limited.map((l) => ({
      href: l.href,
      checkType: l.checkType || 'http',
      hash: l.hash
    })),
    (progress) => {
      broadcast({
        type: MSG.SCAN_PROGRESS,
        scanId,
        progress: {
          phase: 'resolving',
          checked: progress.completed,
          total: progress.total,
          currentUrl: progress.url,
          pagesScanned: details.pages?.length || 0,
          totalPages: details.pages?.length || 0
        }
      });
    },
    abortController?.signal
  );

  let resolved = 0;
  for (const link of limited) {
    if (abortController?.signal?.aborted) break;
    const key = link.checkType === 'hash' ? `hash:${link.href}` : (() => {
      try {
        const u = new URL(link.href);
        u.hash = '';
        return u.href;
      } catch {
        return link.href;
      }
    })();
    const result = results.get(key) || results.get(link.href);
    if (!result) continue;
    link.statusCode = result.statusCode;
    link.status = result.status;
    link.error = result.error;
    link.checkedAt = result.checkedAt || Date.now();
    await updateLink(link);
    if (result.status !== 'rate_limited') resolved++;
  }
  return resolved;
}

async function runPageScan(tab, mode, categoryOptions, existingScanId) {
  const settings = await getSettings();
  const scanId = existingScanId || uuid();
  const startUrl = tab.url;

  abortController = new AbortController();
  checker = makeChecker(settings);

  activeScan = {
    id: scanId,
    mode,
    startUrl,
    tabId: tab.id,
    pagesScanned: 0,
    status: 'running'
  };

  const scan = {
    id: scanId,
    domain: getDomain(startUrl),
    mode,
    categoryFilter: categoryOptions?.categoryPrefix || categoryOptions?.categoryType || '',
    startedAt: Date.now(),
    completedAt: null,
    status: 'running',
    stats: { pages: 0, links: 0, broken: 0 },
    settings,
    batch: {
      maxPages: settings.maxPages,
      skipScannedPages: settings.skipScannedPages !== false,
      batchPick: settings.batchPick === 'random' ? 'random' : 'bfs'
    }
  };
  await createScan(scan);
  broadcast({ type: MSG.SCAN_PROGRESS, scanId, progress: { checked: 0, total: 0, pagesScanned: 0, starting: true } });

  try {
    if (mode === 'page') {
      const extracted = await extractFromTab(tab.id, settings);
      if (!extracted?.links?.length) {
        scan.status = 'completed';
        scan.completedAt = Date.now();
        await updateScan(scan);
        broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan });
        return scanId;
      }

      const pageData = {
        url: extracted.pageUrl,
        title: extracted.pageTitle,
        links: extracted.links,
        order: 0
      };

      const { linkRecords, brokenCount } = await processPage(scanId, pageData, settings, tab.id);
      await resolveRateLimitedForScan(scanId, settings);
      const after = await getScanWithDetails(scanId);
      const brokenAfter = (after?.links || []).filter(isBroken).length;
      scan.stats = {
        pages: 1,
        links: after?.links?.length || linkRecords.length,
        broken: brokenAfter || brokenCount
      };
      scan.status = 'completed';
      scan.completedAt = Date.now();
      await updateScan(scan);
      broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan });
    } else {
      const maxPages = settings.maxPages || 50;
      const skipScanned = settings.skipScannedPages !== false;
      const batchPick = settings.batchPick === 'random' ? 'random' : 'bfs';
      const crawledPages = [];
      const domain = getDomain(startUrl);

      let prior = { urls: new Set(), scanCount: 0, pageCount: 0 };
      if (skipScanned) {
        try {
          prior = await getScannedPageUrlsForDomain(domain);
        } catch { /* history optional */ }
      }

      broadcast({
        type: MSG.SCAN_PROGRESS,
        scanId,
        progress: {
          phase: 'crawling',
          crawling: true,
          pagesScanned: 0,
          maxPages,
          totalPages: maxPages,
          checked: 0,
          total: 0,
          batchSkip: skipScanned ? prior.pageCount : 0,
          batchPick
        }
      });

      // Seed from the live tab DOM (always useful for discovery links)
      let seedPageLinks = [];
      let seedNorm = normalizeUrl(startUrl);
      try {
        const extracted = await extractFromTab(tab.id, settings);
        if (extracted?.links && extracted.pageUrl) {
          seedNorm = normalizeUrl(extracted.pageUrl) || seedNorm;
          seedPageLinks = (extracted.links || [])
            .filter((l) => l.checkType !== 'hash')
            .map((l) => l.href)
            .filter((href) => {
              try {
                return new URL(href).origin === new URL(startUrl).origin;
              } catch {
                return false;
              }
            });

          const alreadyScannedSeed = skipScanned && seedNorm && prior.urls.has(seedNorm);
          if (!alreadyScannedSeed) {
            crawledPages.push({
              url: extracted.pageUrl,
              title: extracted.pageTitle || extracted.pageUrl,
              order: 0,
              links: extracted.links,
              pageLinks: seedPageLinks
            });
            activeScan.pagesScanned = 1;
            broadcast({
              type: MSG.SCAN_PROGRESS,
              scanId,
              progress: {
                phase: 'crawling',
                crawling: true,
                pagesScanned: 1,
                maxPages,
                totalPages: maxPages,
                checked: 0,
                total: 0,
                batchSkip: skipScanned ? prior.pageCount : 0,
                batchPick
              }
            });
          }
        }
      } catch { /* tab extract optional */ }

      const excludeUrls = new Set(prior.urls);
      if (seedNorm) excludeUrls.add(seedNorm);
      for (const p of crawledPages) {
        const n = normalizeUrl(p.url);
        if (n) excludeUrls.add(n);
      }

      await crawlDomain({
        startUrl,
        maxPages,
        settings,
        mode: mode === 'category' ? 'category' : 'domain',
        categoryOptions: { origin: new URL(startUrl).origin, ...categoryOptions },
        signal: abortController.signal,
        crawlConcurrency: settings.crawlConcurrency || 3,
        excludeUrls,
        seededInBatch: crawledPages.length,
        seedQueue: seedPageLinks,
        batchPick
      }, {
        onPage: (page, count, cap) => {
          crawledPages.push(page);
          activeScan.pagesScanned = count;
          broadcast({
            type: MSG.SCAN_PROGRESS,
            scanId,
            progress: {
              phase: 'crawling',
              crawling: true,
              pagesScanned: count,
              maxPages: cap,
              totalPages: cap,
              checked: 0,
              total: 0,
              batchSkip: skipScanned ? prior.pageCount : 0,
              batchPick
            }
          });
        },
        onPageError: (url, errMsg) => {
          broadcast({
            type: MSG.SCAN_PROGRESS,
            scanId,
            progress: {
              phase: 'crawling',
              crawling: true,
              pagesScanned: crawledPages.length,
              maxPages,
              totalPages: maxPages,
              crawlError: `${url}: ${errMsg}`,
              batchSkip: skipScanned ? prior.pageCount : 0,
              batchPick
            }
          });
        }
      });

      if (abortController.signal.aborted) {
        scan.status = 'cancelled';
        scan.completedAt = Date.now();
        scan.stats = { pages: crawledPages.length, links: 0, broken: 0 };
        await updateScan(scan);
        broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan });
        return scanId;
      }

      if (!crawledPages.length) {
        const hint = skipScanned && prior.pageCount
          ? ` No new pages left to scan for ${domain} (already have ${prior.pageCount} in history). Turn off “Skip previously scanned pages” in Settings, or delete old scans for this domain.`
          : ' The start URL may have failed to load, or HTML could not be parsed. Try Current Page first.';
        scan.status = 'error';
        scan.error = `Domain crawl found 0 new pages.${hint}`;
        scan.completedAt = Date.now();
        scan.stats = { pages: 0, links: 0, broken: 0 };
        await updateScan(scan);
        broadcast({ type: MSG.SCAN_ERROR, scanId, error: scan.error });
        return scanId;
      }

      // Count unique checkable URLs for accurate progress
      const uniqueKeys = new Set();
      for (const page of crawledPages) {
        for (const l of page.links || []) {
          if (l.checkType === 'hash') {
            uniqueKeys.add(`hash:${l.href}`);
            continue;
          }
          if (shouldSkipLinkHref(l.href) || !isHttpCheckableUrl(l.href)) continue;
          try {
            const u = new URL(l.href);
            u.hash = '';
            uniqueKeys.add(u.href);
          } catch {
            uniqueKeys.add(l.href);
          }
        }
      }
      const uniqueTotal = uniqueKeys.size;

      broadcast({
        type: MSG.SCAN_PROGRESS,
        scanId,
        progress: {
          phase: 'checking',
          crawling: false,
          pagesScanned: crawledPages.length,
          totalPages: crawledPages.length,
          maxPages,
          checked: 0,
          total: Math.max(uniqueTotal, 1),
          uniqueTotal: Math.max(uniqueTotal, 1)
        }
      });

      if (uniqueTotal === 0) {
        // Still persist crawled pages with zero links
        for (let i = 0; i < crawledPages.length; i++) {
          const page = crawledPages[i];
          page.order = i;
          page.links = page.links || [];
          await processPage(scanId, page, settings, null);
        }
        scan.stats = { pages: crawledPages.length, links: 0, broken: 0 };
        scan.status = 'completed';
        scan.completedAt = Date.now();
        await updateScan(scan);
        broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan });
        return scanId;
      }

      let totalLinks = 0;
      let totalBroken = 0;
      let pagesProcessed = 0;
      let linksCheckedBase = 0;

      activeScan.totalPages = crawledPages.length;
      activeScan.maxPages = maxPages;
      activeScan.uniqueTotal = uniqueTotal;
      activeScan.pagesProcessed = 0;
      activeScan.linksCheckedBase = 0;
      activeScan.brokenSoFar = 0;

      for (let i = 0; i < crawledPages.length; i++) {
        if (abortController.signal.aborted) break;
        const page = crawledPages[i];
        page.order = i;

        activeScan.pagesProcessed = i;
        activeScan.linksCheckedBase = linksCheckedBase;

        const beforeCache = checker.cache.size;
        const { linkRecords, brokenCount } = await processPage(scanId, page, settings, null);
        const newlyCached = Math.max(0, checker.cache.size - beforeCache);
        linksCheckedBase = Math.min(uniqueTotal, linksCheckedBase + newlyCached);
        pagesProcessed++;
        totalLinks += linkRecords.length;
        totalBroken += brokenCount;
        activeScan.pagesProcessed = pagesProcessed;
        activeScan.linksCheckedBase = linksCheckedBase;
        activeScan.brokenSoFar = totalBroken;

        broadcast({
          type: MSG.SCAN_PROGRESS,
          scanId,
          progress: {
            phase: 'checking',
            crawling: false,
            checked: linksCheckedBase || Math.round((pagesProcessed / crawledPages.length) * uniqueTotal),
            total: uniqueTotal,
            uniqueTotal,
            pagesScanned: pagesProcessed,
            totalPages: crawledPages.length,
            maxPages,
            broken: totalBroken
          }
        });
      }

      await resolveRateLimitedForScan(scanId, settings);
      const after = await getScanWithDetails(scanId);
      const brokenAfter = (after?.links || []).filter(isBroken).length;
      const linksAfter = after?.links?.length || totalLinks;

      scan.stats = { pages: crawledPages.length, links: linksAfter, broken: brokenAfter };
      scan.status = abortController.signal.aborted ? 'cancelled' : 'completed';
      scan.completedAt = Date.now();
      await updateScan(scan);

      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && activeTab.url) {
          const details = after || await getScanWithDetails(scanId);
          const matchPage = details.pages.find((p) => p.url === activeTab.url);
          if (matchPage) {
            const pageLinks = details.linksByPage[matchPage.id] || [];
            await highlightOnTab(activeTab.id, pageLinks);
          }
        }
      } catch { /* ignore highlight errors */ }

      broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan });
    }
  } catch (err) {
    scan.status = 'error';
    scan.error = err.message;
    scan.completedAt = Date.now();
    await updateScan(scan);
    broadcast({ type: MSG.SCAN_ERROR, scanId, error: err.message });
  } finally {
    activeScan = null;
    checker = null;
    abortController = null;
  }

  return scanId;
}

async function recheckPage(scanId, pageId, tabId) {
  const details = await getScanWithDetails(scanId);
  if (!details) return;
  const page = details.pages.find((p) => p.id === pageId);
  if (!page) return;

  const settings = await getSettings();
  checker = makeChecker(settings);
  const pageLinks = details.linksByPage[pageId] || [];

  let html, extracted;
  try {
    const res = await fetch(page.url);
    html = await res.text();
    extracted = extractLinksFromHtml(html, page.url, settings);
  } catch {
    return;
  }

  const urls = extracted.links;
  const results = await checker.checkMany(extracted.links);

  for (const linkData of extracted.links) {
    const result = checker.lookupResult(linkData, results);
    const existing = pageLinks.find((l) => l.href === linkData.href);
    if (existing) {
      existing.statusCode = result?.statusCode || 0;
      existing.status = result?.status || 'error';
      existing.checkedAt = Date.now();
      await updateLink(existing);
    }
  }

  const updated = await getScanWithDetails(scanId);
  broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan: updated.scan, recheck: true });

  if (tabId) {
    const allLinks = updated.links.filter((l) => l.pageId === pageId);
    await highlightOnTab(tabId, allLinks);
  }
}

async function recheckLink(scanId, linkId) {
  const details = await getScanWithDetails(scanId);
  const link = details?.links.find((l) => l.id === linkId);
  if (!link) return;

  const settings = await getSettings();
  checker = makeChecker(settings);
  const result = await checker.checkUrl(link.href, null, {
    checkType: link.checkType || 'http',
    hash: link.hash,
    anchorExists: link.anchorExists
  });
  link.statusCode = result.statusCode;
  link.status = result.status;
  link.error = result.error;
  link.checkedAt = result.checkedAt;
  await updateLink(link);
  broadcast({ type: MSG.SCAN_PROGRESS, scanId, recheck: { linkId, result } });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case MSG.START_SCAN: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url?.startsWith('http')) {
          sendResponse({ error: 'Cannot scan this page. Navigate to a website first.' });
          return;
        }
        if (activeScan?.status === 'running') {
          sendResponse({ error: 'A scan is already running.', scanId: activeScan.id });
          return;
        }
        const scanId = uuid();
        const mode = msg.mode || 'page';
        const categoryOptions = msg.categoryOptions || {};

        activeScan = { id: scanId, mode, startUrl: tab.url, tabId: tab.id, status: 'running' };
        sendResponse({ scanId });

        runPageScan(tab, mode, categoryOptions, scanId).catch((err) => {
          broadcast({ type: MSG.SCAN_ERROR, scanId, error: err.message });
        });
        break;
      }
      case MSG.CANCEL_SCAN: {
        abortController?.abort();
        checker?.cancel();
        sendResponse({ ok: true });
        break;
      }
      case MSG.RECHECK_PAGE: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await recheckPage(msg.scanId, msg.pageId, tab?.id);
        sendResponse({ ok: true });
        break;
      }
      case MSG.RECHECK_LINK: {
        await recheckLink(msg.scanId, msg.linkId);
        sendResponse({ ok: true });
        break;
      }
      case MSG.RECHECK_RATE_LIMITED: {
        const settings = await getSettings();
        abortController = new AbortController();
        checker = makeChecker(settings);
        const resolved = await resolveRateLimitedForScan(msg.scanId, { ...settings, autoRetryRateLimited: true });
        const details = await getScanWithDetails(msg.scanId);
        if (details?.scan) {
          details.scan.stats = {
            pages: details.pages.length,
            links: details.links.length,
            broken: details.links.filter(isBroken).length
          };
          await updateScan(details.scan);
          broadcast({ type: MSG.SCAN_COMPLETE, scanId: msg.scanId, scan: details.scan, recheck: true });
        }
        sendResponse({ ok: true, resolved });
        abortController = null;
        checker = null;
        break;
      }
      case MSG.CLEAR_MARKERS: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.tabs.sendMessage(tab.id, { type: MSG.CLEAR_MARKERS });
        }
        sendResponse({ ok: true });
        break;
      }
      case MSG.SCROLL_TO_LINK: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          await chrome.tabs.sendMessage(tab.id, { type: MSG.SCROLL_TO_LINK, link: msg.link });
        }
        sendResponse({ ok: true });
        break;
      }
      case MSG.GET_ACTIVE_SCAN: {
        sendResponse({ activeScan });
        break;
      }
      case MSG.GET_SETTINGS: {
        sendResponse({ settings: await getSettings() });
        break;
      }
      case MSG.SAVE_SETTINGS: {
        await chrome.storage.local.set({ settings: msg.settings });
        sendResponse({ ok: true });
        break;
      }
      case MSG.GET_NAV_SECTIONS: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ sections: [] }); break; }
        const sections = await chrome.tabs.sendMessage(tab.id, { type: 'GET_NAV_SECTIONS' });
        sendResponse({ sections: sections || [] });
        break;
      }
      case MSG.OPEN_SIDEBAR: {
        const tabId = sender.tab?.id;
        if (tabId) {
          await chrome.sidePanel.open({ tabId });
        } else {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
        }
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ error: 'Unknown message' });
    }
  })();
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch { /* older Chrome */ }

  if (details.reason === 'install') {
    await chrome.storage.local.set({ blc_show_welcome: true });
    await chrome.tabs.create({
      url: chrome.runtime.getURL('options/options.html#welcome')
    });
  }
});
