// Vercel Serverless: POST JSON { "url": "..." } -> { input, resolved, cleaned }
export const config = { runtime: 'nodejs' };

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari';
const MAX_REDIRECTS = 10;
const MAX_HTML_BYTES = 256 * 1024;

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

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end',  () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function resolveUrl(inputUrl) {
  let current = inputUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetch(current, { redirect: 'follow', headers: { 'user-agent': UA } });
    const finalUrl = res.url;

    // Some affiliate interstitials use meta-refresh
    const ct = res.headers.get('content-type') || '';
    if (isHtml(ct) && res.body) {
      const reader = res.body.getReader();
      let received = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_HTML_BYTES) break;
        chunks.push(value);
      }
      const html = new TextDecoder('utf-8').decode(joinUint8(chunks));
      const m = html.match(
        /<meta\s+http-equiv=["']?refresh["']?\s+content=["'][^"'>]*url=([^"'>\s]+)[^"'>]*["']?>/i
      );
      if (m && m[1]) {
        current = new URL(m[1], finalUrl).toString();
        continue;
      }
    }
    return finalUrl; // no meta-refresh → this is final
  }
  throw new Error('Too many redirects');
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
  // For all 3 platforms we want origin+pathname only.
  // (If later you need to whitelist some functional params like sku, we can add here.)
  return stripAllQueriesKeepOriginPath(urlStr);
}

export default async function handler(req, res) {
  // CORS (useful for web clients; Shortcuts works either way)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = await readJson(req);
    const input = body?.url;
    if (!input) return res.status(400).json({ error: 'Missing "url"' });

    // Validate URL format early
    try { new URL(input); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const resolved = await resolveUrl(input);
    const platform = detectPlatform(resolved);
    const cleaned = cleanByPlatform(resolved);

    return res.status(200).json({ input, resolved, platform, cleaned });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'fail' });
  }
}
