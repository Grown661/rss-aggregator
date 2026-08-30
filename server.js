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

// Writes serialisieren (refreshAll + POST /api/feeds koennen sonst gleichzeitig
// schreiben) und atomar schreiben (tmp + rename): nie halbe store.json auf Disk.
let writeChain = Promise.resolve();
function saveStore() {
  writeChain = writeChain
    .then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = STORE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(store, null, 2));
      await fsp.rename(tmp, STORE_FILE);
    })
    .catch((e) => console.error('saveStore:', e.message));
  return writeChain;
}

/* ---------- SSRF-Schutz: nur oeffentliche Ziele (net.BlockList) ---------- */
// net.BlockList statt manueller Range-Pruefung: BlockList normalisiert auch
// IPv4-mapped IPv6 in HEX-Form (::ffff:7f00:1) und matcht sie gegen die
// IPv4-Subnets — die manuelle Pruefung erkannte nur die Punktform.
const PRIVATE_BLOCKLIST = new net.BlockList();
PRIVATE_BLOCKLIST.addSubnet('0.0.0.0', 8, 'ipv4');      // "this network"
PRIVATE_BLOCKLIST.addSubnet('10.0.0.0', 8, 'ipv4');     // privat
PRIVATE_BLOCKLIST.addSubnet('127.0.0.0', 8, 'ipv4');    // loopback
PRIVATE_BLOCKLIST.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
PRIVATE_BLOCKLIST.addSubnet('172.16.0.0', 12, 'ipv4');  // privat
PRIVATE_BLOCKLIST.addSubnet('192.168.0.0', 16, 'ipv4'); // privat
PRIVATE_BLOCKLIST.addAddress('::', 'ipv6');             // unspecified
PRIVATE_BLOCKLIST.addSubnet('::1', 128, 'ipv6');        // loopback
PRIVATE_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6');       // ULA
PRIVATE_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6');      // link-local

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true; // unbekanntes Format -> sicherheitshalber blocken
  return PRIVATE_BLOCKLIST.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// Wirft bei nicht-oeffentlichem Ziel. Gibt die geprueften Daten zurueck, inkl.
// einer lookup-Funktion, die genau die geprueften IP PINNT — der eigentliche
// Request darf kein zweites DNS-Lookup machen (DNS-Rebinding/TOCTOU).
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Nur http/https erlaubt');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new Error('Blockierte Adresse: ' + host);
  }
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error('DNS-Aufloesung fehlgeschlagen: ' + host);
    }
  }
  if (!addrs.length) throw new Error('DNS-Aufloesung leer: ' + host);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('Blockierte Adresse: ' + host + ' -> ' + address);
  }
  const pinned = addrs[0];
  const family = pinned.family || net.isIP(pinned.address);
  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options && options.all) cb(null, [{ address: pinned.address, family }]);
    else cb(null, pinned.address, family);
  };
  return { url: u, address: pinned.address, family, lookup };
}

/* ---------- HTTP-Fetch mit Redirect-Handling ---------- */
const MAX_FEED_BYTES = 5 * 1024 * 1024; // 5 MB

async function fetchUrl(url, redirectsLeft = 5) {
  // gilt auch fuer jedes Redirect-Ziel; die geprüfte IP wird unten per
  // lookup-Option gepinnt (kein zweites DNS-Lookup -> kein Rebinding-Fenster)
  const pinned = await assertPublicUrl(url);
  return new Promise((resolve, reject) => {
    let mod;
    if (url.startsWith('https:')) mod = https;
    else if (url.startsWith('http:')) mod = http;
    else return reject(new Error('Unsupported protocol'));
    const req = mod.get(url, {
      lookup: pinned.lookup,
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json(res, 400, { error: 'JSON-Objekt erwartet' });
      }
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
    console.error('request error:', err);
    json(res, 500, { error: 'internal server error' });
  }
});

loadStore().then(() => {
  server.listen(PORT, () => console.log(`rss-aggregator laeuft auf http://localhost:${PORT}`));
  setInterval(() => refreshAll().catch(() => {}), REFRESH_INTERVAL_MS);
});
