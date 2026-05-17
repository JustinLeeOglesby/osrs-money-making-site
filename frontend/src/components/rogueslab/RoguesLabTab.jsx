import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchHighAlch } from '../../api/client';
import { useRoguesLab } from '../../context/RoguesLabContext';
import { useItemModal } from '../../context/ItemModalContext';
import {
  ROGUES_LAB_DEFAULTS,
  ROGUES_LAB_SETTINGS_KEY,
  VOLATILITY_THRESHOLD,
} from '../../utils/constants';

// Rogues' Den Lab — sandbox for calibrating the recommendation engine against
// real-world experience. Three algo panels (Phase A / B / C) plus a user pick
// list. Verdicts and rankings are computed client-side from a set of tunable
// thresholds so the user can iterate on the heuristic without code changes.

const ALGO_LIMIT = 20;

// ---------------------------------------------------------------------------
// Settings: tunable thresholds for verdict + classification logic
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const raw = localStorage.getItem(ROGUES_LAB_SETTINGS_KEY);
    if (!raw) return { ...ROGUES_LAB_DEFAULTS };
    return { ...ROGUES_LAB_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...ROGUES_LAB_DEFAULTS };
  }
}

function useLabSettings() {
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_LAB_SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* session-only fallback */
    }
  }, [settings]);
  const updateSetting = useCallback(
    (key, value) => setSettings((s) => ({ ...s, [key]: value })),
    []
  );
  const resetSettings = useCallback(() => setSettings({ ...ROGUES_LAB_DEFAULTS }), []);
  return { settings, updateSetting, resetSettings };
}

// ---------------------------------------------------------------------------
// Classification: pick the best phase per item under current settings
// ---------------------------------------------------------------------------

// Returns { phase, daily, activeDaily, activePhase, phaseADaily, phaseBDaily, phaseCDaily, reason }.
// Phase A: volume-bound active cycling (insta-buy)
// Phase B: patient GE offer + active selling
// Phase C: GE buy-limit cadence cycling (insta-buy, 4× daily)
function classifyItem(row, settings) {
  if (!row) return null;
  const ha = settings.hoursActive;
  const phaseADaily = (row.phaseARealisticGpPerHr || 0) * ha;
  const phaseBDaily = (row.phaseBRealisticGpPerHr || 0) * ha;
  const phaseCDaily = row.phaseCDailyProfit || 0;

  // Best active-cycling outcome — whichever ceiling binds first.
  let activeDaily = 0;
  let activePhase = null;
  let activeReason = null;
  if (phaseADaily > 0 && phaseCDaily > 0) {
    if (phaseCDaily < phaseADaily) {
      activeDaily = phaseCDaily;
      activePhase = 'C';
      activeReason = `GE 4hr buy limit (${row.limit}/cycle) binds before market volume`;
    } else {
      activeDaily = phaseADaily;
      activePhase = 'A';
      activeReason = 'Volume-bound active cycling at insta-buy price';
    }
  } else if (phaseCDaily > 0) {
    activeDaily = phaseCDaily;
    activePhase = 'C';
    activeReason = `Limit-cadence cycling (${row.limit}/cycle × 4 daily)`;
  } else if (phaseADaily > 0) {
    activeDaily = phaseADaily;
    activePhase = 'A';
    activeReason = 'Volume-bound active cycling at insta-buy price';
  }

  // Patient (B) overrides active when it's meaningfully better.
  const premium = 1 + settings.phaseBPremiumPct / 100;
  if (phaseBDaily > 0 && activeDaily > 0 && phaseBDaily >= activeDaily * premium) {
    const gainPct = Math.round((phaseBDaily / activeDaily - 1) * 100);
    return {
      phase: 'B',
      daily: phaseBDaily,
      activeDaily,
      activePhase,
      phaseADaily,
      phaseBDaily,
      phaseCDaily,
      reason: `Patient offer captures +${gainPct}% more daily profit (≥${settings.phaseBPremiumPct}% threshold)`,
    };
  }
  if (activeDaily > 0) {
    return {
      phase: activePhase,
      daily: activeDaily,
      activeDaily,
      activePhase,
      phaseADaily,
      phaseBDaily,
      phaseCDaily,
      reason: activeReason,
    };
  }
  if (phaseBDaily > 0) {
    return {
      phase: 'B',
      daily: phaseBDaily,
      activeDaily,
      activePhase,
      phaseADaily,
      phaseBDaily,
      phaseCDaily,
      reason: 'Only profitable via patient GE offer',
    };
  }
  return {
    phase: null,
    daily: 0,
    activeDaily: 0,
    activePhase: null,
    phaseADaily,
    phaseBDaily,
    phaseCDaily,
    reason: 'Not profitable in any phase',
  };
}

