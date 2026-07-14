import { MSG } from '../lib/messages.js';
import {
  searchScans, deleteScan, deleteAllData, getScanWithDetails, getAllScans
} from '../lib/storage.js';
import { toCsv, downloadCsv, openGoogleSheets, generateFilename } from '../lib/export.js';
import { debounce, formatDate, escapeHtml, truncate, DEFAULT_SETTINGS } from '../lib/utils.js';
import {
  copyWithFeedback,
  buildTableTsv,
  COPY_COLUMNS,
  normalizeCopyPrefs,
  buildCopyPreviewRows,
  DEFAULT_COPY_PREFS
} from '../lib/copy.js';

let currentPage = 1;
let pageSize = 20;
let searchQuery = '';
let expandedScanId = null;
let copyPrefs = normalizeCopyPrefs(DEFAULT_COPY_PREFS);
let activeTab = 'welcome';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function showToast(msg, duration = 4000) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

function isBroken(link) {
  return ['broken', 'error', 'timeout'].includes(link.status);
}

function switchTab(tabId) {
  activeTab = tabId;
  $$('.opts-nav-item').forEach((btn) => {
    const on = btn.dataset.tab === tabId;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('.opts-panel').forEach((panel) => {
    const on = panel.id === `tab-${tabId}`;
    panel.classList.toggle('is-active', on);
    panel.hidden = !on;
  });
  if (tabId === 'history') {
    renderHistoryStats();
    renderHistory();
  }
  if (tabId === 'settings') {
    renderCopyPreview();
  }
  try {
    localStorage.setItem('blc_options_tab', tabId);
  } catch { /* ignore */ }
}

/* ---------- Settings ---------- */

function renderCopyColumnChecks() {
  const wrap = $('#copyColumnChecks');
  wrap.innerHTML = COPY_COLUMNS.map((col) => `
    <label>
      <input type="checkbox" class="copy-col-check" data-col="${col.id}" ${copyPrefs.columns[col.id] ? 'checked' : ''}>
      ${escapeHtml(col.label)}
    </label>
  `).join('');

  wrap.querySelectorAll('.copy-col-check').forEach((input) => {
    input.addEventListener('change', () => {
      copyPrefs.columns[input.dataset.col] = input.checked;
      copyPrefs = normalizeCopyPrefs(copyPrefs);
      // Re-sync UI if normalize forced a column back on
      wrap.querySelectorAll('.copy-col-check').forEach((el) => {
        el.checked = !!copyPrefs.columns[el.dataset.col];
      });
      renderCopyPreview();
    });
  });
}

function renderCopyPreview() {
  const preview = buildCopyPreviewRows(copyPrefs, 2);
  const table = $('#copyPreviewTable');
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  const meta = $('#copyPreviewMeta');

  const colCount = preview.headers.length;
  meta.textContent = `${colCount} column${colCount === 1 ? '' : 's'}${preview.includeHeader ? ' · header on' : ' · header off'}`;

  thead.innerHTML = preview.includeHeader
    ? `<tr>${preview.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`
    : '';

  tbody.innerHTML = preview.rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('')}</tr>`
  ).join('') || `<tr><td colspan="${Math.max(colCount, 1)}" class="empty-state">Select at least one column</td></tr>`;
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS });
  const s = { ...DEFAULT_SETTINGS, ...res?.settings };
  copyPrefs = normalizeCopyPrefs(s.copyPrefs || DEFAULT_SETTINGS.copyPrefs);

  $('#maxPages').value = s.maxPages;
  $('#concurrency').value = s.concurrency;
  $('#maxLinks').value = s.maxLinksPerPage;
  $('#perHostDelay').value = s.perHostDelay ?? 500;
  $('#autoRetryRateLimited').checked = s.autoRetryRateLimited !== false;
  $('#skipScannedPages').checked = s.skipScannedPages !== false;
  $('#batchPick').value = s.batchPick === 'random' ? 'random' : 'bfs';
  $('#checkAnchors').checked = s.linkTypes?.anchors !== false;
  $('#checkImages').checked = s.linkTypes?.images !== false;
  $('#checkScripts').checked = !!s.linkTypes?.scripts;
  $('#checkIframes').checked = !!s.linkTypes?.iframes;
  $('#copyIncludeHeader').checked = copyPrefs.includeHeader !== false;

  renderCopyColumnChecks();
  renderCopyPreview();
}

async function saveSettings() {
  copyPrefs = normalizeCopyPrefs({
    includeHeader: $('#copyIncludeHeader').checked,
    columns: Object.fromEntries(
      COPY_COLUMNS.map((c) => {
        const el = document.querySelector(`.copy-col-check[data-col="${c.id}"]`);
        return [c.id, el ? el.checked : true];
      })
    )
  });

  const existing = (await chrome.storage.local.get('settings')).settings || {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...existing,
    maxPages: parseInt($('#maxPages').value, 10) || 50,
    concurrency: parseInt($('#concurrency').value, 10) || 3,
    maxLinksPerPage: parseInt($('#maxLinks').value, 10) || 500,
    perHostDelay: parseInt($('#perHostDelay').value, 10) || 500,
    autoRetryRateLimited: $('#autoRetryRateLimited').checked,
    skipScannedPages: $('#skipScannedPages').checked,
    batchPick: $('#batchPick').value === 'random' ? 'random' : 'bfs',
    linkTypes: {
      anchors: $('#checkAnchors').checked,
      images: $('#checkImages').checked,
      scripts: $('#checkScripts').checked,
      iframes: $('#checkIframes').checked
    },
    copyPrefs
  };
  await chrome.runtime.sendMessage({ type: MSG.SAVE_SETTINGS, settings });
  showToast('Settings saved');
  renderCopyPreview();
}

/* ---------- History ---------- */

async function renderHistoryStats() {
  const scans = await getAllScans();
  let pages = 0;
  let broken = 0;
  const domains = new Set();
  for (const s of scans) {
    pages += s.stats?.pages || 0;
    broken += s.stats?.broken || 0;
    if (s.domain) domains.add(s.domain);
  }
  $('#statScans').textContent = String(scans.length);
  $('#statPages').textContent = String(pages);
  $('#statBroken').textContent = String(broken);
  $('#statDomains').textContent = String(domains.size);
}

function getPageLinksForExport(details, pageId, container) {
  let pageLinks = details.links.filter(
    (l) => String(l.pageId) === String(pageId) && isBroken(l)
  );
  if (!pageLinks.length) {
    pageLinks = details.links.filter((l) => String(l.pageId) === String(pageId));
  }
  if (!pageLinks.length && container) {
    const group = container.closest('.detail-page-group') || container;
    const rows = [];
    group.querySelectorAll?.('tbody tr').forEach((tr) => {
      const copyBtns = tr.querySelectorAll('.copy-btn[data-copy]');
      const text = copyBtns[0]?.dataset.copy || '';
      const href = copyBtns[1]?.dataset.copy || '';
      const statusLabel = tr.querySelector('.badge')?.textContent?.trim() || '';
      if (text || href) {
        rows.push({
          text,
          href,
          statusCode: statusLabel,
          status: statusLabel,
          error: '',
          checkedAt: null
        });
      }
    });
    pageLinks = rows;
  }
  return pageLinks;
}

function wireDetailCopyHandlers(container, details) {
  container.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyWithFeedback(btn.dataset.copy, btn, showToast);
    });
  });

  container.querySelectorAll('.copy-detail-row-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pageId = btn.dataset.pageId;
      const linkId = btn.dataset.linkId;
      const page = details.pages.find((p) => String(p.id) === String(pageId));
      const link = details.links.find((l) => String(l.id) === String(linkId));
      if (!page || !link) return;
      const tsv = buildTableTsv(details.scan, page, [link], copyPrefs);
      await copyWithFeedback(tsv, btn, (m) => showToast(m === 'Copied' ? 'Row copied — paste into Excel or Sheets' : m));
    });
  });

  container.querySelectorAll('.copy-detail-table-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pageId = btn.dataset.pageId;
      const page = details.pages.find((p) => String(p.id) === String(pageId));
      if (!page) {
        showToast('Could not find page for this table');
        return;
      }
      const pageLinks = getPageLinksForExport(details, pageId, btn);
      const payload = buildTableTsv(details.scan, page, pageLinks, copyPrefs);
      await copyWithFeedback(
        payload,
        btn,
        (m) => showToast(
          m === 'Copied'
            ? `Table copied (${pageLinks.length} row${pageLinks.length === 1 ? '' : 's'})`
            : m
        )
      );
    });
  });

  container.querySelectorAll('.sheets-detail-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pageId = btn.dataset.pageId;
      const page = details.pages.find((p) => String(p.id) === String(pageId));
      if (!page) {
        showToast('Could not find page for this table');
        return;
      }
      const pageLinks = getPageLinksForExport(details, pageId, btn);
      if (!pageLinks.length) {
        showToast('Nothing to export for this page');
        return;
      }
      const payload = buildTableTsv(details.scan, page, pageLinks, copyPrefs);
      try {
        await navigator.clipboard.writeText(payload);
        openGoogleSheets();
        showToast('Table copied. A new Sheet opened — press Ctrl/Cmd+V to paste.', 6500);
      } catch {
        showToast('Clipboard blocked — use Copy table, then paste into Sheets manually');
      }
    });
  });
}

function renderDetailRow(_scanId, details) {
  const brokenLinks = details.links.filter(isBroken);
  if (!brokenLinks.length) {
    return '<p style="padding:12px;color:var(--text-muted)">No broken links found.</p>';
  }

  let html = '<div class="detail-content">';

  for (const page of details.pages) {
    const pageLinks = brokenLinks.filter((l) => l.pageId === page.id);
    if (!pageLinks.length) continue;
    html += `
      <div class="detail-page-group">
        <div class="detail-page-head">
          <div>
            <h4>${escapeHtml(page.title || page.url)}</h4>
            <div class="page-url copy-cell">
              <span class="copy-cell-text">${escapeHtml(page.url)}</span>
              <button type="button" class="copy-btn" data-copy="${escapeHtml(page.url)}" title="Copy page URL">❐</button>
            </div>
          </div>
          <div class="detail-export">
            <div class="detail-export-actions">
              <button type="button" class="btn btn-sm btn-secondary copy-detail-table-btn" data-page-id="${page.id}" title="Copy this table to the clipboard">Copy table</button>
              <button type="button" class="btn btn-sm btn-primary sheets-detail-btn" data-page-id="${page.id}" title="Copy this table, then open a new Google Sheet so you can paste">Open in Sheets</button>
            </div>
            <p class="detail-export-note">Copy the table first (or use Open in Sheets), then paste in the new Sheet with Ctrl/Cmd+V. Nothing is uploaded automatically.</p>
          </div>
        </div>
        <table class="data-table">
          <thead><tr><th>Text</th><th>URL</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${pageLinks.map((l) => `
              <tr>
                <td>
                  <div class="copy-cell">
                    <span class="copy-cell-text" title="${escapeHtml(l.text || '')}">${escapeHtml(truncate(l.text, 40))}</span>
                    <button type="button" class="copy-btn" data-copy="${escapeHtml(l.text || '')}" title="Copy text">❐</button>
                  </div>
                </td>
                <td>
                  <div class="copy-cell">
                    <span class="copy-cell-text" style="word-break:break-all;font-size:11px" title="${escapeHtml(l.href)}">${escapeHtml(truncate(l.href, 50))}</span>
                    <button type="button" class="copy-btn" data-copy="${escapeHtml(l.href)}" title="Copy URL">❐</button>
                  </div>
                </td>
                <td><span class="badge badge-broken">${l.statusCode || l.status}</span></td>
                <td>
                  <button type="button" class="btn btn-sm btn-icon btn-secondary copy-detail-row-btn" data-page-id="${page.id}" data-link-id="${l.id}" title="Copy row for Excel / Sheets">≡</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  html += '</div>';
  return html;
}

async function renderHistory() {
  const { items, total, totalPages, page } = await searchScans(searchQuery, currentPage, pageSize);
  const tbody = $('#historyBody');
  tbody.innerHTML = '';

  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No scans found.</td></tr>';
  } else {
    for (const scan of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><button class="expand-btn" data-id="${scan.id}" title="Expand details">${expandedScanId === scan.id ? '▼' : '▶'}</button></td>
        <td><strong>${escapeHtml(scan.domain)}</strong></td>
        <td>${escapeHtml(scan.mode)}${scan.categoryFilter ? ` <small>(${escapeHtml(scan.categoryFilter)})</small>` : ''}</td>
        <td>${formatDate(scan.startedAt)}</td>
        <td>${scan.stats?.pages || 0}</td>
        <td><span class="badge ${scan.stats?.broken ? 'badge-broken' : 'badge-ok'}">${scan.stats?.broken || 0}</span></td>
        <td><span class="badge badge-${scan.status === 'completed' ? 'ok' : scan.status === 'running' ? 'running' : 'warning'}">${scan.status}</span></td>
        <td>
          <div class="action-btns">
            <button class="btn btn-sm btn-secondary csv-btn" data-id="${scan.id}" title="Download CSV file">CSV</button>
            <button class="btn btn-sm btn-danger delete-btn" data-id="${scan.id}" title="Delete this scan">Delete</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);

      if (expandedScanId === scan.id) {
        const details = await getScanWithDetails(scan.id);
        const detailTr = document.createElement('tr');
        detailTr.className = 'detail-row';
        detailTr.innerHTML = `<td colspan="8">${renderDetailRow(scan.id, details)}</td>`;
        tbody.appendChild(detailTr);
        wireDetailCopyHandlers(detailTr, details);
      }
    }
  }

  $('#pageInfo').textContent = `Page ${page} of ${totalPages} (${total} scans)`;
  $('#prevPage').disabled = page <= 1;
  $('#nextPage').disabled = page >= totalPages;

  tbody.querySelectorAll('.expand-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      expandedScanId = expandedScanId === btn.dataset.id ? null : btn.dataset.id;
      await renderHistory();
    });
  });

  tbody.querySelectorAll('.csv-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const details = await getScanWithDetails(btn.dataset.id);
      if (!details) return;
      const csv = toCsv(details.pages, details.linksByPage, true);
      downloadCsv(csv, generateFilename(details.scan.domain));
      showToast('CSV downloaded');
    });
  });

  tbody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this scan and all its data?')) return;
      await deleteScan(btn.dataset.id);
      if (expandedScanId === btn.dataset.id) expandedScanId = null;
      showToast('Scan deleted');
      await renderHistoryStats();
      await renderHistory();
    });
  });
}

/* ---------- Events ---------- */

$$('.opts-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

$$('[data-goto]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.goto));
});

$('#copyIncludeHeader')?.addEventListener('change', () => {
  copyPrefs.includeHeader = $('#copyIncludeHeader').checked;
  renderCopyPreview();
});

const debouncedSearch = debounce(() => {
  currentPage = 1;
  renderHistory();
}, 300);

$('#searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  debouncedSearch();
});

$('#prevPage').addEventListener('click', () => {
  if (currentPage > 1) { currentPage--; renderHistory(); }
});

$('#nextPage').addEventListener('click', () => {
  currentPage++;
  renderHistory();
});

$('#pageSize').addEventListener('change', (e) => {
  pageSize = parseInt(e.target.value, 10);
  currentPage = 1;
  renderHistory();
});

$('#saveSettings').addEventListener('click', saveSettings);

$('#deleteAll').addEventListener('click', async () => {
  if (!confirm('Delete ALL scan history and local data? This cannot be undone.')) return;
  await deleteAllData();
  // Keep settings — only wipe scan DB, then clear storage carefully
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.clear();
  if (settings) await chrome.storage.local.set({ settings });
  expandedScanId = null;
  showToast('All scan data deleted');
  await renderHistoryStats();
  await renderHistory();
});

$('#openSidebar').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await chrome.sidePanel.open({ tabId: tab.id });
  } else {
    showToast('Open a browser tab first');
  }
});

(async () => {
  await loadSettings();

  let start = 'welcome';
  try {
    const saved = localStorage.getItem('blc_options_tab');
    if (saved && ['welcome', 'history', 'settings'].includes(saved)) start = saved;
  } catch { /* ignore */ }

  const hash = location.hash.replace('#', '');
  if (['welcome', 'history', 'settings', 'privacy'].includes(hash)) {
    start = hash === 'privacy' ? 'welcome' : hash;
  }

  try {
    const { blc_show_welcome } = await chrome.storage.local.get('blc_show_welcome');
    if (blc_show_welcome) {
      start = 'welcome';
      await chrome.storage.local.remove('blc_show_welcome');
      try { localStorage.setItem('blc_options_tab', 'welcome'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  switchTab(start);

  if (hash === 'privacy') {
    requestAnimationFrame(() => {
      document.getElementById('privacy')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
})();

$('#privacyLink')?.addEventListener('click', (e) => {
  e.preventDefault();
  switchTab('welcome');
  requestAnimationFrame(() => {
    document.getElementById('privacy')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});
