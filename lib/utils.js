export function uuid() {
  return crypto.randomUUID();
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function normalizeUrl(url, base) {
  try {
    const parsed = new URL(url, base);
    parsed.hash = '';
    let normalized = parsed.href;
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    return null;
  }
}

export function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function getDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function isSameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function isHttpUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

export function shouldSkipUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase().trim();
  if (lower.startsWith('#')) return true;
  // Delegate to shared skip rules when available (imported by consumers)
  return (
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:')
  );
}

export function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

export function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncate(str, len = 60) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

export function escapeCsv(value) {
  const str = String(value ?? '');
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const DEFAULT_SETTINGS = {
  maxPages: 50,
  maxLinksPerPage: 500,
  concurrency: 3,
  crawlConcurrency: 3,
  perHostDelay: 500,
  rateLimitRetries: 8,
  autoRetryRateLimited: true,
  timeout: 12000,
  /** Skip page URLs already stored for this domain (batch / continue crawl). */
  skipScannedPages: true,
  /** How to pick the next batch of pages: discovery order (bfs) or random sample. */
  batchPick: 'bfs',
  linkTypes: { anchors: true, images: true, scripts: false, iframes: false },
  respectNofollow: false,
  copyPrefs: {
    includeHeader: true,
    columns: {
      domain: true,
      scanDate: true,
      scanMode: true,
      scanStatus: true,
      pageTitle: true,
      pageUrl: true,
      linkText: true,
      linkUrl: true,
      statusCode: true,
      status: true,
      error: true,
      checkedAt: true
    }
  }
};
