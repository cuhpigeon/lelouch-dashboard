import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { ageSeconds, bytesFromB64, decryptBlob, isStale, noteStamp } from "../js/blob.js";
import { b64, encryptPayload } from "./make-blob.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const demo = JSON.parse(readFileSync(new URL("../data/demo.json", import.meta.url), "utf8"));

assert.equal(demo.accounts.safe.equity, 97.8);
assert.equal(demo.accounts.safe.pnl, -2.2);
assert.equal(demo.accounts.safe.win_rate, 25);
assert.equal(demo.accounts.safe.trades, 4);
assert.equal(demo.accounts.safe.peak, 100.25);
assert.equal(demo.accounts.bold.equity, 21.09);
assert.equal(demo.accounts.bold.pnl, -78.91);
assert.equal(demo.accounts.bold.trades, 13);
assert.equal(demo.status.trading_enabled, false);
assert.equal(demo.status.autopilot_running, false);
assert.equal(demo.status.recorder_running, true);
assert.equal(demo.accounts.safe.trade_list.length + demo.accounts.bold.trade_list.length, 17);
assert.ok(demo.live.latest.spot_median);
assert.equal(demo.live.latest.yes_bid, 0.26);
assert.equal(demo.live.latest.yes_ask, 0.27);
assert.equal(demo.live.latest.no_bid, 0.73);
assert.equal(demo.live.latest.no_ask, 0.74);
assert.ok(demo.accounts.safe.calibration.brier_model < demo.accounts.safe.calibration.brier_market);
assert.equal(demo.accounts.safe.calibration.bins.length, 10);
assert.equal(demo.reports.length, 2);
for (const name of ["safe", "bold"]) {
  const a = demo.accounts[name];
  for (const key of ["curve", "trade_list", "blocks", "by_bucket", "by_side", "by_exit", "by_order", "calibration"]) {
    assert.ok(a[key], `${name}.${key} missing`);
  }
}

const key = webcrypto.getRandomValues(new Uint8Array(32));
const pushed = "2026-10-16T21:40:56Z";
const blob = await encryptPayload(Buffer.from(JSON.stringify(demo)), key, pushed);
const round = await decryptBlob(blob, b64(key));
assert.equal(round.accounts.safe.equity, 97.8);
assert.equal(round.accounts.bold.trade_list.length, 13);
assert.equal(round.generated_cst, demo.generated_cst);

const urlKey = b64(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const blobUrl = {
  ...blob,
  iv: b64(bytesFromB64(blob.iv)).replace(/\+/g, "-").replace(/\//g, "_"),
  ct: b64(bytesFromB64(blob.ct)).replace(/\+/g, "-").replace(/\//g, "_"),
};
const viaUrl = await decryptBlob(blobUrl, urlKey);
assert.equal(viaUrl.live.latest.ticker, demo.live.latest.ticker);

await assert.rejects(() => decryptBlob(blob, b64(webcrypto.getRandomValues(new Uint8Array(32)))), /Decryption failed/);
await assert.rejects(() => decryptBlob({ ...blob, v: 2 }, b64(key)), /Unsupported blob version/);

assert.equal(ageSeconds(1_000, 1_000), 0);
assert.equal(ageSeconds(1_000, 91_500), 90);
assert.equal(isStale(1_000, 90_999), false);
assert.equal(isStale(1_000, 91_000), true);

const first = noteStamp("", { pushed_utc: pushed }, demo, Date.parse(pushed));
assert.equal(first.changed, true);
assert.equal(first.at, Date.parse(pushed));
const again = noteStamp(first.stamp, { pushed_utc: pushed }, demo, Date.parse(pushed) + 120_000);
assert.equal(again.changed, false);
assert.equal(isStale(first.at, Date.parse(pushed) + 120_000), true);

console.log("ok", {
  safe: demo.accounts.safe.equity,
  bold: demo.accounts.bold.equity,
  trades: 17,
  brier: [demo.accounts.safe.calibration.brier_model, demo.accounts.safe.calibration.brier_market],
});
