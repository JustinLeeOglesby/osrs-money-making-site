import { useState } from 'react';
import { fmtGp } from '../../utils/format';
import { useWatchlist } from '../../context/WatchlistContext';
import { useItemModal } from '../../context/ItemModalContext';

// Watchlist tab — list of items the user is tracking, each with optional
// low / high price targets. The provider polls live prices in the background
// (60s); rows that have crossed their target light up and (with permission)
// also fire a desktop notification.
export default function WatchlistTab() {
  const { items, prices, alerts, remove, update, dismissAlert } = useWatchlist();
  const { open: openItemModal } = useItemModal();
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );

  const requestNotifications = () => {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission().then(setNotifPermission);
  };

  if (items.length === 0) {
    return (
      <div className="graph-msg">
        Your watchlist is empty. Open any item and click the 👁 button to start watching it.
      </div>
    );
  }

  return (
    <div className="watchlist-tab">
      <div className="alch-note">
        💡 Set a low and/or high target on any item. While the app is open,
        prices refresh every minute and rows highlight when a target is hit.
        {notifPermission === 'default' && (
          <>
            {' '}
            <button className="range-btn" onClick={requestNotifications}>
              Enable desktop notifications
            </button>
          </>
        )}
        {notifPermission === 'denied' && (
          <span style={{ marginLeft: '0.5em', color: 'var(--red)' }}>
            Desktop notifications blocked — visual alerts only.
          </span>
        )}
      </div>
      <table className="alch-table watchlist-table">
        <thead>
          <tr>
            <th className="left">Item</th>
            <th className="right">Current high</th>
            <th className="right">Current low</th>
            <th className="right">Low target</th>
            <th className="right">High target</th>
            <th className="right">Status</th>
            <th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const p = prices[it.id];
            const lowKey = `${it.id}:low`;
            const highKey = `${it.id}:high`;
            const lowHit = alerts.has(lowKey);
            const highHit = alerts.has(highKey);
            return (
              <tr
                key={it.id}
                className={`watchlist-row ${lowHit || highHit ? 'alerting' : ''}`}
              >
                <td
                  className="left clickable-item"
                  onClick={() => openItemModal(it.id)}
                  title="Open item details"
                >
                  {it.name}
                </td>
                <td className="right" style={{ color: 'var(--red)' }}>
                  {p?.high != null ? fmtGp(p.high) : '—'}
                </td>
                <td className="right" style={{ color: 'var(--green)' }}>
                  {p?.low != null ? fmtGp(p.low) : '—'}
                </td>
                <td className="right">
                  <ThresholdInput
                    value={it.lowTarget}
                    onCommit={(v) => update(it.id, { lowTarget: v })}
                  />
                </td>
                <td className="right">
                  <ThresholdInput
                    value={it.highTarget}
                    onCommit={(v) => update(it.id, { highTarget: v })}
                  />
                </td>
                <td className="right">
                  {lowHit && (
                    <span
                      className="watchlist-alert low"
                      onClick={() => dismissAlert(lowKey)}
                      title="Click to dismiss"
                    >
                      ⬇ low hit
                    </span>
                  )}
                  {highHit && (
                    <span
                      className="watchlist-alert high"
                      onClick={() => dismissAlert(highKey)}
                      title="Click to dismiss"
                    >
                      ⬆ high hit
                    </span>
                  )}
                  {!lowHit && !highHit && (
                    <span style={{ color: 'var(--muted)' }}>—</span>
                  )}
                </td>
                <td className="right">
                  <button
                    className="range-btn"
                    onClick={() => remove(it.id)}
                    title="Stop watching"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Small numeric input that commits on blur or Enter. Empty value clears the
// target. Keeps a local string state so users can type freely without React
// stomping each keystroke.
function ThresholdInput({ value, onCommit }) {
  const [text, setText] = useState(value != null ? String(value) : '');

  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      onCommit(null);
      return;
    }
    const n = Number(trimmed.replace(/[,_\s]/g, ''));
    if (!Number.isFinite(n) || n <= 0) {
      setText(value != null ? String(value) : '');
      return;
    }
    onCommit(Math.round(n));
    setText(String(Math.round(n)));
  };

  return (
    <input
      type="text"
      className="watchlist-threshold-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setText(value != null ? String(value) : '');
      }}
      placeholder="—"
      inputMode="numeric"
    />
  );
}
