import { useState, useEffect, useRef } from 'react';
import { fmtGp } from '../utils/format';
import { RANGE_OPTIONS } from '../utils/constants';
import { fetchTimeseries } from '../api/client';

// Lightweight inline SVG line chart for an item's GE price history.
// Three range toggles (24h/Week/Month) drive a wiki timeseries call;
// results are cached in component state by (itemId, timestep) so flipping
// ranges doesn't re-fetch what's already loaded. Hovering snaps a
// crosshair to the nearest data point and shows a tooltip.
export default function PriceGraph({ itemId }) {
  const [range, setRange] = useState('24h');
  const [items, setItems] = useState({}); // { cacheKey -> { data | loading | error } }
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);

  const opt = RANGE_OPTIONS.find((o) => o.key === range);
  const cacheKey = `${itemId}:${opt.timestep}`;
  const entry = items[cacheKey];

  // Reset hover when switching items or ranges so we don't index a stale array.
  useEffect(() => {
    setHoverIdx(null);
  }, [itemId, range]);

  useEffect(() => {
    if (!itemId || entry) return;
    setItems((s) => ({ ...s, [cacheKey]: { loading: true } }));
    fetchTimeseries(itemId, opt.timestep)
      .then((d) => setItems((s) => ({ ...s, [cacheKey]: { data: d.data || [] } })))
      .catch((e) => setItems((s) => ({ ...s, [cacheKey]: { error: e.message } })));
  }, [itemId, opt.timestep, cacheKey, entry]);

  const width = 600;
  const height = 160;
  const padL = 50, padR = 8, padT = 8, padB = 22;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  let body;
  if (entry?.error) {
    body = <div className="graph-msg">Error: {entry.error}</div>;
  } else if (entry?.loading || !entry) {
    body = <div className="graph-msg">Loading…</div>;
  } else {
    const raw = entry.data || [];
    const points = raw.slice(-opt.maxPoints);
    const usable = points.filter(
      (p) => p.avgHighPrice != null || p.avgLowPrice != null
    );
    if (usable.length < 2) {
      body = <div className="graph-msg">Not enough data for this range.</div>;
    } else {
      const xs = usable.map((p) => p.timestamp);
      const allPrices = [];
      for (const p of usable) {
        if (p.avgHighPrice != null) allPrices.push(p.avgHighPrice);
        if (p.avgLowPrice != null) allPrices.push(p.avgLowPrice);
      }
      const minT = Math.min(...xs);
      const maxT = Math.max(...xs);
      const minP = Math.min(...allPrices);
      const maxP = Math.max(...allPrices);
      const tSpan = maxT - minT || 1;
      const pSpan = maxP - minP || 1;
      const xScale = (t) => padL + ((t - minT) / tSpan) * plotW;
      const yScale = (p) => padT + plotH - ((p - minP) / pSpan) * plotH;

      const buildPath = (key) => {
        const seg = [];
        let started = false;
        for (const p of usable) {
          const v = p[key];
          if (v == null) {
            started = false;
            continue;
          }
          seg.push(
            `${started ? 'L' : 'M'} ${xScale(p.timestamp).toFixed(1)} ${yScale(v).toFixed(1)}`
          );
          started = true;
        }
        return seg.join(' ');
      };

      const lastHigh = [...usable].reverse().find((p) => p.avgHighPrice != null)?.avgHighPrice;
      const lastLow = [...usable].reverse().find((p) => p.avgLowPrice != null)?.avgLowPrice;
      const fmtTime = (ts) => {
        const d = new Date(ts * 1000);
        if (opt.key === '24h') {
          return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      };
      const fmtFullTime = (ts) => {
        const d = new Date(ts * 1000);
        return opt.key === '24h'
          ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric' });
      };

      const handleMouseMove = (e) => {
        if (!svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        if (rect.width === 0) return;
        const svgX = ((e.clientX - rect.left) / rect.width) * width;
        let nearest = 0;
        let bestDist = Infinity;
        for (let i = 0; i < usable.length; i++) {
          const d = Math.abs(xScale(usable[i].timestamp) - svgX);
          if (d < bestDist) {
            bestDist = d;
            nearest = i;
          }
        }
        setHoverIdx(nearest);
      };

      const hp = hoverIdx != null && hoverIdx < usable.length ? usable[hoverIdx] : null;
      const hoverX = hp ? xScale(hp.timestamp) : null;
      // Flip tooltip to the left when too close to the right edge
      const tooltipW = 165;
      const tooltipH = 56;
      const showLeft = hoverX != null && hoverX > width - tooltipW - 12;
      const tx = hoverX != null ? (showLeft ? hoverX - tooltipW - 8 : hoverX + 8) : 0;
      const ty = padT + 4;

      body = (
        <>
          <svg
            ref={svgRef}
            className="price-svg"
            viewBox={`0 0 ${width} ${height}`}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <text x={padL - 6} y={padT + 4} className="axis-label" textAnchor="end">
              {fmtGp(maxP)}
            </text>
            <text x={padL - 6} y={padT + plotH} className="axis-label" textAnchor="end">
              {fmtGp(minP)}
            </text>
            <line x1={padL} x2={padL + plotW} y1={padT} y2={padT} className="grid" />
            <line
              x1={padL} x2={padL + plotW}
              y1={padT + plotH} y2={padT + plotH}
              className="grid"
            />
            <text x={padL} y={height - 6} className="axis-label" textAnchor="start">
              {fmtTime(minT)}
            </text>
            <text x={padL + plotW} y={height - 6} className="axis-label" textAnchor="end">
              {fmtTime(maxT)}
            </text>
            <path d={buildPath('avgHighPrice')} className="line line-high" />
            <path d={buildPath('avgLowPrice')} className="line line-low" />
            {hp && (
              <g className="hover-marker">
                <line
                  x1={hoverX} x2={hoverX}
                  y1={padT} y2={padT + plotH}
                  className="crosshair"
                />
                {hp.avgHighPrice != null && (
                  <circle
                    cx={hoverX}
                    cy={yScale(hp.avgHighPrice)}
                    r="3.5"
                    className="dot-high"
                  />
                )}
                {hp.avgLowPrice != null && (
                  <circle
                    cx={hoverX}
                    cy={yScale(hp.avgLowPrice)}
                    r="3.5"
                    className="dot-low"
                  />
                )}
                <rect
                  x={tx} y={ty}
                  width={tooltipW} height={tooltipH}
                  rx="3"
                  className="tooltip-bg"
                />
                <text x={tx + 8} y={ty + 14} className="tooltip-time">
                  {fmtFullTime(hp.timestamp)}
                </text>
                <text x={tx + 8} y={ty + 30} className="tooltip-text">
                  <tspan className="tooltip-high">High:</tspan>{' '}
                  {hp.avgHighPrice != null ? fmtGp(hp.avgHighPrice) : '—'}
                </text>
                <text x={tx + 8} y={ty + 46} className="tooltip-text">
                  <tspan className="tooltip-low">Low:</tspan>{' '}
                  {hp.avgLowPrice != null ? fmtGp(hp.avgLowPrice) : '—'}
                </text>
              </g>
            )}
          </svg>
          <div className="price-legend">
            <span className="legend-item">
              <span className="swatch swatch-high" />
              High (latest): <strong>{lastHigh != null ? fmtGp(lastHigh) : '—'}</strong>
            </span>
            <span className="legend-item">
              <span className="swatch swatch-low" />
              Low (latest): <strong>{lastLow != null ? fmtGp(lastLow) : '—'}</strong>
            </span>
            <span className="legend-item legend-range">
              Window range: <strong>{fmtGp(minP)} – {fmtGp(maxP)}</strong>
            </span>
          </div>
        </>
      );
    }
  }

  return (
    <div className="price-graph">
      <div className="graph-ranges">
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.key}
            className={`range-btn ${range === o.key ? 'active' : ''}`}
            onClick={() => setRange(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {body}
    </div>
  );
}
