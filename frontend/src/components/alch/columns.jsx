import { fmtGp, fmtAgo, stalenessRatio, stalenessColor } from '../../utils/format';
import ItemNameCell from '../ItemNameCell';

// Compact gp formatter for very large numbers (millions/billions) — used by
// "Profit × Volume" cells where raw digits would crowd the column.
const fmtCompact = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
};

// Column definitions for the High Alch table. Two sets:
//   - ALCH_COLUMNS: classic high-alch view (profit per cast, profit @ limit)
//   - ROGUES_COLUMNS: Martin Thwait's shop view (per-session and floor metrics)
//
// Each column declares:
//   key      stable identifier (also used as the sortKey state value)
//   label    visible header text
//   align    'left' for the name column, otherwise right-aligned numbers
//   sortBy   selector returning a comparable value for that row
//   format   (row) => string|node      — used when render is omitted
//   render   (row) => node             — overrides format when set
//   profit   tints the cell green/red based on the value's sign
//   asc      preferred initial sort direction (true = ascending)

const moveCol = {
  key: 'recentMovePct',
  label: 'Move (1h)',
  sortBy: (r) => (r.recentMovePct != null ? Math.abs(r.recentMovePct) : -1),
  format: (r) =>
    r.recentMovePct == null
      ? '—'
      : `${r.recentMovePct > 0 ? '+' : ''}${r.recentMovePct.toFixed(1)}%`,
};

// 24h-averaged hourly volume — the smoothed baseline that drives the
// realistic gp/hr calculation. Useful alongside the spikier 1h volume so the
// user can spot items where the 1h count is an outlier vs typical throughput.
const dailyVolCol = {
  key: 'dailyVolumePerHr',
  label: '24h vol/hr',
  sortBy: (r) => r.dailyVolumePerHr ?? 0,
  format: (r) =>
    r.dailyVolumePerHr != null ? r.dailyVolumePerHr.toLocaleString() : '—',
};

// "Last traded" relative time, color-coded by staleness ratio (age vs typical
// inter-trade gap given the item's hourly volume). Green = on schedule,
// yellow = several gaps overdue, red = effectively gone dark.
const lastTradedCol = {
  key: 'lastTraded',
  label: 'Last traded',
  sortBy: (r) => {
    const t = Math.max(r.highTime || 0, r.lowTime || 0);
    return t > 0 ? -t : -Infinity; // reverse: most recent first when sorted desc
  },
  render: (r) => {
    const t = Math.max(r.highTime || 0, r.lowTime || 0);
    if (!t) return <span style={{ color: 'var(--muted)' }}>—</span>;
    const ratio = stalenessRatio(t, r.hourlyVolume);
    const color = stalenessColor(ratio);
    return (
      <span
        style={{ color }}
        title={
          ratio != null
            ? `Staleness ratio: ${ratio.toFixed(1)}× (expected gap is ~${(3600 / (r.hourlyVolume || 1)).toFixed(0)}s)`
            : 'No hourly volume data to compute staleness'
        }
      >
        {fmtAgo(t)}
      </span>
    );
  },
};

// "5m active" — small indicator showing whether the item traded in the
// latest 5-minute window. Useful for distinguishing items that are *currently*
// liquid from items whose 1h/24h numbers reflect a stale earlier spike.
const active5mCol = {
  key: 'recent5mVolume',
  label: '5m',
  sortBy: (r) => r.recent5mVolume ?? 0,
  render: (r) => {
    const v = r.recent5mVolume ?? 0;
    if (v > 0) {
      return (
        <span style={{ color: 'var(--green)' }} title={`${v} trades in the last 5 min`}>
          ⚡ {v}
        </span>
      );
    }
    return (
      <span style={{ color: 'var(--muted)' }} title="No trades in the last 5 min">
        ◌
      </span>
    );
  },
};

// "Profit × Volume" is the cheap-but-effective way to rank items high on
// both axes at once: an item with 100gp profit × 10,000 hourly volume scores
// the same as 10,000gp × 100, but neither stale-but-juicy nor cheap-but-
// busy items dominate. Sorting by this naturally surfaces the "real money"
// rows without anyone having to pick thresholds.
const alchScoreCol = {
  key: 'alchScore',
  label: 'Profit × Vol',
  sortBy: (r) => (r.profitPerAlch || 0) * (r.hourlyVolume || 0),
  format: (r) => fmtCompact((r.profitPerAlch || 0) * (r.hourlyVolume || 0)),
  profit: true,
};
const roguesScoreCol = {
  key: 'roguesScore',
  label: 'Profit × Vol',
  sortBy: (r) => (r.roguesProfitPerSession || 0) * (r.hourlyVolume || 0),
  format: (r) => fmtCompact((r.roguesProfitPerSession || 0) * (r.hourlyVolume || 0)),
  profit: true,
};

