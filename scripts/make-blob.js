// Reference encoder for the dashboard blob. Not used by the page.
//   node scripts/make-blob.js [input.json] [output.json]
// Prints the base64 key. Put it only in the URL hash, never in the repo.

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { webcrypto } from "node:crypto";

const crypto = globalThis.crypto ?? webcrypto;

export function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

export async function encryptPayload(jsonBytes, keyBytes, pushedUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) {
  if (![16, 24, 32].includes(keyBytes.length)) throw new Error("key must be 16, 24, or 32 bytes");
  const gz = gzipSync(jsonBytes);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gz));
  return {
    v: 1,
    pushed_utc: pushedUtc,
    iv: b64(iv),
    ct: b64(ct),
  };
}

async function main() {
  const input = process.argv[2] || new URL("../data/demo.json", import.meta.url);
  const output = process.argv[3] || "blob.json";
  const json = readFileSync(input);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const pushed = process.env.PUSHED_UTC || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const blob = await encryptPayload(json, key, pushed);
  writeFileSync(output, JSON.stringify(blob));
  const keyB64 = b64(key);
  console.log(`wrote ${output}`);
  console.log(`k=${keyB64}`);
  console.log(`pushed_utc=${blob.pushed_utc}`);
}

const invoked = process.argv[1] && process.argv[1].endsWith("make-blob.js");
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
