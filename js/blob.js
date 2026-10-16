// Live feed blob (version 1):
//   { v: 1, pushed_utc: ISO-8601, iv: base64, ct: base64 }
// ct is AES-GCM (ciphertext || 16-byte tag) of gzip-compressed UTF-8 JSON.
// The raw key is 16, 24, or 32 bytes, base64 or base64url, supplied out of band.

export const STALE_AFTER_S = 90;

export function bytesFromB64(value) {
  if (value == null || value === "") throw new Error("Missing base64 value");
  const norm = String(value).trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(norm)) throw new Error("Key or blob field is not valid base64");
  const pad = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ageSeconds(lastNewMs, now = Date.now()) {
  if (lastNewMs == null || !Number.isFinite(lastNewMs)) return null;
  return Math.max(0, Math.floor((now - lastNewMs) / 1000));
}

export function isStale(lastNewMs, now = Date.now(), limit = STALE_AFTER_S) {
  const age = ageSeconds(lastNewMs, now);
  return age != null && age >= limit;
}

/** @returns {number|null} ms timestamp of the newest stamp, or null if unchanged */
export function noteStamp(previousStamp, blob, payload, now = Date.now()) {
  const pushed = blob && blob.pushed_utc;
  const stamp = pushed || payload?.generated_cst || payload?.status?.now_cst || "";
  if (!stamp || stamp === previousStamp) return { stamp: previousStamp, changed: false, at: null };
  const parsed = Date.parse(pushed || "");
  return { stamp, changed: true, at: Number.isFinite(parsed) ? parsed : now };
}

export async function decryptBlob(blob, keyB64) {
  if (!blob || typeof blob !== "object") throw new Error("Blob is not JSON");
  if (blob.v !== 1 && blob.v !== "1") throw new Error(`Unsupported blob version: ${blob.v}`);
  const keyBytes = bytesFromB64(keyB64);
  if (keyBytes.length !== 16 && keyBytes.length !== 24 && keyBytes.length !== 32) {
    throw new Error("Key must be 16, 24, or 32 bytes (AES-128/192/256)");
  }
  const iv = bytesFromB64(blob.iv);
  const ct = bytesFromB64(blob.ct);
  if (iv.length < 12) throw new Error("IV is shorter than 12 bytes");
  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  } catch {
    throw new Error("Could not import AES-GCM key");
  }
  let plain;
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct));
  } catch {
    throw new Error("Decryption failed (wrong key, truncated blob, or bad IV)");
  }
  const jsonBytes = await maybeGunzip(plain);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    throw new Error("Decrypted payload is not UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Decrypted payload is not JSON");
  }
}

async function maybeGunzip(bytes) {
  const gzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!gzip) return bytes;
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot gunzip the payload");
  }
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error("gzip decompression failed");
  }
}
