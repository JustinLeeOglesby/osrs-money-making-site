import { useState, useEffect, useMemo } from 'react';
import { fmtGp, profitColor } from '../../utils/format';
import { fetchRecipes } from '../../api/client';
import { useItemModal } from '../../context/ItemModalContext';

// Chain Explorer — pick any recipe output and walk the full production
// tree by traversing the chainSources field that the backend already
// builds. For each input, show the option of either buying it on the GE
// or crafting it from a sub-recipe (which may itself have chainable
// inputs). Doesn't duplicate or replace the existing inline chain
// section in RecipeDetail — that one still works on every recipe row.
//
// Performance: we fetch /api/recipes ourselves so the explorer doesn't
// depend on App's payload being passed through. The backend cache makes
// repeat calls cheap.

// Recursive tree node. Renders one recipe step and, for each input that
// has a producer recipe, calls itself one level deeper.
function ChainNode({ recipe, qty, depth, recipesByOutputId, visited, openItemModal }) {
  if (depth > 6) {
    return (
      <div className="chain-node">
        <div className="chain-node-header">
          {qty != null && <span className="chain-qty">{qty.toLocaleString()}×</span>}{' '}
          <strong>{recipe.name}</strong> (depth limit reached)
        </div>
      </div>
    );
  }

  const totalCost = recipe.inputCost * qty;
  const totalRevenue = recipe.outputRevenue * qty;
  const totalProfit = (recipe.profit) * qty;

  return (
    <div className="chain-node" style={{ marginLeft: depth === 0 ? 0 : '1.2em' }}>
      <div className="chain-node-header">
        {qty != null && <span className="chain-qty">{qty.toLocaleString()}×</span>}{' '}
        <strong>{recipe.name}</strong>
        {recipe.levelReq && <span className="level-chip">{recipe.levelReq}</span>}
        <span className="chain-node-cost">
          {' '}cost {fmtGp(totalCost)} → revenue {fmtGp(totalRevenue)} ={' '}
          <span style={{ color: profitColor(totalProfit), fontWeight: 500 }}>
            {fmtGp(totalProfit)} gp
          </span>
        </span>
      </div>
      {recipe.inputs
        .filter((inp) => inp.item_id != null)
        .map((inp, i) => {
          const inputQty = inp.qty * qty;
          const buyCost = inp.unit_price * inputQty;
          const producerKey = `${recipe.name}>${inp.item_id}`;
          const producer = recipesByOutputId.get(inp.item_id);
          const alreadyVisited = visited.has(inp.item_id);
          const canRecurse = producer && !alreadyVisited;
          return (
            <div key={i} className="chain-input">
              <div className="chain-input-row">
                <span className="chain-qty">{inputQty.toLocaleString()}×</span>{' '}
                <span
                  className="clickable-item"
                  onClick={() => openItemModal(inp.item_id)}
                >
                  {inp.name}
                </span>
                <span className="chain-input-buy">
                  buy @ {fmtGp(inp.unit_price)} = {fmtGp(buyCost)}
                </span>
              </div>
              {canRecurse && (
                <div className="chain-craft-option">
                  <div className="chain-craft-label">
                    ↳ <em>or craft via</em>
                  </div>
                  <ChainNode
                    recipe={producer}
                    qty={Math.ceil(inputQty / producer.outputs[0].qty)}
                    depth={depth + 1}
                    recipesByOutputId={recipesByOutputId}
                    visited={new Set([...visited, inp.item_id])}
                    openItemModal={openItemModal}
                  />
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

export default function ChainExplorer() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);
  const { open: openItemModal } = useItemModal();

  useEffect(() => {
    fetchRecipes().then(setPayload).catch((e) => setError(e.message));
  }, []);

  // Index recipes by their primary output's item_id. Recipes with multiple
  // outputs (decanting, etc.) are skipped to keep chain semantics simple —
  // the backend already does this when building chainSources.
  const recipesByOutputId = useMemo(() => {
    const m = new Map();
    if (!payload) return m;
    for (const r of payload.recipes) {
      if (r.outputs.length !== 1) continue;
      const id = r.outputs[0].item_id;
      if (id == null) continue;
      // Keep the most profitable producer if duplicates exist.
      const existing = m.get(id);
      if (!existing || r.profit > existing.profit) m.set(id, r);
    }
    return m;
  }, [payload]);

  const recipeOptions = useMemo(() => {
    if (!payload) return [];
    const q = query.toLowerCase().trim();
    return payload.recipes
      .filter((r) => r.profit > 0)
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .sort((a, b) => b.profit - a.profit);
  }, [payload, query]);

  const selectedRecipe = useMemo(() => {
    if (!payload || !selectedKey) return null;
    return payload.recipes.find((r) => r.name === selectedKey) || null;
  }, [payload, selectedKey]);

  if (error) return <div className="graph-msg">Error: {error}</div>;
  if (!payload) return <div className="graph-msg">Loading recipes…</div>;

  return (
    <div className="chain-explorer">
      <div className="alch-note">
        💡 Pick any recipe and see its full crafting chain — for every input
        that's itself produced by another recipe, the alternative ("or craft via
        …") expansion shows what you'd pay if you made that input yourself
        instead of buying it on the GE. Useful for deciding "should I do every
        step or just buy the intermediates?"
      </div>
      <div className="chain-picker">
        <input
          type="search"
          className="item-search-input"
          placeholder="Search recipes by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 360 }}
        />
        <div className="chain-picker-results">
          {recipeOptions.length === 0 ? (
            <div className="item-results-hint">No profitable recipes match.</div>
          ) : (
            <>
              {recipeOptions.map((r) => (
                <div
                  key={r.name}
                  className={`item-row ${selectedKey === r.name ? 'active' : ''}`}
                  onClick={() => setSelectedKey(r.name)}
                >
                  <span className="item-row-name">{r.name}</span>
                  <span style={{ color: 'var(--green)', fontVariantNumeric: 'tabular-nums', marginRight: '0.5em' }}>
                    {fmtGp(r.profit)} gp
                  </span>
                  <span className="item-row-id">{r.category}</span>
                </div>
              ))}
              <div className="item-results-hint">
                {recipeOptions.length} profitable recipes (sorted by profit, highest first)
              </div>
            </>
          )}
        </div>
      </div>
      {selectedRecipe ? (
        <div className="chain-tree">
          <ChainNode
            recipe={selectedRecipe}
            qty={1}
            depth={0}
            recipesByOutputId={recipesByOutputId}
            visited={new Set()}
            openItemModal={openItemModal}
          />
        </div>
      ) : (
        <div className="graph-msg">Pick a recipe to walk its chain.</div>
      )}
    </div>
  );
}
