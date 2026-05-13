import { useState, useEffect, useMemo } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchFlipping } from '../../api/client';
import { useItemModal } from '../../context/ItemModalContext';
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

// Live "buy low, sell high" candidates. The "Margin × Vol" column
// (the default sort) multiplies per-flip margin by hourly volume — a
// row scores high only if BOTH are healthy, so the top of the table
// naturally surfaces realistic opportunities.
const COLUMNS = [
  { key: 'name', label: 'Item', align: 'left', sortBy: (r) => r.name.toLowerCase(), render: (r) => <ItemNameCell row={r} />, asc: true },
  { key: 'low', label: 'Buy (low)', sortBy: (r) => r.low, format: (r) => fmtGp(r.low) },
  { key: 'high', label: 'Sell (high)', sortBy: (r) => r.high, format: (r) => fmtGp(r.high) },
  { key: 'margin', label: 'Margin (after tax)', sortBy: (r) => r.margin, format: (r) => fmtGp(r.margin), profit: true },
  { key: 'roi', label: 'ROI %', sortBy: (r) => r.roi, format: (r) => `${r.roi.toFixed(2)}%` },
  { key: 'limit', label: 'GE limit', sortBy: (r) => r.limit ?? -1, format: (r) => (r.limit != null ? r.limit.toLocaleString() : '—') },
  { key: 'hourlyVolume', label: 'Hourly vol', sortBy: (r) => r.hourlyVolume, format: (r) => r.hourlyVolume.toLocaleString() },
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
  { key: 'profitAtLimit', label: 'Profit @ limit', sortBy: (r) => r.profitAtLimit ?? -1, format: (r) => (r.profitAtLimit != null ? fmtGp(r.profitAtLimit) : '—'), profit: true },
];

const MEMBER_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'f2p', label: 'F2P' },
  { key: 'p2p', label: 'P2P' },
];

function parseMin(s) {
  if (!s || !s.trim()) return null;
  const n = Number(s.replace(/[,_\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default function FlippingTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [members, setMembers] = useState('all');
  const [minProfit, setMinProfit] = useState('');
  const [minVolume, setMinVolume] = useState('');
  // Default sort: combined Margin × Volume score.
  const [sortKey, setSortKey] = useState('flipScore');
  const [sortDir, setSortDir] = useState('desc');
  const { open: openItemModal } = useItemModal();

  const load = () => {
    setRefreshing(true);
    setError(null);
    fetchFlipping()
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  };

  useEffect(load, []);

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
  }, [data, query, sortKey, sortDir, members, minProfit, minVolume]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const col = COLUMNS.find((c) => c.key === key);
      setSortDir(col?.asc ? 'asc' : 'desc');
    }
  };

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading flipping data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          {sorted.length.toLocaleString()} items with profitable buy / sell spreads
        </div>
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
              onChange={(e) => setMinProfit(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <label className="min-filter">
            Min hourly vol:
            <input
              type="text"
              value={minVolume}
              onChange={(e) => setMinVolume(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="alch-note">
          💡 Margin already accounts for GE tax on the sell. ROI = margin /
          buy price. Items with hourly volume under 5 are filtered out
          server-side because their last "current" price is usually stale.
        </div>
      </div>
      <table className="alch-table">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
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
          {sorted.slice(0, 200).map((r) => (
            <tr
              key={r.id}
              className="alch-row-clickable"
              onClick={() => openItemModal(r.id)}
              title="Open item details"
            >
              {COLUMNS.map((c) => {
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
          ))}
        </tbody>
      </table>
      {sorted.length > 200 && (
        <div className="alch-footer">
          Showing top 200 of {sorted.length}. Filter to narrow further.
        </div>
      )}
    </div>
  );
}
