const DB_NAME = 'BrokenLinkChecker';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('scans')) {
        const scans = db.createObjectStore('scans', { keyPath: 'id' });
        scans.createIndex('startedAt', 'startedAt', { unique: false });
        scans.createIndex('domain', 'domain', { unique: false });
      }
      if (!db.objectStoreNames.contains('pages')) {
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('scanId', 'scanId', { unique: false });
      }
      if (!db.objectStoreNames.contains('links')) {
        const links = db.createObjectStore('links', { keyPath: 'id' });
        links.createIndex('scanId', 'scanId', { unique: false });
        links.createIndex('pageId', 'pageId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode = 'readonly') {
  return openDb().then((db) => {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return db.transaction(names, mode);
  });
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function createScan(scan) {
  const transaction = await tx('scans', 'readwrite');
  const store = transaction.objectStore('scans');
  await promisifyRequest(store.put(scan));
}

export async function updateScan(scan) {
  return createScan(scan);
}

export async function getScan(scanId) {
  const transaction = await tx('scans');
  return promisifyRequest(transaction.objectStore('scans').get(scanId));
}

export async function addPage(page) {
  const transaction = await tx('pages', 'readwrite');
  await promisifyRequest(transaction.objectStore('pages').put(page));
}

export async function addLinks(links) {
  if (!links.length) return;
  const transaction = await tx('links', 'readwrite');
  const store = transaction.objectStore('links');
  for (const link of links) {
    store.put(link);
  }
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getPagesByScan(scanId) {
  const transaction = await tx('pages');
  const index = transaction.objectStore('pages').index('scanId');
  return promisifyRequest(index.getAll(scanId));
}

export async function getLinksByScan(scanId) {
  const transaction = await tx('links');
  const index = transaction.objectStore('links').index('scanId');
  return promisifyRequest(index.getAll(scanId));
}

export async function getLinksByPage(pageId) {
  const transaction = await tx('links');
  const index = transaction.objectStore('links').index('pageId');
  return promisifyRequest(index.getAll(pageId));
}

export async function updateLink(link) {
  const transaction = await tx('links', 'readwrite');
  await promisifyRequest(transaction.objectStore('links').put(link));
}

export async function getAllScans() {
  const transaction = await tx('scans');
  const scans = await promisifyRequest(transaction.objectStore('scans').getAll());
  return scans.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function deleteScan(scanId) {
  const transaction = await tx(['scans', 'pages', 'links'], 'readwrite');
  await promisifyRequest(transaction.objectStore('scans').delete(scanId));

  const pagesStore = transaction.objectStore('pages');
  const pagesIndex = pagesStore.index('scanId');
  const pages = await promisifyRequest(pagesIndex.getAll(scanId));
  for (const p of pages) pagesStore.delete(p.id);

  const linksStore = transaction.objectStore('links');
  const linksIndex = linksStore.index('scanId');
  const links = await promisifyRequest(linksIndex.getAll(scanId));
  for (const l of links) linksStore.delete(l.id);

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteAllData() {
  const transaction = await tx(['scans', 'pages', 'links'], 'readwrite');
  transaction.objectStore('scans').clear();
  transaction.objectStore('pages').clear();
  transaction.objectStore('links').clear();
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getScanWithDetails(scanId) {
  const scan = await getScan(scanId);
  if (!scan) return null;
  const pages = await getPagesByScan(scanId);
  const links = await getLinksByScan(scanId);
  pages.sort((a, b) => (a.order || 0) - (b.order || 0));
  const linksByPage = {};
  for (const link of links) {
    if (!linksByPage[link.pageId]) linksByPage[link.pageId] = [];
    linksByPage[link.pageId].push(link);
  }
  return { scan, pages, links, linksByPage };
}

export async function searchScans(query, page = 1, pageSize = 20) {
  let scans = await getAllScans();
  if (query) {
    const q = query.toLowerCase();
    scans = scans.filter(
      (s) =>
        (s.domain || '').toLowerCase().includes(q) ||
        (s.mode || '').toLowerCase().includes(q) ||
        (s.categoryFilter || '').toLowerCase().includes(q)
    );
  }
  const total = scans.length;
  const start = (page - 1) * pageSize;
  const items = scans.slice(start, start + pageSize);
  return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 };
}

export class BatchedWriter {
  constructor(flushFn, batchSize = 10, flushInterval = 2000) {
    this.flushFn = flushFn;
    this.batchSize = batchSize;
    this.flushInterval = flushInterval;
    this.buffer = [];
    this.timer = null;
  }

  add(item) {
    this.buffer.push(item);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0);
    await this.flushFn(batch);
  }
}
