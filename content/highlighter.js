(function () {
  const skip = () => window.__blcSkip || {
    shouldSkipLinkHref: () => false,
    shouldSkipResolvedUrl: () => false
  };
  const STORAGE_KEY = 'blc_markers';
  let markers = [];
  let brokenLinks = [];
  let observer = null;
  let throttleTimer = null;

  function loadFromSession() {
    try {
      const data = sessionStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        brokenLinks = parsed.brokenLinks || [];
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  function saveToSession() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ brokenLinks }));
    } catch { /* ignore */ }
  }

  function getElementRect(el) {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height
    };
  }

  function createMarker(el, statusCode) {
    const rect = getElementRect(el);
    if (rect.width === 0 && rect.height === 0) return null;

    const marker = document.createElement('div');
    marker.className = 'blc-marker';
    marker.dataset.blcSelector = el.dataset.blcId || '';
    marker.style.cssText = `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;`;

    const outline = document.createElement('div');
    outline.className = 'blc-marker-outline';

    const badge = document.createElement('div');
    badge.className = 'blc-marker-badge';
    badge.textContent = statusCode || '404';

    marker.appendChild(outline);
    marker.appendChild(badge);
    document.body.appendChild(marker);
    return marker;
  }

  function findElement(link) {
    if (link.selector) {
      try {
        const el = document.querySelector(link.selector);
        if (el) return el;
      } catch { /* invalid selector */ }
    }
    const anchors = document.querySelectorAll('a[href], img[src]');
    for (const el of anchors) {
      const attr = el.getAttribute('href') || el.getAttribute('src');
      try {
        if (new URL(attr, location.href).href === link.href) return el;
      } catch { /* skip */ }
    }
    return null;
  }

  function clearMarkers() {
    markers.forEach((m) => m.remove());
    markers = [];
    brokenLinks = [];
    sessionStorage.removeItem(STORAGE_KEY);
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function repositionMarkers() {
    markers.forEach((m) => m.remove());
    markers = [];
    for (const link of brokenLinks) {
      const el = findElement(link);
      if (el) {
        const m = createMarker(el, link.statusCode);
        if (m) markers.push(m);
      }
    }
  }

  function highlightBroken(links) {
    clearMarkers();
    brokenLinks = links.filter(
      (l) => l.status === 'broken' || l.status === 'error' || l.status === 'timeout'
    );
    saveToSession();
    repositionMarkers();

    if (!observer && brokenLinks.length) {
      observer = new MutationObserver(() => {
        if (throttleTimer) return;
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          repositionMarkers();
        }, 500);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    }
  }

  function scrollToLink(link) {
    const el = findElement(link);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const rect = getElementRect(el);
    const marker = markers.find((m) => {
      return Math.abs(parseFloat(m.style.top) - rect.top) < 5;
    });
    if (marker) {
      marker.classList.add('blc-marker-scroll-pulse');
      setTimeout(() => marker.classList.remove('blc-marker-scroll-pulse'), 2000);
    } else {
      const temp = createMarker(el, link.statusCode);
      if (temp) {
        temp.classList.add('blc-marker-scroll-pulse');
        markers.push(temp);
        setTimeout(() => {
          temp.remove();
          markers = markers.filter((m) => m !== temp);
        }, 2000);
      }
    }
  }

  function getSelector(el) {
    if (!el || el === document.body) return 'body';
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += `#${CSS.escape(current.id)}`;
        parts.unshift(part);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function anchorExists(fragment) {
    if (!fragment) return true;
    const decoded = decodeURIComponent(fragment);
    return !!(
      document.getElementById(decoded) ||
      document.querySelector(`[name="${CSS.escape(decoded)}"]`) ||
      document.querySelector(`a[name="${CSS.escape(decoded)}"]`)
    );
  }

  function stripHashFromUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      return u.href;
    } catch {
      return url;
    }
  }

  function extractLinks(settings) {
    const types = settings?.linkTypes || { anchors: true, images: true };
    const links = [];
    const seen = new Set();
    const maxLinks = settings?.maxLinksPerPage || 500;
    const pageOrigin = location.origin;
    const pagePath = location.pathname;

    const add = (el, href, text, type) => {
      if (!href || links.length >= maxLinks) return;
      const raw = href.trim();
      if (skip().shouldSkipLinkHref(raw)) return;

      try {
        if (raw.startsWith('#')) {
          const fragment = raw.slice(1);
          const absolute = new URL(raw, location.href).href;
          const key = 'hash:' + absolute;
          if (seen.has(key)) return;
          seen.add(key);
          links.push({
            href: absolute,
            text: text || `#${fragment}`,
            type,
            selector: getSelector(el),
            checkType: 'hash',
            hash: fragment,
            anchorExists: anchorExists(fragment)
          });
          return;
        }

        const absolute = new URL(raw, location.href).href;
        if (skip().shouldSkipResolvedUrl(absolute)) return;
        const parsed = new URL(absolute);

        if (parsed.hash) {
          const fragment = parsed.hash.slice(1);
          const samePage = parsed.origin === pageOrigin && parsed.pathname === pagePath;
          const key = samePage ? `hash:${absolute}` : `http:${stripHashFromUrl(absolute)}`;
          if (seen.has(key)) return;
          seen.add(key);

          if (samePage) {
            links.push({
              href: absolute,
              text: text || absolute,
              type,
              selector: getSelector(el),
              checkType: 'hash',
              hash: fragment,
              anchorExists: anchorExists(fragment)
            });
          } else {
            links.push({
              href: stripHashFromUrl(absolute),
              text: text || absolute,
              type,
              selector: getSelector(el),
              checkType: 'http',
              hash: fragment
            });
          }
          return;
        }

        const key = 'http:' + stripHashFromUrl(absolute);
        if (seen.has(key)) return;
        seen.add(key);
        links.push({
          href: stripHashFromUrl(absolute),
          text: (text || absolute).slice(0, 200),
          type,
          selector: getSelector(el),
          checkType: 'http'
        });
      } catch { /* skip */ }
    };

    if (types.anchors) {
      document.querySelectorAll('a[href]').forEach((a) => {
        add(a, a.getAttribute('href'), (a.textContent || '').trim(), 'anchor');
      });
    }
    if (types.images) {
      document.querySelectorAll('img[src]').forEach((img) => {
        add(img, img.getAttribute('src'), img.getAttribute('alt') || 'image', 'image');
      });
    }
    if (types.scripts) {
      document.querySelectorAll('script[src]').forEach((s) => {
        add(s, s.getAttribute('src'), 'script', 'script');
      });
    }
    if (types.iframes) {
      document.querySelectorAll('iframe[src]').forEach((f) => {
        add(f, f.getAttribute('src'), 'iframe', 'iframe');
      });
    }

    return { links, pageUrl: location.href, pageTitle: document.title };
  }

  function extractNavSections() {
    const sections = [];
    const selectors = ['nav', '[role="navigation"]', 'header nav', '.menu', '.navigation', '#menu'];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((nav, idx) => {
        const urls = [];
        nav.querySelectorAll('a[href]').forEach((a) => {
          try {
            const absolute = new URL(a.getAttribute('href'), location.href).href;
            if (new URL(absolute).origin === location.origin) urls.push(absolute);
          } catch { /* skip */ }
        });
        if (urls.length) {
          const label = nav.getAttribute('aria-label') ||
            nav.querySelector('a')?.textContent?.trim()?.slice(0, 40) ||
            `Section ${idx + 1}`;
          sections.push({ label, urls: [...new Set(urls)] });
        }
      });
    }

    const unique = [];
    const seen = new Set();
    for (const s of sections) {
      const key = s.urls.sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(s);
      }
    }
    return unique;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'EXTRACT_LINKS') {
      sendResponse(extractLinks(msg.settings));
      return true;
    }
    if (msg.type === 'GET_NAV_SECTIONS') {
      sendResponse(extractNavSections());
      return true;
    }
    if (msg.type === 'HIGHLIGHT_BROKEN') {
      highlightBroken(msg.links || []);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'CLEAR_MARKERS') {
      clearMarkers();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'SCROLL_TO_LINK') {
      scrollToLink(msg.link);
      sendResponse({ ok: true });
      return true;
    }
  });

  if (loadFromSession()) {
    repositionMarkers();
    if (brokenLinks.length) {
      observer = new MutationObserver(() => {
        if (throttleTimer) return;
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          repositionMarkers();
        }, 500);
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    }
  }
})();
