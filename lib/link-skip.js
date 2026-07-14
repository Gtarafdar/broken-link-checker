/** Protocols that are not crawlable HTTP landing pages */
const SKIP_PROTOCOL_PREFIXES = [
  'mailto:', 'tel:', 'sms:', 'callto:', 'fax:', 'javascript:', 'data:',
  'blob:', 'file:', 'about:', 'chrome:', 'chrome-extension:', 'moz-extension:',
  'vbscript:', 'geo:', 'whatsapp:', 'viber:', 'skype:', 'facetime:',
  'intent:', 'magnet:', 'ftp:', 'sftp:', 'irc:', 'ircs:', 'news:', 'nntp:',
  'feed:', 'urn:', 'cid:', 'mid:', 'wtai:', 'market:', 'itms:', 'itms-apps:',
  'spotify:', 'steam:', 'slack:', 'teams:', 'msteams:', 'zoommtg:', 'webcal:',
  'caldav:', 'tg:', 'line:', 'signal:'
];

const BARE_EMAIL_RE = /^[^\s@<>/\\]+@[^\s@<>/\\]+\.[^\s@<>/\\]+$/i;
const BARE_PHONE_RE = /^[+]?[\d\s().-]{7,20}$/;

export function isBareEmail(href) {
  return BARE_EMAIL_RE.test((href || '').trim());
}

export function isBarePhone(href) {
  return BARE_PHONE_RE.test((href || '').trim());
}

/**
 * Returns true if this href should never be HTTP-checked (email, tel, JS, etc.)
 * Note: pure hash links (#section) return false here — handled separately.
 */
export function shouldSkipLinkHref(href) {
  if (!href || typeof href !== 'string') return true;

  const raw = href.trim();
  if (!raw) return true;

  const lower = raw.toLowerCase();

  if (lower === '#' || lower.startsWith('javascript:') || lower.startsWith('void(0)')) {
    return true;
  }

  for (const prefix of SKIP_PROTOCOL_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }

  if (isBareEmail(raw)) return true;
  if (isBarePhone(raw)) return true;

  if (lower.includes('mailto:')) return true;
  if (/^https?:\/\/mailto:/i.test(raw)) return true;

  return false;
}

/** After resolving to absolute URL, only http/https are valid check targets */
export function isHttpCheckableUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'mailto') return false;
    if (parsed.hostname === 'tel') return false;
    if (parsed.pathname.toLowerCase().includes('mailto:')) return false;
    return true;
  } catch {
    return false;
  }
}

export function shouldSkipResolvedUrl(url) {
  if (shouldSkipLinkHref(url)) return true;
  return !isHttpCheckableUrl(url);
}
