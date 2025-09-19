// Vercel Serverless: POST JSON { "url": "..." } -> { input, resolved, cleaned, platform }
export const config = { runtime: 'nodejs' };

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari';
const MAX_HOPS = 10;
const MAX_HTML_BYTES = 256 * 1024;

/* ---------- utils ---------- */
function isHtml(ct) {
  return typeof ct === 'string' && ct.toLowerCase().includes('text/html');
}
function joinUint8(chunks) {
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
function absolute(from, maybe) {
  try { return new URL(maybe, from).toString(); } catch { return null; }
}
function stripAllQueriesKeepOriginPath(urlStr) {
  const u = new URL(urlStr);
  u.search = '';
  u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}
function detectPlatform(urlStr) {
  const host = new URL(urlStr).hostname.replace(/^www\./, '');
  if (host.includes('shopee.')) return 'shopee';
  if (host.includes('lazada')) return 'lazada';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  return 'other';
}
function cleanByPlatform(urlStr) {
  // Hiện tại: giữ origin + pathname cho cả 3 sàn
  return stripAllQueriesKeepOriginPath(urlStr);
}

/* ---------- HTML redirect extraction ---------- */
function extractFromMetaRefresh(html, baseUrl) {
  const m = html.match(
    /<meta\s+http-equiv=["']?refresh["']?\s+content=["'][^"'>]*url=([^"'>\s]+)[^"'>]*["']?>/i
  );
  if (!m) return null;
  return absolute(baseUrl, m[1]);
}

function extractFromJs(html, baseUrl) {
  // 1) window.location / location.href / assign / replace
  const js1 = html.match(
    /(?:window\.)?location(?:\.href|\.assign|\.replace)?\s*=\s*['"]([^'"]+)['"]/i
  );
  if (js1) return absolute(baseUrl, js1[1]);

  // 2) decodeURIComponent('...')
  const dec = html.match(/decodeURIComponent\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (dec) {
    try {
      const decoded = decodeURIComponent(dec[1]);
      const url = absolute(baseUrl, decoded);
      if (url) return url;
    } catch {}
  }

  // 3) atob('base64')
  const b64 = html.match(/atob\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/i);
  if (b64) {
    try {
      const decoded = Buffer.from(b64[1], 'base64').toString('utf-8');
      const url = absolute(baseUrl, decoded.trim());
      if (url) return url;
    } catch {}
  }

  // 4) A single prominent anchor as fallback
  const a = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>(?:\s*click\s*here|here|tiếp tục|continue|redirect)/i);
  if (a) return absolute(baseUrl, a[1]);

  return null;
}

/* ---------- Resolve chain with manual redirect ---------- */
async function fetchOnce(current) {
  const res = await fetch(current, {
    method: 'GET',
    redirect: 'manual', // handle 3xx ourselves to see every hop
    headers: {
      'user-agent': UA,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  return res;
}

async function readHtml(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  let received = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_HTML_BYTES) break;
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(joinUint8(chunks));
}

async function resolveUrl(inputUrl) {
  let current = inputUrl;
  for (let i = 0; i < MAX_HOPS; i++) {
    const res = await fetchOnce(current);

    // 3xx Location header
    const loc = res.headers.get('location');
    if (loc && res.status >= 300 && res.status < 400) {
      const next = absolute(current, loc);
      if (next) { current = next; continue; }
    }

    // 200 HTML with meta-refresh or JS redirect
    const ct = res.headers.get('content-type') || '';
    if (isHtml(ct)) {
      const html = await readHtml(res);
      const viaMeta = extractFromMetaRefresh(html, current);
      if (viaMeta) { current = viaMeta; continue; }
      const viaJs = extractFromJs(html, current);
      if (viaJs) { current = viaJs; continue; }
    }

    // Consider current as final
    return current;
  }
  throw new Error('Too many hops while resolving');
}

/* ---------- HTTP handler ---------- */
async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end',  () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // CORS (handy for clients; Shortcuts works either way)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = await readJson(req);
    const input = body?.url;
    if (!input) return res.status(400).json({ error: 'Missing "url"' });
    try { new URL(input); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const resolved = await resolveUrl(input);
    const platform = detectPlatform(resolved);
    const cleaned = cleanByPlatform(resolved);

    return res.status(200).json({ input, resolved, platform, cleaned });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'fail' });
  }
}
