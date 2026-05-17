import { useEffect, useMemo, useState } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchHighAlch } from '../../api/client';
import { useRoguesLab } from '../../context/RoguesLabContext';
import { useItemModal } from '../../context/ItemModalContext';
import { ROGUES_VOLUME_FLOOR, VOLATILITY_THRESHOLD } from '../../utils/constants';

// Rogues' Den Lab — a sandbox for calibrating the recommendation engine.
// Three panels:
//   1. Your picks         — user-curated candidates, with verdict badges
//   2. Algo: Phase A      — top insta-buy picks (active-session strategy)
//   3. Algo: Phase B      — top patient-offer picks (logged-off strategy)
// Plus a detail panel that shows full per-item metrics when "Why?" is clicked.
//
// The lab is intentionally separate from the live 27-slot Rogues' list so the
// user can experiment without disturbing their working list.

const ALGO_LIMIT = 15;

// Verdict computed from the rich metric set. Used for the badge on each pick.
// `tone` maps to CSS class so styling stays consistent with the rest of the app.
function verdictFor(row) {
  if (!row) return { tone: 'unknown', icon: '·', label: 'No live data — refresh prices' };

  const phase = row.suggestedPhase;
  if (!phase) {
    return {
      tone: 'weak',
      icon: '👎',
      label: 'Not profitable in either phase right now',
    };
  }

  const susProfit = row.sustainableRoguesProfit || 0;
  // Sustainable check applies to Phase A (insta-buy at 24h avg high).
  // Phase B's sustainable proxy is its own profit (already uses 24h avg low).
  if (phase === 'A' && susProfit <= 0) {
    return {
      tone: 'weak',
      icon: '👎',
      label: 'Phase A current margin is an anomaly — unsustainable at 24h average',
    };
  }

  // Price moved more than 15% from the 24h baseline — risky regardless of profit
  const vs24h = row.priceVs24hPct;
  if (vs24h != null && Math.abs(vs24h) > 15) {
    return {
      tone: 'watch',
      icon: '⚠',
      label: `Price ${vs24h > 0 ? 'spiked +' : 'dropped '}${vs24h}% from 24h average — verify before committing`,
    };
  }

  // Liquidity gate
  const vol = row.hourlyVolume || 0;
  if (vol < ROGUES_VOLUME_FLOOR) {
    return {
      tone: 'neutral',
      icon: '⚖',
      label: `Profitable but thin volume (${vol}/hr < ${ROGUES_VOLUME_FLOOR}/hr) — fill risk`,
    };
  }

  // Look at the realistic gp/hr for the suggested phase
  const phaseGph =
    phase === 'B'
      ? row.phaseBRealisticGpPerHr || 0
      : row.phaseARealisticGpPerHr || 0;
  if (phaseGph < 100_000) {
    return {
      tone: 'neutral',
      icon: '⚖',
      label: `Profitable but modest realistic gp/hr (${fmtGp(phaseGph)})`,
    };
  }

  return {
    tone: 'strong',
    icon: '👍',
    label: `Strong Phase ${phase} pick · realistic ${fmtGp(phaseGph)} gp/hr`,
  };
}

