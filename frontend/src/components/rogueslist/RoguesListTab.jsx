import { useEffect, useMemo, useState } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchHighAlch } from '../../api/client';
import { useRoguesList } from '../../context/RoguesListContext';
import { useItemModal } from '../../context/ItemModalContext';
import { ROGUES_LIST_MAX, ROGUES_VOLUME_FLOOR, VOLATILITY_THRESHOLD } from '../../utils/constants';
import { computeRoguesMetrics } from '../../utils/rogues';

// Recommendations are filtered against the 24h-average buy price to weed out
// momentary spikes. An item is "sustainable" if it would *still* be profitable
// at Rogues' Den when bought at its typical 24h average, not just at the
// transient current low. Anything outside this percentage threshold from the
// 24h baseline is also flagged as currently anomalous (gold price tag) so the
// user can see at a glance which recommendations are riding a spike vs trading
// at a typical level.
const PRICE_ANOMALY_THRESHOLD_PCT = 15;

// Active Rogues' Den 27-slot tracker.
//
// Two panels:
//   1. Your list — the items you're actively running, with live Rogues' Den
//      metrics, volume, recent price move, and a status pip per row.
//   2. Recommendations — top profitable items NOT on the list, filtered by
//      a hourly-volume floor so we don't suggest illiquid stuff that won't fill.
//
// Backed by /api/highalch (same data the High Alch tab uses, since the Rogues'
// metrics are computed per-item there). No new endpoint needed.

const RECOMMEND_LIMIT = 30;

// Max-sells/session cap options. Default 20: when cycling worlds at Rogues'
// Den you'll cycle back to the same world before the shop has fully reset,
// so dumping 50+ per session leads to severely diminished returns on the
// second visit. Capping at 20 stays well clear of the descent floor (the
// shop bottoms out at -2% per item × 20 items = -40% off, well above the
// 60% floor) so revisiting is safe.
const MAX_SELLS_OPTIONS = [10, 15, 20, 25, 30, 50, 60];
const DEFAULT_MAX_SELLS = 20;

// Status pip per row based on profitability + liquidity.
function statusFor(row) {
  if (!row) return { tone: 'unknown', label: 'No data', symbol: '·' };
  const profit = row.roguesProfitPerSession || 0;
  const vol = row.hourlyVolume || 0;
  if (profit <= 0) return { tone: 'bad',     label: 'Not profitable right now', symbol: '●' };
  if (vol < ROGUES_VOLUME_FLOOR)
    return { tone: 'warn',  label: `Thin volume (${vol}/hr < ${ROGUES_VOLUME_FLOOR})`, symbol: '●' };
  return { tone: 'good', label: `Profitable · ${vol.toLocaleString()}/hr`, symbol: '●' };
}

function fmtMovePct(move) {
  if (move == null) return null;
  return `${move > 0 ? '+' : ''}${move.toFixed(1)}%`;
}

