'use strict';
/* rss-aggregator — dependency-freier RSS/Atom-Aggregator (Node-Builtins only) */
const http = require('node:http');
const https = require('node:https');
const fsp = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 8220;
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 2000;

let store = { feeds: [], items: [] };

async function loadStore() {
  try {
    const raw = await fsp.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    store.feeds = Array.isArray(parsed.feeds) ? parsed.feeds : [];
    store.items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch { /* frischer Start */ }
}

async function saveStore() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(STORE_FILE, JSON.stringify(store, null, 2));
}

/* ---------- SSRF-Schutz: nur oeffentliche Ziele ---------- */
function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return true;          // 0/8, 127/8, 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 169 && b === 254) return true;                    // 169.254/16
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;                 // Loopback/unspecified
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;  // fc00::/7 (ULA)
  if (/^fe[89ab]/.test(v6)) return true;                        // fe80::/10 (link-local)
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)); // IPv4-mapped
  return false;
}

async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Nur http/https erlaubt');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new Error('Blockierte Adresse: ' + host);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Blockierte Adresse: ' + host);
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('DNS-Aufloesung fehlgeschlagen: ' + host);
  }
  if (!addrs.length) throw new Error('DNS-Aufloesung leer: ' + host);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('Blockierte Adresse: ' + host + ' -> ' + address);
  }
}

/* ---------- HTTP-Fetch mit Redirect-Handling ---------- */
const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MB

async function fetchUrl(url, redirectsLeft = 5) {
  await assertPublicUrl(url); // gilt auch fuer jedes Redirect-Ziel
  return new Promise((resolve, reject) => {
    let mod;
    if (url.startsWith('https:')) mod = https;
    else if (url.startsWith('http:')) mod = http;
    else return reject(new Error('Unsupported protocol'));
    const req = mod.get(url, {
      headers: {
        'user-agent': 'rss-aggregator/1.0 (+https://github.com)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_FEED_BYTES) {
          req.destroy(new Error('Feed zu gross (max 5 MB)'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Timeout nach 15s')));
  });
}

/* ---------- Mini-XML-Parser (RSS 2.0 + Atom) ---------- */
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tagContent(block, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, '').trim() : '';
}

function parseDate(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(0).toISOString();
}

function parseFeed(xml, source) {
  const items = [];
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of rssItems) {
    items.push({
      title: tagContent(b, 'title') || '(ohne Titel)',
      link: tagContent(b, 'link') || tagContent(b, 'guid'),
      date: parseDate(tagContent(b, 'pubDate') || tagContent(b, 'dc:date')),
      source,
    });
  }
  if (rssItems.length === 0) {
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const b of entries) {
      let link = '';
      for (const lt of b.match(/<link\b[^>]*>/gi) || []) {
        const href = (lt.match(/href="([^"]*)"/i) || [])[1];
        const rel = (lt.match(/rel="([^"]*)"/i) || [])[1];
        if (href && (!rel || rel === 'alternate')) { link = href; break; }
        if (href && !link) link = href;
      }
      items.push({
        title: tagContent(b, 'title') || '(ohne Titel)',
        link: decodeEntities(link),
        date: parseDate(tagContent(b, 'updated') || tagContent(b, 'published')),
        source,
      });
    }
  }
  return items.filter((i) => i.link);
}

function feedName(feed) {
  if (feed.name) return feed.name;
  try { return new URL(feed.url).hostname; } catch { return feed.url; }
}

/* ---------- Refresh (ein kaputter Feed crasht nicht den Rest) ---------- */
let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  try {
    const collected = [];
    for (const feed of store.feeds) {
      try {
        const xml = await fetchUrl(feed.url);
        const items = parseFeed(xml, feedName(feed));
        feed.lastFetch = new Date().toISOString();
        feed.lastError = null;
        feed.itemCount = items.length;
        collected.push(...items);
      } catch (err) {
        feed.lastFetch = new Date().toISOString();
        feed.lastError = String(err.code || err.message || err);
      }
    }
    const byLink = new Map(store.items.map((i) => [i.link, i]));
    for (const it of collected) byLink.set(it.link, it);
    store.items = [...byLink.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_ITEMS);
    await saveStore();
  } finally {
    refreshing = false;
  }
}

/* ---------- HTTP-Server ---------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { req.destroy(); reject(new Error('Body zu gross')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/' && req.method === 'GET') {
      const html = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (u.pathname === '/api/feeds' && req.method === 'GET') {
      return json(res, 200, store.feeds.map((f) => ({ ...f, name: feedName(f) })));
    }
    if (u.pathname === '/api/feeds' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Ungueltiges JSON' }); }
      let parsed;
      try { parsed = new URL(body.url); } catch { return json(res, 400, { error: 'Ungueltige URL' }); }
      if (!/^https?:$/.test(parsed.protocol)) return json(res, 400, { error: 'Nur http/https' });
      if (store.feeds.some((f) => f.url === parsed.href)) return json(res, 409, { error: 'Feed existiert bereits' });
      const feed = { id: Date.now().toString(36), url: parsed.href, name: body.name || null, lastFetch: null, lastError: null, itemCount: 0 };
      store.feeds.push(feed);
      await saveStore();
      refreshAll().catch(() => {});
      return json(res, 201, feed);
    }
    const delMatch = u.pathname.match(/^\/api\/feeds\/([\w-]+)$/);
    if (delMatch && req.method === 'DELETE') {
      const before = store.feeds.length;
      const removed = store.feeds.find((f) => f.id === delMatch[1]);
      store.feeds = store.feeds.filter((f) => f.id !== delMatch[1]);
      if (store.feeds.length === before) return json(res, 404, { error: 'Feed nicht gefunden' });
      const name = feedName(removed);
      store.items = store.items.filter((i) => i.source !== name);
      await saveStore();
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/items' && req.method === 'GET') {
      const source = u.searchParams.get('source');
      const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 500);
      let items = store.items;
      if (source) items = items.filter((i) => i.source === source);
      return json(res, 200, items.slice(0, limit));
    }
    if (u.pathname === '/api/refresh' && req.method === 'POST') {
      await refreshAll();
      return json(res, 200, { ok: true, items: store.items.length });
    }
    json(res, 404, { error: 'Nicht gefunden' });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

loadStore().then(() => {
  server.listen(PORT, () => console.log(`rss-aggregator laeuft auf http://localhost:${PORT}`));
  setInterval(() => refreshAll().catch(() => {}), REFRESH_INTERVAL_MS);
});
