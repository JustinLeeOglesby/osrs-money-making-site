import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  SYNC_PASSPHRASE_KEY,
  SYNC_PUSHED_AT_KEY,
  sha256Hex,
  snapshotLocal,
  applyToLocal,
  snapshotFingerprint,
  syncStatus,
  syncPull,
  syncPush,
} from '../utils/sync';

// Cross-device sync controller.
//
// Lifecycle:
//   - On mount: probe /api/sync/status to learn whether the backend has sync
//     wired up (only true when Render's Postgres is attached). If not, sync
//     UI hides itself and existing localStorage providers behave normally.
//   - On mount with passphrase set: pull from cloud. If cloud is newer than
//     local `pushedAt`, apply cloud blob to localStorage and reload the page
//     so every provider re-reads fresh data.
//   - Background poll (every 2 s): compare current local fingerprint to last
//     pushed fingerprint. If changed, debounced-push to cloud.
//
// We deliberately don't intercept localStorage writes per-provider — polling
// is dumb but lets us add sync without touching any existing provider code.
// The 2 s overhead is trivial (a single hash over ~7 short strings).

const SyncContext = createContext({
  available: false,
  passphrase: '',
  hash: null,
  status: 'idle',
  lastSyncedAt: null,
  setPassphrase: () => {},
  clearPassphrase: () => {},
  pullNow: () => {},
  pushNow: () => {},
});

export const useSync = () => useContext(SyncContext);

const POLL_INTERVAL_MS = 2000;
const PUSH_DEBOUNCE_MS = 1500;