function verdictFor(row, settings, classification) {
  if (!row) return { tone: 'unknown', icon: '·', label: 'No live data — refresh prices' };
  if (!classification || !classification.phase) {
    return { tone: 'weak', icon: '👎', label: 'Not profitable in any phase right now' };
  }

  // Phase A & C use insta-buy → sustainable (24h-avg) check guards against
  // momentary spikes. Phase B is already at 24h-avg-low so it's self-sustainable.
  if (classification.phase !== 'B') {
    const sus = row.sustainableRoguesProfit || 0;
    if (sus <= 0) {
      return {
        tone: 'weak',
        icon: '👎',
        label: 'Current margin is an anomaly — unsustainable at 24h baseline',
      };
    }
  }

  const vs24h = row.priceVs24hPct;
  if (vs24h != null && Math.abs(vs24h) > settings.anomalyPct) {
    return {
      tone: 'watch',
      icon: '⚠',
      label: `Price ${vs24h > 0 ? 'spiked +' : 'dropped '}${vs24h}% from 24h avg (threshold ±${settings.anomalyPct}%)`,
    };
  }

  const vol = row.hourlyVolume || 0;
  if (vol < settings.volumeFloor) {
    return {
      tone: 'neutral',
      icon: '⚖',
      label: `Profitable but thin volume (${vol}/hr < ${settings.volumeFloor}/hr floor)`,
    };
  }

  if (classification.daily < settings.strongGpHrMin) {
    return {
      tone: 'neutral',
      icon: '⚖',
      label: `Profitable but modest daily (${fmtGp(classification.daily)} < ${fmtGp(settings.strongGpHrMin)})`,
    };
  }

  return {
    tone: 'strong',
    icon: '👍',
    label: `Strong Phase ${classification.phase} pick · ${fmtGp(classification.daily)} daily`,
  };
}