export default function RoguesListTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState('roguesGpPerHr');
  const [sortDir, setSortDir] = useState('desc');

  const [stableOnly, setStableOnly] = useState(true);
  const [maxSells, setMaxSells] = useState(DEFAULT_MAX_SELLS);

  const { items: listItems, add, remove, count, isFull } = useRoguesList();
  const { open: openItemModal } = useItemModal();

  const load = () => {
    setRefreshing(true);
    setError(null);
    fetchHighAlch()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  };
  useEffect(load, []);

  // Index live data by id for O(1) lookups.
  const byId = useMemo(() => {
    if (!data) return new Map();
    return new Map(data.items.map((r) => [r.id, r]));
  }, [data]);

  // For each priced item, recompute the rogues metrics under the user's
  // sells-per-session cap — both at the *current* GE buy price (what they'd
  // actually earn right now) and at the *24h average* (the sustainable
  // baseline used for anomaly filtering). The cap is enforced inside
  // `computeRoguesMetrics`, so changing the dropdown re-derives every
  // displayed number without refetching anything.
  const cappedById = useMemo(() => {
    const m = new Map();
    if (!data) return m;
    for (const r of data.items) {
      const current = computeRoguesMetrics(
        r.highalch,
        r.buyPrice,
        maxSells,
        r.dailyVolumePerHr || 0
      );
      const sustainable = r.avg24hBuyPrice
        ? computeRoguesMetrics(r.highalch, r.avg24hBuyPrice, maxSells, r.dailyVolumePerHr || 0)
        : null;
      m.set(r.id, { current, sustainable });
    }
    return m;
  }, [data, maxSells]);

  // Merge live row + capped metrics into a "display row" with the same field
  // names the existing JSX expects, so the rest of the rendering code keeps
  // working unchanged. Returns the live row (untouched non-rogues fields like
  // hourlyVolume, recentMovePct, priceVs24hPct) overlaid with capped rogues
  // fields.
  const displayRowFor = (live) => {
    if (!live) return null;
    const capped = cappedById.get(live.id);
    const c = capped?.current;
    const s = capped?.sustainable;
    return {
      ...live,
      // Current-price metrics — overridden with capped versions
      roguesSellsPerSession: c?.sellsPerSession ?? live.roguesSellsPerSession,
      roguesProfitPerSession: c?.profitPerSession ?? 0,
      roguesGpPerHr: c?.gpPerHr ?? 0,
      roguesLastSaleMargin: c?.lastSaleMargin ?? live.roguesLastSaleMargin,
      roguesAlwaysProfitable: c?.alwaysProfitable ?? live.roguesAlwaysProfitable,
      realisticRoguesGpPerHr: c?.realisticGpPerHr ?? 0,
      volumeBottlenecked: c?.volumeBottlenecked ?? false,
      // Sustainable (24h-avg) metrics
      sustainableRoguesProfit: s?.profitPerSession ?? 0,
      sustainableRoguesGpPerHr: s?.gpPerHr ?? 0,
      sustainableRealisticGpPerHr: s?.realisticGpPerHr ?? 0,
    };
  };

  const listIdSet = useMemo(() => new Set(listItems.map((it) => it.id)), [listItems]);

  // Join list items with live data. Items added to the list that are no longer
  // in the high-alch payload (e.g. dropped from profitability) still appear,
  // just without metrics — that's deliberate, the user wanted to monitor exactly
  // these cases.
  const tracked = useMemo(() => {
    return listItems.map((it) => {
      const live = displayRowFor(byId.get(it.id));
      return {
        id: it.id,
        name: live?.name || it.name,
        addedAt: it.addedAt,
        live, // full row with capped rogues fields, or null
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listItems, byId, cappedById]);

  // Sort tracked rows. We sort by the live data's field; rows with no live
  // data sink to the bottom (their key compares as -Infinity).
  const trackedSorted = useMemo(() => {
    const get = (r) => {
      const v = r.live?.[sortKey];
      return v == null ? -Infinity : v;
    };
    const sorted = [...tracked].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [tracked, sortKey, sortDir]);

  // Recommendations: top items not on the list, profitable at Rogues' Den,
  // ranked by *realistic* (volume-capped) gp/hr — see Sust. realistic column.
  //
  // When `stableOnly` is on, we additionally require:
  //   - sustainableRoguesProfit > 0
  //     (item would *still* be profitable at the 24h average buy price)
  //   - priceVs24hPct > -25  (no extreme downward crash polluting the data)
  //
  // The volume floor still applies as a baseline sanity check, but the real
  // filtering happens via the realistic gp/hr math — items that need 50
  // sells/session but only see 200 trades/hour can't realistically run 12
  // sessions/hour, so their realistic gp/hr collapses and they rank low.
  const recommendations = useMemo(() => {
    if (!data) return [];
    return data.items
      .map((r) => displayRowFor(r))
      .filter((r) => {
        if (!r) return false;
        if (listIdSet.has(r.id)) return false;
        // Profit check uses capped metrics — an item that's only profitable at
        // N=50 won't survive a cap of 20 and gets dropped.
        if (r.roguesProfitPerSession <= 0) return false;
        if (r.hourlyVolume < ROGUES_VOLUME_FLOOR) return false;
        if (stableOnly) {
          if (!r.sustainableRoguesProfit || r.sustainableRoguesProfit <= 0) return false;
          if (r.priceVs24hPct != null && r.priceVs24hPct < -25) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Rank primarily by sustainable + realistic gp/hr (the safest figure)
        // when stable-mode is on, otherwise by realistic gp/hr. Both reflect
        // the user's sells-cap.
        const aRank = stableOnly
          ? (a.sustainableRealisticGpPerHr || 0)
          : (a.realisticRoguesGpPerHr || 0);
        const bRank = stableOnly
          ? (b.sustainableRealisticGpPerHr || 0)
          : (b.realisticRoguesGpPerHr || 0);
        return bRank - aRank;
      })
      .slice(0, RECOMMEND_LIMIT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, listIdSet, stableOnly, cappedById]);

  // Tally how many picks the stability filter is hiding under the current cap.
  const hiddenByStability = useMemo(() => {
    if (!data || !stableOnly) return 0;
    return data.items.filter((live) => {
      if (listIdSet.has(live.id)) return false;
      const r = displayRowFor(live);
      if (!r) return false;
      if (r.roguesProfitPerSession <= 0) return false;
      if (r.hourlyVolume < ROGUES_VOLUME_FLOOR) return false;
      const unstable =
        !r.sustainableRoguesProfit ||
        r.sustainableRoguesProfit <= 0 ||
        (r.priceVs24hPct != null && r.priceVs24hPct < -25);
      return unstable;
    }).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, listIdSet, stableOnly, cappedById]);

  // Roll-up stats for the header.
  const summary = useMemo(() => {
    let profitable = 0;
    let thinVol = 0;
    let unprofitable = 0;
    let projectedGpPerHr = 0;
    let projectedProfitPerSession = 0;
    for (const t of tracked) {
      const r = t.live;
      if (!r) continue;
      const status = statusFor(r);
      if (status.tone === 'good') profitable += 1;
      else if (status.tone === 'warn') thinVol += 1;
      else if (status.tone === 'bad') unprofitable += 1;
      if ((r.roguesProfitPerSession || 0) > 0) {
        // Sum the *realistic* (volume-capped) gp/hr so the headline figure
        // doesn't oversell on items the market won't actually let you buy.
        projectedGpPerHr += r.realisticRoguesGpPerHr || 0;
        projectedProfitPerSession += r.roguesProfitPerSession || 0;
      }
    }
    return { profitable, thinVol, unprofitable, projectedGpPerHr, projectedProfitPerSession };
  }, [tracked]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading Rogues' Den data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          <strong>Rogues' Den active list:</strong> {count} of {ROGUES_LIST_MAX} slots ·{' '}
          <span style={{ color: 'var(--green)' }}>{summary.profitable} good</span> ·{' '}
          <span style={{ color: '#f3c54a' }}>{summary.thinVol} thin vol</span> ·{' '}
          <span style={{ color: 'var(--red)' }}>{summary.unprofitable} losing</span>
          {summary.projectedGpPerHr > 0 && (
            <>
              {' '}· <strong>Sum gp/hr (profitable):</strong>{' '}
              <span style={{ color: 'var(--green)' }}>{fmtGp(summary.projectedGpPerHr)}</span>
            </>
          )}
        </div>

        <div className="alch-controls">
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
          <label
            className="min-filter"
            title="Cap on items sold per session. When you world-hop and cycle back, the shop won't have fully reset — staying at ≤20 keeps you well above the descent floor on the return visit."
          >
            Max sells/session:
            <select
              value={maxSells}
              onChange={(e) => setMaxSells(Number(e.target.value))}
              style={{ marginLeft: '0.4em', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 3, padding: '0.2em 0.4em' }}
            >
              {MAX_SELLS_OPTIONS.map((n) => (
                <option key={n} value={n}>{n === 60 ? '60 (no cap)' : n}</option>
              ))}
            </select>
          </label>
          {isFull && (
            <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
              List is full. Remove items below to make room.
            </span>
          )}
        </div>

        <div className="alch-note">
          💡 Items you're actively cycling at Martin Thwait's shop. Add picks from the High Alch tab's
          Rogues' Den mode (click the 🎒 next to any item name) or from the Recommendations below.
          All Sells/session, Profit/session, and GP/hr numbers below are computed under your{' '}
          <strong>Max sells/session = {maxSells}</strong> cap — change the dropdown above to see
          how a different cycling strategy reshapes the rankings.
          <br />
          <strong>Status pip:</strong>{' '}
          <span style={{ color: 'var(--green)' }}>●</span> profitable + volume ≥ {ROGUES_VOLUME_FLOOR}/hr ·{' '}
          <span style={{ color: '#f3c54a' }}>●</span> profitable but thin volume ·{' '}
          <span style={{ color: 'var(--red)' }}>●</span> not currently profitable. Watch the{' '}
          <strong>Move (1h)</strong> column for items whose GE price is drifting against you.
        </div>
      </div>

      {/* ============================== YOUR LIST ============================== */}
      <div className="table-scroll">
        <table className="alch-table">
          <thead>
            <tr>
              <th className="left">Status</th>
              <th className="left" onClick={() => toggleSort('name')}>Item</th>
              <th className="right" onClick={() => toggleSort('buyPrice')}>GE buy</th>
              <th className="right" onClick={() => toggleSort('highalch')}>High alch</th>
              <th className="right" onClick={() => toggleSort('priceVs24hPct')}>vs 24h</th>
              <th className="right" onClick={() => toggleSort('roguesSellsPerSession')}>Sells/session</th>
              <th className="right" onClick={() => toggleSort('roguesProfitPerSession')}>Profit/session</th>
              <th className="right" onClick={() => toggleSort('roguesGpPerHr')}>GP/hr (theor.)</th>
              <th className="right" onClick={() => toggleSort('realisticRoguesGpPerHr')}>Realistic GP/hr</th>
              <th className="right" onClick={() => toggleSort('hourlyVolume')}>Hourly vol</th>
              <th className="right" onClick={() => toggleSort('recentMovePct')}>Move (1h)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {trackedSorted.length === 0 && (
              <tr><td colSpan={12} style={{ padding: '1.5em', color: 'var(--muted)', textAlign: 'center' }}>
                Your list is empty. Pick items from Recommendations below, or browse the High Alch tab and click 🎒 next to a row.
              </td></tr>
            )}
            {trackedSorted.map(({ id, name, live }) => {
              const status = statusFor(live);
              const move = live?.recentMovePct;
              const isVolatile = move != null && Math.abs(move) >= VOLATILITY_THRESHOLD;
              const vs24h = live?.priceVs24hPct;
              const anomalous = vs24h != null && Math.abs(vs24h) > PRICE_ANOMALY_THRESHOLD_PCT;
              return (
                <tr
                  key={id}
                  className="alch-row-clickable"
                  onClick={() => openItemModal(id)}
                  title="Open item details"
                >
                  <td className="left">
                    <span className={`rogues-pip ${status.tone}`} title={status.label}>
                      {status.symbol}
                    </span>
                  </td>
                  <td className="left">{name}</td>
                  <td className="right">{live ? fmtGp(live.buyPrice) : '—'}</td>
                  <td className="right">{live ? fmtGp(live.highalch) : '—'}</td>
                  <td className="right">
                    {vs24h == null ? '—' : (
                      <span
                        title={live?.avg24hBuyPrice ? `24h avg buy: ${live.avg24hBuyPrice.toLocaleString()}gp` : undefined}
                        style={anomalous ? { color: vs24h > 0 ? '#f3c54a' : 'var(--red)', fontWeight: 600 } : undefined}
                      >
                        {fmtMovePct(vs24h)}
                      </span>
                    )}
                  </td>
                  <td className="right">
                    {live
                      ? `${live.roguesSellsPerSession}${live.roguesAlwaysProfitable ? '+' : ''}`
                      : '—'}
                  </td>
                  <td className="right" style={live ? { color: profitColor(live.roguesProfitPerSession) } : undefined}>
                    {live ? fmtGp(live.roguesProfitPerSession) : '—'}
                  </td>
                  <td className="right" style={live ? { color: profitColor(live.roguesGpPerHr), opacity: 0.7 } : undefined}>
                    {live?.roguesGpPerHr ? fmtGp(live.roguesGpPerHr) : '—'}
                  </td>
                  <td className="right" style={live ? { color: profitColor(live.realisticRoguesGpPerHr), fontWeight: 600 } : undefined}>
                    {live?.realisticRoguesGpPerHr ? fmtGp(live.realisticRoguesGpPerHr) : '—'}
                  </td>
                  <td className="right">{live ? live.hourlyVolume.toLocaleString() : '—'}</td>
                  <td className="right">
                    {move == null ? '—' : (
                      <span style={isVolatile ? { color: move > 0 ? '#f3c54a' : 'var(--accent)', fontWeight: 600 } : undefined}>
                        {fmtMovePct(move)}{isVolatile ? ' ⚡' : ''}
                      </span>
                    )}
                  </td>
                  <td className="right">
                    <button
                      className="range-btn"
                      onClick={(e) => { e.stopPropagation(); remove(id); }}
                      title="Remove from Rogues' list"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ============================== RECOMMENDATIONS ============================== */}
      <div className="alch-header" style={{ marginTop: '2em' }}>
        <div className="alch-summary">
          <strong>Recommendations</strong> — top {RECOMMEND_LIMIT} items not on your list, ranked by
          sustainable + volume-realistic gp/hr at <strong>≤{maxSells} sells/session</strong>{' '}
          · volume floor ≥ {ROGUES_VOLUME_FLOOR}/hr
          {isFull && ' · (List is full — clear room above before adding more)'}
        </div>
        <div className="alch-controls">
          <span style={{ color: 'var(--muted)', fontSize: '0.85em', alignSelf: 'center' }}>
            Filter:
          </span>
          <button
            className={`range-btn ${stableOnly ? 'active' : ''}`}
            onClick={() => setStableOnly(true)}
            title="Hide items whose current margin is driven by an anomalously low GE price (still profitable at 24h average)"
          >
            Stable picks only
          </button>
          <button
            className={`range-btn ${!stableOnly ? 'active' : ''}`}
            onClick={() => setStableOnly(false)}
            title="Include items whose current price is anomalous — risky but may catch real spikes"
          >
            Include anomalies
          </button>
          {stableOnly && hiddenByStability > 0 && (
            <span style={{ color: 'var(--muted)', fontSize: '0.85em', alignSelf: 'center' }}>
              ({hiddenByStability} pick{hiddenByStability === 1 ? '' : 's'} hidden — currently
              unstable)
            </span>
          )}
        </div>
        <div className="alch-note" style={{ fontSize: '0.85em' }}>
          📊 <strong>Realistic GP/hr</strong> caps the theoretical figure by how many items
          actually trade per hour (24h average). When the optimizer says "sell 50/session" but only
          ~200 trade per hour, you can run ≈ 4 sessions/hour at most — realistic gp/hr reflects
          that. <strong>Sust. realistic</strong> does the same but at the 24h-average buy price,
          which is the safest "what you'll actually earn" number. <strong>Vol-bound</strong>{' '}
          column flags items where market liquidity, not click speed, is the bottleneck.
          <br />
          <strong>Stable picks</strong> require the item to still be profitable at its 24h-average
          GE buy price — protects against momentary insta-sell crashes that look juicy for ~10
          minutes then revert. Use <strong>Include anomalies</strong> if you want to see and
          gamble on those.
        </div>
      </div>
      <div className="table-scroll">
        <table className="alch-table">
          <thead>
            <tr>
              <th className="left">Item</th>
              <th className="right">GE buy</th>
              <th className="right">High alch</th>
              <th className="right">vs 24h</th>
              <th className="right">Sells/session</th>
              <th className="right">Profit/session</th>
              <th className="right" title="Theoretical gp/hr if you could buy items as fast as you click">GP/hr (theor.)</th>
              <th className="right" title="GP/hr capped by 24h trade volume — what you'll realistically earn given the market's throughput">Realistic GP/hr</th>
              <th className="right" title="Realistic gp/hr computed at the 24h-average buy price (anomaly-resistant + volume-realistic)">Sust. realistic</th>
              <th className="right" title="Daily trade volume averaged to an hourly rate">Vol/hr (24h)</th>
              <th className="right" title="✓ = market liquidity is the bottleneck, not click speed">Vol-bound</th>
              <th className="right">Move (1h)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recommendations.length === 0 && (
              <tr><td colSpan={13} style={{ padding: '1.5em', color: 'var(--muted)', textAlign: 'center' }}>
                {stableOnly
                  ? `Nothing currently meets the stable-picks bar. Try toggling off "Stable picks only" or refreshing in a few minutes.`
                  : 'Nothing currently meets the volume + profitability bar. Try refreshing in a few minutes.'}
              </td></tr>
            )}
            {recommendations.map((r) => {
              const move = r.recentMovePct;
              const isVolatile = move != null && Math.abs(move) >= VOLATILITY_THRESHOLD;
              const vs24h = r.priceVs24hPct;
              const anomalous = vs24h != null && Math.abs(vs24h) > PRICE_ANOMALY_THRESHOLD_PCT;
              return (
                <tr
                  key={r.id}
                  className="alch-row-clickable"
                  onClick={() => openItemModal(r.id)}
                  title="Open item details"
                >
                  <td className="left">{r.name}</td>
                  <td className="right">{fmtGp(r.buyPrice)}</td>
                  <td className="right">{fmtGp(r.highalch)}</td>
                  <td className="right">
                    {vs24h == null ? '—' : (
                      <span
                        title={r.avg24hBuyPrice ? `24h avg buy: ${r.avg24hBuyPrice.toLocaleString()}gp` : undefined}
                        style={anomalous ? { color: vs24h > 0 ? '#f3c54a' : 'var(--red)', fontWeight: 600 } : undefined}
                      >
                        {fmtMovePct(vs24h)}
                      </span>
                    )}
                  </td>
                  <td className="right">
                    {r.roguesSellsPerSession}{r.roguesAlwaysProfitable ? '+' : ''}
                  </td>
                  <td className="right" style={{ color: profitColor(r.roguesProfitPerSession) }}>
                    {fmtGp(r.roguesProfitPerSession)}
                  </td>
                  <td className="right" style={{ color: profitColor(r.roguesGpPerHr), opacity: 0.7 }}>
                    {r.roguesGpPerHr ? fmtGp(r.roguesGpPerHr) : '—'}
                  </td>
                  <td className="right" style={{ color: profitColor(r.realisticRoguesGpPerHr), fontWeight: 600 }}>
                    {r.realisticRoguesGpPerHr ? fmtGp(r.realisticRoguesGpPerHr) : '—'}
                  </td>
                  <td className="right" style={{ color: profitColor(r.sustainableRealisticGpPerHr), fontWeight: 600 }}>
                    {r.sustainableRealisticGpPerHr ? fmtGp(r.sustainableRealisticGpPerHr) : '—'}
                  </td>
                  <td className="right">{r.dailyVolumePerHr ? r.dailyVolumePerHr.toLocaleString() : '—'}</td>
                  <td className="right">
                    {r.volumeBottlenecked ? (
                      <span style={{ color: '#f3c54a' }} title="Market volume is the bottleneck — you can't buy fast enough to click-bound rate">⚠ vol-cap</span>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>click-cap</span>
                    )}
                  </td>
                  <td className="right">
                    {move == null ? '—' : (
                      <span style={isVolatile ? { color: move > 0 ? '#f3c54a' : 'var(--accent)', fontWeight: 600 } : undefined}>
                        {fmtMovePct(move)}{isVolatile ? ' ⚡' : ''}
                      </span>
                    )}
                  </td>
                  <td className="right">
                    <button
                      className="range-btn"
                      disabled={isFull}
                      onClick={(e) => { e.stopPropagation(); add(r.id, r.name); }}
                      title={isFull ? 'List is full' : "Add to Rogues' list"}
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
    </div>
  );
}
