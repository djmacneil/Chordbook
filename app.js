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
  const viewEdit = $('view-edit');
  const songList = $('song-list');
  const emptyState = $('empty-state');
  const searchInput = $('search-input');
  const btnClearSearch = $('btn-clear-search');
  const syncStrip = $('sync-strip');
  const syncStripText = $('sync-strip-text');
  const toastEl = $('toast');

  function activeClient() {
    return ProxyClient.isConfigured() ? ProxyClient : DropboxClient;
  }
  function sourceReady() {
    return ProxyClient.isConfigured() || DropboxClient.isConnected();
  }
  // Saving always goes straight to Dropbox with the person's own sign-in — never
  // through the public proxy, which stays read-only. So editing is only offered
  // on devices where someone has connected Dropbox, even if reads use the proxy.
  function canEdit() {
    return DropboxClient.isConnected();
  }
  function updateEditAffordances() {
    $('btn-new-song').classList.toggle('hidden', !canEdit());
    $('group-edit').classList.toggle('hidden', !canEdit() || !currentSong);
  }

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
    viewEdit.classList.add('hidden');
    if (name === 'list') viewList.classList.remove('hidden');
    if (name === 'edit') viewEdit.classList.remove('hidden');
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
        $('empty-sub').textContent = sourceReady()
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
      if (song.pending) {
        const badge = document.createElement('div');
        badge.className = 'song-card-badge pending';
        badge.textContent = 'Not uploaded';
        badge.title = 'Saved on this device — waiting to upload to Dropbox';
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
    updateEditAffordances();
    showView('song');
    $('song-content').scrollTop = 0;
  }

  function renderCurrentSong() {
    if (!currentSong) return;
    const preferFlat = localStorage.getItem(LS.flats) === '1';
    const container = $('song-content');
    try {
      if (typeof currentSong.content !== 'string' || currentSong.content.length === 0) {
        const sizeNote = currentSong.size > 0
          ? `Dropbox reports this file is ${currentSong.size} bytes, but nothing was cached locally.`
          : `No content was cached for this file.`;
        throw new Error(`${sizeNote} Try Sync now in Settings.`);
      }
      const blocks = ChordPro.parse(currentSong.content);
      ChordPro.render(container, blocks, { transpose: transposeSteps, preferFlat });
      if (!container.innerHTML.trim()) {
        throw new Error('Parsed to empty output.');
      }
    } catch (e) {
      console.error('ChordBook render failed for', currentSong.path, e);
      container.innerHTML = '';
      const warn = document.createElement('div');
      warn.className = 'cp-comment';
      warn.textContent = `Couldn't format this song (${e.message}). Showing raw file text below — ` +
        `please send this song's content so the parser can be fixed.`;
      container.appendChild(warn);
      const pre = document.createElement('div');
      pre.className = 'cp-tab';
      pre.textContent = currentSong.content || '(no content stored)';
      container.appendChild(pre);
    }
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
  let autoScrollPos = 0; // fractional scroll position we own, since scrollTop rounds to whole pixels
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
      autoScrollPos += SCROLL_SPEEDS[autoScrollState] * dt;
      container.scrollTop = autoScrollPos;
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
    autoScrollPos = container.scrollTop; // resync in case the user manually scrolled
    autoScrollRAF = requestAnimationFrame(tickScroll(container, performance.now()));
  });

  // ---------- Editing ----------
  // editState: { song (null for a new song), original, isNew, appliedTranspose, preview }
  let editState = null;
  const editText = $('edit-text');
  const editPreview = $('edit-preview');

  function editorDirty() {
    return !!editState && (editState.isNew || editText.value !== editState.original);
  }

  function openEditor(song, opts) {
    opts = opts || {};
    stopAutoScroll();
    const content = opts.template != null ? opts.template : (song.content || '');
    editState = { song, original: content, isNew: !!opts.isNew, appliedTranspose: false, preview: false,
                  newName: opts.newName || null, displayPath: opts.displayPath || null };
    editText.value = content;
    editText.classList.remove('hidden');
    editPreview.classList.add('hidden');
    $('btn-edit-preview').textContent = 'Preview';
    $('edit-title-display').textContent = opts.isNew ? `New: ${opts.newName}` : `Edit: ${song.title || song.name}`;
    $('edit-meta-display').textContent = opts.isNew ? opts.displayPath : (song.displayPath || '');
    const showApply = !opts.isNew && transposeSteps !== 0;
    $('group-apply-transpose').classList.toggle('hidden', !showApply);
    $('btn-edit-apply-transpose').textContent = `Apply transpose (${transposeSteps > 0 ? '+' : ''}${transposeSteps})`;
    showView('edit');
    if (opts.isNew) {
      // Put the cursor after the template so typing can start immediately.
      editText.focus();
      editText.setSelectionRange(editText.value.length, editText.value.length);
    } else {
      editText.scrollTop = 0;
    }
  }

  function closeEditor() {
    const wasNew = editState && editState.isNew;
    editState = null;
    if (wasNew || !currentSong) { renderList(searchInput.value); showView('list'); }
    else showView('song');
  }

  $('btn-edit').addEventListener('click', () => {
    if (!currentSong) return;
    if (currentSong.content == null) { showToast('This song has no cached text to edit yet — sync first.', true); return; }
    openEditor(currentSong);
  });

  $('btn-edit-cancel').addEventListener('click', () => {
    if (editorDirty() && editText.value !== editState.original && !confirm('Discard your changes?')) return;
    closeEditor();
  });

  $('btn-edit-preview').addEventListener('click', () => {
    editState.preview = !editState.preview;
    if (editState.preview) {
      const preferFlat = localStorage.getItem(LS.flats) === '1';
      try {
        ChordPro.render(editPreview, ChordPro.parse(editText.value), { transpose: 0, preferFlat });
      } catch (e) {
        editPreview.textContent = `Preview failed: ${e.message}`;
      }
      editPreview.classList.toggle('two-col', $('song-content').classList.contains('two-col'));
    }
    editText.classList.toggle('hidden', editState.preview);
    editPreview.classList.toggle('hidden', !editState.preview);
    $('btn-edit-preview').textContent = editState.preview ? 'Edit text' : 'Preview';
  });

  $('btn-edit-apply-transpose').addEventListener('click', () => {
    const preferFlat = localStorage.getItem(LS.flats) === '1';
    editText.value = ChordPro.transposeSource(editText.value, transposeSteps, preferFlat);
    editState.appliedTranspose = true;
    $('group-apply-transpose').classList.add('hidden');
    showToast('Chords rewritten in the new key — tap Save to keep it.');
  });

  function safeFileName(title) {
    return title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  $('btn-new-song').addEventListener('click', () => {
    if (!canEdit()) return;
    const title = (prompt('Title of the new song:') || '').trim();
    if (!title) return;
    const fname = safeFileName(title) || 'Untitled';
    const folder = (localStorage.getItem(LS.folder) || '/Songbook').replace(/\/+$/, '');
    let displayPath = `${folder}/${fname}.cho`;
    for (let n = 2; allSongs.some(s => s.path === displayPath.toLowerCase()); n++) {
      displayPath = `${folder}/${fname} (${n}).cho`;
    }
    const template = `{title: ${title}}\n{artist: }\n{key: }\n\n`;
    openEditor(null, { isNew: true, template, newName: title, displayPath });
  });

  $('btn-edit-save').addEventListener('click', async () => {
    if (!editState) return;
    const content = editText.value;
    if (!editState.isNew && content === editState.original) { closeEditor(); return; }

    $('btn-edit-save').disabled = true;
    try {
      let base;
      if (editState.isNew) {
        const displayPath = editState.displayPath;
        base = { path: displayPath.toLowerCase(), displayPath, name: displayPath.split('/').pop(), rev: null };
      } else {
        base = editState.song;
      }
      const meta = ChordPro.extractMeta(content);
      const record = Object.assign({}, base, {
        content,
        size: new TextEncoder().encode(content).length,
        title: meta.title, subtitle: meta.subtitle, artist: meta.artist, key: meta.key, capo: meta.capo,
        pending: true,
      });
      // Durable first: the edit is safe on the device before any network attempt.
      await SongDB.putSong(record);
      await SaveQueue.enqueue({
        path: record.path, displayPath: record.displayPath, name: record.name,
        content, baseRev: editState.isNew ? null : base.rev,
      });

      // Keep the live transpose the person was viewing, unless it was just written
      // into the file (then the saved text is already in the new key).
      const keepSteps = editState.appliedTranspose ? 0 : transposeSteps;
      const idx = allSongs.findIndex(s => s.path === record.path);
      if (idx >= 0) allSongs[idx] = record; else allSongs.push(record);
      editState = null;
      openSong(record);
      if (keepSteps) {
        transposeSteps = keepSteps;
        $('transpose-readout').textContent = String(transposeSteps);
        renderCurrentSong();
      }
      await runFlush({ manual: true });
    } catch (e) {
      showToast('Could not save: ' + e.message, true);
    } finally {
      $('btn-edit-save').disabled = false;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (editorDirty() && editText.value !== editState.original) { e.preventDefault(); e.returnValue = ''; }
  });

  // Upload anything waiting in the outbox. Shows a toast describing the outcome
  // when `manual` (a Save just happened) or when something needs attention.
  async function runFlush(opts) {
    opts = opts || {};
    if (!canEdit()) return null;
    const pendingBefore = await SaveQueue.pendingCount();
    if (!pendingBefore) return null;

    const result = await SaveQueue.flush();
    await loadFromCache();
    // Keep the open song pointing at the freshest record (rev changed, or renamed).
    if (currentSong) {
      let path = currentSong.path;
      const ren = result.renamed.find(r => r.from === path);
      if (ren) path = ren.to;
      const conflict = result.conflicts.find(c => c.originalPath === path);
      if (conflict) path = conflict.copyPath; // show the person their own version
      const fresh = allSongs.find(s => s.path === path);
      if (fresh) {
        currentSong = fresh;
        if (!viewSong.classList.contains('hidden')) {
          $('song-title-display').textContent = fresh.title || fresh.name;
          $('song-meta-display').textContent = fresh.artist || fresh.displayPath || '';
          renderCurrentSong();
        }
      }
    }
    updatePendingStatus();

    if (result.conflicts.length) {
      const c = result.conflicts[0];
      showToast(`"${c.name}" was changed elsewhere — your version was saved as "${c.copyName}".`, true);
      if (!opts.fromSync) syncWithDropbox(false); // pull down the other version
    } else if (result.error && result.error.kind === 'network') {
      if (opts.manual) showToast('Saved on this device — will upload to Dropbox when back online.');
    } else if (result.error) {
      showToast(result.error.message, true);
    } else if (opts.manual && result.saved.length) {
      showToast('Saved to Dropbox.');
    } else if (result.saved.length) {
      showToast(`Uploaded ${result.saved.length} saved edit(s) to Dropbox.`);
    }
    return result;
  }

  window.addEventListener('online', () => runFlush());

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
    $('input-proxy-url').value = ProxyClient.getProxyUrl();
    $('input-folder-path').value = localStorage.getItem(LS.folder) || '/Songbook';
    $('toggle-flats').checked = localStorage.getItem(LS.flats) === '1';
    updateDropboxStatus();
    updateSyncStatus();
    updatePendingStatus();
    updateStorageInfo();
    showView('settings');
  }
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-back').addEventListener('click', () => { renderList(searchInput.value); showView('list'); });

  function updateDropboxStatus() {
    const proxyOn = ProxyClient.isConfigured();
    const connected = DropboxClient.isConnected();

    // With a public proxy, reading never needs a login — but signing in to Dropbox
    // is still how the owner gets editing on a device (saves go direct to Dropbox,
    // never through the read-only proxy). So the card stays, worded as optional.
    $('card-appkey').classList.toggle('hidden', proxyOn && connected);

    if (proxyOn) {
      $('dropbox-status').textContent = connected
        ? 'Signed in for editing. Songs are read through the public proxy; saves go directly to your Dropbox.'
        : 'Not needed for reading — this instance reads through a public proxy. Sign in only to edit and save songs on this device.';
    } else {
      $('dropbox-status').textContent = connected ? 'Connected — you can edit and save songs.' : 'Not connected.';
    }
    $('btn-dropbox-connect').textContent = proxyOn ? 'Sign in to edit' : 'Connect Dropbox';
    $('btn-dropbox-connect').classList.toggle('hidden', connected);
    $('btn-dropbox-disconnect').classList.toggle('hidden', !connected);
    updateEditAffordances();
    $('btn-clear-proxy-url').classList.toggle('hidden', !proxyOn);

    const note = $('proxy-source-note');
    if (proxyOn && ProxyClient.isUsingDeploymentDefault()) {
      note.textContent = 'Using this deployment\'s built-in default (from config.js) — no visitor setup needed.';
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }
  }

  $('btn-save-proxy-url').addEventListener('click', () => {
    ProxyClient.setProxyUrl($('input-proxy-url').value);
    updateDropboxStatus();
    showToast(ProxyClient.isConfigured() ? 'Public proxy saved — this instance is now public.' : 'Proxy URL cleared.');
  });
  $('btn-clear-proxy-url').addEventListener('click', () => {
    ProxyClient.setProxyUrl('');
    $('input-proxy-url').value = '';
    updateDropboxStatus();
    showToast('Proxy removed. Reconnect Dropbox to sync privately.');
  });

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
  $('btn-dropbox-disconnect').addEventListener('click', async () => {
    const pending = await SaveQueue.pendingCount();
    if (pending && !confirm(`${pending} edit(s) haven't been uploaded yet. They stay on this device and will upload after you reconnect. Disconnect anyway?`)) return;
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

  async function updatePendingStatus() {
    const n = await SaveQueue.pendingCount();
    const el = $('pending-status');
    el.textContent = n ? `${n} edit(s) saved on this device, waiting to upload to Dropbox.` : '';
    el.classList.toggle('hidden', !n);
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
    const pending = await SaveQueue.pendingCount();
    if (pending && !confirm(`${pending} edit(s) haven't been uploaded to Dropbox yet and will be lost. Clear anyway?`)) return;
    await SongDB.clearAll();
    await SongDB.clearOutbox();
    updatePendingStatus();
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
    if (!sourceReady()) {
      if (manual) showToast('Connect Dropbox, or set a public proxy URL, first.', true);
      return;
    }
    const client = activeClient();
    const folder = localStorage.getItem(LS.folder) || '/Songbook';
    syncStrip.classList.remove('hidden');
    syncStripText.textContent = 'Syncing…';
    try {
      // Upload pending edits first, so the listing below already reflects them.
      if (canEdit()) {
        syncStripText.textContent = 'Uploading saved edits…';
        await runFlush({ fromSync: true });
        syncStripText.textContent = 'Syncing…';
      }
      const remoteFiles = await client.listChordProFiles(folder);
      const cached = await SongDB.getAllSongs();
      const cachedByPath = new Map(cached.map(c => [c.path, c]));
      const remotePaths = new Set(remoteFiles.map(f => f.path));

      let downloaded = 0;
      const failed = [];
      for (const f of remoteFiles) {
        const existing = cachedByPath.get(f.path);
        // Never overwrite an edit that hasn't been uploaded yet.
        if (existing && existing.pending) continue;
        // Only skip re-download if we actually have usable cached content —
        // a same-revision record with empty/missing content is treated as stale
        // so a broken sync self-heals on the next attempt instead of sticking forever.
        if (existing && existing.rev === f.rev && existing.content && existing.content.length > 0) continue;

        syncStripText.textContent = `Syncing… ${f.name}`;
        let content = await client.downloadFile(f.path);

        // Integrity check: Dropbox reports a non-zero size but we got nothing back —
        // retry once before giving up, since this can happen on a flaky mobile connection.
        if (f.size > 0 && (!content || content.length === 0)) {
          console.warn('ChordBook: empty download for', f.path, '(expected', f.size, 'bytes) — retrying once.');
          content = await client.downloadFile(f.path);
        }
        if (f.size > 0 && (!content || content.length === 0)) {
          console.error('ChordBook: sync failed twice for', f.path);
          failed.push(f.name);
          continue; // leave any previous good cache entry untouched rather than overwrite with empty content
        }

        const meta = ChordPro.extractMeta(content);
        await SongDB.putSong({
          path: f.path,
          displayPath: f.displayPath,
          name: f.name,
          rev: f.rev,
          content,
          size: f.size,
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
        if (!remotePaths.has(c.path) && !c.pending) await SongDB.deleteSong(c.path);
      }

      localStorage.setItem(LS.lastSync, new Date().toISOString());
      await loadFromCache();
      updateSyncStatus();
      updateStorageInfo();
      if (failed.length) {
        showToast(`Synced, but ${failed.length} file(s) failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}. Will retry next sync.`, true);
      } else if (manual) {
        showToast(downloaded ? `Synced — ${downloaded} file(s) updated.` : 'Already up to date.');
      }
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
    updateEditAffordances();

    if (sourceReady()) {
      syncWithDropbox(false);
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
