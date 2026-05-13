"""
OSRS Margin Tracker — React-powered static HTML report.

Run: python osrs_margin_react.py  →  produces osrs_margins_react.html

Single self-contained HTML file: React, ReactDOM, and Babel standalone are
loaded from a CDN, recipe data is embedded as JSON, and the app is real JSX
compiled in-browser. No npm, no build step. Open in any browser.
"""

import json
from datetime import datetime
from pathlib import Path

from osrs_herb_margins import (
    MARGIN_STRATEGY,
    RECIPES,
    age_minutes,
    calculate_recipe_margin,
    fetch_latest_prices,
    fetch_mapping,
)

# Reuse styling from the vanilla-JS version so the two implementations look
# identical and the only thing changing is the rendering layer.
from osrs_margin_html import CSS

OUTPUT_FILE = "osrs_margins_react.html"


def gather_json():
    prices = fetch_latest_prices()
    mapping = fetch_mapping()
    out = []
    skipped = 0
    for r in RECIPES:
        m = calculate_recipe_margin(r, prices, mapping)
        if m is None:
            skipped += 1
            continue
        out.append(
            {
                "name": r.name,
                "category": r.category,
                "subcategory": r.subcategory,
                "isF2p": r.is_f2p,
                "xp": r.xp,
                "notes": r.notes,
                "profit": m["profit"],
                "inputCost": m["input_cost"],
                "outputRevenue": m["output_revenue"],
                "tax": m["tax"],
                "buyLimit": m["buy_limit"],
                "max4hrProfit": m["max_4hr_profit"],
                "ageMin": age_minutes(m["oldest_data_ts"]),
                "inputs": m["input_lines"],
                "outputs": m["output_lines"],
            }
        )
    if skipped:
        print(f"  Skipped {skipped} recipes (missing price data)")
    return out


