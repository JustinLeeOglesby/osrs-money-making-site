import { useMemo } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { useRecipeAlerts } from '../../context/RecipeAlertsContext';
import { RECIPE_ALERT_THRESHOLD } from '../../utils/constants';

// Profit Alerts tab.
//
// Lists every recipe the user has subscribed to (via the 🔔 icon on the
// recipe row) and shows its current profit status. Recipes that are
// currently above the threshold get a 🟢 indicator + the float-to-top
// treatment so the user sees them first. Items below threshold sink to
// the bottom of the list.
//
// Browser-notification status is shown at the top so the user can re-
// request permission if they denied initially.
export default function AlertsTab({ payload }) {
  const {
    items,
    triggered,
    toggle,
    notificationPermission,
    requestNotificationPermission,
    acknowledgeAll,
  } = useRecipeAlerts();

  // Join watched recipe names with the latest payload data.
  const rows = useMemo(() => {
    if (!payload) return items.map((it) => ({ ...it, recipe: null }));
    const byName = new Map(payload.recipes.map((r) => [r.name, r]));
    return items.map((it) => ({ ...it, recipe: byName.get(it.name) || null }));
  }, [items, payload]);

  // Sort triggered (profitable) first, then by added-date desc.
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aT = triggered.has(a.name) ? 0 : 1;
      const bT = triggered.has(b.name) ? 0 : 1;
      if (aT !== bT) return aT - bT;
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
  }, [rows, triggered]);

  const triggeredCount = triggered.size;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          <strong>Profit Alerts</strong> — recipes I'll notify you about when their margin flips
          above {RECIPE_ALERT_THRESHOLD} gp.{' '}
          {items.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>
              No alerts set yet. Click the 🔕 icon on any recipe row to start watching it.
            </span>
          ) : (
            <>
              {items.length} watched ·{' '}
              <span style={{ color: triggeredCount > 0 ? 'var(--green)' : 'var(--muted)' }}>
                {triggeredCount} currently profitable
              </span>
            </>
          )}
        </div>

        <div className="alch-controls">
          <NotificationStatusButton
            permission={notificationPermission}
            onRequest={requestNotificationPermission}
          />
          {triggeredCount > 0 && (
            <button
              className="range-btn"
              onClick={acknowledgeAll}
              title="Acknowledge all currently-triggered alerts. They'll re-fire when the recipe drops below threshold and crosses back up."
            >
              Acknowledge all
            </button>
          )}
        </div>

        <div className="alch-note">
          💡 Alerts trigger once per "flip" — when a recipe crosses from below {RECIPE_ALERT_THRESHOLD} gp
          back into the profit zone. The trigger auto-resets when the recipe drops back below
          threshold, so the next flip alerts again. Browser notifications fire if permission is granted
          and at least one browser tab is open in the background; the in-app 🔔 badge in the sidebar
          works regardless. Recipes refresh on tab load and via a 10-minute background poll while you
          have any alerts active.
        </div>
      </div>

      {items.length === 0 ? null : (
        <div className="table-scroll">
          <table className="alch-table bounded-table">
            <thead>
              <tr>
                <th style={{ width: '2.5em' }} />
                <th className="left">Recipe</th>
                <th className="right">Current profit</th>
                <th className="right">GP / XP</th>
                <th className="right">Hourly volume</th>
                <th className="left">Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ name, recipe }) => {
                const isTriggered = triggered.has(name);
                const profit = recipe?.profit ?? null;
                const xp = recipe?.xp ?? null;
                const vol = recipe?.outputHourlyVolume ?? null;
                return (
                  <tr key={name}>
                    <td>
                      <span
                        className={`alert-pip ${
                          isTriggered ? 'triggered' : profit != null && profit < 0 ? 'neg' : 'idle'
                        }`}
                        title={
                          isTriggered
                            ? `Above threshold (+${profit?.toLocaleString()} gp)`
                            : profit != null
                              ? `Currently ${fmtGp(profit)} per cast`
                              : 'No data yet — refresh prices'
                        }
                      >
                        {isTriggered ? '🟢' : profit != null && profit < 0 ? '🔴' : '○'}
                      </span>
                    </td>
                    <td className="left">{name}</td>
                    <td className="right" style={{ color: profit != null ? profitColor(profit) : undefined, fontWeight: 600 }}>
                      {profit != null ? fmtGp(profit) : '—'}
                    </td>
                    <td className="right">
                      {profit != null && xp ? fmtGp(Math.round(profit / xp)) : '—'}
                    </td>
                    <td className="right">{vol != null ? vol.toLocaleString() : '—'}</td>
                    <td className="left" style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
                      {isTriggered ? 'Triggered (above threshold)' : 'Watching for flip'}
                    </td>
                    <td className="right">
                      <button
                        className="range-btn"
                        onClick={() => toggle(name)}
                        title="Stop watching this recipe"
                      >
                        Stop
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NotificationStatusButton({ permission, onRequest }) {
  if (typeof Notification === 'undefined') {
    return (
      <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
        Browser notifications not supported on this device
      </span>
    );
  }
  if (permission === 'granted') {
    return (
      <span style={{ color: 'var(--green)', fontSize: '0.85em' }} title="OS-level notifications enabled">
        ● Notifications on
      </span>
    );
  }
  if (permission === 'denied') {
    return (
      <span style={{ color: 'var(--red)', fontSize: '0.85em' }} title="Notifications were blocked. Re-enable in browser site settings.">
        ● Notifications blocked — re-enable in browser settings
      </span>
    );
  }
  return (
    <button
      className="range-btn"
      onClick={onRequest}
      title="Allow browser notifications so alerts fire even when the tab isn't focused"
    >
      Enable notifications
    </button>
  );
}
