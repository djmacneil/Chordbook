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

## 4. Optional: make it fully public (no login for visitors)

By default, every visitor to your ChordBook URL taps **Connect Dropbox** and
authorizes with *their own* Dropbox account — fine for you, but a stranger's
account obviously won't have your Songbook folder. If you want anyone with
the link to see your songs with **zero login step**, add a small proxy that
holds your Dropbox credentials privately on a server, and have the app talk
to that instead of Dropbox directly. Visitors never see or touch a token.

This uses a free [Cloudflare Worker](https://workers.cloudflare.com/).

**a) Get a refresh token** — the easiest way is through the app itself:
1. On your own device, in Settings, connect Dropbox normally (steps 2–3 above).
2. Open DevTools → Application (or Storage) → Local Storage → your app's origin.
3. Copy the value of `cb_dbx_refresh_token`. Keep this private — it's the key
   that lets the proxy read your Dropbox.

**b) Deploy the Worker (via the `wrangler` CLI)**

Cloudflare's dashboard UI for creating a bare Worker changes fairly often — the
CLI is the stable path and works the same way regardless. This folder already
includes `worker.js` and a `wrangler.toml` config for it, so it's just:

```
npm install -g wrangler        # one-time; needs Node.js installed
wrangler login                 # opens a browser to authorize the CLI

cd chordbook                   # this project folder, where worker.js lives
wrangler deploy
```

That prints a URL like `https://chordbook-proxy.<your-subdomain>.workers.dev`
— that's your proxy's address. Then set the two secrets it needs (each prompts
you to paste the value, and it's stored encrypted — never shown again):

```
wrangler secret put DROPBOX_APP_KEY
wrangler secret put DROPBOX_REFRESH_TOKEN
```

Use the App Key from step 2 above, and the refresh token from (a). After
setting secrets, redeploy once more so the Worker picks them up:

```
wrangler deploy
```

*(If you'd rather use the dashboard: go to* dash.cloudflare.com *→ **Workers &
Pages** → **Create** → look for a "Hello World" / blank Worker template in
the gallery, deploy it, then use **Edit code** to paste in `worker.js`'s
contents, and **Settings → Variables** to add the same two secrets. This flow
moves around between Cloudflare UI updates, which is why the CLI above is the
more dependable route.)*

**c) Point the app at it**

You have two options:

- **Bake it in for everyone (recommended for a public link):** open `config.js`
  in this folder and set `defaultProxyUrl` to your Worker's URL, e.g.:
  ```js
  window.CHORDBOOK_CONFIG = {
    defaultProxyUrl: 'https://chordbook-proxy.yourname.workers.dev',
  };
  ```
  Redeploy the static files (step 1). Now anyone who opens the link sees your
  songs immediately — no Settings step, no login, nothing to type in.

- **Or set it per-browser instead:** in the app's Settings, paste the URL into
  **Public access → Public proxy URL** and tap **Save proxy URL**. This only
  affects that one browser — fine for testing, but visitors on a fresh device
  won't have it unless you use the `config.js` approach above.

Either way, once a proxy URL is active the Dropbox/App key cards disappear —
not needed anymore. If you ever want to test your own private Dropbox login
on the same public deployment, tap **Remove proxy** in Settings — that opts
your browser out of the `config.js` default without affecting other visitors.

**Notes on this setup:**
- Your Dropbox refresh token lives only in the Worker's encrypted secrets —
  never in the browser, never in the static files you hosted in step 1.
- The proxy is read-only by design (`/list` and `/content` only); it can't
  modify or delete anything in your Dropbox.
- To revoke public access entirely, delete the Worker, or go to
  https://www.dropbox.com/account/connected_apps and remove the app — this
  invalidates the refresh token immediately.
- If you want a private instance for yourself *and* a public one for
  visitors, host two copies of these files (or two Worker-pointing configs) —
  Settings are stored per-browser-origin, so each deployment is independent.

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
