# JanDrop

A lightweight, self-hosted **local network file sharing & clipboard hub**. Drop multi-gigabyte files from your laptop, scan a QR code with your phone, and everything stays in sync across open tabs and devices in real time — no cloud, no accounts, no build step.

## Features

- **Drag-and-drop uploads** (single or multiple files, any size) streamed straight to disk — nothing is buffered in RAM
- **Live clipboard / text sharing** — paste a URL, snippet, or note and push it to the feed
- **Real-time sync** across all devices via Server-Sent Events
- **QR code** modal with the server's LAN URL for instant phone connections
- **Expiration options**: Never (default), 1 Hour, 24 Hours, or 🔥 burn after 1 download
- **HTTP Range support** — video/audio streams and scrubs directly in the browser
- **Automatic cleanup worker** that deletes expired items and their files on disk
- **Persistent metadata** — items survive server restarts (JSON store)
- Clean single-page dark-mode UI, zero build tooling

## Architecture

```
                          ┌──────────────────────────────────────────────────┐
                          │                JanDrop server (Express)           │
                          │                                                  │
  ┌──────────┐  HTTP POST │  ┌────────────┐    ┌───────────────────────┐     │
  │  Browser │──(busboy)──┼─►│ /api/upload├───►│ ./uploads/<id><ext>   │     │     ┌──────────┐
  │  SPA     │            │  └────────────┘    │ (streamed to disk)    │     │     │  Phone   │
  │(public/) │            │                    └───────────┬───────────┘     │     │ (QR scan)│
  │          │  GET/DEL   │  ┌────────────┐                │                 │     └────┬─────┘
  │          │◄───────────┼──┤/api/items/ │◄───────────────┘                 │          │
  │          │  download  │  │ :id/       │  (fs stream + Range)             │          │
  │          │  (Range ✓)  │  └────────────┘                                  │          │
  └────┬─────┘            │                    ┌───────────────────────┐     │     ┌────┴─────┐
       │   SSE: item:created / item:deleted   │ ./data/items.json     │     │     │ Browser   │
       │   item:updated / clients / heartbeat │ (metadata store)      │     │     │ (SSE ✓)  │
       └──────────────────┼───────────────────►└───────────┬───────────┘     │     └──────────┘
                          │                                │                 │
                          │  ┌──────────────────────────┐   │                 │
                          │  │ Cleanup worker (30s)     ├───┘                 │
                          │  │ prunes expired items +   │                     │
                          │  │ deletes files on disk,   │                     │
                          │  │ broadcasts removals      │                     │
                          │  └──────────────────────────┘                     │
                          └──────────────────────────────────────────────────┘
```

## Quick start

```bash
npm install
npm start
# ✔ JanDrop is up
#   Local:    http://localhost:3000
#   LAN:      http://192.168.x.x:3000
```

Open the LAN URL on any device on the same network, or click the **QR** button in the header and scan it with your phone.

## Configuration

| Variable          | Default   | Description                                            |
| ----------------- | --------- | ------------------------------------------------------ |
| `PORT`            | `3000`    | HTTP port to listen on                                  |
| `UPLOAD_DIR`      | `./uploads` | Directory where uploaded files are stored            |
| `DATA_DIR`        | `./data`  | Directory for the `items.json` metadata store           |
| `MAX_FILE_SIZE_MB`| unlimited | Optional per-file cap in MB; uploads over it get `413` |

Examples:

```bash
PORT=8080 npm start
MAX_FILE_SIZE_MB=2048 UPLOAD_DIR=/mnt/share/jandrop npm start
```

## API

| Method   | Route                        | Description                                                        |
| -------- | ---------------------------- | ------------------------------------------------------------------ |
| `GET`    | `/api/items`                 | List all live items (newest first)                                 |
| `POST`   | `/api/upload`                | Multipart upload (`file` + optional `expires`: `never`/`1h`/`24h`/`burn`), streamed to disk |
| `POST`   | `/api/text`                  | Share a text snippet (`{ "text": "...", "expires": "1h" }`)        |
| `GET`    | `/api/items/:id/download`   | Stream a file (`Content-Disposition` + HTTP Range; `?inline=1` for preview) |
| `DELETE` | `/api/items/:id`             | Delete an item and its file on disk                                |
| `POST`   | `/api/items/:id/copy`        | Register a text-snippet copy (counts toward burn)                  |
| `POST`   | `/api/items/clear-expired`   | Immediately remove expired items                                   |
| `POST`   | `/api/items/clear-all`       | Remove everything                                                  |
| `GET`    | `/api/events`                | SSE stream: `item:created`, `item:deleted`, `item:updated`, `clients`, heartbeat every 25s |
| `GET`    | `/api/server-info`           | LAN URL of the server                                              |
| `GET`    | `/api/qr?data=…`             | Render a QR code as SVG                                            |

### Expiration modes

- `never` — item stays until manually deleted
- `1h` / `24h` — auto-deleted by the cleanup worker once expired
- `burn` — files are deleted right after their **first full download** (partial `Range` requests from video scrubbing don't count); text snippets are deleted right after their **first copy**

## Notes

- Metadata lives in `data/items.json`; on boot, items whose backing file is missing are pruned automatically.
- The connected-devices counter reflects open SSE connections (tabs/devices with JanDrop open).
- Downloads use `Content-Disposition: attachment`; media previews and text links are served inline with Range support.

## Tech

Node.js ≥ 16 · Express · busboy · Server-Sent Events · vanilla JS SPA (no build step)
