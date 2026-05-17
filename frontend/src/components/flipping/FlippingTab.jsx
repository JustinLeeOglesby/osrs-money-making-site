import { useState, useEffect, useMemo, Fragment } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchFlipping } from '../../api/client';
import { useItemModal } from '../../context/ItemModalContext';
import { useWatchlist } from '../../context/WatchlistContext';
import ItemNameCell from '../ItemNameCell';

// Compact gp formatter for the "Margin × Vol" column (large products).
const fmtCompact = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
};

// All available columns. "Default" set shows just the essentials; the rest
// reveal when the user toggles "Show details".
const COLUMNS = [
  { key: 'name', label: 'Item', align: 'left', sortBy: (r) => r.name.toLowerCase(), render: (r) => <ItemNameCell row={r} />, asc: true, default: true },
  { key: 'low', label: 'Buy (low)', sortBy: (r) => r.low, format: (r) => fmtGp(r.low), default: true },
  {
    key: 'high',
    label: 'Sell (high)',
    sortBy: (r) => r.effectiveHigh ?? r.high,
    // When the raw `high` was a wild outlier vs the hourly average, the
    // backend caps the price used in margin math. Show that capped price
    // here with a small ⚠ if it differs from the raw one.
    render: (r) => {
      const eff = r.effectiveHigh ?? r.high;
      if (r.sanityCapped && r.high !== eff) {
        return (
          <span
            title={`Raw insta-buy showed ${fmtGp(r.high)} gp but that's likely a one-off outlier; using hourly-average ${fmtGp(eff)} gp for the margin instead`}
            style={{ cursor: 'help' }}
          >
            {fmtGp(eff)} <span style={{ color: 'var(--muted)', marginLeft: '0.3em' }}>⚠</span>
          </span>
        );
      }
      return fmtGp(eff);
    },
    default: true,
  },
  { key: 'margin', label: 'Margin (after tax)', sortBy: (r) => r.margin, format: (r) => fmtGp(r.margin), profit: true, default: true },
  { key: 'roi', label: 'ROI %', sortBy: (r) => r.roi, format: (r) => `${r.roi.toFixed(2)}%` },
  { key: 'limit', label: 'GE limit', sortBy: (r) => r.limit ?? -1, format: (r) => (r.limit != null ? r.limit.toLocaleString() : '—') },
  { key: 'hourlyVolume', label: 'Hourly vol', sortBy: (r) => r.hourlyVolume, format: (r) => r.hourlyVolume.toLocaleString(), default: true },
  {
    key: 'flipScore',
    label: 'Margin × Vol',
    sortBy: (r) => (r.margin || 0) * (r.hourlyVolume || 0),
    format: (r) => fmtCompact((r.margin || 0) * (r.hourlyVolume || 0)),
    profit: true,
  },
  {
    key: 'recentMovePct',
    label: 'Move (1h)',
    sortBy: (r) => (r.recentMovePct != null ? Math.abs(r.recentMovePct) : -1),
    format: (r) =>
      r.recentMovePct == null
        ? '—'
        : `${r.recentMovePct > 0 ? '+' : ''}${r.recentMovePct.toFixed(1)}%`,
  },
  { key: 'profitAtLimit', label: 'Profit @ limit', sortBy: (r) => r.profitAtLimit ?? -1, format: (r) => (r.profitAtLimit != null ? fmtGp(r.profitAtLimit) : '—'), profit: true, default: true },
];

const MEMBER_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'f2p', label: 'F2P' },
  { key: 'p2p', label: 'P2P' },
];

// Preset filter scenarios — each applies a combination of min/max thresholds.
// Selecting one fills the filter inputs; the user can still edit them after.
const PRESETS = [
  {
    key: 'cheap',
    label: 'Cheap flips',
    description: 'Low buy price, decent margin, real liquidity — beginner-friendly',
    filters: { maxBuyPrice: '1000', minProfit: '50',    minVolume: '50' },
  },
  {
    key: 'big',
    label: 'Big margins',
    description: '10k+ per flip — fewer items but high per-flip payout',
    filters: { maxBuyPrice: '',     minProfit: '10000', minVolume: '5' },
  },
  {
    key: 'safe',
    label: 'High volume',
    description: 'Trades fill fast — lower margins but very low risk',
    filters: { maxBuyPrice: '',     minProfit: '100',   minVolume: '500' },
  },
];

