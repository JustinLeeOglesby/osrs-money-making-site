// Cross-device sync helpers.
//
// Architecture: a user-chosen passphrase is hashed (SHA-256) client-side and
// sent to /api/sync/<hash> as the lookup key. The body is the full JSON blob
// of all "synced keys" in localStorage. Backend never sees the plaintext
// passphrase.
//
// Storage layout:
//   localStorage[SYNC_PASSPHRASE_KEY] = the raw passphrase, kept local-only
//   localStorage[SYNC_PUSHED_AT_KEY]  = ISO timestamp of last successful push
//                                       (used to detect "cloud is newer than local")

import {
  FAVORITES_STORAGE_KEY,
  ITEM_FAVORITES_STORAGE_KEY,
  WATCHLIST_STORAGE_KEY,
  GE_LIMITS_STORAGE_KEY,
  PACE_STORAGE_KEY,
  ROGUES_LIST_STORAGE_KEY,
  ROGUES_LAB_STORAGE_KEY,
  ROGUES_LAB_SETTINGS_KEY,
  RECIPE_ALERTS_STORAGE_KEY,
} from './constants';

export const SYNC_PASSPHRASE_KEY = 'osrs-margin-sync-passphrase';
export const SYNC_PUSHED_AT_KEY = 'osrs-margin-sync-pushed-at';

// Every localStorage key whose contents should round-trip through the cloud.
// Note `SYNC_PASSPHRASE_KEY` and `SYNC_PUSHED_AT_KEY` are deliberately NOT in
// this list — they're device-local control state, not synced content.
export const SYNCED_KEYS = [
  FAVORITES_STORAGE_KEY,
  ITEM_FAVORITES_STORAGE_KEY,
  WATCHLIST_STORAGE_KEY,
  GE_LIMITS_STORAGE_KEY,
  PACE_STORAGE_KEY,
  ROGUES_LIST_STORAGE_KEY,
  ROGUES_LAB_STORAGE_KEY,
  ROGUES_LAB_SETTINGS_KEY,
  RECIPE_ALERTS_STORAGE_KEY,
];

// SHA-256 → 64 hex chars. Web Crypto API, available in all modern browsers
// over HTTPS or on localhost.
export async function sha256Hex(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Read every synced key from localStorage into a flat `{key: parsed-value}`
// object. Missing keys are omitted (not stored as null) so a fresh device
// importing this blob doesn't clobber its empty state with explicit nulls.
export function snapshotLocal() {
  const blob = {};
  for (const k of SYNCED_KEYS) {
    const raw = localStorage.getItem(k);
    if (raw == null) continue;
    blob[k] = raw; // store the raw JSON string — keeps it opaque + identical to what providers set
  }
  return blob;
}

// Inverse of snapshotLocal: write a cloud blob into localStorage. Any synced
// keys not present in the blob get *cleared* on the local device, so an item
// removed on Device A actually disappears on Device B (rather than lingering).
export function applyToLocal(blob) {
  for (const k of SYNCED_KEYS) {
    if (blob && Object.prototype.hasOwnProperty.call(blob, k)) {
      localStorage.setItem(k, blob[k]);
    } else {
      localStorage.removeItem(k);
    }
  }
}

// Stable hash of the current local snapshot. Used to detect "did anything
// actually change since the last push?" so we don't spam the cloud with
// identical writes.
export async function snapshotFingerprint(blob) {
  // Deterministic key order so the same content always hashes the same way.
  const keys = Object.keys(blob).sort();
  const stringified = keys.map((k) => `${k}=${blob[k]}`).join('\n');
  return sha256Hex(stringified);
}

// HTTP wrappers around the backend endpoints.
export async function syncStatus() {
  try {
    const res = await fetch('/api/sync/status');
    if (!res.ok) return { enabled: false };
    return await res.json();
  } catch {
    return { enabled: false };
  }
}

export async function syncPull(hash) {
  const res = await fetch(`/api/sync/${hash}`);
  if (res.status === 503) return { available: false };
  if (!res.ok) throw new Error(`Sync pull failed: ${res.status}`);
  const json = await res.json();
  return { available: true, ...json };
}

export async function syncPush(hash, blob) {
  const res = await fetch(`/api/sync/${hash}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: blob }),
  });
  if (res.status === 503) return { available: false };
  if (!res.ok) throw new Error(`Sync push failed: ${res.status}`);
  const json = await res.json();
  return { available: true, ...json };
}
