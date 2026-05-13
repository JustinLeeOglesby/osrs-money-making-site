import { fmtGp, profitColor } from '../../utils/format';

// Recipe chain visualizer — shown only when at least one of a recipe's
// inputs is itself produced by another priced recipe. For each chainable
// input, we show:
//   - the producer recipe's name (clickable so the user could go find it)
//   - per-input profit/loss between "buy at GE" vs "craft it yourself"
//   - the recipe-level total savings if you craft every chainable input
//
// The backend (osrs_margin_api._build_payload) populates the `chainSources`
// field on each recipe so this is just rendering.
export default function RecipeChain({ chain, inputQtyMultiplierLookup }) {
  if (!chain || chain.length === 0) return null;

  let totalSavings = 0;
  const rows = chain.map((c) => {
    // Per "1 unit of input" delta: buying from GE costs inputUnitPrice;
    // crafting yields outputQty for inputCost (producer recipe). So crafting
    // cost per unit = producer.inputCost / outputQty.
    const craftCostPerUnit = c.producer.inputCost / (c.producer.outputQty || 1);
    const buyCostPerUnit = c.inputUnitPrice;
    const savingsPerUnit = buyCostPerUnit - craftCostPerUnit;
    const totalForThisInput = savingsPerUnit * c.inputQty;
    totalSavings += totalForThisInput;
    return { ...c, craftCostPerUnit, savingsPerUnit, totalForThisInput };
  });

  return (
    <div className="detail-section graph-section">
      <div className="detail-label">Craft inputs yourself?</div>
      <div className="chain-rows">
        {rows.map((row, i) => (
          <div key={i} className="chain-row">
            <div className="chain-input">
              <strong>{row.inputQty}× {row.inputName}</strong>
              {' '}— buy @ {fmtGp(row.inputUnitPrice)} or craft via{' '}
              <span className="chain-producer">{row.producer.recipeName}</span>
              {row.producer.levelReq && (
                <span className="level-chip">{row.producer.levelReq}</span>
              )}
            </div>
            <div
              className="chain-savings"
              style={{ color: profitColor(row.totalForThisInput) }}
            >
              {row.totalForThisInput > 0 ? '+' : ''}
              {fmtGp(row.totalForThisInput)}
              {' '}
              <span className="chain-savings-note">
                ({row.savingsPerUnit > 0 ? 'save' : 'lose'} {fmtGp(Math.abs(row.savingsPerUnit))}/unit)
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="chain-total" style={{ color: profitColor(totalSavings) }}>
        Total if you craft every chainable input:{' '}
        <strong>
          {totalSavings > 0 ? '+' : ''}
          {fmtGp(totalSavings)} gp
        </strong>
      </div>
    </div>
  );
}