export function SyncProvider({ children }) {
  // Backend availability — set once on mount. While unknown we default to
  // disabled so the UI never offers sync that won't work.
  const [available, setAvailable] = useState(false);

  // Passphrase is loaded eagerly from localStorage so a returning user is
  // already "signed in." If they want to switch passphrases they hit the
  // settings panel.
  const [passphrase, setPassphraseState] = useState(
    () => localStorage.getItem(SYNC_PASSPHRASE_KEY) || ''
  );
  const [hash, setHash] = useState(null);

  // Status surface for the settings UI: 'idle' | 'syncing' | 'ok' | 'error' |
  // 'conflict' (cloud has data, asking what to do). lastSyncedAt is the
  // ISO timestamp of the most recent successful push or pull.
  const [status, setStatus] = useState('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(
    () => localStorage.getItem(SYNC_PUSHED_AT_KEY) || null
  );
  // For the first-connect choice. When non-null the UI should prompt:
  // "cloud has data updated at X — use cloud or overwrite with local?"
  const [pendingConflict, setPendingConflict] = useState(null);

  // Last pushed fingerprint, kept in a ref because we only want to read it
  // inside the poller without retriggering effects.
  const lastPushedFingerprintRef = useRef(null);
  const pushTimerRef = useRef(null);

  // Probe backend availability once.
  useEffect(() => {
    let cancelled = false;
    syncStatus().then((s) => {
      if (!cancelled) setAvailable(!!s.enabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Compute hash whenever passphrase changes.
  useEffect(() => {
    let cancelled = false;
    if (!passphrase) {
      setHash(null);
      return;
    }
    sha256Hex(passphrase).then((h) => {
      if (!cancelled) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, [passphrase]);

  // Initial pull on mount when both passphrase + backend are ready.
  const initialPullDoneRef = useRef(false);
  useEffect(() => {
    if (!available || !hash || initialPullDoneRef.current) return;
    initialPullDoneRef.current = true;

    (async () => {
      setStatus('syncing');
      try {
        const { data, updatedAt } = await syncPull(hash);
        const localPushedAt = localStorage.getItem(SYNC_PUSHED_AT_KEY);
        const localBlob = snapshotLocal();
        const localEmpty = Object.keys(localBlob).length === 0;

        if (data == null) {
          // Cloud has no record yet — push local as the initial seed.
          await pushBlobToCloud(hash, localBlob);
          setStatus('ok');
          setStatusDetail('Pushed local data to cloud as initial seed.');
          return;
        }

        // Cloud has data. Three cases:
        //   1. Local is empty → use cloud (no risk of data loss).
        //   2. Local has data AND we pushed it ourselves recently
        //      (localPushedAt is set and ≥ cloud updatedAt) → already in sync.
        //   3. Local has data AND cloud is newer → ask user.
        if (localEmpty) {
          applyToLocal(data);
          const fp = await snapshotFingerprint(snapshotLocal());
          lastPushedFingerprintRef.current = fp;
          localStorage.setItem(SYNC_PUSHED_AT_KEY, updatedAt);
          setLastSyncedAt(updatedAt);
          setStatus('ok');
          setStatusDetail('Pulled cloud data (local was empty). Reloading…');
          // Reload so every context picks up the fresh localStorage values.
          setTimeout(() => window.location.reload(), 400);
          return;
        }

        const localFp = await snapshotFingerprint(localBlob);
        const cloudFp = await snapshotFingerprint(data);
        if (localFp === cloudFp) {
          // Identical content — nothing to do.
          lastPushedFingerprintRef.current = localFp;
          if (updatedAt) {
            localStorage.setItem(SYNC_PUSHED_AT_KEY, updatedAt);
            setLastSyncedAt(updatedAt);
          }
          setStatus('ok');
          setStatusDetail('In sync.');
          return;
        }

        if (localPushedAt && updatedAt && localPushedAt >= updatedAt) {
          // We have a newer local copy than cloud — push it.
          await pushBlobToCloud(hash, localBlob);
          setStatus('ok');
          setStatusDetail('Local was newer than cloud; pushed.');
          return;
        }

        // Conflict: cloud has data and local has different data, no
        // pushedAt to disambiguate. Hand off to the UI.
        setPendingConflict({ cloudData: data, cloudUpdatedAt: updatedAt });
        setStatus('conflict');
        setStatusDetail('Cloud and local both have data — choose which to keep.');
      } catch (e) {
        setStatus('error');
        setStatusDetail(e.message);
      }
    })();
  }, [available, hash]);

  // Background poller: detect local changes and push them.
  useEffect(() => {
    if (!available || !hash || pendingConflict) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const blob = snapshotLocal();
      const fp = await snapshotFingerprint(blob);
      if (fp === lastPushedFingerprintRef.current) return; // unchanged
      // Debounce: if another change comes in within 1.5 s, the timer resets
      // and we push the combined latest state.
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      pushTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        try {
          await pushBlobToCloud(hash, blob);
        } catch (e) {
          setStatus('error');
          setStatusDetail(e.message);
        }
      }, PUSH_DEBOUNCE_MS);
    };

    const intervalId = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
  }, [available, hash, pendingConflict]);

  // Helper: actually push a blob to cloud and update local bookkeeping.
  const pushBlobToCloud = useCallback(async (h, blob) => {
    setStatus('syncing');
    const result = await syncPush(h, blob);
    if (!result.available) {
      setStatus('error');
      setStatusDetail('Sync server unavailable.');
      return;
    }
    const fp = await snapshotFingerprint(blob);
    lastPushedFingerprintRef.current = fp;
    localStorage.setItem(SYNC_PUSHED_AT_KEY, result.updatedAt);
    setLastSyncedAt(result.updatedAt);
    setStatus('ok');
    setStatusDetail('Synced.');
  }, []);

  // Public API: set the passphrase. Persists to localStorage and triggers
  // the pull-on-mount flow.
  const setPassphrase = useCallback((p) => {
    const trimmed = (p || '').trim();
    if (!trimmed) return;
    localStorage.setItem(SYNC_PASSPHRASE_KEY, trimmed);
    setPassphraseState(trimmed);
    // Reset bookkeeping so the next mount's initial-pull runs again.
    initialPullDoneRef.current = false;
    lastPushedFingerprintRef.current = null;
    setStatus('syncing');
    setStatusDetail('');
  }, []);

  const clearPassphrase = useCallback(() => {
    localStorage.removeItem(SYNC_PASSPHRASE_KEY);
    localStorage.removeItem(SYNC_PUSHED_AT_KEY);
    setPassphraseState('');
    setHash(null);
    setLastSyncedAt(null);
    setStatus('idle');
    setStatusDetail('');
    setPendingConflict(null);
    lastPushedFingerprintRef.current = null;
    initialPullDoneRef.current = false;
  }, []);

  const pullNow = useCallback(async () => {
    if (!hash) return;
    setStatus('syncing');
    try {
      const { data, updatedAt } = await syncPull(hash);
      if (data == null) {
        setStatus('error');
        setStatusDetail('No cloud data found for this passphrase.');
        return;
      }
      applyToLocal(data);
      const fp = await snapshotFingerprint(snapshotLocal());
      lastPushedFingerprintRef.current = fp;
      localStorage.setItem(SYNC_PUSHED_AT_KEY, updatedAt);
      setLastSyncedAt(updatedAt);
      setStatus('ok');
      setStatusDetail('Pulled cloud data. Reloading…');
      setTimeout(() => window.location.reload(), 400);
    } catch (e) {
      setStatus('error');
      setStatusDetail(e.message);
    }
  }, [hash]);

  const pushNow = useCallback(async () => {
    if (!hash) return;
    try {
      await pushBlobToCloud(hash, snapshotLocal());
    } catch (e) {
      setStatus('error');
      setStatusDetail(e.message);
    }
  }, [hash, pushBlobToCloud]);

  // Conflict-resolution actions surfaced to the settings UI.
  const resolveConflictUseCloud = useCallback(async () => {
    if (!pendingConflict) return;
    applyToLocal(pendingConflict.cloudData);
    lastPushedFingerprintRef.current = await snapshotFingerprint(snapshotLocal());
    if (pendingConflict.cloudUpdatedAt) {
      localStorage.setItem(SYNC_PUSHED_AT_KEY, pendingConflict.cloudUpdatedAt);
      setLastSyncedAt(pendingConflict.cloudUpdatedAt);
    }
    setPendingConflict(null);
    setStatus('ok');
    setStatusDetail('Using cloud data. Reloading…');
    setTimeout(() => window.location.reload(), 400);
  }, [pendingConflict]);

  const resolveConflictUseLocal = useCallback(async () => {
    if (!pendingConflict || !hash) return;
    try {
      await pushBlobToCloud(hash, snapshotLocal());
      setPendingConflict(null);
    } catch (e) {
      setStatus('error');
      setStatusDetail(e.message);
    }
  }, [pendingConflict, hash, pushBlobToCloud]);

  const value = useMemo(
    () => ({
      available,
      passphrase,
      hash,
      status,
      statusDetail,
      lastSyncedAt,
      pendingConflict,
      setPassphrase,
      clearPassphrase,
      pullNow,
      pushNow,
      resolveConflictUseCloud,
      resolveConflictUseLocal,
    }),
    [
      available,
      passphrase,
      hash,
      status,
      statusDetail,
      lastSyncedAt,
      pendingConflict,
      setPassphrase,
      clearPassphrase,
      pullNow,
      pushNow,
      resolveConflictUseCloud,
      resolveConflictUseLocal,
    ]
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
