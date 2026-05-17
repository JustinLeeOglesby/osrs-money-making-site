import { useGELimits, msRemaining, isReady } from '../../context/GELimitsContext';
import { useItemModal } from '../../context/ItemModalContext';
import { GE_LIMIT_WINDOW_MS } from '../../utils/constants';

// Pretty "1h 23m" formatter (consistent with the badge in ItemDetail).
function formatMsShort(ms) {
  if (ms <= 0) return '0m';
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// "Tuesday at 4:23 PM" for the absolute reset time tooltip.
function formatAbsoluteTime(ms) {
  return new Date(ms).toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function GELimitsTab() {
  const { entries, now, clear, clearAll } = useGELimits();
  const { open: openItemModal } = useItemModal();

  if (entries.length === 0) {
    return (
      <div className="graph-msg">
        No GE buy limits tracked yet. Open any item and click
        "📅 Mark buy limit hit" to start a 4-hour timer.
      </div>
    );
  }

  // Sort: ready items first, then by remaining time ascending.
  const sorted = [...entries].sort((a, b) => {
    const ra = msRemaining(a, now);
    const rb = msRemaining(b, now);
    if (ra <= 0 && rb > 0) return -1;
    if (rb <= 0 && ra > 0) return 1;
    return ra - rb;
  });

  return (
    <div className="gelimits-tab">
      <div className="alch-note">
        💡 GE buy limits reset 4 hours after your first purchase in that
        window. Click "Mark buy limit hit" on any item's detail panel to
        start the timer. Entries stay here even after they're ready so you
        have a reminder list — click ✕ to clear.
      </div>
      <div className="alch-controls" style={{ marginTop: '0.6em' }}>
        <button className="range-btn" onClick={clearAll}>Clear all</button>
      </div>
      <div className="gelimits-list">
        {sorted.map((entry) => {
          const ms = msRemaining(entry, now);
          const ready = ms <= 0;
          const resetAt = entry.startedAt + GE_LIMIT_WINDOW_MS;
          // Progress 0..1 through the 4hr window
          const pct = Math.min(1, Math.max(0, 1 - ms / GE_LIMIT_WINDOW_MS));
          return (
            <div
              key={entry.id}
              className={`gelimit-row ${ready ? 'ready' : ''}`}
            >
              <div
                className="gelimit-name clickable-item"
                onClick={() => openItemModal(entry.id)}
                title="Open item details"
              >
                {entry.name}
              </div>
              <div className="gelimit-status">
                {ready ? (
                  <span className="gelimit-ready">✅ Ready to buy</span>
                ) : (
                  <span title={`Resets ${formatAbsoluteTime(resetAt)}`}>
                    ⏳ {formatMsShort(ms)} remaining
                  </span>
                )}
              </div>
              <div className="gelimit-bar">
                <div
                  className="gelimit-bar-fill"
                  style={{ width: `${pct * 100}%` }}
                />
              </div>
              <button
                className="gelimit-close"
                onClick={() => clear(entry.id)}
                title="Clear this timer"
                aria-label="Clear"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
