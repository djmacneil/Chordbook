/* proxy-client.js — talks to the ChordBook public proxy (see worker.js) instead of Dropbox
   directly. No login, no token, no App Key — just a base URL. Used when the person has
   deployed the Worker and set its URL in Settings, for a fully public/anonymous instance. */

const ProxyClient = (() => {
  const LS_URL = 'cb_proxy_url';

  function getProxyUrl() {
    // An explicit (even empty) localStorage value always wins — that's how
    // someone opts out of a deployment's baked-in default back to their own
    // Dropbox login. Only fall back to the deployment default when nothing
    // has been explicitly set in this browser at all.
    const explicit = localStorage.getItem(LS_URL);
    if (explicit !== null) return explicit.trim().replace(/\/+$/, '');
    const fallback = (window.CHORDBOOK_CONFIG && window.CHORDBOOK_CONFIG.defaultProxyUrl) || '';
    return fallback.trim().replace(/\/+$/, '');
  }
  function isUsingDeploymentDefault() {
    return localStorage.getItem(LS_URL) === null && !!getProxyUrl();
  }
  function setProxyUrl(u) {
    localStorage.setItem(LS_URL, (u || '').trim().replace(/\/+$/, ''));
  }
  function isConfigured() {
    return !!getProxyUrl();
  }

  async function listChordProFiles(folderPath) {
    const base = getProxyUrl();
    if (!base) throw new Error('Public proxy URL is not set.');
    const res = await fetch(`${base}/list?folder=${encodeURIComponent(folderPath)}`);
    if (!res.ok) throw new Error('Proxy list failed: ' + (await res.text()).slice(0, 200));
    return res.json();
  }

  async function downloadFile(path) {
    const base = getProxyUrl();
    if (!base) throw new Error('Public proxy URL is not set.');
    const res = await fetch(`${base}/content?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error('Proxy download failed: ' + (await res.text()).slice(0, 200));
    return res.text();
  }

  return { getProxyUrl, setProxyUrl, isConfigured, isUsingDeploymentDefault, listChordProFiles, downloadFile };
})();
