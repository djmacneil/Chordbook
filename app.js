/* app.js — wires together DropboxClient, SongDB and ChordPro into the ChordBook UI. */

(() => {
  const LS = {
    folder: 'cb_folder_path',
    flats: 'cb_prefer_flats',
    fontScale: 'cb_font_scale',
    columns: 'cb_columns',
    stage: 'cb_stage_mode',
    lastSync: 'cb_last_sync',
  };

  let allSongs = [];      // [{path, name, title, subtitle, key, content, rev, ...}]
  let currentSong = null; // full record currently open in viewer
  let transposeSteps = 0;
  let autoScrollState = 0; // 0 off, 1 slow, 2 med, 3 fast
  let autoScrollRAF = null;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const viewList = $('view-list');
  const viewSong = $('view-song');
  const viewSettings = $('view-settings');
  const songList = $('song-list');
  const emptyState = $('empty-state');
  const searchInput = $('search-input');
  const btnClearSearch = $('btn-clear-search');
  const syncStrip = $('sync-strip');
  const syncStripText = $('sync-strip-text');
  const toastEl = $('toast');

  function showToast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 3200);
  }

  function showView(name) {
    viewList.classList.add('hidden');
    viewSong.classList.add('hidden');
    viewSettings.classList.add('hidden');
    if (name === 'list') viewList.classList.remove('hidden');
    if (name === 'song') viewSong.classList.remove('hidden');
    if (name === 'settings') viewSettings.classList.remove('hidden');
  }

  // ---------- List rendering ----------
  function highlightSnippet(content, query) {
    if (!query) return '';
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return '';
    const start = Math.max(0, idx - 20);
    const end = Math.min(content.length, idx + query.length + 30);
    let snippet = content.slice(start, end).replace(/\n/g, ' ');
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
    snippet = snippet.replace(re, (m) => `<mark>${m}</mark>`);
    return (start > 0 ? '…' : '') + snippet + (end < content.length ? '…' : '');
  }

  function renderList(query) {
    const q = (query || '').trim().toLowerCase();
    let items = allSongs;
    let matches = [];

    if (!q) {
      matches = allSongs.map(s => ({ song: s, snippet: '' }));
    } else {
      for (const s of allSongs) {
        const titleHit = (s.title || s.name).toLowerCase().includes(q);
        const contentHit = !titleHit && s.content && s.content.toLowerCase().includes(q);
        if (titleHit || contentHit) {
          matches.push({ song: s, snippet: contentHit ? highlightSnippet(s.content, q) : '' });
        }
      }
    }

    matches.sort((a, b) => (a.song.title || a.song.name).localeCompare(b.song.title || b.song.name));

    songList.innerHTML = '';
    if (matches.length === 0) {
      emptyState.classList.remove('hidden');
      songList.classList.add('hidden');
      if (allSongs.length === 0) {
        $('empty-title').textContent = 'No songs yet';
        $('empty-sub').textContent = DropboxClient.isConnected()
          ? 'No ChordPro files found yet — try Sync now in Settings.'
          : 'Connect Dropbox in Settings to load your Songbook.';
        $('btn-empty-action').textContent = 'Open Settings';
        $('btn-empty-action').onclick = () => { openSettings(); };
      } else {
        $('empty-title').textContent = 'No matches';
        $('empty-sub').textContent = `Nothing found for "${query}".`;
        $('btn-empty-action').textContent = 'Clear search';
        $('btn-empty-action').onclick = () => { searchInput.value = ''; renderList(''); };
      }
      return;
    }
    emptyState.classList.add('hidden');
    songList.classList.remove('hidden');

    for (const { song, snippet } of matches) {
      const card = document.createElement('div');
      card.className = 'song-card';
      const main = document.createElement('div');
      main.className = 'song-card-main';
      const title = document.createElement('div');
      title.className = 'song-card-title';
      title.textContent = song.title || song.name.replace(/\.[^.]+$/, '');
      main.appendChild(title);
      const sub = document.createElement('div');
      sub.className = 'song-card-sub';
      sub.textContent = song.artist || song.subtitle || song.displayPath || '';
      main.appendChild(sub);
      if (snippet) {
        const sn = document.createElement('div');
        sn.className = 'song-card-snippet';
        sn.innerHTML = snippet;
        main.appendChild(sn);
      }
      card.appendChild(main);
      if (song.key) {
        const badge = document.createElement('div');
        badge.className = 'song-card-badge';
        badge.textContent = song.key;
        card.appendChild(badge);
      }
      card.addEventListener('click', () => openSong(song));
      songList.appendChild(card);
    }
  }

  // ---------- Song viewer ----------
  function openSong(song) {
    currentSong = song;
    transposeSteps = 0;
    $('transpose-readout').textContent = '0';
    $('song-title-display').textContent = song.title || song.name;
    $('song-meta-display').textContent = song.artist || song.displayPath || '';
    renderCurrentSong();
    showView('song');
    $('song-content').scrollTop = 0;
  }

  function renderCurrentSong() {
    if (!currentSong) return;
    const blocks = ChordPro.parse(currentSong.content);
    const preferFlat = localStorage.getItem(LS.flats) === '1';
    ChordPro.render($('song-content'), blocks, { transpose: transposeSteps, preferFlat });
  }

  $('btn-back').addEventListener('click', () => { stopAutoScroll(); showView('list'); });

  $('btn-transpose-down').addEventListener('click', () => {
    transposeSteps -= 1;
    $('transpose-readout').textContent = String(transposeSteps);
    renderCurrentSong();
  });
  $('btn-transpose-up').addEventListener('click', () => {
    transposeSteps += 1;
    $('transpose-readout').textContent = String(transposeSteps);
    renderCurrentSong();
  });

  function applyFontScale(scale) {
    document.documentElement.style.setProperty('--song-scale', scale);
    $('font-readout').textContent = Math.round(scale * 100) + '%';
    localStorage.setItem(LS.fontScale, String(scale));
  }
  $('btn-font-down').addEventListener('click', () => {
    const cur = parseFloat(localStorage.getItem(LS.fontScale) || '1');
    applyFontScale(Math.max(0.6, +(cur - 0.1).toFixed(2)));
  });
  $('btn-font-up').addEventListener('click', () => {
    const cur = parseFloat(localStorage.getItem(LS.fontScale) || '1');
    applyFontScale(Math.min(2.2, +(cur + 0.1).toFixed(2)));
  });

  $('btn-columns').addEventListener('click', () => {
    const el = $('song-content');
    const on = el.classList.toggle('two-col');
    $('btn-columns').textContent = on ? '1-col' : '2-col';
    localStorage.setItem(LS.columns, on ? '1' : '0');
  });

  $('btn-stage').addEventListener('click', () => {
    const on = document.body.classList.toggle('stage-mode');
    localStorage.setItem(LS.stage, on ? '1' : '0');
  });

  const SCROLL_SPEEDS = [0, 22, 42, 70]; // px/sec
  const SCROLL_LABELS = ['▶ Scroll', '▶ Slow', '▶ Medium', '▶ Fast'];
  function stopAutoScroll() {
    autoScrollState = 0;
    if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
    autoScrollRAF = null;
    $('btn-autoscroll').textContent = SCROLL_LABELS[0];
    $('btn-autoscroll').classList.remove('active');
  }
  function tickScroll(container, lastTs) {
    return (ts) => {
      if (autoScrollState === 0) return;
      const dt = (ts - lastTs) / 1000;
      container.scrollTop += SCROLL_SPEEDS[autoScrollState] * dt;
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        stopAutoScroll();
        return;
      }
      autoScrollRAF = requestAnimationFrame(tickScroll(container, ts));
    };
  }
  $('btn-autoscroll').addEventListener('click', () => {
    const container = $('song-content');
    autoScrollState = (autoScrollState + 1) % SCROLL_SPEEDS.length;
    if (autoScrollState === 0) { stopAutoScroll(); return; }
    $('btn-autoscroll').textContent = SCROLL_LABELS[autoScrollState];
    $('btn-autoscroll').classList.add('active');
    if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
    autoScrollRAF = requestAnimationFrame(tickScroll(container, performance.now()));
  });

  // ---------- Search ----------
  searchInput.addEventListener('input', () => {
    btnClearSearch.classList.toggle('hidden', !searchInput.value);
    renderList(searchInput.value);
  });
  btnClearSearch.addEventListener('click', () => {
    searchInput.value = '';
    btnClearSearch.classList.add('hidden');
    renderList('');
    searchInput.focus();
  });

  // ---------- Settings ----------
  function openSettings() {
    $('input-app-key').value = DropboxClient.getAppKey();
    $('input-folder-path').value = localStorage.getItem(LS.folder) || '/Songbook';
    $('toggle-flats').checked = localStorage.getItem(LS.flats) === '1';
    updateDropboxStatus();
    updateSyncStatus();
    updateStorageInfo();
    showView('settings');
  }
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-back').addEventListener('click', () => { renderList(searchInput.value); showView('list'); });

  function updateDropboxStatus() {
    const connected = DropboxClient.isConnected();
    $('dropbox-status').textContent = connected ? 'Connected.' : 'Not connected.';
    $('btn-dropbox-connect').classList.toggle('hidden', connected);
    $('btn-dropbox-disconnect').classList.toggle('hidden', !connected);
  }

  $('btn-save-app-key').addEventListener('click', () => {
    DropboxClient.setAppKey($('input-app-key').value);
    showToast('App key saved.');
  });

  $('btn-dropbox-connect').addEventListener('click', async () => {
    try {
      if (!DropboxClient.getAppKey()) DropboxClient.setAppKey($('input-app-key').value);
      await DropboxClient.beginAuth();
    } catch (e) {
      showToast(e.message, true);
    }
  });
  $('btn-dropbox-disconnect').addEventListener('click', () => {
    DropboxClient.disconnect();
    updateDropboxStatus();
    showToast('Disconnected from Dropbox.');
  });

  $('btn-save-folder').addEventListener('click', () => {
    let v = $('input-folder-path').value.trim() || '/Songbook';
    if (!v.startsWith('/')) v = '/' + v;
    localStorage.setItem(LS.folder, v);
    showToast('Folder saved.');
  });

  $('toggle-flats').addEventListener('change', (e) => {
    localStorage.setItem(LS.flats, e.target.checked ? '1' : '0');
    if (currentSong) renderCurrentSong();
  });

  function updateSyncStatus(text) {
    if (text) { $('sync-status').textContent = text; return; }
    const last = localStorage.getItem(LS.lastSync);
    $('sync-status').textContent = last
      ? `Last synced ${new Date(last).toLocaleString()} · ${allSongs.length} songs`
      : 'Never synced.';
  }

  async function updateStorageInfo() {
    const est = await SongDB.estimateUsage();
    if (est && est.usage != null) {
      const mb = (est.usage / (1024 * 1024)).toFixed(1);
      $('storage-info').textContent = `${allSongs.length} songs cached · ~${mb} MB used`;
    } else {
      $('storage-info').textContent = `${allSongs.length} songs cached`;
    }
  }

  $('btn-clear-cache').addEventListener('click', async () => {
    await SongDB.clearAll();
    allSongs = [];
    localStorage.removeItem(LS.lastSync);
    renderList('');
    updateSyncStatus();
    updateStorageInfo();
    showToast('Local cache cleared.');
  });

  $('btn-sync-now').addEventListener('click', () => syncWithDropbox(true));

  // ---------- Sync ----------
  async function loadFromCache() {
    const records = await SongDB.getAllSongs();
    allSongs = records;
    renderList(searchInput.value);
  }

  async function syncWithDropbox(manual) {
    if (!DropboxClient.isConnected()) {
      if (manual) showToast('Connect Dropbox first.', true);
      return;
    }
    const folder = localStorage.getItem(LS.folder) || '/Songbook';
    syncStrip.classList.remove('hidden');
    syncStripText.textContent = 'Syncing…';
    try {
      const remoteFiles = await DropboxClient.listChordProFiles(folder);
      const cached = await SongDB.getAllSongs();
      const cachedByPath = new Map(cached.map(c => [c.path, c]));
      const remotePaths = new Set(remoteFiles.map(f => f.path));

      let downloaded = 0;
      for (const f of remoteFiles) {
        const existing = cachedByPath.get(f.path);
        if (existing && existing.rev === f.rev) continue; // unchanged
        syncStripText.textContent = `Syncing… ${f.name}`;
        const content = await DropboxClient.downloadFile(f.path);
        const meta = ChordPro.extractMeta(content);
        await SongDB.putSong({
          path: f.path,
          displayPath: f.displayPath,
          name: f.name,
          rev: f.rev,
          content,
          title: meta.title,
          subtitle: meta.subtitle,
          artist: meta.artist,
          key: meta.key,
          capo: meta.capo,
          serverModified: f.serverModified,
        });
        downloaded++;
      }

      // Remove cached songs no longer present remotely.
      for (const c of cached) {
        if (!remotePaths.has(c.path)) await SongDB.deleteSong(c.path);
      }

      localStorage.setItem(LS.lastSync, new Date().toISOString());
      await loadFromCache();
      updateSyncStatus();
      updateStorageInfo();
      if (manual) showToast(downloaded ? `Synced — ${downloaded} file(s) updated.` : 'Already up to date.');
    } catch (e) {
      showToast(e.message, true);
    } finally {
      syncStrip.classList.add('hidden');
    }
  }

  // ---------- Init ----------
  async function init() {
    // Restore display prefs
    applyFontScale(parseFloat(localStorage.getItem(LS.fontScale) || '1'));
    if (localStorage.getItem(LS.columns) === '1') {
      $('song-content').classList.add('two-col');
      $('btn-columns').textContent = '1-col';
    }
    if (localStorage.getItem(LS.stage) === '1') {
      document.body.classList.add('stage-mode');
    }

    try {
      const cameFromAuth = await DropboxClient.handleRedirectIfPresent();
      if (cameFromAuth) showToast('Dropbox connected.');
    } catch (e) {
      showToast(e.message, true);
    }

    await loadFromCache();
    updateDropboxStatus();

    if (DropboxClient.isConnected()) {
      syncWithDropbox(false);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
