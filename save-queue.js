/* save-queue.js — durable "outbox" for edits made in ChordBook.

   Every save is written to IndexedDB first (both the song record, so the edit shows
   immediately and survives a reload, and an outbox entry), then flush() tries to
   upload. That one path covers online and offline: if there's no signal at a gig,
   the entry just waits and is uploaded on the next flush (app start, sync, or the
   browser's `online` event).

   Uploads use Dropbox's update-by-rev mode, so an edit made against an old copy can
   never silently overwrite a newer one. On a conflict, the local version is saved
   next to the original as "Song (conflicted copy YYYY-MM-DD HHMM).cho" — the same
   convention the Dropbox desktop client uses — and the original is re-downloaded on
   the next sync. Nothing is lost either way. */

const SaveQueue = (() => {
  let inFlight = null;

  // Queue a save. If this song already has a pending save, keep the rev that entry
  // was based on — the new text supersedes the old, but Dropbox hasn't seen either.
  async function enqueue({ path, displayPath, name, content, baseRev }) {
    const existing = await SongDB.getOutboxEntry(path);
    await SongDB.putOutbox({
      path,
      displayPath: displayPath || path,
      name,
      content,
      baseRev: existing ? existing.baseRev : (baseRev || null),
      isNew: existing ? existing.isNew : !baseRev,
      queuedAt: Date.now(),
    });
  }

  async function pendingCount() {
    return (await SongDB.getOutbox()).length;
  }

  function conflictPath(displayPath) {
    const slash = displayPath.lastIndexOf('/');
    const dir = displayPath.slice(0, slash);
    const file = displayPath.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const base = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '.cho';
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
    return `${dir}/${base} (conflicted copy ${stamp})${ext}`;
  }

  // Build the cached song record from what Dropbox returned after an upload.
  function recordFromUpload(base, content, meta) {
    const m = ChordPro.extractMeta(content);
    return Object.assign({}, base || {}, {
      path: meta.path_lower,
      displayPath: meta.path_display,
      name: meta.name,
      rev: meta.rev,
      size: meta.size,
      serverModified: meta.server_modified,
      content,
      title: m.title, subtitle: m.subtitle, artist: m.artist, key: m.key, capo: m.capo,
      pending: false,
    });
  }

  async function uploadOne(entry, result) {
    let meta;
    try {
      meta = await DropboxClient.uploadFile(entry.displayPath, entry.content, entry.baseRev, { autorename: entry.isNew });
    } catch (e) {
      if (e.kind !== 'conflict') throw e;

      // Someone changed the file on Dropbox since we synced it. Keep both versions.
      const copyMeta = await DropboxClient.uploadFile(conflictPath(entry.displayPath), entry.content, null, { autorename: true });
      await SongDB.putSong(recordFromUpload(null, entry.content, copyMeta));
      // Leave the original's cached record in place but force the next sync to
      // re-download it (rev '' never matches), so it ends up as Dropbox's version.
      const original = await SongDB.getSong(entry.path);
      if (original) await SongDB.putSong(Object.assign(original, { rev: '', pending: false }));
      await SongDB.deleteOutbox(entry.path);
      result.conflicts.push({ name: entry.name, copyName: copyMeta.name, copyPath: copyMeta.path_lower, originalPath: entry.path });
      return;
    }

    // Uploaded. If the person edited this song again while the upload was in flight,
    // keep that newer edit queued, now based on the rev we just created.
    const latest = await SongDB.getOutboxEntry(entry.path);
    const newerEdit = latest && latest.queuedAt !== entry.queuedAt ? latest : null;

    const existing = await SongDB.getSong(entry.path);
    const record = recordFromUpload(existing, newerEdit ? newerEdit.content : entry.content, meta);
    if (newerEdit) {
      record.pending = true;
      record.rev = meta.rev;
    }

    await SongDB.deleteOutbox(entry.path);
    if (meta.path_lower !== entry.path) {
      // New song was auto-renamed by Dropbox (name taken) — re-key under the real path.
      await SongDB.deleteSong(entry.path);
      result.renamed.push({ from: entry.path, to: meta.path_lower });
    }
    await SongDB.putSong(record);
    if (newerEdit) {
      await SongDB.putOutbox(Object.assign(newerEdit, {
        path: meta.path_lower, displayPath: meta.path_display, name: meta.name,
        baseRev: meta.rev, isNew: false,
      }));
    }
    result.saved.push(record);
  }

  async function doFlush() {
    const result = { saved: [], conflicts: [], renamed: [], error: null, remaining: 0 };
    if (!DropboxClient.isConnected()) {
      result.remaining = await pendingCount();
      return result;
    }
    // A few passes, so an edit made during an upload goes up in the same flush.
    for (let pass = 0; pass < 3; pass++) {
      const entries = await SongDB.getOutbox();
      if (!entries.length) break;
      entries.sort((a, b) => a.queuedAt - b.queuedAt);
      try {
        for (const entry of entries) await uploadOne(entry, result);
      } catch (e) {
        result.error = e; // network → try later; permission/other → surface to the user
        break;
      }
    }
    result.remaining = await pendingCount();
    return result;
  }

  // Only one flush at a time; concurrent callers share the same run.
  function flush() {
    if (!inFlight) inFlight = doFlush().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { enqueue, flush, pendingCount, conflictPath };
})();
