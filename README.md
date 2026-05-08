# TL;DL

A self-hosted web UI for downloading media from Telegram channels. Built to run as a Docker container on ZimaOS / CasaOS or any Docker-compatible server.

> 🤖 This project was built with [Claude](https://claude.ai) (Anthropic AI).

---

## Features

- 🔐 Telegram login via phone number + verification code (2FA supported)
- 📡 Browse all your joined channels and groups
- 🎬 List media in a channel with filename, type badge, and file size
- ☑️ Select all or individual files to download
- ⏸️ Pause, resume, and cancel downloads mid-flight
- ⬇️ Dual progress bars — current file % and overall package %
- 📋 Per-file status list — see which files are pending, downloading, completed, or failed
- 💾 Persistent session — authenticate once, stays logged in across restarts
- 🔁 Automatic retry — up to 3 attempts per file on failure
- 🗂️ Supports videos, photos, audio, voice, documents, and GIFs

---

## Screenshots

| Login | Channels | Download Progress |
|-------|----------|-------------------|
| Phone + code + optional 2FA | Browse and search channels | File list with live dual progress |

---

## Requirements

- Docker + Docker Compose
- A Telegram API ID and API Hash — get them free at [my.telegram.org](https://my.telegram.org)

---

## Setup

### 1. Get Telegram API credentials

1. Go to [https://my.telegram.org](https://my.telegram.org)
2. Log in with your phone number
3. Go to **API Development Tools**
4. Create an app — copy the `api_id` and `api_hash`

### 2. Run with Docker Compose

```yaml
services:
  tldl:
    image: ghcr.io/darkomg/tldl:latest
    container_name: tldl
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - API_ID=your_api_id_here
      - API_HASH=your_api_hash_here
      - DATA_DIR=/data
      - DOWNLOADS_DIR=/downloads
    volumes:
      - ./data:/data
      - /your/media/folder:/downloads
```

```bash
docker compose up -d
```

Open your browser at `http://localhost:3000`

### 3. First login

1. Enter your Telegram phone number (with country code, e.g. `+521234567890`)
2. Enter the verification code sent to your Telegram app
3. If your account has 2FA enabled, enter your password when prompted
4. Done — session is saved persistently in your data volume

---

## ZimaOS / CasaOS Installation

Install directly from the App Store using a custom compose URL, or via the CLI:

```bash
casaos-cli app-management install -f https://raw.githubusercontent.com/Darkomg/tldl/master/docker-compose.yml
```

The app includes full CasaOS metadata (`x-casaos`) — it appears with its icon and description in the app dashboard.

---

## Download UI

Each active download shows:

- **File list** with status icons:
  - `✓` Completed
  - `↓` Downloading (with live bytes and %)
  - `✗` Failed
  - `·` Pending
- **Current file progress bar** — percentage + bytes downloaded / total
- **Global progress bar** — overall package progress (X/Y files)
- **Pause / Resume / Cancel** buttons

Cancelling or pausing interrupts the current file immediately and removes the partial download.

---

## Project Structure

```
tldl/
├── server.js          # Express backend + GramJS + WebSocket
├── public/
│   ├── index.html     # Main UI
│   ├── style.css      # Dark theme
│   └── app.js         # Frontend logic
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web UI port |
| `API_ID` | — | Telegram API ID (required) |
| `API_HASH` | — | Telegram API Hash (required) |
| `DATA_DIR` | `/data` | Directory for session credentials |
| `DOWNLOADS_DIR` | `/downloads` | Root directory for downloaded files |

---

## Notes

- Sessions are stored in `DATA_DIR/credentials.json` — keep this volume persistent
- Downloads are organized in subfolders by channel name inside `DOWNLOADS_DIR`
- Skips files that already exist on disk (safe to re-run)
- Built with [GramJS](https://github.com/gram-js/gramjs) for MTProto

---

## Built With AI

This project was fully designed and coded using **Claude Sonnet** by [Anthropic](https://anthropic.com).  
Prompted and directed by **Orlando Gutiérrez**.
