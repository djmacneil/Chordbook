# ChordBook

An offline-first ChordPro reader for Android tablets, syncing from a `/Songbook`
folder in your Dropbox. It's a static PWA — no server, no build step, no backend.
Everything (search index, cached song text) lives in IndexedDB on the device.

## 1. Host the files

This is five static files plus icons. Any static host works. Two easy options:

**GitHub Pages** (recommended if you already have a GitHub account)
```
git init chordbook && cd chordbook
# copy all files from this folder in
git add . && git commit -m "ChordBook"
git remote add origin https://github.com/<you>/chordbook.git
git push -u origin main
# then enable Pages in repo Settings → Pages → deploy from main branch
```
Your app URL will be `https://<you>.github.io/chordbook/`.

**Netlify Drop** — go to https://app.netlify.com/drop and drag the folder in.
You'll get a URL like `https://random-name.netlify.app/` instantly (you can
rename it in site settings).

Either way, **note the exact URL** — you need it for step 2.

## 2. Create your own Dropbox app (takes ~2 minutes)

Dropbox requires every app to have its own API credentials — this keeps your
files private to an app only you control.

1. Go to https://www.dropbox.com/developers/apps and click **Create app**.
2. Choose **Scoped access**, then **App folder** or **Full Dropbox** access
   (Full Dropbox is simplest if your Songbook folder lives at the top level).
3. Name it anything (e.g. "ChordBook-yourname" — names must be globally unique).
4. In the app's **Settings** tab:
   - Under **OAuth 2** → **Redirect URIs**, add the exact URL from step 1
     (e.g. `https://<you>.github.io/chordbook/index.html` or
     `https://<you>.github.io/chordbook/` — add both if unsure).
5. In the app's **Permissions** tab, enable:
   - `files.metadata.read`
   - `files.content.read`
   Click **Submit** to save permissions.
6. Back in **Settings**, copy the **App key** at the top.

## 3. Connect the app

1. Open your hosted URL on the tablet and install it (Chrome menu → **Install app**,
   or **Add to Home screen**) so it runs full-screen like a native app.
2. Open it, tap the gear icon (Settings).
3. Paste the **App key** into "App key" and tap **Save key**.
4. Set **Folder** to `/Songbook` (or a subfolder path, e.g. `/Music/Songbook`) and
   tap **Save folder**.
5. Tap **Connect Dropbox** — you'll be sent to Dropbox to approve access, then
   returned to the app automatically.
6. Tap **Sync now**. Your `.cho` / `.chopro` / `.crd` / `.pro` / `.txt` files under
   that folder (including subfolders) download and cache on the device.

From here it works offline — the app re-syncs automatically each time you open
it with a connection, and you can trigger a manual sync anytime from Settings.

## Notes

- **Search** matches song titles and full lyric/chord text, from the local cache
  — instant, no network needed.
- **Transpose** shifts chords live per song without touching the Dropbox file.
- **Stage mode** (the moon icon in the song view) dims the toolbar and pushes
  contrast for dark venues.
- **Auto-scroll** cycles slow/medium/fast/off — tap repeatedly to change speed.
- File formats recognized: `.cho`, `.chopro`, `.crd`, `.chordpro`, `.pro`, `.txt`.
  Directives supported: `title/t`, `subtitle/st`, `artist`, `key`, `capo`,
  `comment/c/ci`, chorus/verse/bridge/tab blocks (`soc`/`eoc`, `sov`/`eov`,
  `sob`/`eob`, `sot`/`eot`), and `section`. Unknown directives are ignored
  rather than breaking the render.
- Tokens are stored in `localStorage`/IndexedDB on-device only — nothing is
  sent anywhere except directly between the browser and Dropbox's API.
- To revoke access later, either tap **Disconnect** in Settings or remove the
  app from your Dropbox account's **Connected apps** list.
