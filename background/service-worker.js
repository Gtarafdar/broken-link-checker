import { MSG } from '../lib/messages.js';
import { LinkChecker, isBroken, extractLinksFromHtml } from '../lib/checker.js';
import { crawlDomain } from '../lib/crawler.js';
import {
  createScan, updateScan, addPage, addLinks, updateLink,
  getScanWithDetails, BatchedWriter
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
    broadcast({
      type: MSG.SCAN_PROGRESS,
      scanId,
      progress: {
        checked: progress.completed,
        total: progress.total,
        currentUrl: progress.url,
        pagesScanned: activeScan?.pagesScanned || 1
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

async function runPageScan(tab, mode, categoryOptions, existingScanId) {
  const settings = await getSettings();
  const scanId = existingScanId || uuid();
  const startUrl = tab.url;

  abortController = new AbortController();
  checker = new LinkChecker({
    concurrency: settings.concurrency,
    perHostDelay: settings.perHostDelay,
    timeout: settings.timeout
  });

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
    settings
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
      scan.stats = { pages: 1, links: linkRecords.length, broken: brokenCount };
      scan.status = 'completed';
      scan.completedAt = Date.now();
      await updateScan(scan);
      broadcast({ type: MSG.SCAN_COMPLETE, scanId, scan });
    } else {
      const crawledPages = [];
      await crawlDomain({
        startUrl,
        maxPages: settings.maxPages,
        settings,
        mode: mode === 'category' ? 'category' : 'domain',
        categoryOptions: { origin: new URL(startUrl).origin, ...categoryOptions },
        signal: abortController.signal
      }, {
        onPage: (page) => {
          crawledPages.push(page);
          activeScan.pagesScanned = crawledPages.length;
          broadcast({
            type: MSG.SCAN_PROGRESS,
            scanId,
            progress: { checked: 0, total: 0, pagesScanned: crawledPages.length, crawling: true }
          });
        },
        onPageError: () => {}
      });

      let totalLinks = 0;
      let totalBroken = 0;

      for (let i = 0; i < crawledPages.length; i++) {
        if (abortController.signal.aborted) break;
        const page = crawledPages[i];
        page.order = i;
        const { linkRecords, brokenCount } = await processPage(scanId, page, settings, null);
        totalLinks += linkRecords.length;
        totalBroken += brokenCount;
        broadcast({
          type: MSG.SCAN_PROGRESS,
          scanId,
          progress: {
            checked: totalLinks,
            total: totalLinks,
            pagesScanned: i + 1,
            totalPages: crawledPages.length,
            broken: totalBroken
          }
        });
      }

      scan.stats = { pages: crawledPages.length, links: totalLinks, broken: totalBroken };
      scan.status = abortController.signal.aborted ? 'cancelled' : 'completed';
      scan.completedAt = Date.now();
      await updateScan(scan);

      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && activeTab.url) {
          const details = await getScanWithDetails(scanId);
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
  checker = new LinkChecker({
    concurrency: settings.concurrency,
    perHostDelay: settings.perHostDelay,
    timeout: settings.timeout
  });
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
  checker = new LinkChecker({
    concurrency: settings.concurrency,
    perHostDelay: settings.perHostDelay,
    timeout: settings.timeout
  });
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