REACT_APP = r"""
const { useState, useMemo } = React;

const fmtGp = (n) => {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
};

const profitColor = (p) =>
  p > 0 ? 'var(--green)' : p < 0 ? 'var(--red)' : undefined;

function DetailLine({ name, num, color, total, big }) {
  return (
    <div className={`detail-line ${total ? 'total' : ''}`}
         style={big ? { fontSize: '1.05em' } : undefined}>
      <span className="name">{name}</span>
      <span className="num" style={{ color, fontWeight: total ? 500 : undefined }}>
        {num}
      </span>
    </div>
  );
}

function RecipeDetail({ r }) {
  const netRevenue = r.outputRevenue - r.tax;
  return (
    <div className="recipe-detail open">
      <div className="detail-section">
        <div className="detail-label">Buy</div>
        {r.inputs.map((l, i) => (
          <DetailLine
            key={i}
            name={(l.qty > 1 ? `${l.qty}× ` : '') + l.name +
                  (l.qty > 1 ? ` @ ${fmtGp(l.unit_price)}` : '')}
            num={fmtGp(l.line_total)}
          />
        ))}
        <DetailLine name="Total cost" num={fmtGp(r.inputCost)} total />
      </div>
      <div className="detail-section">
        <div className="detail-label">Sell</div>
        {r.outputs.map((l, i) => (
          <div key={i} className="detail-line">
            <span className="name">
              {l.qty > 1 ? `${l.qty}× ` : ''}{l.name}
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
        <DetailLine
          name="Net revenue (after tax)"
          num={fmtGp(netRevenue)}
          total
        />
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
      {r.notes && <div className="notes">{r.notes}</div>}
      {r.ageMin != null && (
        <div className="notes">
          Price data: {r.ageMin >= 1
            ? `${Math.round(r.ageMin)} min`
            : `${Math.round(r.ageMin * 60)} sec`} old
        </div>
      )}
    </div>
  );
}

function Recipe({ r }) {
  const [open, setOpen] = useState(false);
  const klass = r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : '';

  const lineStr = (l) =>
    `${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}: ${fmtGp(l.unit_price)}`;
  const inline =
    `${r.inputs.map(lineStr).join(' + ')} → ${r.outputs.map(lineStr).join(' + ')}`;

  const xpStr = r.xp ? `${r.xp}` : '—';
  const gpXpStr = r.xp ? fmtGp(Math.round(r.profit / r.xp)) : '—';
  const limitStr = r.buyLimit != null ? r.buyLimit.toLocaleString() : '—';

  return (
    <>
      <div className={`recipe ${klass}`} onClick={() => setOpen(!open)}>
        <div className="recipe-summary">
          <div className="recipe-name">{r.name}</div>
          <div className="recipe-profit">{fmtGp(r.profit)}</div>
          <div>{xpStr}</div>
          <div>{gpXpStr}</div>
          <div>{limitStr}</div>
        </div>
        <div className="recipe-inline">{inline}</div>
      </div>
      {open && <RecipeDetail r={r} />}
    </>
  );
}

function ColHeaders() {
  return (
    <div className="recipe col-headers">
      <div className="recipe-summary">
        <div className="recipe-name">Recipe</div>
        <div>Profit</div>
        <div>XP</div>
        <div>GP / XP</div>
        <div>4hr limit</div>
      </div>
    </div>
  );
}

function Subcategory({ name, recipes }) {
  return (
    <div className="subcat">
      <h2>{name}</h2>
      <ColHeaders />
      {recipes.map((r, i) => <Recipe key={`${r.name}-${i}`} r={r} />)}
    </div>
  );
}

function TabContent({ recipes, search }) {
  const filtered = useMemo(() => {
    if (!search) return recipes;
    const q = search.toLowerCase();
    return recipes.filter((r) => {
      const text = [
        r.name, r.subcategory, r.notes,
        ...r.inputs.map((l) => l.name),
        ...r.outputs.map((l) => l.name),
      ].join(' ').toLowerCase();
      return text.includes(q);
    });
  }, [recipes, search]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      if (!map.has(r.subcategory)) map.set(r.subcategory, []);
      map.get(r.subcategory).push(r);
    }
    for (const arr of map.values()) arr.sort((a, b) => b.profit - a.profit);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  if (filtered.length === 0) {
    return <div className="no-match" style={{ display: 'block' }}>
      No recipes match your search in this category.
    </div>;
  }

  return <>{grouped.map(([sub, rs]) =>
    <Subcategory key={sub} name={sub} recipes={rs} />
  )}</>;
}

function App({ data, generated, strategy }) {
  const [search, setSearch] = useState('');

  const byCategory = useMemo(() => {
    const map = new Map();
    for (const r of data) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category).push(r);
    }
    return map;
  }, [data]);

  const categories = useMemo(
    () => [...byCategory.keys()].sort(),
    [byCategory]
  );

  const [activeTab, setActiveTab] = useState(categories[0]);

  return (
    <>
      <header>
        <h1>OSRS Margin Tracker <span style={{opacity: 0.5, fontSize: '0.75em'}}>(React)</span></h1>
        <div className="meta">
          Generated {generated} · {data.length} recipes priced · Strategy: {strategy}
        </div>
        <input
          id="search"
          type="search"
          placeholder="Search recipes, ingredients, notes..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </header>
      <div className="tabs">
        {categories.map((c) => (
          <div
            key={c}
            className={`tab ${c === activeTab ? 'active' : ''}`}
            onClick={() => setActiveTab(c)}
          >
            {c} <span style={{ opacity: 0.6 }}>({byCategory.get(c).length})</span>
          </div>
        ))}
      </div>
      <div className="content">
        <TabContent
          key={activeTab}
          recipes={byCategory.get(activeTab) || []}
          search={search}
        />
      </div>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <App data={DATA} generated={GENERATED_AT} strategy={STRATEGY} />
);
"""


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>OSRS Margin Tracker (React)</title>
  <style>__CSS__</style>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body>
  <div id="root">
    <div style="padding:2em;color:#8b94a3;font-family:sans-serif">
      Compiling React app in-browser via Babel… (one-time, ~1s)
    </div>
  </div>
  <script>
    const DATA = __DATA__;
    const GENERATED_AT = __GENERATED__;
    const STRATEGY = __STRATEGY__;
  </script>
  <script type="text/babel" data-presets="react">__APP__</script>
</body>
</html>
"""


def main():
    print("Fetching prices and item mapping...")
    data = gather_json()
    print(f"Rendering {len(data)} recipes to {OUTPUT_FILE}...")

    strategy_label = (
        "instant (insta-buy + insta-sell — conservative)"
        if MARGIN_STRATEGY == "instant"
        else "patient (buy low, sell high — optimistic)"
    )
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    output = (
        HTML_TEMPLATE.replace("__CSS__", CSS)
        .replace("__DATA__", json.dumps(data))
        .replace("__GENERATED__", json.dumps(generated_at))
        .replace("__STRATEGY__", json.dumps(strategy_label))
        .replace("__APP__", REACT_APP)
    )
    Path(OUTPUT_FILE).write_text(output, encoding="utf-8")
    print(f"Done. Open {OUTPUT_FILE} in your browser (needs internet for the CDN).")


if __name__ == "__main__":
    main()
