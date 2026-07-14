import { MSG } from '../lib/messages.js';
import { getScanWithDetails } from '../lib/storage.js';
import { toCsv, toTsv, downloadCsv, openGoogleSheets, showSheetsPasteModal } from '../lib/export.js';
import { escapeHtml, truncate } from '../lib/utils.js';
import { copyWithFeedback, buildTableTsv, loadCopyPrefs } from '../lib/copy.js';

let currentScanId = null;
let scanData = null;
let navSections = [];
let showBrokenOnly = true;
let lastConfettiScanId = null;

const $ = (sel) => document.querySelector(sel);

function computeScanStats(data) {
  if (!data?.links) {
    return { total: 0, broken: 0, healthy: 0, rateLimited: 0, pages: 0, healthPct: 100 };
  }

  const links = data.links.filter((l) => !isSkippedLink(l));
  const broken = links.filter(isBrokenLink).length;
  const rateLimited = links.filter((l) => l.status === 'rate_limited').length;
  const healthy = links.length - broken - rateLimited;
  const pages = data.pages?.length || data.scan?.stats?.pages || 0;
  const healthPct = links.length ? Math.round((healthy / links.length) * 100) : 100;

  return {
    total: links.length,
    broken,
    healthy,
    rateLimited,
    pages,
    healthPct,
    domain: data.scan?.domain || '—',
    mode: data.scan?.mode || 'page',
    status: data.scan?.status || 'completed'
  };
}

