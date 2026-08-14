/**
 * ChordBook public proxy (Cloudflare Worker)
 *
 * Holds Dropbox credentials server-side and exposes two read-only,
 * anonymous endpoints so a public ChordBook instance can list and read
 * ChordPro files without visitors ever touching Dropbox or a token.
 *
 *   GET /list?folder=/Songbook   -> JSON array of file metadata
 *   GET /content?path=/Songbook/foo.cho -> raw file text
 *
 * Required secrets (set with `wrangler secret put NAME`, or in the
 * Cloudflare dashboard under Settings -> Variables -> Encrypt):
 *   DROPBOX_APP_KEY        Your Dropbox app's App Key (not secret, but fine here)
 *   DROPBOX_REFRESH_TOKEN  A refresh token for the Dropbox account holding the songs
 *
 * Optional variable:
 *   ALLOWED_ORIGIN          Restrict CORS to your app's origin instead of "*"
 *
 * See README.md for how to obtain the refresh token and deploy this.
 */

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API_ROOT = 'https://api.dropboxapi.com/2';
const CONTENT_ROOT = 'https://content.dropboxapi.com/2';
const EXTS = ['.cho', '.chopro', '.crd', '.chordpro', '.pro', '.txt'];

// Persists across requests on a warm Worker instance; harmless to lose on cold start.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken(env) {
  if (cachedToken && Date.now() < cachedTokenExpiry - 60000) return cachedToken;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.DROPBOX_REFRESH_TOKEN,
    client_id: env.DROPBOX_APP_KEY,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Dropbox token refresh failed: ' + (await res.text()));
  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function dropboxApi(token, path, body) {
  const res = await fetch(`${API_ROOT}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`Dropbox API error (${path}): ${await res.text()}`);
  return res.json();
}

// Dropbox requires header values to be ASCII-only.
function asciiSafeHeaderJson(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}

async function listSongs(env, folder) {
  const token = await getAccessToken(env);
  const results = [];
  let data = await dropboxApi(token, '/files/list_folder', {
    path: folder === '/' ? '' : folder,
    recursive: true,
  });
  const consume = (entries) => {
    for (const e of entries) {
      if (e['.tag'] !== 'file') continue;
      const lower = e.name.toLowerCase();
      if (!EXTS.some((ext) => lower.endsWith(ext))) continue;
      results.push({
        path: e.path_lower,
        displayPath: e.path_display,
        name: e.name,
        rev: e.rev,
        size: e.size,
        serverModified: e.server_modified,
      });
    }
  };
  consume(data.entries);
  while (data.has_more) {
    data = await dropboxApi(token, '/files/list_folder/continue', { cursor: data.cursor });
    consume(data.entries);
  }
  return results;
}

async function getContent(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(`${CONTENT_ROOT}/files/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': asciiSafeHeaderJson({ path }),
    },
  });
  if (!res.ok) throw new Error(`Dropbox download error: ${await res.text()}`);
  return res.text();
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(env);

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers });

    try {
      if (url.pathname === '/list') {
        const folder = url.searchParams.get('folder') || '/Songbook';
        const files = await listSongs(env, folder);
        return new Response(JSON.stringify(files), {
          headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      if (url.pathname === '/content') {
        const path = url.searchParams.get('path');
        if (!path) return new Response('Missing "path" query parameter', { status: 400, headers });
        const text = await getContent(env, path);
        return new Response(text, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return new Response('Not found. Use /list?folder=... or /content?path=...', { status: 404, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
