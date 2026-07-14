import { escapeCsv } from './utils.js';

export function buildExportRows(pages, linksByPage, brokenOnly = false) {
  const rows = [];
  const header = ['Page Title', 'Page URL', 'Link Text', 'Link URL', 'Status Code', 'Status', 'Checked At'];

  for (const page of pages) {
    const pageLinks = linksByPage[page.id] || [];
    const filtered = brokenOnly
      ? pageLinks.filter((l) => l.status === 'broken' || l.status === 'error' || l.status === 'timeout')
      : pageLinks;

    if (!filtered.length) continue;

    for (const link of filtered) {
      rows.push([
        page.title || page.url,
        page.url,
        link.text || '',
        link.href,
        link.statusCode || '',
        link.status || '',
        link.checkedAt ? new Date(link.checkedAt).toISOString() : ''
      ]);
    }
    rows.push(['', '', '', '', '', '', '']);
  }

  if (rows.length && rows[rows.length - 1].every((c) => c === '')) {
    rows.pop();
  }

  return { header, rows };
}

export function toCsv(pages, linksByPage, brokenOnly = false) {
  const { header, rows } = buildExportRows(pages, linksByPage, brokenOnly);
  const lines = [header.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(','));
  }
  return lines.join('\n');
}

export function toTsv(pages, linksByPage, brokenOnly = false) {
  const { header, rows } = buildExportRows(pages, linksByPage, brokenOnly);
  const lines = [header.join('\t')];
  for (const row of rows) {
    lines.push(row.join('\t'));
  }
  return lines.join('\n');
}

export function downloadCsv(csvContent, filename) {
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function generateFilename(domain, ext = 'csv') {
  const date = new Date().toISOString().slice(0, 10);
  const safeDomain = (domain || 'scan').replace(/[^a-z0-9.-]/gi, '_');
  return `broken-links-${safeDomain}-${date}.${ext}`;
}

export async function copyTsvToClipboard(tsvContent) {
  await navigator.clipboard.writeText(tsvContent);
}

export function openGoogleSheets() {
  chrome.tabs.create({ url: 'https://sheets.new' });
}

export function showSheetsPasteModal() {
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const shortcut = isMac ? 'Cmd+V' : 'Ctrl+V';
  return `Data copied! A new Google Sheet was opened.\n\nPress ${shortcut} to paste your results.\n\nAlternatively: File → Import → Upload the downloaded CSV.`;
}

export function exportScanData(scan, pages, linksByPage, format = 'csv', brokenOnly = true) {
  const content = format === 'tsv'
    ? toTsv(pages, linksByPage, brokenOnly)
    : toCsv(pages, linksByPage, brokenOnly);
  const filename = generateFilename(scan.domain, format === 'tsv' ? 'tsv' : 'csv');

  if (format === 'csv') {
    downloadCsv(content, filename);
    return { success: true, filename };
  }

  return { content, filename };
}
