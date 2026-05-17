import { useState, useMemo } from 'react';
import { fmtGp } from '../../utils/format';
import { usePace } from '../../context/PaceContext';

// Materials shopping list — given a recipe and a session length, compute
// total inputs you'd need to buy from the GE. Useful for scaling up
// processing methods so you don't have to do the multiplication in your head.
//
// Capped by the GE 4hr buy limit when one's present (you can't actually
// craft more than the limit allows over 4 hours).
export default function ShoppingList({ recipe }) {
  const { actionsPerHour } = usePace();
  const [hoursStr, setHoursStr] = useState('1');
  const [copied, setCopied] = useState(false);

  const hours = useMemo(() => {
    const n = Number(hoursStr);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }, [hoursStr]);

  const { actions, capped, totals, totalCost } = useMemo(() => {
    const ratePerHour = recipe.buyLimit != null
      ? Math.min(actionsPerHour, recipe.buyLimit / 4)
      : actionsPerHour;
    const crafts = Math.round(ratePerHour * hours);
    const limitCap = recipe.buyLimit != null
      ? Math.floor(recipe.buyLimit * (hours / 4))
      : Infinity;
    const usableCrafts = Math.min(crafts, limitCap);
    const isCapped = recipe.buyLimit != null && crafts >= limitCap;

    // For each input, compute total quantity + cost.
    const lines = recipe.inputs
      .filter((l) => l.item_id != null)
      .map((l) => ({
        item_id: l.item_id,
        name: l.name,
        qty: l.qty * usableCrafts,
        unit_price: l.unit_price,
        cost: l.qty * usableCrafts * l.unit_price,
      }));

    // Non-GE coin costs (NPC fees etc) — apply per-craft.
    const coinLine = recipe.inputs.find((l) => l.item_id == null);
    const coinTotal = coinLine ? coinLine.unit_price * usableCrafts : 0;

    const total = lines.reduce((s, l) => s + l.cost, 0) + coinTotal;
    return { actions: usableCrafts, capped: isCapped, totals: lines, totalCost: total };
  }, [recipe, hours, actionsPerHour]);

  const copyAsText = () => {
    const text = totals
      .map((l) => `${l.qty.toLocaleString()} × ${l.name}`)
      .join('\n');
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };

  return (
    <div className="detail-section graph-section">
      <div className="detail-label">Shopping list</div>
      <div className="shopping-controls">
        <label className="min-filter">
          For
          <input
            type="text"
            value={hoursStr}
            onChange={(e) => setHoursStr(e.target.value)}
            inputMode="decimal"
            style={{ width: 60 }}
          />
          hours of crafting
        </label>
        <span className="shopping-summary">
          = <strong>{actions.toLocaleString()}</strong> crafts
          {capped && (
            <span className="notes" style={{ display: 'inline', marginLeft: '0.4em' }}>
              (capped by 4hr GE buy limit)
            </span>
          )}
        </span>
      </div>
      <div className="shopping-list">
        {totals.map((l) => (
          <div key={l.item_id} className="shopping-row">
            <span className="shopping-qty">{l.qty.toLocaleString()}×</span>
            <span className="shopping-name">{l.name}</span>
            <span className="shopping-cost">{fmtGp(l.cost)}</span>
          </div>
        ))}
        <div className="shopping-row shopping-total">
          <span className="shopping-qty"></span>
          <span className="shopping-name">Total input cost</span>
          <span className="shopping-cost">{fmtGp(totalCost)}</span>
        </div>
      </div>
      <button
        className="range-btn"
        onClick={copyAsText}
        style={{ marginTop: '0.5em' }}
      >
        {copied ? '✓ Copied' : '📋 Copy as text'}
      </button>
    </div>
  );
}
