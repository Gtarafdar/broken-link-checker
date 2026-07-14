/**
 * Copy text to clipboard with brief visual feedback on a button.
 * Returns true if copy succeeded.
 */
export async function copyText(text) {
  if (text == null || text === '') return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Mark a button as briefly showing copied state */
export function flashCopied(btn, label = 'Copied') {
  if (!btn) return;
  const prev = btn.innerHTML;
  const prevTitle = btn.title;
  btn.classList.add('copy-btn--done');
  btn.innerHTML = 'OK';
  btn.title = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.classList.remove('copy-btn--done');
    btn.innerHTML = prev;
    btn.title = prevTitle;
    btn.disabled = false;
  }, 1400);
}

export async function copyWithFeedback(text, btn, toastFn) {
  const ok = await copyText(text);
  if (ok) {
    flashCopied(btn);
    toastFn?.('Copied');
  } else {
    toastFn?.('Copy failed — try again');
  }
  return ok;
}

/** Build a single tab-separated row for Excel / Sheets paste */
export function rowAsTsv(cells) {
  return cells.map((c) => String(c ?? '').replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t');
}

/** Column definitions for export / copy preferences */
export const COPY_COLUMNS = [
  { id: 'domain', label: 'Domain' },
  { id: 'scanDate', label: 'Scan Date' },
  { id: 'scanMode', label: 'Scan Mode' },
  { id: 'scanStatus', label: 'Scan Status' },
  { id: 'pageTitle', label: 'Page Title' },
  { id: 'pageUrl', label: 'Page URL' },
  { id: 'linkText', label: 'Link Text' },
  { id: 'linkUrl', label: 'Link URL' },
  { id: 'statusCode', label: 'Status Code' },
  { id: 'status', label: 'Status' },
  { id: 'error', label: 'Error' },
  { id: 'checkedAt', label: 'Checked At' }
];

export const COPY_TABLE_HEADERS = COPY_COLUMNS.map((c) => c.label);

export const DEFAULT_COPY_PREFS = {
  includeHeader: true,
  columns: Object.fromEntries(COPY_COLUMNS.map((c) => [c.id, true]))
};

export function formatCopyDate(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function normalizeCopyPrefs(prefs) {
  const base = {
    includeHeader: DEFAULT_COPY_PREFS.includeHeader,
    columns: { ...DEFAULT_COPY_PREFS.columns }
  };
  if (!prefs || typeof prefs !== 'object') return base;
  if (typeof prefs.includeHeader === 'boolean') base.includeHeader = prefs.includeHeader;
  if (prefs.columns && typeof prefs.columns === 'object') {
    for (const col of COPY_COLUMNS) {
      if (typeof prefs.columns[col.id] === 'boolean') {
        base.columns[col.id] = prefs.columns[col.id];
      }
    }
  }
  // Always keep at least one column selected
  if (!Object.values(base.columns).some(Boolean)) {
    base.columns.linkUrl = true;
    base.columns.status = true;
  }
  return base;
}

export function getActiveCopyColumns(prefs) {
  const normalized = normalizeCopyPrefs(prefs);
  return COPY_COLUMNS.filter((c) => normalized.columns[c.id] !== false);
}

function cellValue(colId, scan, page, link) {
  switch (colId) {
    case 'domain': return scan?.domain || '';
    case 'scanDate': return formatCopyDate(scan?.startedAt || scan?.completedAt);
    case 'scanMode': return scan?.mode || '';
    case 'scanStatus': return scan?.status || '';
    case 'pageTitle': return page?.title || page?.url || '';
    case 'pageUrl': return page?.url || '';
    case 'linkText': return link?.text || '';
    case 'linkUrl': return link?.href || '';
    case 'statusCode': return link?.statusCode ?? '';
    case 'status': return link?.status || '';
    case 'error': return link?.error || '';
    case 'checkedAt': return formatCopyDate(link?.checkedAt);
    default: return '';
  }
}

export function linkRowCells(scan, page, link, prefs) {
  return getActiveCopyColumns(prefs).map((c) => cellValue(c.id, scan, page, link));
}

export function linkRowForCopy(scan, page, link, prefs) {
  return rowAsTsv(linkRowCells(scan, page, link, prefs));
}

export function buildTableTsv(scan, page, links, prefs) {
  const normalized = normalizeCopyPrefs(prefs);
  const cols = getActiveCopyColumns(normalized);
  const lines = [];
  if (normalized.includeHeader) {
    lines.push(rowAsTsv(cols.map((c) => c.label)));
  }
  for (const l of links || []) {
    lines.push(linkRowForCopy(scan, page, l, normalized));
  }
  return lines.join('\n');
}

/** Sample preview rows for settings UI */
export function buildCopyPreviewRows(prefs, sampleCount = 2) {
  const normalized = normalizeCopyPrefs(prefs);
  const sampleScan = {
    domain: 'example.com',
    startedAt: Date.now() - 3600000,
    mode: 'page',
    status: 'completed'
  };
  const samplePage = {
    title: 'Example Documentation',
    url: 'https://example.com/docs/getting-started'
  };
  const samples = [
    {
      text: 'Installation guide',
      href: 'https://example.com/docs/install',
      statusCode: 200,
      status: 'ok',
      error: '',
      checkedAt: Date.now() - 3500000
    },
    {
      text: 'Legacy assets',
      href: 'https://example.com/old/resource.pdf',
      statusCode: 404,
      status: 'broken',
      error: '',
      checkedAt: Date.now() - 3400000
    }
  ].slice(0, sampleCount);

  return {
    headers: getActiveCopyColumns(normalized).map((c) => c.label),
    includeHeader: normalized.includeHeader,
    rows: samples.map((l) => linkRowCells(sampleScan, samplePage, l, normalized))
  };
}

export async function loadCopyPrefs() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    return normalizeCopyPrefs(settings?.copyPrefs);
  } catch {
    return normalizeCopyPrefs(null);
  }
}
