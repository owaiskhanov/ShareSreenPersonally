# ScreenLink

A very light "share my screen and let my friend fix it" app for Windows.

- **Sharing side:** open the app → *Share my screen* → your friend gets an ID + password → they can watch, and if **you** allow it, move the mouse and type.
- **Helping side:** open the app → *Control a friend* → type the ID + password → you see their screen.
- Video goes **peer-to-peer (WebRTC)**. The relay server only introduces the two computers — it never sees your screen.
- Control is **off by default**, needs your explicit *Allow*, and can be killed instantly with **Ctrl + Shift + F12**.

```
┌──────────────┐    handshake only     ┌──────────────┐
│  Your PC     │◄──── tiny relay ─────►│  Friend's PC │
│  (Electron)  │                       │  (Electron)  │
└──────┬───────┘                       └──────▲───────┘
       │        video + mouse/keys           │
       └──────────── peer-to-peer ───────────┘
```

---

## 1. Download the EXE

**[Download the latest release →](../../releases/latest)**

- `ScreenLink-Portable-1.0.0.exe` — **single file, just double-click.** Nothing to install. Easiest for helping a friend.
- `ScreenLink-Setup-1.0.0.exe` — installer with a Start-menu shortcut (~76 MB).

The build is produced by GitHub Actions (`.github/workflows/build-windows.yml`):
it compiles the tiny C# input helper, packages the app with electron-builder and
attaches both EXEs to the release. To rebuild: **Actions → Build Windows app →
Run workflow**.

Both friends need the app on the computer that is being shared. The helper can
also watch from a plain browser tab (see §4).

> First launch: Windows SmartScreen may show "unrecognised app" because the
> build is not code-signed. *More info → Run anyway.*

## 2. Point it at a relay (2 minutes)

The relay is a ~200-line Node WebSocket server in `server/`. Two peers cannot
find each other without it, so pick one:

**Free hosted relay** — deploy this repo to [Render](https://render.com) with
`render.yaml`, or to Railway/Fly/any VPS:

```bash
cd server
npm install
npm start            # listens on :8787
```

**Same Wi-Fi / LAN** — run it on either PC and use your local IP:

```bash
node server/index.js
# then in ScreenLink → Settings → Relay server:  ws://192.168.1.10:8787
```

Put the address into **Settings → Relay server** in the app:

| Where the relay runs | Address to enter |
| --- | --- |
| Render / Railway (HTTPS) | `wss://your-service.onrender.com` |
| Your LAN | `ws://192.168.1.10:8787` |
| Your own VPS behind TLS | `wss://relay.example.com` |

Both people must use the **same** relay.

> Strict office/hotel networks can block even WebRTC. If the picture never
> appears but the status says *Connected to relay*, add a TURN server in
> Settings (`turn:host:3478|user|pass`) — a free tier from
> [Metered](https://www.metered.ca/tools/openrelay/) is enough.

## 3. Use it

**On the PC that needs help**

1. *Share my screen* → pick **Screen** (whole display — needed for control) → **Start sharing**.
2. Click **Copy ID** and send the text to your friend (it contains the ID and password).
3. When a *"Allow control?"* card appears, press **Allow control**.
4. A red bar confirms the session. Hit **Stop their control** (or **Ctrl + Shift + F12**) any time — that hotkey works even while your mouse is being moved remotely.

**On the helper's PC**

1. *Control a friend* → paste the ID and password → **Connect**.
2. The screen appears. Click **Request control** and wait for your friend to approve.
3. Move the mouse / type. **F11** = fullscreen, **Esc** = leave fullscreen, **Disconnect** ends it.
4. *Send clipboard* pushes your copied text into their clipboard (they press Ctrl+V).

**Shortcuts**

| Key | Action |
| --- | --- |
| Ctrl + Shift + F12 | *Sharing PC:* instantly revoke remote control |
| F11 | *Viewer:* fullscreen |
| Esc | leave fullscreen |
| Ctrl + Alt + Del | not forwarded (Windows blocks synthetic SAS) |

## 4. Browser fallback (no install)

The relay also serves the same UI at `http://<relay-host>:8787/`, so a friend
can join from a browser tab:

- Browser → *Share my screen*: the browser's own picker appears; works on Chrome/Edge.
- Browser → *Control a friend*: watching works, **control does not** (a web page is not allowed to drive the OS). Use the desktop app for the PC that needs help.

## 5. Safety

- The password is exchanged as a **SHA-256 hash**; the relay never learns the plain password.
  Five wrong tries from one ID pauses joins for a minute.
- Remote input is gated three times: renderer only sends when control is granted,
  the main process drops anything else, and the helper process is **killed** the
  moment control is revoked.
- Mouse/keyboard injection happens in `electron/input-helper.exe` (C#, ~200 lines,
  source in this repo) so the Electron app needs no native node modules.
- Window sharing is watch-only; only a full screen can be controlled.
- There is no account, no telemetry, no cloud storage. Sessions are ephemeral.

## 6. Build it yourself on Windows

```powershell
git clone <this repo> ; cd ShareSreenPersonally
npm install

# native input helper (Windows SDK / .NET Framework compiler)
csc /nologo /optimize /target:exe /out:electron/input-helper.exe `
    /r:System.Windows.Forms.dll electron/input-helper.cs

npm start        # run the app
npm run dist     # build the installer + portable exe in dist/
```

Layout:

```
electron/  main process, preload bridge, native input helper (C#)
src/       UI + WebRTC + relay client (the same files the browser uses)
server/    tiny WebSocket relay that also serves src/
tests/     relay smoke test (node tests/relay.test.js)
```

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Could not reach the relay server" | Wrong address in Settings; `ws://` for LAN, `wss://` for HTTPS hosts. Is the relay running? |
| ID rejected as "already in use" | Another session is using that ID — press *Stop sharing* and start again. |
| Black/empty screen | Screen sharing needs a desktop session, not a locked/RDP-disconnected PC. |
| Control does nothing | The sharing PC must run the **desktop app** (browser viewers are view-only) and you must press **Allow control**. |
| Mouse/keys work everywhere except one app | That app runs as administrator; Windows blocks input from non-elevated programs. Right-click ScreenLink → *Run as administrator* on the sharing PC. |
| Picture freezes on some networks | Add a TURN server in Settings. |
