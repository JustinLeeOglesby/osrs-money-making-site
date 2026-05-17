import { useState, useEffect, useMemo } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchHighAlch } from '../../api/client';
import { useItemModal } from '../../context/ItemModalContext';
import { useItemFavorites } from '../../context/ItemFavoritesContext';
import { ALCH_COLUMNS, ROGUES_COLUMNS } from './columns';

// Best items to alch (or sell to Martin Thwait's Lost and Found at Rogues'
// Den). Two independent toggles control the view:
//   tableMode: 'alch' | 'rogues'   — swaps column set + sort default
//   members:   'all' | 'f2p' | 'p2p' — works in both modes
//
// Sortable column headers (defaults to the headline column for the
// current mode). Capped at 200 rendered rows for performance.
const TABLE_MODES = [
  { key: 'alch', label: 'High Alch' },
  { key: 'rogues', label: "Rogues' Den" },
];
const MEMBER_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'f2p', label: 'F2P' },
  { key: 'p2p', label: 'P2P' },
];

// Parse a "min" filter input: blank → no filter (null), otherwise the
// numeric value with commas/spaces/underscores stripped. Returns null on
// junk input so the filter just disables itself instead of vanishing rows.
function parseMin(s) {
  if (!s || !s.trim()) return null;
  const n = Number(s.replace(/[,_\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export default function HighAlchTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [tableMode, setTableMode] = useState('alch');
  const [members, setMembers] = useState('all');
  const [minProfit, setMinProfit] = useState('');
  const [minVolume, setMinVolume] = useState('');
  const [maxBuyPrice, setMaxBuyPrice] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // Default sort: "Profit × Volume" — surfaces items that are good on
  // both axes simultaneously, no thresholds needed.
  const [sortKey, setSortKey] = useState('alchScore');
  const [sortDir, setSortDir] = useState('desc');
  const { open: openItemModal } = useItemModal();
  const { items: favItems } = useItemFavorites();
  const favIdSet = useMemo(() => new Set(favItems.map((it) => it.id)), [favItems]);

  const columns = tableMode === 'rogues' ? ROGUES_COLUMNS : ALCH_COLUMNS;

  const load = () => {
    setRefreshing(true);
    setError(null);
    fetchHighAlch()
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  };

  useEffect(load, []);

  // Reset sort to the mode's headline column when flipping modes.
  const setTableModeAndSort = (newMode) => {
    setTableMode(newMode);
    setSortKey(newMode === 'rogues' ? 'roguesScore' : 'alchScore');
    setSortDir('desc');
  };

  const sorted = useMemo(() => {
    if (!data) return [];
    let rows = data.items;
    if (members === 'f2p') rows = rows.filter((r) => !r.members);
    else if (members === 'p2p') rows = rows.filter((r) => r.members);
    // Mode-specific profitability filter. Backend now includes items
    // profitable in *either* mode (so we don't pre-exclude rogues-only items),
    // but each table view should only show items profitable in its mode.
    if (tableMode === 'rogues') rows = rows.filter((r) => r.roguesProfitPerSession > 0);
    else rows = rows.filter((r) => r.profitPerAlch > 0);
    if (favoritesOnly) rows = rows.filter((r) => favIdSet.has(r.id));
    if (query.trim()) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q));
    }
    const minP = parseMin(minProfit);
    if (minP != null) {
      // For Rogues' mode, "profit" means profit-per-session at the shop;
      // for High Alch mode, profit-per-alch.
      rows = rows.filter((r) =>
        tableMode === 'rogues'
          ? r.roguesProfitPerSession >= minP
          : r.profitPerAlch >= minP
      );
    }
    const minV = parseMin(minVolume);
    if (minV != null) rows = rows.filter((r) => r.hourlyVolume >= minV);
    const maxBP = parseMin(maxBuyPrice);
    if (maxBP != null) rows = rows.filter((r) => r.buyPrice <= maxBP);
    const col = columns.find((c) => c.key === sortKey);
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
  }, [data, query, sortKey, sortDir, members, tableMode, columns, minProfit, minVolume, maxBuyPrice, favoritesOnly, favIdSet]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      const col = columns.find((c) => c.key === key);
      setSortDir(col?.asc ? 'asc' : 'desc');
    }
  };

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading high alch data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          {tableMode === 'rogues' ? (
            <>
              {sorted.length.toLocaleString()} items profitable at Martin Thwait's
              shop{members !== 'all' && <> ({members.toUpperCase()})</>} · No nature
              rune cost
            </>
          ) : (
            <>
              {sorted.length.toLocaleString()} items currently profitable to alch ·
              Nature rune: <strong>{fmtGp(data.natureRunePrice)}</strong>
            </>
          )}
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
            {TABLE_MODES.map((f) => (
              <button
                key={f.key}
                className={`range-btn ${tableMode === f.key ? 'active' : ''}`}
                onClick={() => setTableModeAndSort(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
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
          <button
            className={`range-btn ${favoritesOnly ? 'active' : ''}`}
            onClick={() => setFavoritesOnly((v) => !v)}
            title={
              favItems.length === 0
                ? 'No favorited items yet — click ☆ on any row first'
                : favoritesOnly
                  ? 'Showing only your favorites'
                  : 'Show only favorited items'
            }
            disabled={favItems.length === 0 && !favoritesOnly}
          >
            ★ Favorites only{favItems.length ? ` (${favItems.length})` : ''}
          </button>
          <label className="min-filter">
            Min profit:
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
          <label className="min-filter">
            Max buy price:
            <input
              type="text"
              value={maxBuyPrice}
              onChange={(e) => setMaxBuyPrice(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {tableMode === 'rogues' ? (
          <div className="alch-note">
            💡 Martin Thwait's Lost and Found pays <strong>100% high alch</strong> on
            sale 1, drops <strong>2% per item sold</strong>, floors at{' '}
            <strong>60%</strong>. You can only sell in batches of 5/10/50, so
            "Sells / session" is always a multiple of 5. The optimizer maximises
            gp/<em>hour</em> while only recommending N where{' '}
            <strong>every individual sale is still profitable</strong>.
            <br />
            <strong>"Last sale"</strong> = margin of the Nth (final) sale — if
            this is positive, the recommendation isn't selling at a loss.{' '}
            <strong>"Floor (info)"</strong> = margin if you kept selling past
            sale 20 to the price floor (informational only; the recommendation
            never reaches floor unless the floor itself is still profitable).
          </div>
        ) : (
          <div className="alch-note">
            💡 Rogues' Den's high-alch shop pays full alch value for the first few items
            but the per-item payout drops fast — switch to the <strong>Rogues' Den</strong>{' '}
            filter to see exactly how many you can dump per session. Plain High Alch
            casting has no diminishing returns but burns a nature rune per cast.
          </div>
        )}
      </div>
      <div className="table-scroll">
      <table className="alch-table">
        <thead>
          <tr>
            {columns.map((c) => (
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
              {columns.map((c) => {
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
      </div>
      {sorted.length > 200 && (
        <div className="alch-footer">
          Showing top 200 of {sorted.length}. Filter to narrow further.
        </div>
      )}
    </div>
  );
}
