import { useState } from 'react';
import { useSync } from '../context/SyncContext';

// Settings modal for cross-device sync. Shows current state + lets the user
// set / change / clear the sync passphrase, manually push or pull, and
// resolve the "both local and cloud have data" conflict on first connect.
export default function SyncPanel({ onClose }) {
  const {
    available,
    passphrase,
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
  } = useSync();

  const [draft, setDraft] = useState(passphrase);
  const [showPassphrase, setShowPassphrase] = useState(false);

  if (!available) {
    return (
      <div className="sync-modal-backdrop" onClick={onClose}>
        <div className="sync-modal" onClick={(e) => e.stopPropagation()}>
          <div className="sync-modal-header">
            Cross-device sync
            <button className="sync-close" onClick={onClose}>✕</button>
          </div>
          <div className="sync-modal-body">
            <p style={{ color: 'var(--muted)' }}>
              Sync isn't configured on this server. It requires a Postgres database
              connection (Render adds this automatically when the next deploy runs
              with the updated <code>render.yaml</code>).
            </p>
            <p style={{ color: 'var(--muted)', fontSize: '0.85em', marginTop: '1em' }}>
              Until then, your data stays in this browser's localStorage.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const onSave = () => {
    if (draft.trim().length < 4) return;
    setPassphrase(draft);
  };

  const onClear = () => {
    if (!confirm('Clear sync passphrase? Local data stays; cloud sync stops.')) return;
    clearPassphrase();
    setDraft('');
  };

  return (
    <div className="sync-modal-backdrop" onClick={onClose}>
      <div className="sync-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sync-modal-header">
          Cross-device sync
          <button className="sync-close" onClick={onClose}>✕</button>
        </div>

        <div className="sync-modal-body">
          {/* --- Conflict resolution: only shown on first connect when both
              local and cloud have data and we don't know which to keep. --- */}
          {pendingConflict && (
            <div className="sync-conflict">
              <strong>Both this device and the cloud have data.</strong>
              <p style={{ margin: '0.5em 0', fontSize: '0.9em' }}>
                Cloud last updated:{' '}
                {pendingConflict.cloudUpdatedAt
                  ? new Date(pendingConflict.cloudUpdatedAt).toLocaleString()
                  : 'unknown'}
                . Pick one — the other will be replaced.
              </p>
              <div className="sync-buttons">
                <button className="range-btn" onClick={resolveConflictUseCloud}>
                  Use cloud (replace local)
                </button>
                <button className="range-btn" onClick={resolveConflictUseLocal}>
                  Use local (overwrite cloud)
                </button>
              </div>
            </div>
          )}

          {/* --- Status row --- */}
          <div className="sync-status-row">
            <StatusBadge status={status} />
            <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
              {statusDetail || (passphrase ? '' : 'No passphrase set')}
            </span>
          </div>
          {lastSyncedAt && (
            <div style={{ color: 'var(--muted)', fontSize: '0.8em', marginBottom: '0.8em' }}>
              Last synced: {new Date(lastSyncedAt).toLocaleString()}
            </div>
          )}

          {/* --- Passphrase entry --- */}
          <div className="sync-field">
            <label htmlFor="sync-passphrase">Sync passphrase</label>
            <div style={{ display: 'flex', gap: '0.4em' }}>
              <input
                id="sync-passphrase"
                type={showPassphrase ? 'text' : 'password'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Pick something memorable (e.g. osrs-myname-2026)"
                style={{ flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSave();
                }}
              />
              <button
                className="range-btn"
                onClick={() => setShowPassphrase((v) => !v)}
                title={showPassphrase ? 'Hide' : 'Show'}
              >
                {showPassphrase ? '🙈' : '👁'}
              </button>
            </div>
            <div className="sync-help">
              Use the <em>same</em> passphrase on every device. Anyone who knows it
              can read your data — keep it private but it doesn't need to be a
              security-grade password. Minimum 4 characters.
            </div>
          </div>

          {/* --- Actions --- */}
          <div className="sync-buttons">
            <button
              className="range-btn"
              onClick={onSave}
              disabled={!draft || draft.trim().length < 4 || draft === passphrase}
              title="Save passphrase and sync"
            >
              {passphrase ? 'Update passphrase' : 'Enable sync'}
            </button>
            {passphrase && (
              <>
                <button className="range-btn" onClick={pushNow} title="Push local data to cloud now">
                  Push now
                </button>
                <button className="range-btn" onClick={pullNow} title="Pull cloud data (replaces local)">
                  Pull now
                </button>
                <button className="range-btn" onClick={onClear} title="Stop syncing on this device">
                  Stop syncing
                </button>
              </>
            )}
          </div>

          <div className="sync-help" style={{ marginTop: '1.2em' }}>
            <strong>How it works:</strong> after enabling, every change you make
            (favorites, watchlist, Rogues' list/lab, etc.) is pushed to the cloud
            within a couple seconds. On a fresh device, enter the same passphrase
            and your data pulls down on page load. Last write wins — if you edit
            on two devices at the exact same time, the most recent edit clobbers
            the other.
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    idle:     { color: 'var(--muted)', label: '○ idle' },
    syncing:  { color: 'var(--accent)', label: '↻ syncing' },
    ok:       { color: 'var(--green)', label: '● synced' },
    error:    { color: 'var(--red)', label: '● error' },
    conflict: { color: '#f3c54a', label: '⚠ conflict' },
  };
  const s = map[status] || map.idle;
  return (
    <span style={{ color: s.color, fontWeight: 600, fontSize: '0.9em' }}>
      {s.label}
    </span>
  );
}