function fmtPct(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function RoguesLabTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { settings, updateSetting, resetSettings } = useLabSettings();
  const { items: labItems, add, remove, count, clear } = useRoguesLab();
  const { open: openItemModal } = useItemModal();

  const load = useCallback(() => {
    setRefreshing(true);
    setError(null);
    fetchHighAlch()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setRefreshing(false));
  }, []);
  useEffect(load, [load]);

  // Auto-refresh interval. 0 = off. We use a ref to avoid restarting the
  // interval on every refreshing-state change.
  const refreshTimerRef = useRef(null);
  useEffect(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (settings.autoRefreshSec > 0) {
      refreshTimerRef.current = setInterval(load, settings.autoRefreshSec * 1000);
    }
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [settings.autoRefreshSec, load]);

  const byId = useMemo(() => {
    if (!data) return new Map();
    return new Map(data.items.map((r) => [r.id, r]));
  }, [data]);

  const labIdSet = useMemo(() => new Set(labItems.map((it) => it.id)), [labItems]);

  // For each item, compute classification + verdict under current settings.
  const enrichedById = useMemo(() => {
    const m = new Map();
    if (!data) return m;
    for (const r of data.items) {
      const classification = classifyItem(r, settings);
      const verdict = verdictFor(r, settings, classification);
      m.set(r.id, { row: r, classification, verdict });
    }
    return m;
  }, [data, settings]);

  // Bucket items by phase for the algo panels, sorted by daily profit.
  const algoBuckets = useMemo(() => {
    const buckets = { A: [], B: [], C: [] };
    for (const entry of enrichedById.values()) {
      const phase = entry.classification?.phase;
      if (phase && buckets[phase]) buckets[phase].push(entry);
    }
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((a, b) => b.classification.daily - a.classification.daily);
      buckets[k] = buckets[k].slice(0, ALGO_LIMIT);
    }
    return buckets;
  }, [enrichedById]);

  const labRows = useMemo(() => {
    return labItems.map((it) => {
      const entry = enrichedById.get(it.id);
      return {
        id: it.id,
        addedAt: it.addedAt,
        name: entry?.row?.name || it.name,
        entry,
      };
    });
  }, [labItems, enrichedById]);

  const diffStats = useMemo(() => {
    let agree = 0, disagree = 0, watch = 0, nodata = 0;
    for (const r of labRows) {
      const t = r.entry?.verdict?.tone;
      if (t === 'strong') agree += 1;
      else if (t === 'weak') disagree += 1;
      else if (t === 'watch') watch += 1;
      else nodata += 1;
    }
    return { agree, disagree, watch, nodata };
  }, [labRows]);

  const searchResults = useMemo(() => {
    if (!data || !query.trim()) return [];
    const q = query.toLowerCase();
    return data.items
      .filter((r) => r.name.toLowerCase().includes(q) && !labIdSet.has(r.id))
      .slice(0, 8);
  }, [data, query, labIdSet]);

  const detailEntry = detailId != null ? enrichedById.get(detailId) : null;

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!data) return <div className="graph-msg">Loading lab data…</div>;

  return (
    <div className="alch-tab">
      <div className="alch-header">
        <div className="alch-summary">
          <strong>Rogues' Lab</strong> — sandbox for calibrating picks. {count} of your candidates ·{' '}
          <span style={{ color: 'var(--green)' }}>{diffStats.agree} 👍</span> ·{' '}
          <span style={{ color: '#f3c54a' }}>{diffStats.watch} ⚠</span> ·{' '}
          <span style={{ color: 'var(--red)' }}>{diffStats.disagree} 👎</span>
          {diffStats.nodata > 0 && (
            <> · <span style={{ color: 'var(--muted)' }}>{diffStats.nodata} no data</span></>
          )}
          {' · '}
          <span style={{ color: 'var(--muted)', fontSize: '0.9em' }}>
            Active: {settings.hoursActive}h/day · Volume floor: {settings.volumeFloor}/hr · Patient premium: ≥{settings.phaseBPremiumPct}%
          </span>
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
          <button
            className={`range-btn ${settingsOpen ? 'active' : ''}`}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            ⚙ Lab settings
          </button>
          {count > 0 && (
            <button
              className="range-btn"
              onClick={() => { if (confirm('Clear all lab picks?')) clear(); }}
            >
              Clear picks
            </button>
          )}
        </div>

        {searchResults.length > 0 && (
          <div className="lab-search-results">
            {searchResults.map((r) => {
              const cls = classifyItem(r, settings);
              const v = verdictFor(r, settings, cls);
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
                    {cls?.phase ? `Phase ${cls.phase}` : 'unprofitable'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {settingsOpen && (
          <LabSettings
            settings={settings}
            updateSetting={updateSetting}
            resetSettings={resetSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        <div className="alch-note">
          💡 Three strategies, ranked by daily profit under your settings:{' '}
          <strong>Phase A</strong> (insta-buy + volume-bound active cycling),{' '}
          <strong>Phase B</strong> (patient GE offer at typical low), and{' '}
          <strong>Phase C</strong> (insta-buy capped by the 4hr GE buy limit, 4× daily cadence).
          Click ⚙ Lab settings to tune the thresholds and re-rank without refetching.
        </div>
      </div>

      <div className="lab-grid">
        {/* Your Picks */}
        <div className="lab-panel">
          <div className="lab-panel-header">Your picks ({count})</div>
          {labRows.length === 0 ? (
            <div className="lab-panel-empty">
              Search above to add candidate items. Try items you're already running on your live
              list to see how the algo grades them.
            </div>
          ) : (
            <YourPicksTable
              rows={labRows}
              detailId={detailId}
              onSelect={(id) => setDetailId(id)}
              onRemove={(id) => { remove(id); if (detailId === id) setDetailId(null); }}
            />
          )}
        </div>

        <AlgoPanel
          title="Algo: Phase A (insta-buy, volume-bound)"
          subtitle="Active cycling at current high · ranked by daily profit"
          entries={algoBuckets.A}
          phaseLetter="A"
          onAdd={(r) => add(r.id, r.name)}
          onSelect={(r) => setDetailId(r.id)}
          inLab={(id) => labIdSet.has(id)}
          selectedId={detailId}
        />

        <AlgoPanel
          title="Algo: Phase C (insta-buy, limit-bound)"
          subtitle="GE 4hr buy limit caps daily volume · cycle on the 4-hour cadence"
          entries={algoBuckets.C}
          phaseLetter="C"
          onAdd={(r) => add(r.id, r.name)}
          onSelect={(r) => setDetailId(r.id)}
          inLab={(id) => labIdSet.has(id)}
          selectedId={detailId}
        />

        <AlgoPanel
          title="Algo: Phase B (patient GE offer)"
          subtitle="Buy at 24h-avg low while logged off · best for wide-spread items"
          entries={algoBuckets.B}
          phaseLetter="B"
          onAdd={(r) => add(r.id, r.name)}
          onSelect={(r) => setDetailId(r.id)}
          inLab={(id) => labIdSet.has(id)}
          selectedId={detailId}
        />
      </div>

      {detailEntry && (
        <DetailPanel
          entry={detailEntry}
          settings={settings}
          onClose={() => setDetailId(null)}
          onOpenItemModal={() => openItemModal(detailEntry.row.id)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings panel — tunable thresholds
// ---------------------------------------------------------------------------

function LabSettings({ settings, updateSetting, resetSettings, onClose }) {
  return (
    <div className="lab-settings">
      <div className="lab-settings-header">
        <strong>Lab settings</strong>
        <div>
          <button className="range-btn" onClick={resetSettings} title="Restore defaults">
            Reset to defaults
          </button>
          <button className="range-btn" onClick={onClose} style={{ marginLeft: '0.3em' }}>
            ✕
          </button>
        </div>
      </div>
      <div className="lab-settings-body">
        <SettingNumber
          label="Hours active per day"
          help="How long you actively cycle items at Rogues' Den each day. Used as the multiplier on Phase A/B gp/hr to estimate daily profit."
          value={settings.hoursActive}
          step={0.25}
          min={0.25}
          max={24}
          onChange={(v) => updateSetting('hoursActive', v)}
        />
        <SettingNumber
          label="Volume floor (items/hour)"
          help="Items with hourly volume below this get a ⚖ neutral verdict instead of 👍 strong. Tighter floor = stricter."
          value={settings.volumeFloor}
          step={10}
          min={0}
          max={10000}
          onChange={(v) => updateSetting('volumeFloor', v)}
        />
        <SettingNumber
          label="Strong-pick threshold (daily gp)"
          help="Picks need at least this much projected daily profit to earn a 👍 strong verdict. Below this they're ⚖ neutral."
          value={settings.strongGpHrMin}
          step={10000}
          min={0}
          max={50_000_000}
          onChange={(v) => updateSetting('strongGpHrMin', v)}
        />
        <SettingNumber
          label="Anomaly threshold (% from 24h)"
          help="If current price diverges from the 24h average by more than this percentage, the verdict turns to ⚠ watch."
          value={settings.anomalyPct}
          step={1}
          min={1}
          max={100}
          onChange={(v) => updateSetting('anomalyPct', v)}
        />
        <SettingNumber
          label="Phase B premium (%)"
          help="Patient offer must yield at least this much MORE daily profit than active cycling to be the suggested phase. Higher = stricter, prefers active."
          value={settings.phaseBPremiumPct}
          step={5}
          min={0}
          max={200}
          onChange={(v) => updateSetting('phaseBPremiumPct', v)}
        />
        <SettingNumber
          label="Auto-refresh (seconds)"
          help="0 = off. If set, the lab automatically pulls new GE prices on this interval. Recommended 300+ to avoid distracting list reshuffles."
          value={settings.autoRefreshSec}
          step={30}
          min={0}
          max={3600}
          onChange={(v) => updateSetting('autoRefreshSec', v)}
        />
      </div>
    </div>
  );
}

function SettingNumber({ label, help, value, onChange, step, min, max }) {
  return (
    <div className="lab-setting-field">
      <label>
        <div className="lab-setting-label">{label}</div>
        <input
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
        />
      </label>
      <div className="lab-setting-help">{help}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Your Picks table
// ---------------------------------------------------------------------------

function YourPicksTable({ rows, detailId, onSelect, onRemove }) {
  return (
    <table className="alch-table lab-table">
      <thead>
        <tr>
          <th style={{ width: '2.5em' }} />
          <th className="left">Item</th>
          <th className="right">Phase</th>
          <th className="right">Buy @</th>
          <th className="right">Daily profit</th>
          <th className="right">vs 24h</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map(({ id, name, entry }) => {
          const verdict = entry?.verdict || { tone: 'unknown', icon: '·', label: 'No data' };
          const cls = entry?.classification;
          const row = entry?.row;
          const phase = cls?.phase;
          const buy =
            phase === 'B'
              ? row?.phaseBBuyPrice
              : phase === 'C'
                ? row?.phaseCBuyPrice
                : row?.phaseABuyPrice;
          const daily = cls?.daily || 0;
          const vs24h = row?.priceVs24hPct;
          return (
            <tr
              key={id}
              className={`lab-row ${detailId === id ? 'selected' : ''}`}
              onClick={() => onSelect(id)}
            >
              <td>
                <span className={`rogues-pip ${verdict.tone}`} title={verdict.label}>
                  {verdict.icon}
                </span>
              </td>
              <td className="left">{name}</td>
              <td className="right">
                {phase ? <span className={`phase-badge phase-${phase.toLowerCase()}`}>{phase}</span> : '—'}
              </td>
              <td className="right">{buy != null ? fmtGp(buy) : '—'}</td>
              <td className="right" style={{ color: profitColor(daily), fontWeight: 600 }}>
                {daily > 0 ? fmtGp(daily) : '—'}
              </td>
              <td className="right">{fmtPct(vs24h)}</td>
              <td className="right">
                <button
                  className="range-btn"
                  onClick={(e) => { e.stopPropagation(); onRemove(id); }}
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
  );
}

// ---------------------------------------------------------------------------
// Algo panels (A / B / C)
// ---------------------------------------------------------------------------

function AlgoPanel({ title, subtitle, entries, phaseLetter, onAdd, onSelect, inLab, selectedId }) {
  const showItemsPerCycle = phaseLetter === 'C';
  return (
    <div className="lab-panel">
      <div className="lab-panel-header">
        {title}
        <span style={{ display: 'block', fontSize: '0.75em', color: 'var(--muted)', fontWeight: 400, marginTop: '0.15em' }}>
          {subtitle}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="lab-panel-empty">No qualifying picks right now.</div>
      ) : (
        <table className="alch-table lab-table">
          <thead>
            <tr>
              <th className="left">#</th>
              <th className="left">Item</th>
              <th className="right">Buy</th>
              {showItemsPerCycle ? (
                <>
                  <th className="right">Limit</th>
                  <th className="right">Profit/cycle</th>
                </>
              ) : (
                <th className="right">Profit/sess</th>
              )}
              <th className="right">Daily</th>
              <th className="right">vs 24h</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => {
              const { row, verdict, classification } = entry;
              const already = inLab(row.id);
              const buy =
                phaseLetter === 'B'
                  ? row.phaseBBuyPrice
                  : phaseLetter === 'C'
                    ? row.phaseCBuyPrice
                    : row.phaseABuyPrice;
              const profitColLabel =
                phaseLetter === 'A'
                  ? row.phaseAProfitPerSession
                  : phaseLetter === 'B'
                    ? row.phaseBProfitPerSession
                    : row.phaseCProfitPerCycle;
              return (
                <tr
                  key={row.id}
                  className={`lab-row ${selectedId === row.id ? 'selected' : ''}`}
                  onClick={() => onSelect(row)}
                >
                  <td className="left" style={{ color: 'var(--muted)' }}>{i + 1}</td>
                  <td className="left">
                    <span className={`rogues-pip ${verdict.tone}`} title={verdict.label} style={{ marginRight: '0.3em' }}>
                      {verdict.icon}
                    </span>
                    {row.name}
                  </td>
                  <td className="right">{buy != null ? fmtGp(buy) : '—'}</td>
                  {showItemsPerCycle ? (
                    <>
                      <td className="right">{row.phaseCItemsPerCycle?.toLocaleString() ?? '—'}</td>
                      <td className="right">{fmtGp(row.phaseCProfitPerCycle)}</td>
                    </>
                  ) : (
                    <td className="right">{fmtGp(profitColLabel)}</td>
                  )}
                  <td className="right" style={{ color: profitColor(classification.daily), fontWeight: 600 }}>
                    {fmtGp(classification.daily)}
                  </td>
                  <td className="right">{fmtPct(row.priceVs24hPct)}</td>
                  <td className="right">
                    <button
                      className="range-btn"
                      disabled={already}
                      onClick={(e) => { e.stopPropagation(); onAdd(row); }}
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

// ---------------------------------------------------------------------------
// Detail panel — full per-item readout including all three phases
// ---------------------------------------------------------------------------

function DetailPanel({ entry, settings, onClose, onOpenItemModal }) {
  const { row, verdict, classification } = entry;
  const move = row.recentMovePct;
  const isVolatile = move != null && Math.abs(move) >= VOLATILITY_THRESHOLD;

  const copyAsText = () => {
    const lines = [
      `Rogues' Lab readout — ${row.name} (id ${row.id})`,
      `  Verdict: ${verdict.icon} ${verdict.label}`,
      `  Suggested phase: ${classification?.phase || 'none'} ${classification?.reason ? `— ${classification.reason}` : ''}`,
      `  Settings: ${settings.hoursActive}h active/day, volume floor ${settings.volumeFloor}/hr, anomaly ±${settings.anomalyPct}%, Phase B premium ≥${settings.phaseBPremiumPct}%`,
      ``,
      `Phase A · insta-buy + volume-bound active cycling:`,
      `  Buy: ${row.phaseABuyPrice} gp · Sells/session: ${row.phaseASellsPerSession}`,
      `  Profit/session: ${row.phaseAProfitPerSession} · Realistic gp/hr: ${row.phaseARealisticGpPerHr}`,
      `  Daily (× ${settings.hoursActive}h): ${Math.round(classification.phaseADaily)}`,
      ``,
      `Phase B · patient GE offer at typical low:`,
      `  Buy: ${row.phaseBBuyPrice ?? 'n/a'} gp · Sells/session: ${row.phaseBSellsPerSession ?? '—'}`,
      `  Profit/session: ${row.phaseBProfitPerSession ?? '—'} · Realistic gp/hr: ${row.phaseBRealisticGpPerHr ?? '—'}`,
      `  Daily (× ${settings.hoursActive}h): ${Math.round(classification.phaseBDaily)}`,
      ``,
      `Phase C · insta-buy + 4hr GE-limit cadence:`,
      `  Buy: ${row.phaseCBuyPrice ?? 'n/a'} gp · Items/cycle (= GE limit): ${row.phaseCItemsPerCycle ?? '—'}`,
      `  Profit/cycle: ${row.phaseCProfitPerCycle ?? '—'} · Daily (4× cycles): ${row.phaseCDailyProfit ?? '—'}`,
      ``,
      `Market context:`,
      `  High alch: ${row.highalch}  Current high/low: ${row.buyPrice} / ${row.lowPrice}`,
      `  Spread: ${row.spreadPct ?? '—'}%  vs 24h avg: ${row.priceVs24hPct ?? '—'}%  Recent move (1h): ${move ?? '—'}%`,
      `  24h volume: ${row.dailyVolumePerHr ?? '—'}/hr  1h volume: ${row.hourlyVolume}/hr`,
      `  GE 4hr buy limit: ${row.limit ?? '—'}  →  ${row.buyLimitSessions ?? '—'} sessions of ${row.phaseASellsPerSession}`,
      `  Sustainable Phase A profit: ${row.sustainableRoguesProfit ?? '—'} gp/session`,
    ];
    navigator.clipboard?.writeText(lines.join('\n'));
  };

  return (
    <div className="lab-detail">
      <div className="lab-detail-header">
        <div>
          <span className={`rogues-pip ${verdict.tone}`} style={{ marginRight: '0.4em' }}>{verdict.icon}</span>
          <strong style={{ fontSize: '1.1em' }}>{row.name}</strong>
          <span style={{ marginLeft: '0.8em', color: 'var(--muted)', fontSize: '0.9em' }}>{verdict.label}</span>
        </div>
        <div>
          <button className="range-btn" onClick={onOpenItemModal} title="Open full item modal">
            Item details
          </button>
          <button className="range-btn" onClick={copyAsText} style={{ marginLeft: '0.3em' }}>
            Copy as text
          </button>
          <button className="range-btn" onClick={onClose} style={{ marginLeft: '0.3em' }}>
            Close
          </button>
        </div>
      </div>

      <div className="lab-detail-grid">
        <PhaseDetail
          title="Phase A · insta-buy, volume-bound"
          isSuggested={classification?.phase === 'A'}
          fields={[
            ['Buy price', `${row.phaseABuyPrice} gp`],
            ['Sells/session', row.phaseASellsPerSession],
            ['Profit/session', fmtGp(row.phaseAProfitPerSession), profitColor(row.phaseAProfitPerSession)],
            ['Realistic gp/hr', fmtGp(row.phaseARealisticGpPerHr), profitColor(row.phaseARealisticGpPerHr)],
            [`Daily (× ${settings.hoursActive}h)`, fmtGp(classification.phaseADaily), profitColor(classification.phaseADaily), true],
            ['Sustainable @ 24h-avg', fmtGp(row.sustainableRoguesProfit), profitColor(row.sustainableRoguesProfit)],
          ]}
        />
        <PhaseDetail
          title="Phase C · insta-buy, limit-bound"
          isSuggested={classification?.phase === 'C'}
          fields={[
            ['Buy price', row.phaseCBuyPrice != null ? `${row.phaseCBuyPrice} gp` : '—'],
            ['Items/cycle (GE limit)', row.phaseCItemsPerCycle?.toLocaleString() ?? '—'],
            ['Profit/cycle', row.phaseCProfitPerCycle != null ? fmtGp(row.phaseCProfitPerCycle) : '—', profitColor(row.phaseCProfitPerCycle)],
            ['Daily (4× cycles)', row.phaseCDailyProfit != null ? fmtGp(row.phaseCDailyProfit) : '—', profitColor(row.phaseCDailyProfit), true],
          ]}
        />
        <PhaseDetail
          title="Phase B · patient GE offer"
          isSuggested={classification?.phase === 'B'}
          fields={[
            ['Buy price (24h avg low)', row.phaseBBuyPrice ? `${row.phaseBBuyPrice} gp` : '—'],
            ['Sells/session', row.phaseBSellsPerSession ?? '—'],
            ['Profit/session', row.phaseBProfitPerSession != null ? fmtGp(row.phaseBProfitPerSession) : '—', profitColor(row.phaseBProfitPerSession)],
            ['Realistic gp/hr', row.phaseBRealisticGpPerHr ? fmtGp(row.phaseBRealisticGpPerHr) : '—', profitColor(row.phaseBRealisticGpPerHr)],
            [`Daily (× ${settings.hoursActive}h)`, fmtGp(classification.phaseBDaily), profitColor(classification.phaseBDaily), true],
            ['Last-sale margin', row.phaseBLastSaleMargin != null ? `${fmtGp(row.phaseBLastSaleMargin)} gp` : '—'],
          ]}
        />
        <div className="lab-detail-section lab-detail-verdict">
          <div className="lab-detail-section-title">Market context</div>
          <Field label="High alch" value={`${fmtGp(row.highalch)} gp`} />
          <Field label="Current high / low" value={`${fmtGp(row.buyPrice)} / ${fmtGp(row.lowPrice)} gp`} />
          <Field label="Spread" value={fmtPct(row.spreadPct)} />
          <Field
            label="vs 24h avg"
            value={fmtPct(row.priceVs24hPct)}
            color={Math.abs(row.priceVs24hPct || 0) > settings.anomalyPct ? (row.priceVs24hPct > 0 ? '#f3c54a' : 'var(--red)') : undefined}
          />
          <Field label="Recent move (1h)" value={isVolatile ? `${fmtPct(move)} ⚡` : fmtPct(move)} />
          <Field label="Hourly volume" value={`${row.hourlyVolume?.toLocaleString() ?? '—'}/hr`} />
          <Field label="Daily volume (per hr)" value={`${row.dailyVolumePerHr?.toLocaleString() ?? '—'}/hr`} />
          <Field label="GE 4hr buy limit" value={row.limit?.toLocaleString() ?? '—'} />
          {classification?.reason && (
            <div style={{ marginTop: '0.8em', fontSize: '0.85em', color: 'var(--muted)', lineHeight: 1.5 }}>
              <strong>Why this phase:</strong> {classification.reason}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PhaseDetail({ title, isSuggested, fields }) {
  return (
    <div className={`lab-detail-section ${isSuggested ? 'lab-detail-suggested' : ''}`}>
      <div className="lab-detail-section-title">
        {title}
        {isSuggested && <span className="lab-detail-suggested-tag"> ★ suggested</span>}
      </div>
      {fields.map(([label, value, color, bold], i) => (
        <Field key={i} label={label} value={value} color={color} bold={bold} />
      ))}
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
