import { useState, useMemo } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { useItemModal } from '../../context/ItemModalContext';
import { usePace } from '../../context/PaceContext';
import DetailLine from './DetailLine';
import PriceGraph from '../PriceGraph';
import RecipeChain from './RecipeChain';
import ShoppingList from './ShoppingList';

// Expanded recipe panel: per-line buy + sell breakdown, totals, profit,
// XP, buy-limit data, notes, and a price-history graph for any item in
// the recipe. Buy/Sell line items are clickable; clicking one opens the
// global item-detail modal via ItemModalContext.
export default function RecipeDetail({ r }) {
  const netRevenue = r.outputRevenue - r.tax;
  const { open: openItemModal } = useItemModal();

  const chartableItems = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const l of [...r.outputs, ...r.inputs]) {
      if (l.item_id == null) continue;
      if (seen.has(l.item_id)) continue;
      seen.add(l.item_id);
      out.push({ id: l.item_id, name: l.name });
    }
    return out;
  }, [r]);
  const [chartItem, setChartItem] = useState(chartableItems[0]?.id ?? null);

  const clickableProps = (itemId) =>
    itemId != null
      ? {
          className: 'name clickable-item',
          onClick: (e) => {
            e.stopPropagation();
            openItemModal(itemId);
          },
          title: 'Open item details',
        }
      : { className: 'name' };

  return (
    <div className="recipe-detail open">
      <div className="detail-section">
        <div className="detail-label">Buy</div>
        {r.inputs.map((l, i) => (
          <div key={i} className="detail-line">
            <span {...clickableProps(l.item_id)}>
              {l.qty > 1 ? `${l.qty}× ` : ''}
              {l.name}
              {l.qty > 1 && ` @ ${fmtGp(l.unit_price)}`}
            </span>
            <span className="num">{fmtGp(l.line_total)}</span>
          </div>
        ))}
        <DetailLine name="Total cost" num={fmtGp(r.inputCost)} total />
      </div>
      <div className="detail-section">
        <div className="detail-label">Sell</div>
        {r.outputs.map((l, i) => (
          <div key={i} className="detail-line">
            <span {...clickableProps(l.item_id)}>
              {l.qty > 1 ? `${l.qty}× ` : ''}
              {l.name}
              {l.qty > 1 && ` @ ${fmtGp(l.unit_price)}`}
              {l.line_tax > 0 && (
                <span style={{ color: 'var(--red)' }}>
                  {' '}(-{fmtGp(l.line_tax)} tax)
                </span>
              )}
            </span>
            <span className="num">{fmtGp(l.line_total)}</span>
          </div>
        ))}
        <DetailLine name="Net revenue (after tax)" num={fmtGp(netRevenue)} total />
      </div>
      <DetailLine
        name="Profit per craft"
        num={fmtGp(r.profit)}
        color={profitColor(r.profit)}
        total
        big
      />
      {r.xp > 0 && (
        <DetailLine
          name="XP per craft"
          num={`${r.xp} XP — ${fmtGp(Math.round(r.profit / r.xp))} per XP`}
        />
      )}
      {r.buyLimit && (
        <DetailLine
          name="Buy limit (4hr)"
          num={`${r.buyLimit.toLocaleString()} crafts → max ${fmtGp(r.max4hrProfit)} / 4hr`}
        />
      )}
      {r.levelReq && <div className="notes">Required: {r.levelReq}</div>}
      {r.notes && <div className="notes">{r.notes}</div>}
      {r.ageMin != null && (
        <div className="notes">
          Price data:{' '}
          {r.ageMin >= 1
            ? `${Math.round(r.ageMin)} min`
            : `${Math.round(r.ageMin * 60)} sec`}{' '}
          old
        </div>
      )}
      <RecipeChain chain={r.chainSources} />
      <ShoppingList recipe={r} />
      {chartableItems.length > 0 && (
        <div className="detail-section graph-section">
          <div className="detail-label">Price history</div>
          <div className="item-picker">
            {chartableItems.map((it) => (
              <button
                key={it.id}
                className={`item-btn ${chartItem === it.id ? 'active' : ''}`}
                onClick={() => setChartItem(it.id)}
              >
                {it.name}
              </button>
            ))}
          </div>
          {chartItem != null && <PriceGraph itemId={chartItem} />}
        </div>
      )}
    </div>
  );
}
