/* proxy-client.js — talks to the ChordBook public proxy (see worker.js) instead of Dropbox
   directly. No login, no token, no App Key — just a base URL. Used when the person has
   deployed the Worker and set its URL in Settings, for a fully public/anonymous instance. */

const ProxyClient = (() => {
  const LS_URL = 'cb_proxy_url';

  function getProxyUrl() {
    return (localStorage.getItem(LS_URL) || '').trim().replace(/\/+$/, '');
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

  return { getProxyUrl, setProxyUrl, isConfigured, listChordProFiles, downloadFile };
})();