export const ALCH_COLUMNS = [
  { key: 'name', label: 'Item', align: 'left', sortBy: (r) => r.name.toLowerCase(), render: (r) => <ItemNameCell row={r} />, asc: true },
  { key: 'buyPrice', label: 'Buy', sortBy: (r) => r.buyPrice, format: (r) => fmtGp(r.buyPrice) },
  { key: 'highalch', label: 'High alch', sortBy: (r) => r.highalch, format: (r) => fmtGp(r.highalch) },
  { key: 'profitPerAlch', label: 'Profit / alch', sortBy: (r) => r.profitPerAlch, format: (r) => fmtGp(r.profitPerAlch), profit: true },
  { key: 'limit', label: 'GE limit', sortBy: (r) => r.limit ?? -1, format: (r) => (r.limit != null ? r.limit.toLocaleString() : '—') },
  { key: 'hourlyVolume', label: 'Hourly vol', sortBy: (r) => r.hourlyVolume, format: (r) => r.hourlyVolume.toLocaleString() },
  dailyVolCol,
  active5mCol,
  lastTradedCol,
  alchScoreCol,
  moveCol,
  { key: 'totalProfitAtLimit', label: 'Profit @ limit', sortBy: (r) => r.totalProfitAtLimit ?? -1, format: (r) => (r.totalProfitAtLimit != null ? fmtGp(r.totalProfitAtLimit) : '—'), profit: true },
];

// Rogues' Den (Martin Thwait) — shop pays 100% high alch on sale 1,
// drops -2% per sale, floors at 60%. No nature rune burn vs straight alching.
export const ROGUES_COLUMNS = [
  { key: 'name', label: 'Item', align: 'left', sortBy: (r) => r.name.toLowerCase(), render: (r) => <ItemNameCell row={r} />, asc: true },
  { key: 'buyPrice', label: 'Buy', sortBy: (r) => r.buyPrice, format: (r) => fmtGp(r.buyPrice) },
  { key: 'highalch', label: 'High alch', sortBy: (r) => r.highalch, format: (r) => fmtGp(r.highalch) },
  {
    key: 'roguesSellsPerSession',
    label: 'Sells / session',
    sortBy: (r) => r.roguesSellsPerSession,
    format: (r) =>
      r.roguesAlwaysProfitable
        ? `${r.roguesSellsPerSession}+`
        : `${r.roguesSellsPerSession}`,
  },
  {
    key: 'roguesProfitPerSession',
    label: 'Profit / session',
    sortBy: (r) => r.roguesProfitPerSession,
    format: (r) => fmtGp(r.roguesProfitPerSession),
    profit: true,
  },
  {
    key: 'roguesLastSaleMargin',
    label: 'Last sale',
    sortBy: (r) => r.roguesLastSaleMargin ?? 0,
    format: (r) =>
      r.roguesLastSaleMargin != null ? fmtGp(r.roguesLastSaleMargin) : '—',
    profit: true,
  },
  {
    key: 'roguesFloorMargin',
    label: 'Floor (info)',
    sortBy: (r) => r.roguesFloorMargin,
    format: (r) => fmtGp(r.roguesFloorMargin),
    profit: true,
  },
  {
    key: 'roguesGpPerHr',
    label: 'GP / hr (realistic)',
    sortBy: (r) => r.roguesGpPerHr ?? 0,
    format: (r) => (r.roguesGpPerHr ? fmtGp(r.roguesGpPerHr) : '—'),
    profit: true,
  },
  {
    // Phase C-style daily ceiling: 4 × buy_limit × avg_profit_per_item at
    // your capped sells/session. The hard ceiling from the GE 4hr buy limit.
    key: 'roguesDailyCeiling',
    label: 'Daily ceiling',
    sortBy: (r) => r.roguesDailyCeiling ?? 0,
    format: (r) => (r.roguesDailyCeiling ? fmtGp(r.roguesDailyCeiling) : '—'),
    profit: true,
  },
  { key: 'limit', label: 'GE limit', sortBy: (r) => r.limit ?? -1, format: (r) => (r.limit != null ? r.limit.toLocaleString() : '—') },
  { key: 'hourlyVolume', label: 'Hourly vol', sortBy: (r) => r.hourlyVolume, format: (r) => r.hourlyVolume.toLocaleString() },
  dailyVolCol,
  active5mCol,
  lastTradedCol,
  roguesScoreCol,
  moveCol,
  {
    key: 'roguesTotalProfit4hr',
    label: "Profit @ 4hr limit",
    sortBy: (r) => r.roguesTotalProfit4hr,
    format: (r) => fmtGp(r.roguesTotalProfit4hr),
    profit: true,
  },
];