function fireConfetti() {
  const canvas = $('#confettiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth || 360;
  canvas.height = canvas.offsetHeight || 600;

  const colors = ['#10b981', '#34d399', '#6ee7b7', '#fbbf24', '#60a5fa', '#a78bfa', '#f472b6'];
  const pieces = Array.from({ length: 80 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height - canvas.height,
    w: 6 + Math.random() * 6,
    h: 4 + Math.random() * 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    vx: (Math.random() - 0.5) * 2,
    vy: 2 + Math.random() * 3,
    rot: Math.random() * 360,
    vr: (Math.random() - 0.5) * 8
  }));

  let frame = 0;
  const maxFrames = 120;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > canvas.height) {
        p.y = -10;
        p.x = Math.random() * canvas.width;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rot * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frame++;
    if (frame < maxFrames) {
      requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  draw();
}

function renderReportCard(stats) {
  const card = $('#reportCard');
  if (!stats || stats.total === 0) {
    card.classList.add('hidden');
    card.innerHTML = '';
    return;
  }

  card.classList.remove('hidden');
  const modeLabel = { page: 'Current Page', domain: 'Entire Domain', category: 'Category' }[stats.mode] || stats.mode;

  if (stats.broken === 0) {
    card.className = 'report-card report-card--success';
    card.innerHTML = `
      <div class="report-hero-icon">🎉</div>
      <div class="report-title">All Clear — No Broken Links!</div>
      <div class="report-subtitle">Every link checked on this scan returned a healthy response. Your page looks solid.</div>
      <div class="report-stats">
        <div class="report-stat">
          <div class="report-stat-value">${stats.total}</div>
          <div class="report-stat-label">Links Checked</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-value">${stats.pages}</div>
          <div class="report-stat-label">Pages Scanned</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-value">100%</div>
          <div class="report-stat-label">Healthy</div>
        </div>
      </div>
      <div class="report-meta">
        <span class="report-meta-chip">${escapeHtml(stats.domain)}</span>
        <span class="report-meta-chip">${escapeHtml(modeLabel)}</span>
      </div>
      ${stats.rateLimited > 0 ? `
      <div class="report-unverified report-unverified--on-success">
        <span>${stats.rateLimited} still unverified (server busy). Not counted as broken.</span>
        <button type="button" class="btn btn-sm btn-secondary" id="recheckRateLimited">Recheck unverified</button>
      </div>` : ''}
    `;

    if (currentScanId && lastConfettiScanId !== currentScanId) {
      lastConfettiScanId = currentScanId;
      setTimeout(fireConfetti, 200);
    }
    bindRecheckUnverified();
    return;
  }

  card.className = 'report-card report-card--issues';
  card.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div>
        <div class="report-title" style="font-size:14px;color:var(--text)">Issues Found</div>
        <div class="report-subtitle" style="margin:0;color:var(--text-muted)">${stats.broken} broken link${stats.broken !== 1 ? 's' : ''} need attention</div>
      </div>
      <span class="badge badge-broken" style="font-size:13px;padding:4px 10px">${stats.broken}</span>
    </div>
    <div class="report-stats">
      <div class="report-stat">
        <div class="report-stat-value">${stats.total}</div>
        <div class="report-stat-label">Total Checked</div>
      </div>
      <div class="report-stat report-stat--broken">
        <div class="report-stat-value">${stats.broken}</div>
        <div class="report-stat-label">Broken</div>
      </div>
      <div class="report-stat">
        <div class="report-stat-value">${stats.healthy}</div>
        <div class="report-stat-label">Healthy</div>
      </div>
    </div>
    <div class="report-health-bar">
      <div class="report-health-fill ${stats.healthPct >= 80 ? 'report-health-fill--good' : 'report-health-fill--warn'}" style="width:${stats.healthPct}%"></div>
    </div>
    <div class="report-health-label">
      <span>${stats.healthPct}% healthy</span>
      <span>${stats.pages} page${stats.pages !== 1 ? 's' : ''}</span>
    </div>
    ${stats.rateLimited > 0 ? `
    <div class="report-unverified">
      <span>${stats.rateLimited} still unverified (server busy). Not counted as broken.</span>
      <button type="button" class="btn btn-sm btn-secondary" id="recheckRateLimited">Recheck unverified</button>
    </div>` : ''}
    <div class="report-meta">
      <span class="report-meta-chip">${escapeHtml(stats.domain)}</span>
      <span class="report-meta-chip">${escapeHtml(modeLabel)}</span>
    </div>
    <div class="report-actions">
      <button class="btn btn-sm btn-primary" id="jumpFirstBroken">Jump to First Issue</button>
      <button class="btn btn-sm btn-secondary" id="expandAllBroken">Expand All</button>
      <button class="btn btn-sm btn-secondary" id="cardExportCsv">Export CSV</button>
    </div>
  `;

  card.querySelector('#jumpFirstBroken')?.addEventListener('click', () => {
    for (const page of scanData.pages) {
      const broken = (scanData.linksByPage[page.id] || []).find(isBrokenLink);
      if (broken) {
        chrome.runtime.sendMessage({ type: MSG.SCROLL_TO_LINK, link: broken });
        showToast('Scrolled to first broken link');
        return;
      }
    }
  });

  card.querySelector('#expandAllBroken')?.addEventListener('click', () => {
    document.querySelectorAll('.page-group').forEach((g) => {
      const badge = g.querySelector('.badge-broken');
      if (badge) {
        g.querySelector('.page-group-body')?.classList.add('open');
        g.querySelector('.chevron')?.classList.add('open');
      }
    });
    showToast('Expanded pages with issues');
  });

  card.querySelector('#cardExportCsv')?.addEventListener('click', () => {
    $('#exportCsv')?.click();
  });

  bindRecheckUnverified();
}

function bindRecheckUnverified() {
  const btn = $('#recheckRateLimited');
  if (!btn || !currentScanId) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    showToast('Rechecking unverified links slowly…');
    setScanning(true);
    try {
      await chrome.runtime.sendMessage({
        type: MSG.RECHECK_RATE_LIMITED,
        scanId: currentScanId
      });
    } catch (err) {
      showToast(err.message || 'Recheck failed');
      setScanning(false);
    }
  });
}

function showToast(msg, duration = 4000) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

function setStatus(text, type = 'ok') {
  const badge = $('#statusBadge');
  badge.textContent = text;
  badge.className = `badge badge-${type}`;
}

/** Keep sidebar mode select in sync with the scan that is actually running (e.g. started from popup). */
function syncScanMode(mode) {
  if (!mode || !['page', 'domain', 'category'].includes(mode)) return;
  const select = $('#scanMode');
  if (!select) return;

  if (select.value !== mode) {
    select.value = mode;
  }

  const isCategory = mode === 'category';
  $('#categoryOptions')?.classList.toggle('hidden', !isCategory);
  $('#domainModeTip')?.classList.toggle('hidden', mode === 'page');
  if (isCategory && !$('#navSection')?.options?.length) {
    loadNavSections().catch(() => {});
  }
}

function setScanning(scanning) {
  $('#startScan').disabled = scanning;
  $('#cancelScan').classList.toggle('hidden', !scanning);
  $('#progressSection').classList.toggle('hidden', !scanning);
  const modeSelect = $('#scanMode');
  if (modeSelect) modeSelect.disabled = scanning;
  $('#categoryType') && ($('#categoryType').disabled = scanning);
  $('#categoryPrefix') && ($('#categoryPrefix').disabled = scanning);
  $('#navSection') && ($('#navSection').disabled = scanning);
  if (scanning) setStatus('Scanning', 'running');
}

function updateProgress(progress) {
  const {
    checked = 0,
    total = 0,
    pagesScanned = 0,
    totalPages = 0,
    maxPages = 0,
    broken,
    crawling,
    phase,
    batchSkip = 0,
    batchPick = 'bfs'
  } = progress || {};

  const isCrawling = crawling || phase === 'crawling';
  const pageCap = maxPages || totalPages || 0;
  let text = 'Scanning…';
  let pct = 0;
  let detail = '';

  if (isCrawling) {
    text = pageCap
      ? `Discovering pages: ${pagesScanned} / ${pageCap}`
      : `Discovering pages: ${pagesScanned}`;
    if (batchSkip > 0) {
      text += ` · skip ${batchSkip} known`;
    }
    if (batchPick === 'random') {
      text += ' · random';
    }
    pct = pageCap ? Math.max(4, (pagesScanned / pageCap) * 45) : Math.min(40, 4 + pagesScanned * 2);
    detail = batchSkip > 0
      ? `Skipping ${batchSkip} pages already in History for this domain. This batch only adds new pages.`
      : 'Whole-domain crawl finds pages first, then checks every unique link. You can Cancel anytime.';
  } else if (phase === 'resolving') {
    text = total > 0
      ? `Clearing rate limits: ${checked} / ${total}`
      : 'Clearing rate limits…';
    pct = total > 0 ? Math.max(5, (checked / total) * 100) : 60;
    detail = 'Slow retry pass so busy-server responses become OK or truly broken.';
  } else if (totalPages > 1 && pagesScanned) {
    text = `Checking page ${pagesScanned} / ${totalPages}`;
    if (total > 0) text += ` · ~${checked}/${total} unique URLs`;
    pct = 45 + (pagesScanned / totalPages) * 55;
    detail = 'Cached duplicates skip network. Large sites take longer — lower Max pages in Settings if needed.';
  } else if (total > 0) {
    text = `Checking links: ${checked} / ${total}`;
    pct = Math.max(5, (checked / total) * 100);
    detail = 'Verifying HTTP status for each unique URL.';
  } else if (pagesScanned) {
    text = `Pages scanned: ${pagesScanned}`;
    pct = 30;
  }

  $('#progressText').textContent = text;
  $('#progressFill').style.width = `${Math.min(pct, 100)}%`;

  const empty = $('#emptyState');
  if (empty && !empty.classList.contains('hidden')) {
    empty.innerHTML = `
      <div class="spinner" style="margin:20px auto"></div>
      <p><strong>${escapeHtml(text)}</strong></p>
      <p class="progress-hint">${escapeHtml(detail || 'Working…')}</p>
    `;
  }

  const brokenBadge = $('#brokenCount');
  if (broken > 0) {
    brokenBadge.textContent = `${broken} broken`;
    brokenBadge.classList.remove('hidden');
  }
}

function getCategoryOptions() {
  const mode = $('#scanMode').value;
  if (mode !== 'category') return {};

  const categoryType = $('#categoryType').value;
  const opts = { categoryType };

  if (categoryType === 'prefix') {
    opts.categoryPrefix = $('#categoryPrefix').value || '/';
  } else if (categoryType === 'nav') {
    const idx = parseInt($('#navSection').value, 10);
    if (!isNaN(idx) && navSections[idx]) {
      opts.sectionUrls = navSections[idx].urls;
    }
  }

  return opts;
}

async function loadNavSections() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_NAV_SECTIONS });
    navSections = res?.sections || [];
    const select = $('#navSection');
    select.innerHTML = '';
    if (!navSections.length) {
      select.innerHTML = '<option value="">No sections found</option>';
      return;
    }
    navSections.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${s.label} (${s.urls.length} links)`;
      select.appendChild(opt);
    });
  } catch {
    $('#navSection').innerHTML = '<option value="">Error loading sections</option>';
  }
}