function fmtPct(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export default function RoguesLabTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState(null);

  const { items: labItems, add, remove, count, clear } = useRoguesLab();
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

  const byId = useMemo(() => {
    if (!data) return new Map();
    return new Map(data.items.map((r) => [r.id, r]));
  }, [data]);

  const labIdSet = useMemo(() => new Set(labItems.map((it) => it.id)), [labItems]);

  // Pre-rank algo picks by phase. Phase A wants the existing sustainable
  // anomaly guard (24h-avg-priced Rogues' must still be profitable); Phase B
  // already uses 24h-avg-low as its buy price so the anomaly issue is built in.
  const algoPhaseA = useMemo(() => {
    if (!data) return [];
    return data.items
      .filter(
        (r) =>
          r.suggestedPhase === 'A' &&
          r.hourlyVolume >= ROGUES_VOLUME_FLOOR &&
          (r.sustainableRoguesProfit || 0) > 0 &&
          (r.phaseARealisticGpPerHr || 0) > 0
      )
      .sort((a, b) => (b.phaseARealisticGpPerHr || 0) - (a.phaseARealisticGpPerHr || 0))
      .slice(0, ALGO_LIMIT);
  }, [data]);

  const algoPhaseB = useMemo(() => {
    if (!data) return [];
    return data.items
      .filter(
        (r) =>
          r.suggestedPhase === 'B' &&
          (r.phaseBRealisticGpPerHr || 0) > 0
      )
      .sort((a, b) => (b.phaseBRealisticGpPerHr || 0) - (a.phaseBRealisticGpPerHr || 0))
      .slice(0, ALGO_LIMIT);
  }, [data]);

  // Lab picks joined with live data
  const labRows = useMemo(() => {
    return labItems.map((it) => ({
      id: it.id,
      addedAt: it.addedAt,
      live: byId.get(it.id),
      name: byId.get(it.id)?.name || it.name,
    }));
  }, [labItems, byId]);

  // Diff stats: how many lab picks the algo agrees / disagrees with
  const diffStats = useMemo(() => {
    let agree = 0;
    let disagree = 0;
    let watch = 0;
    let nodata = 0;
    for (const r of labRows) {
      const v = verdictFor(r.live);
      if (v.tone === 'strong') agree += 1;
      else if (v.tone === 'weak') disagree += 1;
      else if (v.tone === 'watch') watch += 1;
      else nodata += 1;
    }
    return { agree, disagree, watch, nodata };
  }, [labRows]);

  // Search-to-add box: filter live items by name, fuzzy-ish
  const searchResults = useMemo(() => {
    if (!data || !query.trim()) return [];
    const q = query.toLowerCase();
    return data.items
      .filter((r) => r.name.toLowerCase().includes(q) && !labIdSet.has(r.id))
      .slice(0, 8);
  }, [data, query, labIdSet]);

  const detailRow = detailId != null ? byId.get(detailId) : null;

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading lab data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          <strong>Rogues' Lab</strong> — sandbox for calibrating picks. {count} of your candidates ·
          {' '}<span style={{ color: 'var(--green)' }}>{diffStats.agree} 👍</span> ·
          {' '}<span style={{ color: '#f3c54a' }}>{diffStats.watch} ⚠</span> ·
          {' '}<span style={{ color: 'var(--red)' }}>{diffStats.disagree} 👎</span>
          {diffStats.nodata > 0 && (
            <> · <span style={{ color: 'var(--muted)' }}>{diffStats.nodata} no data</span></>
          )}
        </div>

        <div className="alch-controls">
          <input
            type="search"
            className="item-search-input"
            placeholder="Search items to add to your picks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ maxWidth: 340 }}
          />
          <button className="range-btn" onClick={load} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh prices'}
          </button>
          {count > 0 && (
            <button
              className="range-btn"
              onClick={() => { if (confirm('Clear all lab picks?')) clear(); }}
              title="Clear all lab picks"
            >
              Clear all
            </button>
          )}
        </div>

        {searchResults.length > 0 && (
          <div className="lab-search-results">
            {searchResults.map((r) => {
              const v = verdictFor(r);
              return (
                <button
                  key={r.id}
                  className="lab-search-result"
                  onClick={() => { add(r.id, r.name); setQuery(''); }}
                  title={`Add "${r.name}" to your lab picks`}
                >
                  <span className={`rogues-pip ${v.tone}`}>{v.icon}</span>
                  <span style={{ flex: 1 }}>{r.name}</span>
                  <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
                    {r.suggestedPhase ? `Phase ${r.suggestedPhase}` : 'unprofitable'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="alch-note">
          💡 The lab is a sandbox — picks here don't affect your live 27-slot list. Click{' '}
          <strong>Why?</strong> on any picked item to see the full metric breakdown, then paste
          the readout into the chat with Claude to get a written critique. The algo's columns on
          the right show what it would pick on its own; differences between your list and the algo
          list are the most useful feedback signal.
        </div>
      </div>

      <div className="lab-grid">
        {/* ============================== YOUR PICKS ============================== */}
        <div className="lab-panel">
          <div className="lab-panel-header">Your picks ({count})</div>
          {labRows.length === 0 ? (
            <div className="lab-panel-empty">
              Search above to add candidate items. Try items you're already running on your live
              list to see how the algo grades them.
            </div>
          ) : (
            <table className="alch-table lab-table">
              <thead>
                <tr>
                  <th style={{ width: '2.5em' }} />
                  <th className="left">Item</th>
                  <th className="right">Phase</th>
                  <th className="right">Buy @</th>
                  <th className="right">Profit/sess</th>
                  <th className="right">Real gp/hr</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {labRows.map(({ id, name, live }) => {
                  const v = verdictFor(live);
                  const phase = live?.suggestedPhase;
                  const isB = phase === 'B';
                  const buy = isB ? live?.phaseBBuyPrice : live?.phaseABuyPrice;
                  const profit = isB ? live?.phaseBProfitPerSession : live?.phaseAProfitPerSession;
                  const gph = isB ? live?.phaseBRealisticGpPerHr : live?.phaseARealisticGpPerHr;
                  return (
                    <tr
                      key={id}
                      className={`lab-row ${detailId === id ? 'selected' : ''}`}
                      onClick={() => setDetailId(id)}
                    >
                      <td>
                        <span className={`rogues-pip ${v.tone}`} title={v.label}>
                          {v.icon}
                        </span>
                      </td>
                      <td className="left">{name}</td>
                      <td className="right">
                        {phase ? <span className={`phase-badge phase-${phase.toLowerCase()}`}>{phase}</span> : '—'}
                      </td>
                      <td className="right">{buy != null ? fmtGp(buy) : '—'}</td>
                      <td className="right">{profit != null ? fmtGp(profit) : '—'}</td>
                      <td className="right" style={{ color: profitColor(gph || 0), fontWeight: 600 }}>
                        {gph ? fmtGp(gph) : '—'}
                      </td>
                      <td className="right">
                        <button
                          className="range-btn"
                          onClick={(e) => { e.stopPropagation(); remove(id); if (detailId === id) setDetailId(null); }}
                          title="Remove from lab"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ============================== ALGO PHASE A ============================== */}
        <AlgoPanel
          title="Algo: Phase A (insta-buy)"
          subtitle="Active-session picks · buy at current high, sell during cycling"
          rows={algoPhaseA}
          gpHrField="phaseARealisticGpPerHr"
          profitField="phaseAProfitPerSession"
          buyField="phaseABuyPrice"
          onAdd={(r) => add(r.id, r.name)}
          onSelect={(r) => setDetailId(r.id)}
          inLab={(id) => labIdSet.has(id)}
          selectedId={detailId}
        />

        {/* ============================== ALGO PHASE B ============================== */}
        <AlgoPanel
          title="Algo: Phase B (patient offer)"
          subtitle="Logged-off picks · queue GE offer at typical low, collect next session"
          rows={algoPhaseB}
          gpHrField="phaseBRealisticGpPerHr"
          profitField="phaseBProfitPerSession"
          buyField="phaseBBuyPrice"
          onAdd={(r) => add(r.id, r.name)}
          onSelect={(r) => setDetailId(r.id)}
          inLab={(id) => labIdSet.has(id)}
          selectedId={detailId}
        />
      </div>

      {/* ============================== DETAIL PANEL ============================== */}
      {detailRow && (
        <DetailPanel
          row={detailRow}
          onClose={() => setDetailId(null)}
          onOpenItemModal={() => openItemModal(detailRow.id)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AlgoPanel({ title, subtitle, rows, gpHrField, profitField, buyField, onAdd, onSelect, inLab, selectedId }) {
  return (
    <div className="lab-panel">
      <div className="lab-panel-header">
        {title}
        <span style={{ display: 'block', fontSize: '0.75em', color: 'var(--muted)', fontWeight: 400, marginTop: '0.15em' }}>
          {subtitle}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="lab-panel-empty">No qualifying picks right now.</div>
      ) : (
        <table className="alch-table lab-table">
          <thead>
            <tr>
              <th className="left">#</th>
              <th className="left">Item</th>
              <th className="right">Buy</th>
              <th className="right">Profit/sess</th>
              <th className="right">Real gp/hr</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const v = verdictFor(r);
              const already = inLab(r.id);
              return (
                <tr
                  key={r.id}
                  className={`lab-row ${selectedId === r.id ? 'selected' : ''}`}
                  onClick={() => onSelect(r)}
                >
                  <td className="left" style={{ color: 'var(--muted)' }}>{i + 1}</td>
                  <td className="left">
                    <span className={`rogues-pip ${v.tone}`} title={v.label} style={{ marginRight: '0.3em' }}>
                      {v.icon}
                    </span>
                    {r.name}
                  </td>
                  <td className="right">{r[buyField] != null ? fmtGp(r[buyField]) : '—'}</td>
                  <td className="right">{fmtGp(r[profitField])}</td>
                  <td className="right" style={{ color: profitColor(r[gpHrField] || 0), fontWeight: 600 }}>
                    {fmtGp(r[gpHrField])}
                  </td>
                  <td className="right">
                    <button
                      className="range-btn"
                      disabled={already}
                      onClick={(e) => { e.stopPropagation(); onAdd(r); }}
                      title={already ? 'Already in your picks' : 'Add to your lab picks'}
                    >
                      {already ? '✓' : '+'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DetailPanel({ row, onClose, onOpenItemModal }) {
  const v = verdictFor(row);
  const move = row.recentMovePct;
  const isVolatile = move != null && Math.abs(move) >= VOLATILITY_THRESHOLD;

  // Copy-as-text button — exports a structured snapshot the user can paste
  // into chat to ask "what do you think of this item?"
  const copyAsText = () => {
    const lines = [
      `Rogues' Lab readout — ${row.name} (id ${row.id})`,
      `  Verdict: ${v.icon} ${v.label}`,
      `  Suggested phase: ${row.suggestedPhase || 'none'} ${row.suggestedPhaseReason ? `— ${row.suggestedPhaseReason}` : ''}`,
      ``,
      `Phase A (insta-buy during session):`,
      `  Buy price: ${row.phaseABuyPrice} gp`,
      `  Sells/session: ${row.phaseASellsPerSession}  Profit/session: ${row.phaseAProfitPerSession} gp`,
      `  GP/hr theoretical: ${row.phaseAGpPerHr}  Realistic: ${row.phaseARealisticGpPerHr}`,
      ``,
      `Phase B (patient GE offer):`,
      `  Buy price: ${row.phaseBBuyPrice ?? 'n/a'} gp`,
      `  Sells/session: ${row.phaseBSellsPerSession ?? '—'}  Profit/session: ${row.phaseBProfitPerSession ?? '—'} gp`,
      `  GP/hr theoretical: ${row.phaseBGpPerHr ?? '—'}  Realistic: ${row.phaseBRealisticGpPerHr ?? '—'}`,
      ``,
      `Market context:`,
      `  High alch: ${row.highalch}  Current high: ${row.buyPrice}  Current low: ${row.lowPrice}`,
      `  Spread: ${row.spreadPct ?? '—'}%  vs 24h avg: ${row.priceVs24hPct ?? '—'}%  Recent move (1h): ${move ?? '—'}%`,
      `  24h volume: ${row.dailyVolumePerHr ?? '—'}/hr  1h volume: ${row.hourlyVolume}/hr`,
      `  GE buy limit: ${row.limit ?? '—'}/4hr  → ${row.buyLimitSessions ?? '—'} sessions of ${row.phaseASellsPerSession} items`,
      `  Sustainable Phase A profit: ${row.sustainableRoguesProfit ?? '—'} gp/session`,
    ];
    const txt = lines.join('\n');
    navigator.clipboard?.writeText(txt);
  };

  return (
    <div className="lab-detail">
      <div className="lab-detail-header">
        <div>
          <span className={`rogues-pip ${v.tone}`} style={{ marginRight: '0.4em' }}>{v.icon}</span>
          <strong style={{ fontSize: '1.1em' }}>{row.name}</strong>
          <span style={{ marginLeft: '0.8em', color: 'var(--muted)', fontSize: '0.9em' }}>{v.label}</span>
        </div>
        <div>
          <button className="range-btn" onClick={onOpenItemModal} title="Open full item modal">
            Item details
          </button>
          <button className="range-btn" onClick={copyAsText} style={{ marginLeft: '0.3em' }} title="Copy a text snapshot for pasting into chat">
            Copy as text
          </button>
          <button className="range-btn" onClick={onClose} style={{ marginLeft: '0.3em' }}>
            Close
          </button>
        </div>
      </div>

      <div className="lab-detail-grid">
        <div className="lab-detail-section">
          <div className="lab-detail-section-title">Phase A · insta-buy during session</div>
          <Field label="Buy price" value={`${row.phaseABuyPrice} gp`} />
          <Field label="Sells/session (optimal)" value={row.phaseASellsPerSession} />
          <Field label="Profit/session" value={`${fmtGp(row.phaseAProfitPerSession)} gp`} color={profitColor(row.phaseAProfitPerSession)} />
          <Field label="GP/hr (theoretical)" value={fmtGp(row.phaseAGpPerHr)} />
          <Field label="GP/hr (realistic, vol-capped)" value={fmtGp(row.phaseARealisticGpPerHr)} color={profitColor(row.phaseARealisticGpPerHr)} bold />
          <Field label="Sustainable profit (at 24h avg high)" value={fmtGp(row.sustainableRoguesProfit)} color={profitColor(row.sustainableRoguesProfit)} />
        </div>

        <div className="lab-detail-section">
          <div className="lab-detail-section-title">Phase B · patient GE offer</div>
          <Field label="Buy price (24h avg low)" value={row.phaseBBuyPrice ? `${row.phaseBBuyPrice} gp` : '—'} />
          <Field label="Sells/session (optimal)" value={row.phaseBSellsPerSession ?? '—'} />
          <Field label="Profit/session" value={row.phaseBProfitPerSession != null ? `${fmtGp(row.phaseBProfitPerSession)} gp` : '—'} color={profitColor(row.phaseBProfitPerSession)} />
          <Field label="GP/hr (theoretical)" value={row.phaseBGpPerHr != null ? fmtGp(row.phaseBGpPerHr) : '—'} />
          <Field label="GP/hr (realistic)" value={row.phaseBRealisticGpPerHr ? fmtGp(row.phaseBRealisticGpPerHr) : '—'} color={profitColor(row.phaseBRealisticGpPerHr)} bold />
          <Field label="Last-sale margin (Phase B)" value={row.phaseBLastSaleMargin != null ? `${fmtGp(row.phaseBLastSaleMargin)} gp` : '—'} />
        </div>

        <div className="lab-detail-section">
          <div className="lab-detail-section-title">Market context</div>
          <Field label="High alch" value={`${fmtGp(row.highalch)} gp`} />
          <Field label="Current high / low" value={`${fmtGp(row.buyPrice)} / ${fmtGp(row.lowPrice)} gp`} />
          <Field label="Spread" value={fmtPct(row.spreadPct)} />
          <Field label="vs 24h avg" value={fmtPct(row.priceVs24hPct)} color={Math.abs(row.priceVs24hPct || 0) > 15 ? (row.priceVs24hPct > 0 ? '#f3c54a' : 'var(--red)') : undefined} />
          <Field label="Recent move (1h)" value={isVolatile ? `${fmtPct(move)} ⚡` : fmtPct(move)} />
          <Field label="Hourly volume" value={`${row.hourlyVolume?.toLocaleString() ?? '—'}/hr`} />
          <Field label="Daily volume (per hr)" value={`${row.dailyVolumePerHr?.toLocaleString() ?? '—'}/hr`} />
          <Field label="GE 4hr buy limit" value={row.limit?.toLocaleString() ?? '—'} />
          <Field label="Buy-limit headroom" value={row.buyLimitSessions != null ? `${row.buyLimitSessions} sessions of ${row.phaseASellsPerSession}` : '—'} />
        </div>

        <div className="lab-detail-section lab-detail-verdict">
          <div className="lab-detail-section-title">Algo verdict</div>
          <div style={{ marginBottom: '0.4em' }}>
            <strong>Suggested phase:</strong>{' '}
            {row.suggestedPhase ? (
              <span className={`phase-badge phase-${row.suggestedPhase.toLowerCase()}`}>
                Phase {row.suggestedPhase}
              </span>
            ) : (
              <em>none — currently unprofitable</em>
            )}
          </div>
          {row.suggestedPhaseReason && (
            <div style={{ color: 'var(--muted)', fontSize: '0.9em', marginBottom: '0.8em' }}>
              {row.suggestedPhaseReason}
            </div>
          )}
          <div style={{ fontSize: '0.85em', color: 'var(--muted)', lineHeight: 1.5 }}>
            Use <strong>Copy as text</strong> to paste this readout into chat with Claude for a
            written critique. The verdict pip is a heuristic — Claude can reason from the raw
            numbers about edge cases the heuristic misses.
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, color, bold }) {
  return (
    <div className="lab-field">
      <div className="lab-field-label">{label}</div>
      <div className="lab-field-value" style={{ color, fontWeight: bold ? 600 : undefined }}>
        {value}
      </div>
    </div>
  );
}
