import { useState, useEffect, useMemo } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchShops } from '../../api/client';

function parseMin(s) {
  if (!s || !s.trim()) return null;
  const n = Number(s.replace(/[,_\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const COLUMNS = [
  { key: 'itemName',  label: 'Item',      align: 'left',  sortBy: (r) => r.itemName.toLowerCase() },
  { key: 'shop',      label: 'Shop',      align: 'left',  sortBy: (r) => r.shop.toLowerCase() },
  { key: 'location',  label: 'Location',  align: 'left',  sortBy: (r) => r.location.toLowerCase() },
  { key: 'req',       label: 'Req',       align: 'left',  sortBy: (r) => r.req.toLowerCase() },
  { key: 'shopPrice', label: 'Shop price',               sortBy: (r) => r.shopPrice,  format: (r) => fmtGp(r.shopPrice) },
  { key: 'geSell',    label: 'GE sell',                  sortBy: (r) => r.geSell ?? -1, format: (r) => r.geSell != null ? fmtGp(r.geSell) : '—' },
  { key: 'margin',    label: 'Margin/ea', profit: true,   sortBy: (r) => r.margin ?? -Infinity, format: (r) => r.margin != null ? fmtGp(r.margin) : '—' },
  { key: 'roi',       label: '% ROI',     profit: true,   sortBy: (r) => r.roi ?? -Infinity, format: (r) => r.roi != null ? `${r.roi > 0 ? '+' : ''}${r.roi}%` : '—' },
  { key: 'stock',     label: 'Stock/world',               sortBy: (r) => r.stock, format: (r) => r.stock.toLocaleString() },
  { key: 'hourlyVolume', label: 'Hourly vol',             sortBy: (r) => r.hourlyVolume, format: (r) => r.hourlyVolume.toLocaleString() },
];

export default function ShopsTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState('');
  const [shopFilter, setShopFilter] = useState('');
  const [minMargin, setMinMargin] = useState('');
  const [profitableOnly, setProfitableOnly] = useState(false);

  const [sortKey, setSortKey] = useState('margin');
  const [sortDir, setSortDir] = useState('desc');

  const load = () => {
    setRefreshing(true);
    setError(null);
    fetchShops()
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  };

  useEffect(load, []);

  const allShops = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.items.map((r) => r.shop))].sort();
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    let list = data.items;

    if (profitableOnly) list = list.filter((r) => r.margin != null && r.margin > 0);

    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((r) => r.itemName.toLowerCase().includes(q) || r.shop.toLowerCase().includes(q));
    }

    if (shopFilter) list = list.filter((r) => r.shop === shopFilter);

    const minM = parseMin(minMargin);
    if (minM != null) list = list.filter((r) => r.margin != null && r.margin >= minM);

    const col = COLUMNS.find((c) => c.key === sortKey);
    if (col) {
      list = [...list].sort((a, b) => {
        const va = col.sortBy(a);
        const vb = col.sortBy(b);
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }
    return list;
  }, [data, query, shopFilter, minMargin, profitableOnly, sortKey, sortDir]);

  const profitable = useMemo(() => (data ? data.items.filter((r) => r.margin != null && r.margin > 0).length : 0), [data]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'itemName' || key === 'shop' || key === 'location' || key === 'req' ? 'asc' : 'desc');
    }
  };

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading shop data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          {profitable} of {data.count} tracked items currently profitable · Buy from NPC shop, sell on GE
        </div>
        <div className="alch-controls">
          <input
            type="search"
            className="item-search-input"
            placeholder="Filter by item or shop…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <select
            value={shopFilter}
            onChange={(e) => setShopFilter(e.target.value)}
            className="range-btn"
            style={{ cursor: 'pointer' }}
          >
            <option value="">All shops</option>
            {allShops.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button
            className={`range-btn ${profitableOnly ? 'active' : ''}`}
            onClick={() => setProfitableOnly((v) => !v)}
          >
            Profitable only
          </button>
          <label className="min-filter">
            Min margin:
            <input
              type="text"
              value={minMargin}
              onChange={(e) => setMinMargin(e.target.value)}
              placeholder="—"
              inputMode="numeric"
            />
          </label>
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <div className="alch-note">
          💡 <strong>Buy from NPC</strong> at the fixed shop price, then sell on the GE. Margin shown
          is after 1% GE tax on the insta-sell price. Prices flip constantly — use{' '}
          <strong>Profitable only</strong> to hide negatives, or leave it off to monitor items that
          are close to breaking even. <strong>Stock/world</strong> resets on every world hop.
        </div>
      </div>

      <div className="table-scroll">
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
            {rows.map((r, i) => (
              <tr key={`${r.shop}-${r.itemId}-${i}`}>
                {COLUMNS.map((c) => {
                  const val = c.format ? c.format(r) : r[c.key];
                  let color;
                  if (c.profit) {
                    const raw = c.sortBy(r);
                    if (raw !== -Infinity) color = profitColor(raw);
                  }
                  return (
                    <td
                      key={c.key}
                      className={c.align === 'left' ? 'left' : 'right'}
                      style={color ? { color } : undefined}
                      title={c.key === 'req' || c.key === 'shop' ? r.notes || undefined : undefined}
                    >
                      {c.key === 'itemName' && r.notes ? (
                        <span title={r.notes}>{val} <span style={{ opacity: 0.5, fontSize: '0.8em' }}>ⓘ</span></span>
                      ) : val}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <div className="alch-footer">No items match the current filters.</div>
      )}
    </div>
  );
}
