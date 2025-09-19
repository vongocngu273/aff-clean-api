// api/clean.js
export const config = { runtime: 'nodejs' }; // ✅ giá trị hợp lệ

// Vercel Serverless Function: POST { "url": "..." } -> { input, resolved, cleaned }
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari';
const MAX_REDIRECTS = 10;
const MAX_HTML_BYTES = 256 * 1024;

function isHtml(ct) { return typeof ct === 'string' && ct.toLowerCase().includes('text/html'); }
function stripAll(u) {
  u.search = ''; u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}
function cleanByPlatform(urlStr) { const u = new URL(urlStr); return stripAll(u); }

function mergeChunks(chunks) {
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}
async function extractMetaRefreshIfAny(res) {
  const ct = res.headers.get('content-type') || '';
  if (!isHtml(ct) || !res.body) return null;
  const reader = res.body.getReader();
  let received = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_HTML_BYTES) break;
    chunks.push(value);
  }
  const html = new TextDecoder('utf-8').decode(mergeChunks(chunks));
  const m = html.match(/<meta\s+http-equiv=["']?refresh["']?\s+content=["'][^"'>]*url=([^"'>\s]+)[^"'>]*["']?>/i);
  return m ? m[1] : null;
}
async function resolveUrl(inputUrl) {
  let current = inputUrl;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetch(current, { redirect: 'follow', headers: { 'user-agent': USER_AGENT } });
    const finalUrl = res.url;
    const meta = await extractMetaRefreshIfAny(res);
    if (meta) { current = new URL(meta, finalUrl).toString(); continue; }
    return finalUrl;
  }
  throw new Error('Too many redirects');
}

async function readJson(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = await readJson(req);
    const url = body?.url;
    if (!url) return res.status(400).json({ error: 'Missing "url"' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const resolved = await resolveUrl(url);
    const cleaned = cleanByPlatform(resolved);
    return res.status(200).json({ input: url, resolved, cleaned });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'fail' });
  }
}
