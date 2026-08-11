/* dropbox-client.js — minimal Dropbox API v2 client using OAuth2 PKCE (no server, no app secret). */

const DropboxClient = (() => {

  const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const API_ROOT = 'https://api.dropboxapi.com/2';
  const CONTENT_ROOT = 'https://content.dropboxapi.com/2';

  const LS_KEYS = {
    appKey: 'cb_dbx_app_key',
    access: 'cb_dbx_access_token',
    refresh: 'cb_dbx_refresh_token',
    expiry: 'cb_dbx_expiry',
    verifier: 'cb_dbx_pkce_verifier',
  };

  function getAppKey() { return localStorage.getItem(LS_KEYS.appKey) || ''; }
  function setAppKey(k) { localStorage.setItem(LS_KEYS.appKey, k.trim()); }

  function redirectUri() {
    // Same-origin redirect keeps this a fully static, backend-free app.
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function base64url(bytes) {
    let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256(input) {
    const enc = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return digest;
  }

  function randomString(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return base64url(arr.buffer);
  }

  async function beginAuth() {
    const appKey = getAppKey();
    if (!appKey) throw new Error('Set your Dropbox App Key in Settings first.');
    const verifier = randomString(64);
    localStorage.setItem(LS_KEYS.verifier, verifier);
    const challenge = base64url(await sha256(verifier));

    const params = new URLSearchParams({
      client_id: appKey,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri(),
      token_access_type: 'offline',
    });
    window.location.href = `${AUTH_URL}?${params.toString()}`;
  }

  async function handleRedirectIfPresent() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return false;

    const verifier = localStorage.getItem(LS_KEYS.verifier);
    const appKey = getAppKey();
    const body = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: appKey,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    // Clean the URL regardless of outcome so a refresh doesn't resubmit the code.
    window.history.replaceState({}, '', redirectUri());

    if (!res.ok) {
      const errText = await res.text();
      throw new Error('Dropbox auth failed: ' + errText);
    }
    const data = await res.json();
    storeTokens(data);
    return true;
  }

  function storeTokens(data) {
    localStorage.setItem(LS_KEYS.access, data.access_token);
    if (data.refresh_token) localStorage.setItem(LS_KEYS.refresh, data.refresh_token);
    const expiry = Date.now() + (data.expires_in ? data.expires_in * 1000 : 3600 * 1000);
    localStorage.setItem(LS_KEYS.expiry, String(expiry));
  }

  async function refreshAccessToken() {
    const refresh = localStorage.getItem(LS_KEYS.refresh);
    const appKey = getAppKey();
    if (!refresh || !appKey) throw new Error('Not connected to Dropbox.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: appKey,
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error('Could not refresh Dropbox session.');
    const data = await res.json();
    storeTokens(data);
    return data.access_token;
  }

  async function getValidAccessToken() {
    const access = localStorage.getItem(LS_KEYS.access);
    const expiry = Number(localStorage.getItem(LS_KEYS.expiry) || 0);
    if (!access) throw new Error('Not connected to Dropbox.');
    if (Date.now() > expiry - 60000) {
      return await refreshAccessToken();
    }
    return access;
  }

  function isConnected() {
    return !!localStorage.getItem(LS_KEYS.refresh) || !!localStorage.getItem(LS_KEYS.access);
  }

  function disconnect() {
    Object.values(LS_KEYS).forEach(k => { if (k !== LS_KEYS.appKey) localStorage.removeItem(k); });
  }

  async function apiCall(path, body) {
    const token = await getValidAccessToken();
    const res = await fetch(`${API_ROOT}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Dropbox API error (${path}): ${errText.slice(0, 200)}`);
    }
    return res.json();
  }

  // List every entry under folderPath, recursively, filtered to chordpro-like extensions.
  async function listChordProFiles(folderPath) {
    const exts = ['.cho', '.chopro', '.crd', '.chordpro', '.pro', '.txt'];
    const results = [];
    let data = await apiCall('/files/list_folder', {
      path: folderPath === '/' ? '' : folderPath,
      recursive: true,
      include_deleted: false,
    });
    const consume = (entries) => {
      for (const e of entries) {
        if (e['.tag'] !== 'file') continue;
        const lower = e.name.toLowerCase();
        if (!exts.some(ext => lower.endsWith(ext))) continue;
        results.push({
          path: e.path_lower,
          displayPath: e.path_display,
          name: e.name,
          rev: e.rev,
          contentHash: e.content_hash,
          serverModified: e.server_modified,
          size: e.size,
        });
      }
    };
    consume(data.entries);
    while (data.has_more) {
      data = await apiCall('/files/list_folder/continue', { cursor: data.cursor });
      consume(data.entries);
    }
    return results;
  }

  async function downloadFile(path) {
    const token = await getValidAccessToken();
    const res = await fetch(`${CONTENT_ROOT}/files/download`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path }),
      },
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Dropbox download error: ${errText.slice(0, 200)}`);
    }
    return res.text();
  }

  return {
    getAppKey, setAppKey,
    beginAuth, handleRedirectIfPresent,
    isConnected, disconnect,
    listChordProFiles, downloadFile,
    redirectUri,
  };
})();
