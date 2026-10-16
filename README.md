# Lelouch · KXBTC15M paper dashboard

Read-only dashboard for the Kalshi **KXBTC15M** (BTC 15-minute up/down) paper bot. It shows the Safe and Bold accounts: status, equity, the live window, trades, blocked reasons, calibration, and reports.

The site is static. GitHub Pages or Vercel can host it. There is no server and no control that starts trading or changes a setting.

Opening the site with no hash loads `data/demo.json`, the embedded snapshot, and labels it **Example data**. A live feed is an encrypted JSON blob. The blob URL and the AES key live only in the URL hash, so they are not committed and are not sent to the host.

## Hash parameters

```
https://<host>/<path>/#src=<blob-url>&k=<base64-key>
```

| Parameter | Meaning |
| --- | --- |
| `src` | Absolute URL of the encrypted blob. Percent-encode it (`encodeURIComponent`). |
| `k` | Raw AES key, 16, 24, or 32 bytes, standard or URL-safe base64. Percent-encode it. |

Example (values are placeholders):

```
https://<user>.github.io/<repo>/#src=https%3A%2F%2Fexample.com%2Fkxbtc15m.json&k=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8%3D
```

The page reads the fragment in the browser. `+` inside a base64 key must be written as `%2B`. URL-safe base64 (`-` and `_`, padding optional) is accepted.

The page polls `src` every 15 seconds with `cache: no-store`. The subtitle shows **Updated Ns ago**, counted from `pushed_utc` (or from `generated_cst` when the wrapper has no push time). If that stamp does not change for 90 seconds, a **STALE** banner stays on screen. A failed poll keeps the last good payload and reports the error on the same line.

If the hash contains only one of `src` or `k`, the page shows an empty error state and does not fall back to the example snapshot.

## Blob format

The file at `src` is JSON:

```json
{
  "v": 1,
  "pushed_utc": "2026-10-16T21:40:56Z",
  "iv": "<base64 of the 12-byte IV>",
  "ct": "<base64 of ciphertext || 16-byte GCM tag>"
}
```

Version 1:

1. Serialize the dashboard object as UTF-8 JSON. The shape matches `data/demo.json` (`generated_cst`, `status`, `accounts.safe`, `accounts.bold`, `live`, `reports`).
2. gzip-compress those bytes (RFC 1952).
3. Encrypt with AES-GCM and a random 12-byte IV. WebCrypto appends the 16-byte authentication tag to the ciphertext.
4. Base64-encode the IV and the ciphertext. Set `pushed_utc` to the time of this push. Bump it on every publish so the page can tell new data from a cached body.

The host that serves the blob must allow the dashboard origin to read it (`Access-Control-Allow-Origin: *` or the Pages origin).

`scripts/make-blob.js` is a reference encoder. It prints a new key and writes a blob. Do not commit either.

```bash
node scripts/make-blob.js data/demo.json /tmp/kxbtc15m.json
```

## Deploy on GitHub Pages

1. Push this repository to GitHub. Publish the branch that contains `index.html` at the repository root (`main`, or a release branch).
2. Open the repository **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Choose that branch and the folder **`/ (root)`**. Save.
5. Wait until the Pages deploy finishes. The site URL is shown at the top of the Pages settings.
6. Visit that URL to see the example snapshot. Append `#src=...&k=...` to connect the live blob.

Assets use relative paths, so a project site (`https://<user>.github.io/<repo>/`) and a user site both work. Do not commit the key, and do not put `src` or `k` in a query string. A query string would be sent to the host and may land in logs. The fragment is not.

GitHub Pages only serves files that are in the repository. The encrypted blob stays on whatever URL you control (object storage, a gist-like raw host, the bot's own HTTPS endpoint). That URL has to send CORS headers the browser will accept.

## Deploy on Vercel

1. Import the repository.
2. Framework preset: **Other**. There is no build command. Output is the repository root.
3. Deploy, then open the deployment URL with the same hash.

## Local preview

```bash
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/` for the example snapshot.

`npm test` checks the demo snapshot and a gzip + AES-GCM round trip. It does not start a server.

## What the page shows

Status pills for trading, autopilot, and the recorder. Safe and Bold cards (equity, P&L, win rate, drawdown, peak). Equity curves. The current 15-minute window (BTC spot against the strike, minutes left, YES and NO bid/ask) plus recent official results. A trade table filtered by account, side, price bucket, exit, and result, with a row that expands to gates and settlement. Blocked-trade reasons, P&L by price bucket, YES vs NO and exit type, model-vs-market Brier scores with a reliability chart, and the text reports.

Filters and report tabs only change what you are looking at.
