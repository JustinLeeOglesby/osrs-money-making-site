import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtGp } from '../../utils/format';
import { ROGUES_STOCKS_STORAGE_KEY, ROGUES_EQUALIZER_TARGET_KEY } from '../../utils/constants';
import { fetchOcrStatus, ocrInventory } from '../../api/client';

// Stock Equalizer — small calculator for the user's curated Rogues' Den
// running list.
//
// Problem it solves: each item in the running list has a different N
// (sells-per-session). Item A might be 5/session, B 10/session, C 20/session.
// If A and C both have "100 in stock" the user gets 20 sessions of A but
// only 5 of C — they'll run dry on C first and the rotation falls apart.
//
// The right invariant to maintain is *sessions remaining per item*, not
// raw quantity. This calculator:
//   1. Lets the user enter their current stock + their preferred N per item
//   2. Auto-computes sessions-remaining per item
//   3. Picks a "target sessions" (default: the max across all items, but
//      overridable to e.g. 10 if they want to top everyone up to that bar)
//   4. Reports how many to buy of each, and the total gp cost
//
// Persists to localStorage with key ROGUES_STOCKS_STORAGE_KEY — synced via
// SyncContext so the inventory state follows the user across devices.

// Fallback loader when used outside RoguesListTab (the parent passes stocks
// and setStocks in via props; we read once on mount only if those are absent).
function loadStocks() {
  try {
    const raw = localStorage.getItem(ROGUES_STOCKS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Parse a possibly-empty user input into a non-negative integer; "" → 0.
function parseInt0(v) {
  if (v === '' || v == null) return 0;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export default function StockEqualizer({
  items,
  byId,
  defaultSellsPerSession = 20,
  stocks: stocksProp,
  setStocks: setStocksProp,
}) {
  // If the parent passes stocks state in, we use it (controlled). Otherwise
  // fall back to local state with localStorage persistence so the component
  // still works in isolation.
  const [localStocks, setLocalStocks] = useState(loadStocks);
  const stocks = stocksProp ?? localStocks;
  const setStocks = setStocksProp ?? setLocalStocks;
  // Persist only when running uncontrolled (controlled parent owns persistence).
  useEffect(() => {
    if (setStocksProp) return; // controlled, parent handles writes
    try {
      localStorage.setItem(ROGUES_STOCKS_STORAGE_KEY, JSON.stringify(localStocks));
    } catch {
      /* session-only fallback */
    }
  }, [localStocks, setStocksProp]);
  // Override the auto-computed target. Persisted to localStorage (and synced
  // across devices) so the "buying list" view doesn't reset to auto every
  // time the user navigates away.
  const [targetOverride, setTargetOverride] = useState(() => {
    try {
      return localStorage.getItem(ROGUES_EQUALIZER_TARGET_KEY) || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      if (targetOverride === '') localStorage.removeItem(ROGUES_EQUALIZER_TARGET_KEY);
      else localStorage.setItem(ROGUES_EQUALIZER_TARGET_KEY, targetOverride);
    } catch {
      /* ignore */
    }
  }, [targetOverride]);
  // Sort + filter state for the equalizer table. Default: items most in need
  // first (highest "need to buy" descending) so users see action items at top.
  const [sortKey, setSortKey] = useState('need');
  const [sortDir, setSortDir] = useState('desc');
  const [hideSatisfied, setHideSatisfied] = useState(false);
  // OCR feature toggles + state. Hidden entirely if backend says OCR isn't
  // configured (no ANTHROPIC_API_KEY). Otherwise: a small panel above the
  // equalizer table with file picker, preview, extracted-items review, and
  // apply-to-equalizer button.
  const [ocrAvailable, setOcrAvailable] = useState(false);
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrPreview, setOcrPreview] = useState(null);     // data URL for thumbnail
  const [ocrMediaType, setOcrMediaType] = useState(null); // 'image/png' etc.
  const [ocrExtracting, setOcrExtracting] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);       // {items, model, ...}
  const [ocrError, setOcrError] = useState(null);
  const [ocrShowRaw, setOcrShowRaw] = useState(false);    // raw JSON debug
  // 'item_list' (default) = text list from a RuneLite plugin — easier to OCR,
  // virtually error-free. 'inventory' = OSRS 4×7 bag icon grid.
  const [ocrFormat, setOcrFormat] = useState('item_list');

  useEffect(() => {
    let cancelled = false;
    fetchOcrStatus()
      .then((s) => { if (!cancelled) setOcrAvailable(!!s.enabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // For each list item, gather inputs + live data into a derived row.
  const rows = useMemo(() => {
    return items.map((it) => {
      const live = byId.get(it.id);
      const s = stocks[it.id] || {};
      const qty = s.qty ?? 0;
      const n = s.n ?? defaultSellsPerSession;
      const sessionsLeft = n > 0 ? qty / n : 0;
      return {
        id: it.id,
        name: it.name || live?.name || `Item ${it.id}`,
        buyPrice: live?.buyPrice ?? null,
        qty,
        n,
        sessionsLeft,
      };
    });
  }, [items, byId, stocks, defaultSellsPerSession]);

  const autoTarget = rows.length ? Math.max(...rows.map((r) => r.sessionsLeft)) : 0;
  const parsedOverride = targetOverride !== '' ? Number(targetOverride) : null;
  const target = parsedOverride != null && Number.isFinite(parsedOverride) && parsedOverride >= 0
    ? parsedOverride
    : autoTarget;

  // Enrich with "need to buy" + cost.
  const enriched = useMemo(() => {
    return rows.map((r) => {
      const ideal = Math.ceil(target * r.n);
      const need = Math.max(0, ideal - r.qty);
      const cost = r.buyPrice != null ? need * r.buyPrice : null;
      return { ...r, need, cost };
    });
  }, [rows, target]);

  // Apply sort + filter to produce the table's display rows. The sort is
  // stable: ties (e.g. multiple items with need=0) fall back to alphabetical
  // by name so the order doesn't shuffle on every click.
  const sortGetter = (key) => (r) => {
    switch (key) {
      case 'name':        return (r.name || '').toLowerCase();
      case 'buyPrice':    return r.buyPrice ?? -1;
      case 'n':           return r.n ?? 0;
      case 'qty':         return r.qty ?? 0;
      case 'sessionsLeft':return r.sessionsLeft ?? 0;
      case 'need':        return r.need ?? 0;
      case 'cost':        return r.cost ?? 0;
      default:            return 0;
    }
  };

  const sorted = useMemo(() => {
    let list = enriched;
    if (hideSatisfied) list = list.filter((r) => r.need > 0);
    const get = sortGetter(sortKey);
    const getName = sortGetter('name');
    return [...list].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      // Tie-break alphabetically by name for stable ordering.
      const na = getName(a);
      const nb = getName(b);
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
  }, [enriched, sortKey, sortDir, hideSatisfied]);

  // Freeze-on-focus: hold the row order steady while the user is editing
  // an input cell, so the row they're typing into doesn't jump out from
  // under them. Released ~250ms after the last input blur.
  const [frozenOrder, setFrozenOrder] = useState(null);
  const blurTimerRef = useRef(null);
  const handleInputFocus = () => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    if (!frozenOrder) setFrozenOrder(sorted.map((r) => r.id));
  };
  const handleInputBlur = () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => {
      setFrozenOrder(null);
      blurTimerRef.current = null;
    }, 250);
  };
  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);

  const displayed = useMemo(() => {
    if (!frozenOrder) return sorted;
    const byIdMap = new Map(sorted.map((r) => [r.id, r]));
    const out = [];
    const seen = new Set();
    for (const id of frozenOrder) {
      const r = byIdMap.get(id);
      if (r) { out.push(r); seen.add(id); }
    }
    for (const r of sorted) {
      if (!seen.has(r.id)) out.push(r);
    }
    return out;
  }, [sorted, frozenOrder]);

  // Header click → toggle direction if same column, else switch to it
  // with a sensible default (name → asc, everything else → desc).
  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  };
  const sortArrow = (key) =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  // Roll-up totals
  const totals = useMemo(() => {
    let totalNeed = 0;
    let totalCost = 0;
    let costAvailable = true;
    for (const r of enriched) {
      totalNeed += r.need;
      if (r.cost == null) costAvailable = false;
      else totalCost += r.cost;
    }
    return { totalNeed, totalCost, costAvailable };
  }, [enriched]);

  const updateQty = (id, val) => {
    setStocks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), qty: parseInt0(val) },
    }));
  };

  const updateN = (id, val) => {
    setStocks((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), n: parseInt0(val) },
    }));
  };

  const resetAllStocks = () => {
    if (!confirm('Reset all stock quantities to 0? (Your sells/session values stay.)')) return;
    setStocks((prev) => {
      const next = {};
      for (const id of Object.keys(prev)) {
        next[id] = { ...prev[id], qty: 0 };
      }
      return next;
    });
  };

  // --- OCR handlers ---

  const handleFile = (e) => {
    const f = e.target.files?.[0];
    setOcrError(null);
    setOcrResult(null);
    if (!f) {
      setOcrPreview(null);
      setOcrMediaType(null);
      return;
    }
    if (!f.type.startsWith('image/')) {
      setOcrError('Please pick an image file.');
      return;
    }
    setOcrMediaType(f.type);
    const reader = new FileReader();
    reader.onload = (ev) => setOcrPreview(ev.target.result);
    reader.onerror = () => setOcrError('Failed to read file.');
    reader.readAsDataURL(f);
  };

  const runOcr = async () => {
    if (!ocrPreview) return;
    setOcrExtracting(true);
    setOcrError(null);
    setOcrResult(null);
    try {
      // Strip "data:image/png;base64," prefix; backend re-adds expected wrapping.
      const b64 = ocrPreview.split(',', 2)[1] || '';
      // Pass the running-list item names so Claude can "pick from this list"
      // instead of guessing from the icon. Major accuracy win.
      const expected = items.map((it) => it.name).filter(Boolean);
      const data = await ocrInventory(b64, ocrMediaType || 'image/png', expected, ocrFormat);
      setOcrResult(data);
    } catch (err) {
      setOcrError(err.message || 'OCR failed');
    } finally {
      setOcrExtracting(false);
    }
  };

  // Fuzzy-match extracted item name → running list item id.
  // Returns the matched list item or null.
  const matchToListItem = (extractedName) => {
    if (!extractedName) return null;
    const needle = extractedName.toLowerCase().trim();
    // Exact case-insensitive first
    let hit = items.find((it) => (it.name || '').toLowerCase() === needle);
    if (hit) return hit;
    // Strip "(p)", "(p++)", "(unf)", etc. variations on both sides
    const strip = (s) => s.replace(/\s*\([^)]*\)/g, '').trim();
    const needleStripped = strip(needle);
    hit = items.find((it) => strip((it.name || '').toLowerCase()) === needleStripped);
    return hit || null;
  };

  // Build a per-extracted-row review entry with matched id (if any).
  // Sort by slot so the UI ordering matches how the user reads their
  // screenshot (top-left to bottom-right). This makes it easy to spot
  // mis-pairings visually.
  const ocrReview = useMemo(() => {
    if (!ocrResult?.items) return [];
    const list = ocrResult.items.map((entry, idx) => {
      const match = matchToListItem(entry.name);
      return {
        idx,
        name: entry.name,
        quantity: entry.quantity ?? 0,
        confidence: entry.confidence || null,
        slot: entry.slot ?? null,
        matchedId: match?.id ?? null,
        matchedName: match?.name ?? null,
      };
    });
    return list.sort((a, b) => {
      const sa = a.slot ?? 999;
      const sb = b.slot ?? 999;
      return sa - sb;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocrResult, items]);

  const applyOcrToStocks = () => {
    if (!ocrReview.length) return;
    setStocks((prev) => {
      const next = { ...prev };
      for (const r of ocrReview) {
        if (r.matchedId == null) continue;
        next[r.matchedId] = {
          ...(next[r.matchedId] || {}),
          qty: r.quantity,
        };
      }
      return next;
    });
    // Keep the result visible briefly so the user can confirm; clear preview
    // so the file input is re-usable.
    setOcrPreview(null);
    setOcrMediaType(null);
  };

  const clearOcr = () => {
    setOcrPreview(null);
    setOcrMediaType(null);
    setOcrResult(null);
    setOcrError(null);
  };

  return (
    <div className="stock-equalizer">
      <div className="alch-header">
        <div className="alch-summary">
          <strong>Stock equalizer</strong> — enter what you currently have of each item;
          the table tells you how many to buy to equalize everyone to the same number
          of sessions remaining.
          {rows.length > 0 && (
            <>
              {' · '}
              <strong>Target:</strong>{' '}
              {target.toFixed(1)} sessions
              {parsedOverride == null && autoTarget > 0 && (
                <span style={{ color: 'var(--muted)' }}> (auto = max in list)</span>
              )}
              {' · '}
              <strong>Total to buy:</strong> {totals.totalNeed.toLocaleString()} items
              {totals.costAvailable && (
                <>
                  {' · '}
                  <strong>Cost:</strong> {fmtGp(totals.totalCost)} gp
                </>
              )}
            </>
          )}
        </div>

        <div className="alch-controls">
          <label className="min-filter">
            Target sessions:
            <input
              type="text"
              value={targetOverride}
              placeholder={autoTarget > 0 ? autoTarget.toFixed(1) : '—'}
              onChange={(e) => setTargetOverride(e.target.value)}
              inputMode="decimal"
              title="Override the auto-computed target (max sessions across items). Leave blank for auto."
              style={{ width: '5em' }}
            />
          </label>
          {targetOverride !== '' && (
            <button className="range-btn" onClick={() => setTargetOverride('')} title="Use auto target">
              Auto
            </button>
          )}
          <button
            className={`range-btn ${hideSatisfied ? 'active' : ''}`}
            onClick={() => setHideSatisfied((v) => !v)}
            title="Show only items that still need buying (need > 0)"
          >
            {hideSatisfied ? 'Show all' : 'Hide ✓ at target'}
          </button>
          <button className="range-btn" onClick={resetAllStocks} title="Reset all stock quantities to 0">
            Reset stocks
          </button>
        </div>
      </div>

      {/* === OCR upload panel (collapsible, hidden when backend doesn't have API key) === */}
      {ocrAvailable && (
        <div className="ocr-panel">
          <div className="ocr-panel-header">
            <button
              className="range-btn"
              onClick={() => setOcrOpen((v) => !v)}
              title="Upload an OSRS inventory screenshot and auto-fill the quantities below"
            >
              📷 {ocrOpen ? 'Hide' : 'Upload screenshot'} (auto-fill via OCR)
            </button>
            {ocrOpen && (
              <span style={{ marginLeft: '0.8em', color: 'var(--muted)', fontSize: '0.85em' }}>
                Drop or pick an inventory screenshot — Claude vision extracts item names + quantities
              </span>
            )}
          </div>
          {ocrOpen && (
            <div className="ocr-panel-body">
              <div className="ocr-controls">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleFile}
                />
                <button
                  className="range-btn"
                  onClick={runOcr}
                  disabled={!ocrPreview || ocrExtracting}
                >
                  {ocrExtracting ? 'Extracting…' : 'Extract'}
                </button>
                {(ocrPreview || ocrResult) && (
                  <button className="range-btn" onClick={clearOcr}>Clear</button>
                )}
              </div>
              <div className="ocr-controls" style={{ marginTop: '0.4em' }}>
                <span style={{ color: 'var(--muted)', fontSize: '0.85em' }}>
                  Screenshot format:
                </span>
                <button
                  className={`range-btn ${ocrFormat === 'item_list' ? 'active' : ''}`}
                  onClick={() => setOcrFormat('item_list')}
                  title="RuneLite plugin output: text rows of 'quantity ItemName gpValue'. Much more accurate."
                >
                  📋 RuneLite item list
                </button>
                <button
                  className={`range-btn ${ocrFormat === 'inventory' ? 'active' : ''}`}
                  onClick={() => setOcrFormat('inventory')}
                  title="OSRS bag icon grid (4×7). Relies on icon recognition — less reliable."
                >
                  🎒 Inventory icons
                </button>
              </div>
              {ocrPreview && (
                <div className="ocr-preview-wrap">
                  <img src={ocrPreview} alt="Inventory preview" className="ocr-preview" />
                </div>
              )}
              {ocrError && (
                <div style={{ color: 'var(--red)', fontSize: '0.9em', padding: '0.4em 0' }}>
                  {ocrError}
                </div>
              )}
              {ocrResult && (
                <div className="ocr-result">
                  <div style={{ marginBottom: '0.5em' }}>
                    <strong>Extracted {ocrReview.length} items</strong>
                    {' '} (model: {ocrResult.model}, {ocrResult.inputTokens}+{ocrResult.outputTokens} tokens)
                  </div>
                  <p style={{ fontSize: '0.85em', color: 'var(--muted)', marginBottom: '0.4em' }}>
                    Rows are ordered by slot (top-left = slot 1). Compare each row to
                    your screenshot to verify the pairing — if a quantity looks wrong
                    for an item, the OCR likely mis-paired it with a neighbor's number.
                    Drop those rows before applying.
                  </p>
                  <table className="alch-table bounded-table">
                    <thead>
                      <tr>
                        <th className="right">Slot</th>
                        <th className="left">Extracted name</th>
                        <th className="right">Qty</th>
                        <th className="left">Match in running list</th>
                        <th className="right">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ocrReview.map((r) => (
                        <tr key={r.idx}>
                          <td className="right" style={{ color: 'var(--muted)' }}>
                            {r.slot ?? '?'}
                          </td>
                          <td className="left">{r.name}</td>
                          <td className="right">{r.quantity.toLocaleString()}</td>
                          <td
                            className="left"
                            style={{ color: r.matchedId ? 'var(--green)' : 'var(--muted)' }}
                          >
                            {r.matchedId ? `✓ ${r.matchedName}` : '— not on your running list'}
                          </td>
                          <td
                            className="right"
                            style={{
                              color:
                                r.confidence === 'high'
                                  ? 'var(--green)'
                                  : r.confidence === 'low'
                                    ? '#f3c54a'
                                    : 'var(--muted)',
                            }}
                          >
                            {r.confidence || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: '0.6em', display: 'flex', gap: '0.4em', flexWrap: 'wrap' }}>
                    <button
                      className="range-btn"
                      onClick={applyOcrToStocks}
                      disabled={ocrReview.every((r) => r.matchedId == null)}
                    >
                      Apply quantities to equalizer
                    </button>
                    <button
                      className={`range-btn ${ocrShowRaw ? 'active' : ''}`}
                      onClick={() => setOcrShowRaw((v) => !v)}
                      title="Show the raw JSON Claude returned. Useful when item identification is off."
                    >
                      {ocrShowRaw ? 'Hide' : 'Show'} raw response
                    </button>
                    <span style={{ alignSelf: 'center', color: 'var(--muted)', fontSize: '0.85em' }}>
                      Only matched items fill in; unmatched rows are ignored.
                    </span>
                  </div>
                  {ocrShowRaw && (
                    <pre
                      style={{
                        marginTop: '0.6em',
                        padding: '0.6em 0.8em',
                        background: 'var(--bg)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        fontSize: '0.78em',
                        overflowX: 'auto',
                        maxHeight: '300px',
                        overflowY: 'auto',
                      }}
                    >
                      {JSON.stringify(ocrResult, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="lab-panel-empty">
          Add items to your running list first — the equalizer works on the list above.
        </div>
      ) : (
        <div className="table-scroll">
          <table className="alch-table bounded-table">
            <thead>
              <tr>
                <th className={`left ${sortKey === 'name' ? 'sorted' : ''}`} onClick={() => toggleSort('name')}>
                  Item{sortArrow('name')}
                </th>
                <th className={`right ${sortKey === 'buyPrice' ? 'sorted' : ''}`} onClick={() => toggleSort('buyPrice')}>
                  Buy price{sortArrow('buyPrice')}
                </th>
                <th className={`right ${sortKey === 'n' ? 'sorted' : ''}`} onClick={() => toggleSort('n')}>
                  Sells / session{sortArrow('n')}
                </th>
                <th className={`right ${sortKey === 'qty' ? 'sorted' : ''}`} onClick={() => toggleSort('qty')}>
                  Current stock{sortArrow('qty')}
                </th>
                <th className={`right ${sortKey === 'sessionsLeft' ? 'sorted' : ''}`} onClick={() => toggleSort('sessionsLeft')}>
                  Sessions left{sortArrow('sessionsLeft')}
                </th>
                <th className={`right ${sortKey === 'need' ? 'sorted' : ''}`} onClick={() => toggleSort('need')}>
                  Buy to equalize{sortArrow('need')}
                </th>
                <th className={`right ${sortKey === 'cost' ? 'sorted' : ''}`} onClick={() => toggleSort('cost')}>
                  Cost{sortArrow('cost')}
                </th>
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: '1em', color: 'var(--muted)', textAlign: 'center' }}>
                    {hideSatisfied
                      ? 'All items are at target — nothing to buy. Toggle "Hide already at target" off to see them.'
                      : 'No items.'}
                  </td>
                </tr>
              )}
              {displayed.map((r) => {
                const isBehind = r.need > 0;
                const isTarget = Math.abs(r.sessionsLeft - target) < 0.05;
                return (
                  <tr key={r.id}>
                    <td className="left">{r.name}</td>
                    <td className="right">{r.buyPrice != null ? fmtGp(r.buyPrice) : '—'}</td>
                    <td className="right">
                      <input
                        type="text"
                        value={r.n}
                        onChange={(e) => updateN(r.id, e.target.value)}
                        onFocus={handleInputFocus}
                        onBlur={handleInputBlur}
                        inputMode="numeric"
                        style={{
                          width: '4em',
                          textAlign: 'right',
                          background: 'var(--bg)',
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          padding: '0.2em 0.4em',
                          fontFamily: 'inherit',
                          fontSize: '0.95em',
                        }}
                      />
                    </td>
                    <td className="right">
                      <input
                        type="text"
                        value={r.qty}
                        onChange={(e) => updateQty(r.id, e.target.value)}
                        onFocus={handleInputFocus}
                        onBlur={handleInputBlur}
                        inputMode="numeric"
                        style={{
                          width: '5em',
                          textAlign: 'right',
                          background: 'var(--bg)',
                          color: 'var(--text)',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          padding: '0.2em 0.4em',
                          fontFamily: 'inherit',
                          fontSize: '0.95em',
                        }}
                      />
                    </td>
                    <td
                      className="right"
                      style={{ color: isTarget ? 'var(--green)' : isBehind ? 'var(--red)' : 'var(--text)' }}
                    >
                      {r.sessionsLeft.toFixed(2)}
                    </td>
                    <td
                      className="right"
                      style={{ color: isBehind ? 'var(--red)' : 'var(--muted)', fontWeight: isBehind ? 600 : 400 }}
                    >
                      {r.need > 0 ? r.need.toLocaleString() : '✓'}
                    </td>
                    <td className="right" style={{ color: isBehind ? 'var(--red)' : 'var(--muted)' }}>
                      {r.cost != null && r.cost > 0 ? fmtGp(r.cost) : r.need === 0 ? '—' : '?'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
