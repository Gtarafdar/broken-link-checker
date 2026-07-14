(function () {
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

  function shouldSkipLinkHref(href) {
    if (!href || typeof href !== 'string') return true;
    const raw = href.trim();
    if (!raw) return true;
    const lower = raw.toLowerCase();
    if (lower === '#' || lower.startsWith('javascript:') || lower.startsWith('void(0)')) return true;
    for (const prefix of SKIP_PROTOCOL_PREFIXES) {
      if (lower.startsWith(prefix)) return true;
    }
    if (BARE_EMAIL_RE.test(raw)) return true;
    if (BARE_PHONE_RE.test(raw)) return true;
    if (lower.includes('mailto:')) return true;
    if (/^https?:\/\/mailto:/i.test(raw)) return true;
    return false;
  }

  function isHttpCheckableUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
      if (parsed.hostname === 'mailto' || parsed.hostname === 'tel') return false;
      if (parsed.pathname.toLowerCase().includes('mailto:')) return false;
      return true;
    } catch {
      return false;
    }
  }

  function shouldSkipResolvedUrl(url) {
    if (shouldSkipLinkHref(url)) return true;
    return !isHttpCheckableUrl(url);
  }

  window.__blcSkip = { shouldSkipLinkHref, isHttpCheckableUrl, shouldSkipResolvedUrl };
})();