// Smart thresholds for the "Best flips now" button given a max buy price.
// Asks for at least a ~3% return per flip with real liquidity, scaling so
// cheap items don't get filtered by absolute-gp floors.
function bestFlipsFilters(maxBuy) {
  const buy = Math.max(1, Math.floor(maxBuy));
  // Min margin: ~3% of buy price, with an absolute floor of 20gp so cheap
  // items don't slip through with single-digit margins.
  const minProfit = Math.max(20, Math.round(buy * 0.03));
  return {
    maxBuyPrice: String(buy),
    minProfit: String(minProfit),
    minVolume: '50',
  };
}

function parseMin(s) {
  if (!s || !s.trim()) return null;
  const n = Number(s.replace(/[,_\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Plain-English action plan for an expanded row.
function ActionPlan({ row, openItemModal, watchlistAdd, isWatched }) {
  const fillsPerHour = row.limit
    ? Math.min(row.limit, row.hourlyVolume)
    : row.hourlyVolume;
  const realisticHourly = fillsPerHour * row.margin;
  const limitText = row.limit
    ? `${row.limit.toLocaleString()} per 4 hours`
    : 'no GE buy limit';
  const sellPrice = row.effectiveHigh ?? row.high;
  return (
    <div className="action-plan">
      <div className="plan-line">
        <strong>Buy</strong> at <span className="plan-buy">{fmtGp(row.low)} gp</span>
        {' '}→ <strong>Sell</strong> at{' '}
        <span className="plan-sell">{fmtGp(sellPrice)} gp</span>
        {' '}→ <strong>Margin</strong>{' '}
        <span style={{ color: profitColor(row.margin) }}>
          {fmtGp(row.margin)} gp/flip
        </span>{' '}
        (after GE tax)
      </div>
      {row.sanityCapped && (
        <div className="plan-line plan-warn">
          ⚠ The raw insta-buy on /latest is {fmtGp(row.high)} gp — likely a
          one-off outlier. We're using the last-hour average ({fmtGp(sellPrice)} gp)
          as the realistic sell price instead. Your actual fills will be closer
          to that.
        </div>
      )}
      <div className="plan-line">
        Last hour: <strong>{row.hourlyVolume.toLocaleString()}</strong> traded
        · GE limit <strong>{limitText}</strong>
      </div>
      <div className="plan-line">
        At current volume you could realistically clear ~
        <strong>{fillsPerHour.toLocaleString()}</strong> flips per hour ≈{' '}
        <strong style={{ color: profitColor(realisticHourly) }}>
          {fmtGp(realisticHourly)} gp/hr
        </strong>
        . Hitting the full 4hr buy limit:{' '}
        <strong style={{ color: profitColor(row.profitAtLimit) }}>
          {row.profitAtLimit != null ? fmtGp(row.profitAtLimit) : '—'} gp
        </strong>
        .
      </div>
      {row.recentMovePct != null && Math.abs(row.recentMovePct) >= 3 && (
        <div className="plan-line plan-warn">
          ⚠ Price is moving — currently{' '}
          <strong>
            {row.recentMovePct > 0 ? '+' : ''}
            {row.recentMovePct.toFixed(1)}%
          </strong>{' '}
          vs the last hour's average. Spread may close before your orders fill.
        </div>
      )}
      <div className="plan-actions">
        <button
          className="range-btn"
          onClick={(e) => {
            e.stopPropagation();
            openItemModal(row.id);
          }}
        >
          📈 Item details
        </button>
        <button
          className="range-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (!isWatched) {
              watchlistAdd(row.id, row.name, {
                lowTarget: row.low,
                highTarget: row.high,
              });
            }
          }}
          disabled={isWatched}
          title={
            isWatched
              ? 'Already on your watchlist'
              : `Add to watchlist with targets at ${fmtGp(row.low)} / ${fmtGp(row.high)}`
          }
        >
          {isWatched ? '👁 Watching' : '👁 Watch with these targets'}
        </button>
      </div>
    </div>
  );
}

export default function FlippingTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState('all');
  const [minProfit, setMinProfit] = useState('');
  const [minVolume, setMinVolume] = useState('');
  const [maxBuyPrice, setMaxBuyPrice] = useState('');
  // Dialog state for the "Best flips now" wizard: when open, prompts the
  // user for a max-buy-price and applies smart filters on submit.
  const [bestFlipsOpen, setBestFlipsOpen] = useState(false);
  const [bestFlipsInput, setBestFlipsInput] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [activePreset, setActivePreset] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  // Default sort: combined Margin × Volume score.
  const [sortKey, setSortKey] = useState('flipScore');
  const [sortDir, setSortDir] = useState('desc');
  const { open: openItemModal } = useItemModal();
  const { add: watchlistAdd, isWatched } = useWatchlist();

  const visibleColumns = showDetails
    ? COLUMNS
    : COLUMNS.filter((c) => c.default);

  const load = () => {
    setRefreshing(true);
    setError(null);
    fetchFlipping()
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  };

  useEffect(load, []);

  const applyPreset = (preset) => {
    setActivePreset(preset.key);
    setMinProfit(preset.filters.minProfit);
    setMinVolume(preset.filters.minVolume);
    setMaxBuyPrice(preset.filters.maxBuyPrice);
  };

  const clearFilters = () => {
    setActivePreset(null);
    setMinProfit('');
    setMinVolume('');
    setMaxBuyPrice('');
  };

  // Editing any filter input manually unsets the active preset so the user
  // doesn't see a "preset is active" highlight while filters no longer match.
  const editFilter = (setter) => (val) => {
    setter(val);
    setActivePreset(null);
  };

  // "Best flips now" — apply smart thresholds for a given max buy price and
  // jump the sort to the combined Margin × Vol score so the top of the
  // table is whatever combines healthy margin AND healthy volume.
  const applyBestFlips = () => {
    const buy = parseMin(bestFlipsInput);
    if (buy == null || buy <= 0) return;
    const f = bestFlipsFilters(buy);
    setActivePreset('best');
    setMinProfit(f.minProfit);
    setMinVolume(f.minVolume);
    setMaxBuyPrice(f.maxBuyPrice);
    setSortKey('flipScore');
    setSortDir('desc');
    setBestFlipsOpen(false);
  };

  const openBestFlips = () => {
    // Pre-fill with current maxBuyPrice if the user has one, else blank.
    setBestFlipsInput(maxBuyPrice || '');
    setBestFlipsOpen(true);
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    let rows = data.items;
    if (members === 'f2p') rows = rows.filter((r) => !r.members);
    else if (members === 'p2p') rows = rows.filter((r) => r.members);
    if (query.trim()) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    }
    const minP = parseMin(minProfit);
    if (minP != null) rows = rows.filter((r) => r.margin >= minP);
    const minV = parseMin(minVolume);
    if (minV != null) rows = rows.filter((r) => r.hourlyVolume >= minV);
    const maxBP = parseMin(maxBuyPrice);
    if (maxBP != null) rows = rows.filter((r) => r.low <= maxBP);
    const col = COLUMNS.find((c) => c.key === sortKey);
    if (col) {
      rows = [...rows].sort((a, b) => {
        const va = col.sortBy(a);
        const vb = col.sortBy(b);
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return rows;
  }, [data, query, sortKey, sortDir, members, minProfit, minVolume, maxBuyPrice]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const col = COLUMNS.find((c) => c.key === key);
      setSortDir(col?.asc ? 'asc' : 'desc');
    }
  };

  const toggleExpanded = (id) => {
    setExpandedId((curr) => (curr === id ? null : id));
  };

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading flipping data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          {sorted.length.toLocaleString()} items with profitable buy / sell spreads
        </div>

        {/* "Best flips now" — smart preset that asks for max buy price */}
        <div className="alch-controls" style={{ marginBottom: '0.4em' }}>
          <button
            className={`range-btn best-flips-btn ${activePreset === 'best' ? 'active' : ''}`}
            onClick={openBestFlips}
            title="Pick a max buy price, see the top items by combined margin × volume"
          >
            🎯 Best flips now
          </button>
          {bestFlipsOpen && (
            <span className="best-flips-form">
              Max buy price:
              <input
                type="text"
                className="item-search-input"
                style={{ maxWidth: 120 }}
                value={bestFlipsInput}
                onChange={(e) => setBestFlipsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyBestFlips();
                  if (e.key === 'Escape') setBestFlipsOpen(false);
                }}
                placeholder="e.g. 10000"
                inputMode="numeric"
                autoFocus
              />
              <button className="range-btn" onClick={applyBestFlips}>
                Find
              </button>
              <button className="range-btn" onClick={() => setBestFlipsOpen(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>

        {/* Preset scenarios */}
        <div className="alch-controls" style={{ marginBottom: '0.6em' }}>
          <span className="preset-label">Quick filters:</span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`range-btn ${activePreset === p.key ? 'active' : ''}`}
              onClick={() => applyPreset(p)}
              title={p.description}
            >
              {p.label}
            </button>
          ))}
          {(activePreset ||
            minProfit ||
            minVolume ||
            maxBuyPrice) && (
            <button
              className="range-btn"
              onClick={clearFilters}
              title="Clear all min/max filters"
            >
              Clear
            </button>
          )}
        </div>

        {/* Other controls */}
        <div className="alch-controls">
          <input
            type="search"
            className="item-search-input"
            placeholder="Filter by item name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 280 }}
          />
          <div className="member-toggle">
            {MEMBER_FILTERS.map((f) => (
              <button
                key={f.key}
                className={`range-btn ${members === f.key ? 'active' : ''}`}
                onClick={() => setMembers(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className="min-filter">
            Min margin:
            <input
              type="text"
              value={minProfit}
              onChange={(e) => editFilter(setMinProfit)(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <label className="min-filter">
            Min hourly vol:
            <input
              type="text"
              value={minVolume}
              onChange={(e) => editFilter(setMinVolume)(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <label className="min-filter">
            Max buy price:
            <input
              type="text"
              value={maxBuyPrice}
              onChange={(e) => editFilter(setMaxBuyPrice)(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <button
            className={`range-btn ${showDetails ? 'active' : ''}`}
            onClick={() => setShowDetails((v) => !v)}
            title="Toggle extra columns (ROI, GE limit, Move, Margin × Vol)"
          >
            {showDetails ? 'Less detail' : 'Show details'}
          </button>
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="alch-note">
          💡 Click any row for a plain-English plan (buy, sell, expected hourly).
          Margin already accounts for GE tax. Items with hourly volume under 5 are
          filtered out server-side because their last "current" price is usually stale.
        </div>
      </div>
      <div className="table-scroll">
      <table className="alch-table">
        <thead>
          <tr>
            {visibleColumns.map((c) => (
              <th
                key={c.key}
                onClick={() => toggleSort(c.key)}
                className={`${sortKey === c.key ? 'sorted' : ''} ${c.align === 'left' ? 'left' : 'right'}`}
              >
                {c.label}
                {sortKey === c.key && (
                  <span className="sort-arrow">{sortDir === 'asc' ? ' ▲' : ' ▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 200).map((r) => {
            const isExpanded = expandedId === r.id;
            return (
              <Fragment key={r.id}>
                <tr
                  className={`alch-row-clickable ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => toggleExpanded(r.id)}
                  title={isExpanded ? 'Collapse' : 'Show action plan'}
                >
                  {visibleColumns.map((c) => {
                    const content = c.render ? c.render(r) : c.format(r);
                    let color;
                    if (c.profit) color = profitColor(c.sortBy(r));
                    return (
                      <td
                        key={c.key}
                        className={c.align === 'left' ? 'left' : 'right'}
                        style={color ? { color } : undefined}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
                {isExpanded && (
                  <tr className="action-plan-row">
                    <td colSpan={visibleColumns.length}>
                      <ActionPlan
                        row={r}
                        openItemModal={openItemModal}
                        watchlistAdd={watchlistAdd}
                        isWatched={isWatched(r.id)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {sorted.length > 200 && (
        <div className="alch-footer">
          Showing top 200 of {sorted.length}. Filter to narrow further.
        </div>
      )}
    </div>
  );
}
