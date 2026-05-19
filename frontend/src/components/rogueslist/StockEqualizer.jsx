import { useEffect, useMemo, useState } from 'react';
import { fmtGp } from '../../utils/format';
import { ROGUES_STOCKS_STORAGE_KEY } from '../../utils/constants';

// Stock Equalizer — small calculator for the user's curated Rogues' Den
// running list.
//
// Problem it solves: each item in the running list has a different N
// (sells-per-session). Item A might be 5/session, B 10/session, C 20/session.
// If A and C both have "100 in stock" the user gets 20 sessions of A but
// only 5 of C — they'll run dry on C first and the rotation falls apart.
//
// The right invariant to maintain is *sessions remaining per item*, not
// raw quantity. This calculator:
//   1. Lets the user enter their current stock + their preferred N per item
//   2. Auto-computes sessions-remaining per item
//   3. Picks a "target sessions" (default: the max across all items, but
//      overridable to e.g. 10 if they want to top everyone up to that bar)
//   4. Reports how many to buy of each, and the total gp cost
//
// Persists to localStorage with key ROGUES_STOCKS_STORAGE_KEY — synced via
// SyncContext so the inventory state follows the user across devices.

function loadStocks() {
  try {
    const raw = localStorage.getItem(ROGUES_STOCKS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Parse a possibly-empty user input into a non-negative integer; "" → 0.
function parseInt0(v) {
  if (v === '' || v == null) return 0;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export default function StockEqualizer({ items, byId, defaultSellsPerSession = 20 }) {
  const [stocks, setStocks] = useState(loadStocks);
  // Override the auto-computed target. null = "use the auto max."
  const [targetOverride, setTargetOverride] = useState('');

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_STOCKS_STORAGE_KEY, JSON.stringify(stocks));
    } catch {
      /* session-only fallback */
    }
  }, [stocks]);

  // For each list item, gather inputs + live data into a derived row.
  const rows = useMemo(() => {
    return items.map((it) => {
      const live = byId.get(it.id);
      const s = stocks[it.id] || {};
      const qty = s.qty ?? 0;
      const n = s.n ?? defaultSellsPerSession;
      const sessionsLeft = n > 0 ? qty / n : 0;
      return {
        id: it.id,
        name: it.name || live?.name || `Item ${it.id}`,
        buyPrice: live?.buyPrice ?? null,
        qty,
        n,
        sessionsLeft,
      };
    });
  }, [items, byId, stocks, defaultSellsPerSession]);

  const autoTarget = rows.length ? Math.max(...rows.map((r) => r.sessionsLeft)) : 0;
  const parsedOverride = targetOverride !== '' ? Number(targetOverride) : null;
  const target = parsedOverride != null && Number.isFinite(parsedOverride) && parsedOverride >= 0
    ? parsedOverride
    : autoTarget;

  // Enrich with "need to buy" + cost.
  const enriched = useMemo(() => {
    return rows.map((r) => {
      const ideal = Math.ceil(target * r.n);
      const need = Math.max(0, ideal - r.qty);
      const cost = r.buyPrice != null ? need * r.buyPrice : null;
      return { ...r, need, cost };
    });
  }, [rows, target]);

  // Roll-up totals
  const totals = useMemo(() => {
    let totalNeed = 0;
    let totalCost = 0;
    let costAvailable = true;
    for (const r of enriched) {
      totalNeed += r.need;
      if (r.cost == null) costAvailable = false;
      else totalCost += r.cost;
    }
    return { totalNeed, totalCost, costAvailable };
  }, [enriched]);

  const updateQty = (id, val) => {
    setStocks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), qty: parseInt0(val) },
    }));
  };

  const updateN = (id, val) => {
    setStocks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), n: parseInt0(val) },
    }));
  };

  const resetAllStocks = () => {
    if (!confirm('Reset all stock quantities to 0? (Your sells/session values stay.)')) return;
    setStocks((prev) => {
      const next = {};
      for (const id of Object.keys(prev)) {
        next[id] = { ...prev[id], qty: 0 };
      }
      return next;
    });
  };

  return (
    <div className="stock-equalizer">
      <div className="alch-header">
        <div className="alch-summary">
          <strong>Stock equalizer</strong> — enter what you currently have of each item;
          the table tells you how many to buy to equalize everyone to the same number
          of sessions remaining.
          {rows.length > 0 && (
            <>
              {' · '}
              <strong>Target:</strong>{' '}
              {target.toFixed(1)} sessions
              {parsedOverride == null && autoTarget > 0 && (
                <span style={{ color: 'var(--muted)' }}> (auto = max in list)</span>
              )}
              {' · '}
              <strong>Total to buy:</strong> {totals.totalNeed.toLocaleString()} items
              {totals.costAvailable && (
                <>
                  {' · '}
                  <strong>Cost:</strong> {fmtGp(totals.totalCost)} gp
                </>
              )}
            </>
          )}
        </div>

        <div className="alch-controls">
          <label className="min-filter">
            Target sessions:
            <input
              type="text"
              value={targetOverride}
              placeholder={autoTarget > 0 ? autoTarget.toFixed(1) : '—'}
              onChange={(e) => setTargetOverride(e.target.value)}
              inputMode="decimal"
              title="Override the auto-computed target (max sessions across items). Leave blank for auto."
              style={{ width: '5em' }}
            />
          </label>
          {targetOverride !== '' && (
            <button className="range-btn" onClick={() => setTargetOverride('')} title="Use auto target">
              Auto
            </button>
          )}
          <button className="range-btn" onClick={resetAllStocks} title="Reset all stock quantities to 0">
            Reset stocks
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="lab-panel-empty">
          Add items to your running list first — the equalizer works on the list above.
        </div>
      ) : (
        <div className="table-scroll">
          <table className="alch-table bounded-table">
            <thead>
              <tr>
                <th className="left">Item</th>
                <th className="right">Buy price</th>
                <th className="right">Sells / session</th>
                <th className="right">Current stock</th>
                <th className="right">Sessions left</th>
                <th className="right">Buy to equalize</th>
                <th className="right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((r) => {
                const isBehind = r.need > 0;
                const isTarget = Math.abs(r.sessionsLeft - target) < 0.05;
                return (
                  <tr key={r.id}>
                    <td className="left">{r.name}</td>
                    <td className="right">{r.buyPrice != null ? fmtGp(r.buyPrice) : '—'}</td>
                    <td className="right">
                      <input
                        type="text"
                        value={r.n}
                        onChange={(e) => updateN(r.id, e.target.value)}
                        inputMode="numeric"
                        style={{
                          width: '4em',
                          textAlign: 'right',
                          background: 'var(--bg)',
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          padding: '0.2em 0.4em',
                          fontFamily: 'inherit',
                          fontSize: '0.95em',
                        }}
                      />
                    </td>
                    <td className="right">
                      <input
                        type="text"
                        value={r.qty}
                        onChange={(e) => updateQty(r.id, e.target.value)}
                        inputMode="numeric"
                        style={{
                          width: '5em',
                          textAlign: 'right',
                          background: 'var(--bg)',
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          padding: '0.2em 0.4em',
                          fontFamily: 'inherit',
                          fontSize: '0.95em',
                        }}
                      />
                    </td>
                    <td
                      className="right"
                      style={{ color: isTarget ? 'var(--green)' : isBehind ? 'var(--red)' : 'var(--text)' }}
                    >
                      {r.sessionsLeft.toFixed(2)}
                    </td>
                    <td
                      className="right"
                      style={{ color: isBehind ? 'var(--red)' : 'var(--muted)', fontWeight: isBehind ? 600 : 400 }}
                    >
                      {r.need > 0 ? r.need.toLocaleString() : '✓'}
                    </td>
                    <td className="right" style={{ color: isBehind ? 'var(--red)' : 'var(--muted)' }}>
                      {r.cost != null && r.cost > 0 ? fmtGp(r.cost) : r.need === 0 ? '—' : '?'}
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
