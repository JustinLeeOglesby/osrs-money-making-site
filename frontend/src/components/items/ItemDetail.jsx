import { useState, useEffect } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchItem, fetchTimeseries } from '../../api/client';
import { PRICE_POSITION_LOW, PRICE_POSITION_HIGH } from '../../utils/constants';
import { useWatchlist } from '../../context/WatchlistContext';
import { useGELimits, msRemaining, isReady } from '../../context/GELimitsContext';
import ItemNameCell from '../ItemNameCell';
import PriceGraph from '../PriceGraph';

// Where does the current insta-buy fall within the last 24 hours of trading?
// Returns { pct, band } where:
//   pct  = 0 (at min) to 1 (at max)
//   band = 'low' | 'high' | 'mid' (uses PRICE_POSITION_LOW/HIGH thresholds)
// Returns null when there's not enough timeseries data to draw a conclusion.
function pricePosition(points, currentHigh) {
  if (!Array.isArray(points) || points.length < 6 || currentHigh == null) return null;
  const values = [];
  for (const p of points) {
    if (p.avgHighPrice != null) values.push(p.avgHighPrice);
    if (p.avgLowPrice != null) values.push(p.avgLowPrice);
  }
  if (values.length < 6) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return null;
  const pct = (currentHigh - min) / (max - min);
  let band = 'mid';
  if (pct <= PRICE_POSITION_LOW) band = 'low';
  else if (pct >= PRICE_POSITION_HIGH) band = 'high';
  return { pct, band, min, max };
}

// Compact "Xh Ym" formatter for the GE-limit countdown.
function formatMsShort(ms) {
  if (ms <= 0) return '0m';
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function PricePositionBadge({ position }) {
  if (!position || position.band === 'mid') return null;
  const isLow = position.band === 'low';
  const label = isLow ? 'Near 24h low' : 'Near 24h high';
  const emoji = isLow ? '⬇' : '⬆';
  return (
    <span
      className={`position-badge ${position.band}`}
      data-tooltip={`Current price is at ${Math.round(position.pct * 100)}% of the 24h range (${fmtGp(position.min)} – ${fmtGp(position.max)})`}
    >
      {emoji} {label}
    </span>
  );
}

// Right-pane (and modal) view for a single item: icon, current insta-buy /
// insta-sell, margin, after-tax margin, 4hr buy limit, high alch value,
// plus the full price history graph.
export default function ItemDetail({ itemId }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [timeseries, setTimeseries] = useState(null);
  const { isWatched, add, remove } = useWatchlist();
  const geLimits = useGELimits();

  useEffect(() => {
    setInfo(null);
    setError(null);
    setTimeseries(null);
    fetchItem(itemId).then(setInfo).catch((e) => setError(e.message));
    // Pull 24h timeseries (5m steps) for the price-position indicator. This
    // is the same data the graph below uses, so cached server-side anyway.
    fetchTimeseries(itemId, '5m')
      .then((d) => setTimeseries(d.data || []))
      .catch(() => setTimeseries([]));
  }, [itemId]);

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!info) return <div className="graph-msg">Loading item…</div>;

  const spread =
    info.high != null && info.low != null ? info.high - info.low : null;
  const spreadAfterTax =
    spread != null ? spread - (info.tax || 0) : null;

  const watched = isWatched(info.id);
  const toggleWatch = () => {
    if (watched) remove(info.id);
    else add(info.id, info.name);
  };

  // GE buy-limit tracker — show "Mark limit hit" / "Ready in Xh Ym" / "Ready!"
  // depending on the entry's state.
  const limitEntry = geLimits.entries.find((e) => e.id === info.id);
  const limitTracked = !!limitEntry;
  const limitReady = limitTracked && isReady(limitEntry, geLimits.now);
  const limitMsLeft = limitTracked ? msRemaining(limitEntry, geLimits.now) : null;
  const limitLabel = !limitTracked
    ? '📅 Mark buy limit hit'
    : limitReady
      ? '✅ Limit ready'
      : `⏳ Ready in ${formatMsShort(limitMsLeft)}`;
  const onLimitClick = () => {
    if (!limitTracked || limitReady) geLimits.mark(info.id, info.name);
    else geLimits.clear(info.id);
  };

  const position = pricePosition(timeseries, info.high);

  return (
    <div className="item-detail">
      <div className="item-header">
        {info.icon && (
          <img
            src={`https://oldschool.runescape.wiki/images/${encodeURIComponent(
              info.icon.replace(/ /g, '_')
            )}`}
            alt=""
            className="item-icon"
            onError={(e) => (e.currentTarget.style.display = 'none')}
          />
        )}
        <div style={{ flex: 1 }}>
          <h2 className="item-name">
            <ItemNameCell row={info} />{' '}
            <span className="item-id-chip">id {info.id}</span>
            {info.members && <span className="item-id-chip members">members</span>}{' '}
            <PricePositionBadge position={position} />
          </h2>
          {info.examine && <div className="item-examine">{info.examine}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4em', flexShrink: 0 }}>
          <button
            className={`range-btn watch-btn ${watched ? 'active' : ''}`}
            onClick={toggleWatch}
            title={watched ? 'Stop watching this item' : 'Add to watchlist'}
          >
            {watched ? '👁 Watching' : '👁 Watch'}
          </button>
          <button
            className={`range-btn ${limitReady ? 'active' : ''}`}
            onClick={onLimitClick}
            title={
              !limitTracked
                ? 'Start a 4-hour timer for the GE buy limit on this item'
                : limitReady
                  ? 'Click to restart the 4-hour timer'
                  : 'Click to clear this timer'
            }
          >
            {limitLabel}
          </button>
        </div>
      </div>

      <div className="item-stats">
        <div className="stat">
          <div className="stat-label">Insta-buy (high)</div>
          <div className="stat-value" style={{ color: 'var(--red)' }}>
            {info.high != null ? fmtGp(info.high) : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Insta-sell (low)</div>
          <div className="stat-value" style={{ color: 'var(--green)' }}>
            {info.low != null ? fmtGp(info.low) : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Margin (high − low)</div>
          <div className="stat-value">{spread != null ? fmtGp(spread) : '—'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">After tax</div>
          <div className="stat-value" style={{ color: profitColor(spreadAfterTax) }}>
            {spreadAfterTax != null ? fmtGp(spreadAfterTax) : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">4hr buy limit</div>
          <div className="stat-value">
            {info.limit != null ? info.limit.toLocaleString() : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">High alch</div>
          <div className="stat-value">
            {info.highalch != null ? fmtGp(info.highalch) : '—'}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Hourly volume</div>
          <div className="stat-value">
            {info.hourlyVolume != null ? info.hourlyVolume.toLocaleString() : '—'}
          </div>
        </div>
      </div>

      <div className="detail-label" style={{ marginTop: '1em' }}>
        Price history
      </div>
      <PriceGraph itemId={info.id} />
    </div>
  );
}
