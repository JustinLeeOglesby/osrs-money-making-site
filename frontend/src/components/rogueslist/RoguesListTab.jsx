import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchHighAlch } from '../../api/client';
import { useRoguesList } from '../../context/RoguesListContext';
import { useItemModal } from '../../context/ItemModalContext';
import {
  ROGUES_LAB_SETTINGS_KEY,
  ROGUES_LAB_DEFAULTS,
  ROGUES_LIST_MAX,
} from '../../utils/constants';
import { computeRoguesMetrics } from '../../utils/rogues';
import StockEqualizer from './StockEqualizer';
import { ROGUES_STOCKS_STORAGE_KEY, ROGUES_EQUALIZER_OPEN_KEY } from '../../utils/constants';

// Per-item stock + N storage shared with the StockEqualizer. Lifting this
// state into the tab lets both the running list (which uses N for profit
// math) and the equalizer table edit the same map. Persisted via the
// storage key already in SYNCED_KEYS so changes propagate across devices.
function loadStocks() {
  try {
    const raw = localStorage.getItem(ROGUES_STOCKS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function parseInt0(v) {
  if (v === '' || v == null) return 0;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Parse a comma-tolerant numeric input. Returns null for empty/invalid
// (used to clear the override), otherwise a non-negative integer.
function parseGpOrNull(v) {
  if (v == null || v === '') return null;
  const cleaned = String(v).replace(/[,_\s]/g, '');
  if (!cleaned) return null;
  const n = Math.floor(Number(cleaned));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Rogues' Den Running List.
//
// The user's curated, stable pool of items they cycle through Martin Thwait's
// shop. Sized to their playstyle math (hours × sells/hour ÷ 4 × buy_limit ×
// buffer), not a fixed cap. The list itself is unbounded — coverage math at
// the top tells the user when the pool is too thin or comfortably oversized.
//
// Three sections, top to bottom:
//   1. The Running List — items the user actively buys and cycles
//   2. Recommendations — priority candidates (buy_limit ≤ 125) not on the list
//   3. Fallback safety net (collapsed) — high-volume staples like Rune arrow
//
// All verdict/Phase complexity is intentionally absent here — that lives in
// the lab. This tab is the daily driver: stable, opinionated, simple.

// Recommendation list sizes.
const PRIORITY_RECS_LIMIT = 30;
const FALLBACK_RECS_LIMIT = 10;
// Floor for "stockable enough to keep a slot filled."
const VOLUME_FLOOR_DAILY = 100;

// Math helpers --------------------------------------------------------------

const HOP_SECONDS = 10;
const CLICK_SECONDS = 2;
const BATCH_SIZES = [50, 10, 5];

function clicksForN(n) {
  let clicks = 0, remaining = n;
  for (const b of BATCH_SIZES) {
    clicks += Math.floor(remaining / b);
    remaining %= b;
  }
  return clicks;
}

// Daily items the user can sell at their cycling pace. Driven by:
//   - hours_active per day
//   - max sells per session (the N cap)
//   - cycling efficiency (% of click-perfect throughput they sustain)
function dailySellThroughput(hours, maxSells, efficiency) {
  const sessionSec = HOP_SECONDS + clicksForN(maxSells) * CLICK_SECONDS;
  const sessionsPerHr = 3600 / sessionSec;
  return Math.round(sessionsPerHr * maxSells * efficiency * hours);
}

// Per-item daily supply ceiling from the GE 4hr buy limit.
function dailySupplyFromLimit(buyLimit) {
  return (buyLimit || 0) * 4;
}

// Read lab settings from localStorage (shared with the lab tab).
function loadSettings() {
  try {
    const raw = localStorage.getItem(ROGUES_LAB_SETTINGS_KEY);
    if (!raw) return { ...ROGUES_LAB_DEFAULTS };
    return { ...ROGUES_LAB_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...ROGUES_LAB_DEFAULTS };
  }
}

// Status pip per row.
//   ✓ green: profitable + sustainable + can be sourced at sufficient rate
//   ◌ yellow: profitable but a yellow flag (low volume, anomaly, etc.)
//   ✗ red:    not currently profitable at this max sells/session
function statusFor(row, maxSells, anomalyPct) {
  if (!row) return { tone: 'unknown', icon: '·', label: 'No data' };
  // Recompute at user's actual N (server picks optimal up to 60)
  const metrics = computeRoguesMetrics(
    row.highalch,
    row.buyPrice,
    maxSells,
    row.dailyVolumePerHr || 0
  );
  if (!metrics || metrics.profitPerSession <= 0) {
    return { tone: 'bad', icon: '✗', label: 'Not currently profitable at insta-buy' };
  }
  if ((row.sustainableRoguesProfit || 0) <= 0) {
    return {
      tone: 'bad',
      icon: '✗',
      label: 'Current margin is an anomaly — unprofitable at the 24h baseline',
    };
  }
  if (row.priceVs24hPct != null && Math.abs(row.priceVs24hPct) > anomalyPct) {
    return {
      tone: 'warn',
      icon: '⚠',
      label: `Price has moved ${row.priceVs24hPct > 0 ? '+' : ''}${row.priceVs24hPct}% vs 24h avg`,
    };
  }
  // Liquidity sanity: can the daily market sustain 4 × limit per day?
  const dailyVolTotal = (row.dailyVolumePerHr || 0) * 24;
  const dailyLimit = dailySupplyFromLimit(row.limit);
  if (dailyLimit > 0 && dailyVolTotal < dailyLimit) {
    return {
      tone: 'warn',
      icon: '◌',
      label: `Daily market volume (${dailyVolTotal}) below your GE buy limit (${dailyLimit}) — slot may run dry`,
    };
  }
  return {
    tone: 'good',
    icon: '✓',
    label: `Profitable · ${fmtGp(metrics.profitPerSession)} per ${maxSells}-item session`,
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RoguesListTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [showFallbacks, setShowFallbacks] = useState(false);
  // Stock equalizer is heavy (table of editable inputs); keep it folded
  // away until the user explicitly opens it — but remember their choice
  // across navigations so the "buying list" doesn't reset to closed each
  // time. Per-device (not in SYNCED_KEYS); it's a UI preference.
  const [showEqualizer, setShowEqualizer] = useState(() => {
    try {
      return localStorage.getItem(ROGUES_EQUALIZER_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_EQUALIZER_OPEN_KEY, showEqualizer ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [showEqualizer]);

  // We read settings on every render so changes from the lab propagate
  // (no cross-tab listener needed; the user has to refresh anyway).
  const settings = loadSettings();
  const hoursActive = settings.hoursActive ?? 1;
  const maxSells = settings.maxSells ?? 20;
  const efficiency = settings.cyclingEfficiency ?? 0.6;
  const priorityLimitMax = settings.priorityLimitMax ?? 125;
  const anomalyPct = settings.anomalyPct ?? 15;

  const {
    items: listItems,
    mainItems,
    backupItems,
    add,
    remove,
    promote,
    demote,
    mainCount,
    backupCount,
    isFull,
  } = useRoguesList();
  const { open: openItemModal } = useItemModal();

  // Shared per-item {qty, n} state for the running list + equalizer.
  const [stocks, setStocks] = useState(loadStocks);
  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_STOCKS_STORAGE_KEY, JSON.stringify(stocks));
    } catch {
      /* session-only fallback */
    }
  }, [stocks]);
  const updateItemN = (id, val) => {
    const n = parseInt0(val);
    setStocks((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), n } }));
  };
  // Get the effective N for an item — per-item override if set, otherwise
  // the global default from lab settings.
  const effectiveN = (id) => stocks[id]?.n ?? maxSells;

  // Buy-price override: lets the user pin a price manually when the live
  // GE data is missing/stale/wrong, so the profit math reflects what they
  // actually paid (or what they realistically can buy at).
  // Empty input clears the override and we fall back to live buyPrice.
  const updateItemBuyOverride = (id, val) => {
    setStocks((prev) => {
      const current = prev[id] || {};
      const parsed = parseGpOrNull(val);
      if (parsed == null) {
        // Clear the override field; keep qty/n intact.
        const { buyOverride: _drop, ...rest } = current;
        return { ...prev, [id]: rest };
      }
      return { ...prev, [id]: { ...current, buyOverride: parsed } };
    });
  };

  const load = () => {
    setRefreshing(true);
    setError(null);
    fetchHighAlch()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  };
  useEffect(load, []);

  const byId = useMemo(() => {
    if (!data) return new Map();
    return new Map(data.items.map((r) => [r.id, r]));
  }, [data]);
  const listIdSet = useMemo(() => new Set(listItems.map((it) => it.id)), [listItems]);

  // Hydrate each list item with live data + recomputed-at-user-N metrics.
  // N comes from the per-item stocks map (set in the equalizer or the
  // running list's inline input), falling back to the global maxSells when
  // the item has no per-row override.
  // Build display rows for a given source array (mainItems or backupItems).
  // Same enrichment logic — just parameterized by which subset.
  const buildRows = useCallback((source) => {
    return source.map((it) => {
      const live = byId.get(it.id);
      const n = stocks[it.id]?.n ?? maxSells;
      const override = stocks[it.id]?.buyOverride;
      const effectiveBuyPrice = override ?? live?.buyPrice ?? null;
      const metrics = live && live.highalch && effectiveBuyPrice
        ? computeRoguesMetrics(live.highalch, effectiveBuyPrice, n, live.dailyVolumePerHr || 0)
        : null;
      return {
        id: it.id,
        name: live?.name || it.name,
        live,
        metrics,
        n,
        buyPrice: effectiveBuyPrice,
        buyOverride: override ?? null,
        status: statusFor({ ...live, buyPrice: effectiveBuyPrice }, n, anomalyPct),
      };
    });
  }, [byId, stocks, maxSells, anomalyPct]);

  const mainRows = useMemo(() => buildRows(mainItems), [mainItems, buildRows]);
  const backupRows = useMemo(() => buildRows(backupItems), [backupItems, buildRows]);
  // Kept for the equalizer + diff stats: combined list of all tracked items.
  const listRows = useMemo(() => [...mainRows, ...backupRows], [mainRows, backupRows]);

  // Total expected profit if you cycle through every main-list item once at
  // its preferred N. The user's "I burned through one full rotation" number.
  const totalProfitPerCycle = useMemo(() => {
    return mainRows.reduce((sum, r) => sum + (r.metrics?.profitPerSession || 0), 0);
  }, [mainRows]);

  // Throughput math + coverage. Daily supply = sum of per-item daily limits.
  const throughput = dailySellThroughput(hoursActive, maxSells, efficiency);
  const totalDailySupply = useMemo(() => {
    let total = 0;
    for (const r of listRows) {
      total += dailySupplyFromLimit(r.live?.limit);
    }
    return total;
  }, [listRows]);
  const coverage = throughput > 0 ? totalDailySupply / throughput : 0;
  const coverageColor = coverage >= 1.5 ? 'var(--green)' : coverage >= 1.0 ? '#f3c54a' : 'var(--red)';
  const coverageLabel = coverage >= 1.5 ? 'comfortable' : coverage >= 1.0 ? 'tight' : 'under-supplied';

  // Recommendations: priority items (low buy limit) not already on the list.
  const priorityRecs = useMemo(() => {
    if (!data) return [];
    return data.items
      .filter((r) => {
        if (listIdSet.has(r.id)) return false;
        if (!r.limit || r.limit > priorityLimitMax) return false;
        // Profitable insta-buy at user's N cap (need to recompute since server uses up to 60)
        const m = computeRoguesMetrics(r.highalch, r.buyPrice, maxSells, r.dailyVolumePerHr || 0);
        if (!m || m.profitPerSession <= 0) return false;
        if ((r.sustainableRoguesProfit || 0) <= 0) return false;
        // Daily market volume must beat the buy limit (you need market depth)
        const dailyVolTotal = (r.dailyVolumePerHr || 0) * 24;
        if (dailyVolTotal < r.limit * 2) return false; // 2x cushion
        return true;
      })
      .map((r) => ({
        row: r,
        dailyCeiling:
          (r.phaseCDailyProfit) ||
          (computeRoguesMetrics(r.highalch, r.buyPrice, maxSells, r.dailyVolumePerHr || 0)?.profitPerSession || 0) * (r.limit / maxSells) * 4,
      }))
      .sort((a, b) => b.dailyCeiling - a.dailyCeiling)
      .slice(0, PRIORITY_RECS_LIMIT);
  }, [data, listIdSet, maxSells, priorityLimitMax]);

  // ===== Swap suggestions =====
  // Find candidates that dominate items currently in the main list on BOTH
  // profit AND stability. Stability is a composite of:
  //   - low price-vs-24h-avg deviation (item isn't on a momentary spike)
  //   - daily volume comfortably covers the 4hr buy limit (you can stock it)
  //   - sustainable profit positive (still works at the 24h baseline price)
  // The result is up to 5 "remove X, add Y" pairs ranked by absolute profit
  // gain. Click "Apply swap" and Y takes X's spot in main.
  const swapSuggestions = useMemo(() => {
    if (!data || mainRows.length === 0) return [];

    // Score a live row (used for both main items and candidates).
    const stability = (live) => {
      if (!live) return 0;
      let s = 1.0;
      const vs24h = live.priceVs24hPct ?? 0;
      // Penalize anomalous prices — falls off linearly to 0 at 50% deviation.
      s *= Math.max(0, 1 - Math.abs(vs24h) / 50);
      // Reward sustainable-at-24h-avg items, penalize spike-driven margins.
      if ((live.sustainableRoguesProfit || 0) > 0) s *= 1.2;
      else s *= 0.5;
      // Volume vs buy-limit headroom (4× limit/day vs daily volume)
      const limit = live.limit || 0;
      const dailyVolTotal = (live.dailyVolumePerHr || 0) * 24;
      if (limit > 0 && dailyVolTotal > 0) {
        const headroom = dailyVolTotal / (limit * 4);
        if (headroom < 1) s *= 0.5;
        else if (headroom > 3) s *= 1.1;
      } else if (limit > 0) {
        s *= 0.4; // no volume data
      }
      return s;
    };

    // Candidate set: anything not on the list with a small buy limit + good
    // metrics. Use the priority cutoff so suggestions stay on-strategy.
    const candidates = data.items
      .filter((r) => {
        if (listIdSet.has(r.id)) return false;
        if (!r.limit || r.limit > priorityLimitMax) return false;
        const m = computeRoguesMetrics(r.highalch, r.buyPrice, maxSells, r.dailyVolumePerHr || 0);
        if (!m || m.profitPerSession <= 0) return false;
        if ((r.sustainableRoguesProfit || 0) <= 0) return false;
        const dailyVolTotal = (r.dailyVolumePerHr || 0) * 24;
        if (dailyVolTotal < r.limit * 2) return false;
        return true;
      })
      .map((r) => {
        const m = computeRoguesMetrics(r.highalch, r.buyPrice, maxSells, r.dailyVolumePerHr || 0);
        return {
          row: r,
          profit: m?.profitPerSession || 0,
          stability: stability(r),
        };
      });

    // For each main row, find the best candidate that beats it on both axes.
    const suggestions = [];
    for (const m of mainRows) {
      if (!m.live || !m.metrics) continue;
      const mProfit = m.metrics.profitPerSession;
      if (mProfit <= 0) continue;
      const mStab = stability(m.live);
      // Candidate must strictly dominate on profit AND stability.
      const dominators = candidates.filter(
        (c) => c.profit > mProfit && c.stability > mStab
      );
      if (dominators.length === 0) continue;
      // Pick the candidate with highest profit (the user's primary axis).
      const best = dominators.sort((a, b) => b.profit - a.profit)[0];
      suggestions.push({
        removeId: m.id,
        removeName: m.name,
        removeProfit: mProfit,
        removeStability: mStab,
        addRow: best.row,
        addProfit: best.profit,
        addStability: best.stability,
        profitGain: best.profit - mProfit,
        stabilityGain: best.stability - mStab,
      });
    }
    return suggestions.sort((a, b) => b.profitGain - a.profitGain).slice(0, 5);
  }, [data, listIdSet, mainRows, maxSells, priorityLimitMax]);

  // Apply a single swap: remove the old item from main, add the candidate
  // (which lands in main since the slot just opened up).
  const applySwap = useCallback((s) => {
    remove(s.removeId);
    // Defer add to next tick so the remove commits first (otherwise the
    // add sees main as full and pushes the new item to backup).
    setTimeout(() => add(s.addRow.id, s.addRow.name), 0);
  }, [remove, add]);

  // Fallback rail: high-volume staples (loose buy limit), always-buyable.
  const fallbacks = useMemo(() => {
    if (!data) return [];
    return data.items
      .filter((r) => {
        if (listIdSet.has(r.id)) return false;
        if (!r.limit || r.limit < 1000) return false;
        const m = computeRoguesMetrics(r.highalch, r.buyPrice, maxSells, r.dailyVolumePerHr || 0);
        if (!m || m.profitPerSession <= 0) return false;
        if ((r.sustainableRoguesProfit || 0) <= 0) return false;
        if ((r.dailyVolumePerHr || 0) < VOLUME_FLOOR_DAILY) return false;
        return true;
      })
      .sort((a, b) => (b.phaseARealisticGpPerHr || 0) - (a.phaseARealisticGpPerHr || 0))
      .slice(0, FALLBACK_RECS_LIMIT);
  }, [data, listIdSet, maxSells]);

  // Search-to-add. Doesn't filter by limit — user can add anything they want.
  const searchResults = useMemo(() => {
    if (!data || !query.trim()) return [];
    const q = query.toLowerCase();
    return data.items
      .filter((r) => r.name.toLowerCase().includes(q) && !listIdSet.has(r.id))
      .slice(0, 8);
  }, [data, query, listIdSet]);

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading running list…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        {/* === Coverage header === */}
        <div className="alch-summary">
          <strong>
            Main: {mainCount}/{ROGUES_LIST_MAX}
          </strong>
          {backupCount > 0 && (
            <> · <strong>Backup: {backupCount}</strong></>
          )}
          {' '}· supplies{' '}
          <strong>{totalDailySupply.toLocaleString()}</strong>/day from buy limits ·
          throughput need{' '}
          <strong>{throughput.toLocaleString()}</strong>/day →{' '}
          <span style={{ color: coverageColor, fontWeight: 600 }}>
            {coverage.toFixed(2)}× ({coverageLabel})
          </span>
        </div>
        {totalProfitPerCycle > 0 && (
          <div className="alch-summary" style={{ marginTop: '0.3em' }}>
            <strong>Estimated profit per full rotation:</strong>{' '}
            <span style={{ color: 'var(--green)', fontWeight: 600 }}>
              {fmtGp(totalProfitPerCycle)} gp
            </span>
            <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
              {' '}— sum of profit/session across your {mainCount} main-list items at their preferred N
            </span>
          </div>
        )}
        <div className="alch-summary" style={{ color: 'var(--muted)', fontSize: '0.85em', marginTop: '0.3em' }}>
          Sized by: {hoursActive}h/day × {maxSells} per session ×{' '}
          {Math.round(efficiency * 100)}% efficiency. Priority cutoff: buy limit ≤ {priorityLimitMax}.
          Tune in <em>Rogues' lab</em> → Lab settings.
        </div>

        <div className="alch-controls">
          <input
            type="search"
            className="item-search-input"
            placeholder="Search any item to add to your running list…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 340 }}
          />
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
          <button
            className={`range-btn ${showFallbacks ? 'active' : ''}`}
            onClick={() => setShowFallbacks((v) => !v)}
            title="High-volume staples (Rune arrow type) — only show when your priority pool is thin"
          >
            {showFallbacks ? 'Hide' : 'Show'} fallbacks
          </button>
          <button
            className={`range-btn ${showEqualizer ? 'active' : ''}`}
            onClick={() => setShowEqualizer((v) => !v)}
            title="Open the Stock Equalizer — calculate how many of each item to buy so they all have the same number of sessions remaining"
          >
            🧮 {showEqualizer ? 'Hide' : 'Stock'} equalizer
          </button>
        </div>

        {searchResults.length > 0 && (
          <div className="lab-search-results">
            {searchResults.map((r) => (
              <button
                key={r.id}
                className="lab-search-result"
                onClick={() => { add(r.id, r.name); setQuery(''); }}
              >
                <span style={{ flex: 1 }}>{r.name}</span>
                <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
                  limit {r.limit?.toLocaleString() ?? '—'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* === Main running list (capped at ROGUES_LIST_MAX) === */}
      <div className="alch-header" style={{ marginTop: '0.6em' }}>
        <div className="alch-summary">
          <strong>Main running list</strong> — your active rotation (capped at {ROGUES_LIST_MAX})
        </div>
      </div>
      <PoolTable
        rows={mainRows}
        emptyMessage={
          <>
            Empty. Use the search above, or pick from the Recommendations below
            to start building your stable rotation.
          </>
        }
        renderActions={(row) => (
          <>
            <button
              className="range-btn"
              onClick={(e) => { e.stopPropagation(); demote(row.id); }}
              title="Move to backup pool"
            >
              ↓ Backup
            </button>
            <button
              className="range-btn"
              onClick={(e) => { e.stopPropagation(); remove(row.id); }}
              title="Remove from list entirely"
              style={{ marginLeft: '0.25em' }}
            >
              ✕
            </button>
          </>
        )}
        onRowClick={(row) => openItemModal(row.id)}
        onUpdateN={updateItemN}
        onUpdateBuyOverride={updateItemBuyOverride}
      />

      {/* === Swap suggestions (only shown when there are dominators) === */}
      {swapSuggestions.length > 0 && (
        <>
          <div className="alch-header" style={{ marginTop: '1.5em' }}>
            <div className="alch-summary">
              <strong>🔁 Swap suggestions</strong> — candidates that beat a main-list item
              on <em>both</em> profit AND stability (price ≈ 24h baseline, volume covers buy
              limit, sustainable margin)
            </div>
          </div>
          <div className="swap-suggestions">
            {swapSuggestions.map((s, i) => (
              <div key={`swap-${i}`} className="swap-suggestion">
                <div className="swap-suggestion-text">
                  <span style={{ color: 'var(--muted)' }}>Remove</span>{' '}
                  <strong>{s.removeName}</strong>{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    ({fmtGp(s.removeProfit)} profit, stability {s.removeStability.toFixed(2)})
                  </span>
                  {' → '}
                  <span style={{ color: 'var(--muted)' }}>Add</span>{' '}
                  <strong style={{ color: 'var(--green)' }}>{s.addRow.name}</strong>{' '}
                  <span style={{ color: 'var(--muted)' }}>
                    ({fmtGp(s.addProfit)} profit, stability {s.addStability.toFixed(2)})
                  </span>
                </div>
                <div className="swap-suggestion-gain">
                  <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                    +{fmtGp(s.profitGain)} gp/session
                  </span>
                  {' · '}
                  <span style={{ color: 'var(--muted)' }}>
                    +{s.stabilityGain.toFixed(2)} stability
                  </span>
                </div>
                <button
                  className="range-btn"
                  onClick={() => applySwap(s)}
                  title={`Remove ${s.removeName} and add ${s.addRow.name}`}
                >
                  Apply swap
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* === Backup pool (uncapped) — only render if non-empty === */}
      {backupRows.length > 0 && (
        <>
          <div className="alch-header" style={{ marginTop: '1.5em' }}>
            <div className="alch-summary">
              <strong>Backup pool</strong> ({backupCount}) — extra items rotating in and out of
              the active set. Promote any back to main when there's room.
            </div>
          </div>
          <PoolTable
            rows={backupRows}
            emptyMessage="Backup pool is empty."
            renderActions={(row) => (
              <>
                <button
                  className="range-btn"
                  onClick={(e) => { e.stopPropagation(); promote(row.id); }}
                  disabled={isFull}
                  title={isFull ? `Main is full (${ROGUES_LIST_MAX}). Demote a main item first.` : 'Move to main pool'}
                >
                  ↑ Main
                </button>
                <button
                  className="range-btn"
                  onClick={(e) => { e.stopPropagation(); remove(row.id); }}
                  title="Remove from list entirely"
                  style={{ marginLeft: '0.25em' }}
                >
                  ✕
                </button>
              </>
            )}
            onRowClick={(row) => openItemModal(row.id)}
            onUpdateN={updateItemN}
            onUpdateBuyOverride={updateItemBuyOverride}
          />
        </>
      )}

      {/* === Stock equalizer (collapsible) === */}
      {showEqualizer && (
        <div style={{ marginTop: '2em' }}>
          <StockEqualizer
            items={listItems}
            byId={byId}
            defaultSellsPerSession={maxSells}
            stocks={stocks}
            setStocks={setStocks}
          />
        </div>
      )}

      {/* === Priority recommendations === */}
      <div className="alch-header" style={{ marginTop: '2em' }}>
        <div className="alch-summary">
          <strong>Recommendations</strong> · priority items (buy limit ≤ {priorityLimitMax}) not on your list,
          ranked by daily profit ceiling. Click <em>+ Add</em> to grow your list.
        </div>
      </div>
      <RecsTable
        rows={priorityRecs}
        maxSells={maxSells}
        anomalyPct={anomalyPct}
        onAdd={(r) => add(r.id, r.name)}
        onRowClick={(r) => openItemModal(r.id)}
        emptyMessage="No qualifying priority items right now. Try refreshing or check the lab for diagnostics."
      />

      {/* === Fallback rail === */}
      {showFallbacks && (
        <>
          <div className="alch-header" style={{ marginTop: '2em' }}>
            <div className="alch-summary">
              <strong>Fallback safety net</strong> · high-volume staples (buy limit ≥ 1000) for slots
              your priority items can't fill. Lower margin, always available.
            </div>
          </div>
          <RecsTable
            rows={fallbacks.map((r) => ({ row: r }))}
            maxSells={maxSells}
            anomalyPct={anomalyPct}
            onAdd={(r) => add(r.id, r.name)}
            onRowClick={(r) => openItemModal(r.id)}
            emptyMessage="No qualifying fallbacks right now."
            isFallback
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pool table: the user's running list
// ---------------------------------------------------------------------------

function PoolTable({ rows, emptyMessage, renderActions, onRowClick, onUpdateN, onUpdateBuyOverride }) {
  // Default sort: by profit/session descending so the highest-margin picks
  // float to the top.
  const [sortKey, setSortKey] = useState('profit');
  const [sortDir, setSortDir] = useState('desc');

  // Freeze the displayed row order while any input is focused, so the row
  // the user is editing doesn't jump out from under them. We snapshot the
  // order on focus and release ~250ms after the last blur (the gap lets a
  // tab-or-click to the next row's input keep the freeze active).
  const [frozenOrder, setFrozenOrder] = useState(null);
  const blurTimerRef = useRef(null);
  const handleInputFocus = (currentSorted) => () => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    if (!frozenOrder) setFrozenOrder(currentSorted.map((r) => r.id));
  };
  const handleInputBlur = () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => {
      setFrozenOrder(null);
      blurTimerRef.current = null;
    }, 250);
  };
  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);

  const get = (r, key) => {
    const live = r.live;
    const m = r.metrics;
    switch (key) {
      case 'name':         return (r.name || '').toLowerCase();
      case 'limit':        return live?.limit ?? -1;
      // Use the row's effective buy price (override > live) for sorting,
      // so manually-priced items sort alongside everything else correctly.
      case 'buyPrice':     return r.buyPrice ?? -1;
      case 'n':            return r.n ?? 0;
      case 'profit':       return m?.profitPerSession ?? -Infinity;
      case 'dailyCeiling': {
        if (!live?.limit || !m || !m.sellsPerSession) return -Infinity;
        return (m.profitPerSession / m.sellsPerSession) * live.limit * 4;
      }
      default: return 0;
    }
  };

  const sorted = useMemo(() => {
    const getter = (r) => get(r, sortKey);
    const nameGet = (r) => get(r, 'name');
    return [...rows].sort((a, b) => {
      const va = getter(a);
      const vb = getter(b);
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      const na = nameGet(a);
      const nb = nameGet(b);
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
  }, [rows, sortKey, sortDir]);

  // When the user is editing, hold the row order steady. New rows that
  // weren't in the original snapshot append at the end so they don't get
  // hidden.
  const displayed = useMemo(() => {
    if (!frozenOrder) return sorted;
    const byIdMap = new Map(sorted.map((r) => [r.id, r]));
    const out = [];
    const seen = new Set();
    for (const id of frozenOrder) {
      const r = byIdMap.get(id);
      if (r) { out.push(r); seen.add(id); }
    }
    for (const r of sorted) {
      if (!seen.has(r.id)) out.push(r);
    }
    return out;
  }, [sorted, frozenOrder]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };
  const arrow = (key) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div className="table-scroll">
      <table className="alch-table bounded-table">
        <thead>
          <tr>
            <th style={{ width: '2.5em' }} />
            <th className={`left ${sortKey === 'name' ? 'sorted' : ''}`} onClick={() => toggleSort('name')}>
              Item{arrow('name')}
            </th>
            <th className={`right ${sortKey === 'limit' ? 'sorted' : ''}`} onClick={() => toggleSort('limit')}>
              Buy limit{arrow('limit')}
            </th>
            <th className={`right ${sortKey === 'buyPrice' ? 'sorted' : ''}`} onClick={() => toggleSort('buyPrice')}>
              Buy price{arrow('buyPrice')}
            </th>
            <th className={`right ${sortKey === 'n' ? 'sorted' : ''}`} onClick={() => toggleSort('n')}>
              Sells / session{arrow('n')}
            </th>
            <th className={`right ${sortKey === 'profit' ? 'sorted' : ''}`} onClick={() => toggleSort('profit')}>
              Profit / session{arrow('profit')}
            </th>
            <th className={`right ${sortKey === 'dailyCeiling' ? 'sorted' : ''}`} onClick={() => toggleSort('dailyCeiling')}>
              Daily ceiling{arrow('dailyCeiling')}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {displayed.length === 0 && (
            <tr>
              <td colSpan={8} style={{ padding: '1.5em', color: 'var(--muted)', textAlign: 'center' }}>
                {emptyMessage}
              </td>
            </tr>
          )}
          {displayed.map((row) => {
            const { id, name, live, metrics, status, n, buyPrice, buyOverride } = row;
            const profit = metrics?.profitPerSession ?? 0;
            const buyLimit = live?.limit ?? null;
            const livePrice = live?.buyPrice ?? null;
            const dailyCeiling = buyLimit && metrics && metrics.sellsPerSession
              ? (metrics.profitPerSession / metrics.sellsPerSession) * buyLimit * 4
              : null;
            return (
              <tr key={id} className="alch-row-clickable" onClick={() => onRowClick(row)}>
                <td>
                  <span className={`rogues-pip ${status.tone}`} title={status.label}>
                    {status.icon}
                  </span>
                </td>
                <td className="left">{name}</td>
                <td className="right">{buyLimit?.toLocaleString() ?? '—'}</td>
                <td className="right" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={buyOverride != null ? buyOverride : ''}
                    placeholder={livePrice != null ? livePrice.toLocaleString() : '—'}
                    onChange={(e) => onUpdateBuyOverride(id, e.target.value)}
                    onFocus={handleInputFocus(sorted)}
                    onBlur={handleInputBlur}
                    inputMode="numeric"
                    title={
                      buyOverride != null
                        ? `Manual override: ${buyOverride.toLocaleString()} gp (live: ${livePrice != null ? livePrice.toLocaleString() : 'n/a'}). Clear to revert.`
                        : 'Override the buy price for this row when live data is missing or stale. Empty = use live price.'
                    }
                    style={{
                      width: '6em',
                      textAlign: 'right',
                      background: 'var(--bg)',
                      color: buyOverride != null ? '#f3c54a' : 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                      padding: '0.15em 0.4em',
                      fontFamily: 'inherit',
                      fontSize: '0.95em',
                      fontStyle: buyOverride != null ? 'italic' : 'normal',
                    }}
                  />
                </td>
                <td className="right" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={n ?? ''}
                    onChange={(e) => onUpdateN(id, e.target.value)}
                    onFocus={handleInputFocus(sorted)}
                    onBlur={handleInputBlur}
                    inputMode="numeric"
                    title="How many you sell per Rogues' Den session for this item. Drives the profit math."
                    style={{
                      width: '4em',
                      textAlign: 'right',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                      padding: '0.15em 0.4em',
                      fontFamily: 'inherit',
                      fontSize: '0.95em',
                    }}
                  />
                </td>
                <td className="right" style={{ color: profitColor(profit), fontWeight: 600 }}>
                  {metrics ? fmtGp(profit) : '—'}
                </td>
                <td className="right" style={{ color: profitColor(dailyCeiling || 0) }}>
                  {dailyCeiling != null ? fmtGp(dailyCeiling) : '—'}
                </td>
                <td className="right">{renderActions(row)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recommendations table (priority + fallback)
// ---------------------------------------------------------------------------

function RecsTable({ rows, maxSells, anomalyPct, onAdd, onRowClick, emptyMessage, isFallback }) {
  return (
    <div className="table-scroll">
      <table className="alch-table bounded-table">
        <thead>
          <tr>
            <th style={{ width: '2.5em' }} />
            <th className="left">Item</th>
            <th className="right">Buy limit</th>
            <th className="right">Buy price</th>
            <th className="right">Profit / {maxSells}-item session</th>
            <th className="right">
              {isFallback ? 'Realistic gp/hr' : 'Daily ceiling'}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} style={{ padding: '1.5em', color: 'var(--muted)', textAlign: 'center' }}>
                {emptyMessage}
              </td>
            </tr>
          )}
          {rows.map(({ row }) => {
            const m = computeRoguesMetrics(row.highalch, row.buyPrice, maxSells, row.dailyVolumePerHr || 0);
            const profit = m?.profitPerSession || 0;
            const dailyCeiling =
              row.limit && m
                ? (m.profitPerSession / m.sellsPerSession) * row.limit * 4
                : null;
            const status = statusFor(row, maxSells, anomalyPct);
            const rightValue = isFallback
              ? row.phaseARealisticGpPerHr || 0
              : dailyCeiling || 0;
            return (
              <tr key={row.id} className="alch-row-clickable" onClick={() => onRowClick(row)}>
                <td>
                  <span className={`rogues-pip ${status.tone}`} title={status.label}>
                    {status.icon}
                  </span>
                </td>
                <td className="left">{row.name}</td>
                <td className="right">{row.limit?.toLocaleString() ?? '—'}</td>
                <td className="right">{fmtGp(row.buyPrice)}</td>
                <td className="right" style={{ color: profitColor(profit), fontWeight: 600 }}>
                  {fmtGp(profit)}
                </td>
                <td className="right" style={{ color: profitColor(rightValue) }}>
                  {fmtGp(rightValue)}
                </td>
                <td className="right">
                  <button
                    className="range-btn"
                    onClick={(e) => { e.stopPropagation(); onAdd(row); }}
                  >
                    + Add
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
