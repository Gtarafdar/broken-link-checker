(function () {
  const MAX_LINKS = 500;

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
          const idx = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function extractLinks(settings) {
    const types = settings?.linkTypes || { anchors: true, images: true };
    const links = [];
    const seen = new Set();

    const add = (el, href, text, type) => {
      if (!href || links.length >= MAX_LINKS) return;
      if (href.startsWith('mailto:') || href.startsWith('tel:') ||
          href.startsWith('javascript:') || href.startsWith('data:') || href.startsWith('#')) return;
      try {
        const absolute = new URL(href, location.href).href;
        const key = absolute + '|' + (text || '');
        if (seen.has(key)) return;
        seen.add(key);
        links.push({
          href: absolute,
          text: (text || absolute).slice(0, 200),
          type,
          selector: getSelector(el)
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

    return {
      links,
      pageUrl: location.href,
      pageTitle: document.title
    };
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
  });
})();