function isBrokenLink(link) {
  return ['broken', 'error', 'timeout'].includes(link.status);
}

function isSkippedLink(link) {
  return link.status === 'skipped';
}

function renderResults() {
  const list = $('#resultsList');
  const empty = $('#emptyState');
  list.innerHTML = '';

  if (!scanData?.pages?.length) {
    list.classList.add('hidden');
    $('#reportCard').classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = `
      <div class="empty-state-icon">🔗</div>
      <p>No pages were scanned.</p>
      <p>Try <strong>Current Page</strong>, or check Max pages / that the site is reachable.</p>
    `;
    $('#exportCsv').disabled = true;
    $('#exportSheets').disabled = true;
    $('#recheckPage').classList.add('hidden');
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');
  $('#exportCsv').disabled = false;
  $('#exportSheets').disabled = false;
  $('#recheckPage').classList.remove('hidden');

  const stats = computeScanStats(scanData);
  renderReportCard(stats);

  const toggle = document.createElement('div');
  toggle.className = 'broken-only-toggle';
  toggle.innerHTML = `<label><input type="checkbox" id="brokenOnlyCheck" ${showBrokenOnly ? 'checked' : ''}> Show broken links only</label>`;
  list.appendChild(toggle);
  toggle.querySelector('#brokenOnlyCheck').addEventListener('change', (e) => {
    showBrokenOnly = e.target.checked;
    renderResults();
  });

  let hasVisibleGroups = false;

  for (const page of scanData.pages) {
    let links = scanData.linksByPage[page.id] || [];
    if (showBrokenOnly) links = links.filter(isBrokenLink);
    if (!links.length && showBrokenOnly) continue;

    hasVisibleGroups = true;

    const group = document.createElement('div');
    group.className = 'page-group';

    const brokenOnPage = (scanData.linksByPage[page.id] || []).filter(isBrokenLink).length;

    group.innerHTML = `
      <div class="page-group-header" data-page-id="${page.id}">
        <span class="chevron">▶</span>
        <span class="page-group-title">${escapeHtml(truncate(page.title, 40))}</span>
        ${brokenOnPage ? `<span class="badge badge-broken">${brokenOnPage}</span>` : '<span class="badge badge-ok">OK</span>'}
      </div>
      <div class="page-group-url copy-cell">
        <span class="copy-cell-text" title="${escapeHtml(page.url)}">${escapeHtml(truncate(page.url, 50))}</span>
        <button type="button" class="copy-btn copy-page-url-btn" data-copy="${escapeHtml(page.url)}" title="Copy page URL">❐</button>
      </div>
      <div class="page-group-body open">
        <div class="page-group-actions" style="padding:6px 12px;gap:6px;display:flex;flex-wrap:wrap">
          <button class="btn btn-sm btn-secondary recheck-page-btn" data-page-id="${page.id}">Recheck Page</button>
          <button class="btn btn-sm btn-secondary copy-page-table-btn" data-page-id="${page.id}" title="Copy table with date, status, and URLs for Excel or Sheets">Copy table</button>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Text</th><th>URL</th><th>Status</th><th></th></tr></thead>
            <tbody>${links.map((link) => `
              <tr class="link-row">
                <td>
                  <div class="copy-cell">
                    <span class="copy-cell-text link-text" title="${escapeHtml(link.text)}">${escapeHtml(truncate(link.text, 22))}</span>
                    <button type="button" class="copy-btn copy-text-btn" data-copy="${escapeHtml(link.text || '')}" title="Copy text">❐</button>
                  </div>
                </td>
                <td>
                  <div class="copy-cell">
                    <span class="copy-cell-text link-href" title="${escapeHtml(link.href)}">${escapeHtml(truncate(link.href, 28))}</span>
                    <button type="button" class="copy-btn copy-url-btn" data-copy="${escapeHtml(link.href)}" title="Copy URL">❐</button>
                  </div>
                </td>
                <td><span class="badge badge-${isBrokenLink(link) ? 'broken' : link.status === 'rate_limited' ? 'warning' : 'ok'}">${link.statusCode || link.status}</span></td>
                <td class="row-actions">
                  <button class="btn btn-sm btn-icon btn-secondary copy-row-btn" data-link-id="${link.id}" title="Copy row for Excel / Sheets">≡</button>
                  <button class="btn btn-sm btn-icon btn-secondary scroll-btn" data-link-id="${link.id}" title="Scroll to link">↗</button>
                  <button class="btn btn-sm btn-icon btn-secondary recheck-link-btn" data-link-id="${link.id}" title="Recheck">↻</button>
                </td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
      </div>
    `;

    const header = group.querySelector('.page-group-header');
    const body = group.querySelector('.page-group-body');
    const chevron = group.querySelector('.chevron');
    header.addEventListener('click', () => {
      body.classList.toggle('open');
      chevron.classList.toggle('open');
    });
    chevron.classList.add('open');

    group.querySelector('.recheck-page-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: MSG.RECHECK_PAGE,
        scanId: currentScanId,
        pageId: page.id
      });
      showToast('Rechecking page…');
    });

    group.querySelector('.copy-page-url-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      copyWithFeedback(e.currentTarget.dataset.copy, e.currentTarget, showToast);
    });

    group.querySelector('.copy-page-table-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const prefs = await loadCopyPrefs();

      let tableLinks = links.slice();
      if (!tableLinks.length) {
        tableLinks = (scanData.linksByPage[page.id] || []).slice();
        if (showBrokenOnly) tableLinks = tableLinks.filter(isBrokenLink);
      }
      if (!tableLinks.length) {
        group.querySelectorAll('tbody tr').forEach((tr) => {
          const copyBtns = tr.querySelectorAll('.copy-btn[data-copy]');
          const text = copyBtns[0]?.dataset.copy || '';
          const href = copyBtns[1]?.dataset.copy || '';
          const statusLabel = tr.querySelector('.badge')?.textContent?.trim() || '';
          if (text || href) {
            tableLinks.push({ text, href, statusCode: statusLabel, status: statusLabel });
          }
        });
      }

      const payload = buildTableTsv(scanData.scan, page, tableLinks, prefs);
      await copyWithFeedback(
        payload,
        btn,
        (m) => showToast(
          m === 'Copied'
            ? `Table copied (${tableLinks.length} row${tableLinks.length === 1 ? '' : 's'}) — paste into Excel or Sheets`
            : m
        )
      );
    });

    group.querySelectorAll('.copy-text-btn, .copy-url-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyWithFeedback(btn.dataset.copy, btn, showToast);
      });
    });

    group.querySelectorAll('.copy-row-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const link = (scanData.linksByPage[page.id] || []).find((l) => l.id === btn.dataset.linkId)
          || links.find((l) => l.id === btn.dataset.linkId);
        if (!link) return;
        const prefs = await loadCopyPrefs();
        const tsv = buildTableTsv(scanData.scan, page, [link], prefs);
        await copyWithFeedback(tsv, btn, (m) => showToast(m === 'Copied' ? 'Row copied — paste into Excel or Sheets' : m));
      });
    });

    group.querySelectorAll('.scroll-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const link = (scanData.linksByPage[page.id] || []).find((l) => l.id === btn.dataset.linkId);
        if (link) chrome.runtime.sendMessage({ type: MSG.SCROLL_TO_LINK, link });
      });
    });

    group.querySelectorAll('.recheck-link-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({
          type: MSG.RECHECK_LINK,
          scanId: currentScanId,
          linkId: btn.dataset.linkId
        });
        showToast('Link rechecked');
        await loadScan(currentScanId);
      });
    });

    list.appendChild(group);
  }

  if (!hasVisibleGroups && stats.broken === 0) {
    const banner = document.createElement('div');
    banner.className = 'all-clear-banner';
    banner.innerHTML = `<strong>✓ ${stats.total} links verified</strong>Uncheck "Show broken links only" to browse all checked links.`;
    list.appendChild(banner);
  }
}

async function loadScan(scanId) {
  if (!scanId) return;
  scanData = await getScanWithDetails(scanId);
  currentScanId = scanId;
  if (scanData?.scan?.mode) syncScanMode(scanData.scan.mode);
  renderResults();

  const broken = scanData?.links?.filter(isBrokenLink).length || 0;
  if (scanData?.scan?.status === 'completed') {
    setStatus(broken ? `${broken} broken` : 'All OK', broken ? 'broken' : 'ok');
  }
}

async function startScan() {
  const mode = $('#scanMode').value;
  setScanning(true);
  setStatus('Scanning', 'running');
  $('#brokenCount').classList.add('hidden');
  $('#resultsList').classList.add('hidden');
  $('#reportCard').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  const startMsg = mode === 'domain' || mode === 'category'
    ? 'Starting domain crawl… This can take a few minutes.'
    : 'Scanning links…';
  $('#emptyState').innerHTML = `<div class="spinner" style="margin:20px auto"></div><p>${startMsg}</p>`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: MSG.START_SCAN,
      mode,
      categoryOptions: getCategoryOptions()
    });
    if (res?.error) {
      showToast(res.error);
      if (res.scanId) {
        currentScanId = res.scanId;
      } else {
        setScanning(false);
        setStatus('Error', 'broken');
      }
      return;
    }
    currentScanId = res.scanId;
  } catch (err) {
    showToast(err.message);
    setScanning(false);
  }
}

$('#scanMode').addEventListener('change', () => {
  const mode = $('#scanMode').value;
  const isCategory = mode === 'category';
  $('#categoryOptions').classList.toggle('hidden', !isCategory);
  if (isCategory) loadNavSections();
  const tip = $('#domainModeTip');
  if (tip) tip.classList.toggle('hidden', mode === 'page');
});

$('#categoryType').addEventListener('change', () => {
  const type = $('#categoryType').value;
  $('#prefixInput').classList.toggle('hidden', type !== 'prefix');
  $('#navSelect').classList.toggle('hidden', type !== 'nav');
  if (type === 'nav') loadNavSections();
});

$('#startScan').addEventListener('click', startScan);
$('#cancelScan').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.CANCEL_SCAN });
  setScanning(false);
  setStatus('Cancelled', 'warning');
});

$('#recheckPage').addEventListener('click', async () => {
  if (!scanData?.pages?.length || !currentScanId) return;
  const page = scanData.pages[0];
  await chrome.runtime.sendMessage({ type: MSG.RECHECK_PAGE, scanId: currentScanId, pageId: page.id });
  showToast('Rechecking page…');
  setTimeout(() => loadScan(currentScanId), 2000);
});

$('#clearMarkers').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: MSG.CLEAR_MARKERS });
  showToast('Markers cleared');
});

$('#openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('#exportCsv').addEventListener('click', () => {
  if (!scanData) return;
  const csv = toCsv(scanData.pages, scanData.linksByPage, true);
  const filename = `broken-links-${scanData.scan.domain}-${new Date().toISOString().slice(0, 10)}.csv`;
  downloadCsv(csv, filename);
  showToast('CSV downloaded');
});

$('#exportSheets').addEventListener('click', async () => {
  if (!scanData) return;
  const tsv = toTsv(scanData.pages, scanData.linksByPage, true);
  try {
    await navigator.clipboard.writeText(tsv);
    openGoogleSheets();
    showToast(showSheetsPasteModal(), 6000);
  } catch {
    const csv = toCsv(scanData.pages, scanData.linksByPage, true);
    downloadCsv(csv, 'broken-links.csv');
    showToast('Clipboard failed — CSV downloaded instead. Import via File → Import in Sheets.');
  }
});

$('#refreshNav').addEventListener('click', loadNavSections);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.SCAN_PROGRESS) {
    if (msg.scanId) currentScanId = msg.scanId;
    if (msg.mode) syncScanMode(msg.mode);
    setScanning(true);
    updateProgress(msg.progress || {});
  }
  if (msg.type === MSG.SCAN_COMPLETE) {
    setScanning(false);
    if (msg.scan?.mode) syncScanMode(msg.scan.mode);
    loadScan(msg.scanId);
    const broken = msg.scan?.stats?.broken || 0;
    const pages = msg.scan?.stats?.pages || 0;
    if (!pages) {
      setStatus('No pages', 'warning');
    } else {
      setStatus(broken ? `${broken} broken` : 'All OK', broken ? 'broken' : 'ok');
    }
  }
  if (msg.type === MSG.SCAN_ERROR) {
    setScanning(false);
    if (msg.mode) syncScanMode(msg.mode);
    setStatus('Error', 'broken');
    showToast(msg.error || 'Scan failed');
    $('#emptyState').classList.remove('hidden');
    $('#resultsList').classList.add('hidden');
    $('#reportCard').classList.add('hidden');
    $('#emptyState').innerHTML = `
      <div class="empty-state-icon">⚠️</div>
      <p><strong>Scan failed</strong></p>
      <p class="progress-hint">${escapeHtml(msg.error || 'Try Current Page, or lower Max pages in Settings.')}</p>
    `;
  }
});

async function adoptActiveScan() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.GET_ACTIVE_SCAN });
    const active = res?.activeScan;
    if (!active || active.status !== 'running') return false;
    currentScanId = active.id;
    syncScanMode(active.mode);
    setScanning(true);
    setStatus('Scanning', 'running');
    $('#progressSection').classList.remove('hidden');
    $('#resultsList').classList.add('hidden');
    $('#reportCard').classList.add('hidden');
    $('#emptyState').classList.remove('hidden');
    const modeLabel = { page: 'current page', domain: 'entire domain', category: 'category' }[active.mode] || 'scan';
    $('#emptyState').innerHTML = `<div class="spinner" style="margin:20px auto"></div><p>Running ${modeLabel}…</p>`;
    return true;
  } catch {
    return false;
  }
}

(async () => {
  await adoptActiveScan();
  // Popup opens the sidebar first, then starts the scan — retry briefly so mode catches up
  setTimeout(() => adoptActiveScan(), 250);
  setTimeout(() => adoptActiveScan(), 700);
})();
