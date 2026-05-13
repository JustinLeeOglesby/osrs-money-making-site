"""
OSRS Margin Tracker — static HTML report.

Run: python osrs_margin_html.py  →  produces osrs_margins.html

Reuses RECIPES + pricing logic from osrs_herb_margins.py. Generates a single
self-contained HTML file (CSS + JS embedded, no external dependencies, fully
offline) with category tabs, click-to-expand per-recipe breakdowns, and live
client-side search. No Python server needed once generated.
"""

import html
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

OUTPUT_FILE = "osrs_margins.html"


def fmt_gp(n) -> str:
    if n is None:
        return "—"
    return f"{round(n):,}"


def gather():
    prices = fetch_latest_prices()
    mapping = fetch_mapping()
    rows = []
    skipped = 0
    for r in RECIPES:
        m = calculate_recipe_margin(r, prices, mapping)
        if m is None:
            skipped += 1
            continue
        rows.append((r, m))
    if skipped:
        print(f"  Skipped {skipped} recipes (missing price data)")
    return rows


CSS = """
:root {
  --bg: #15171c; --bg-2: #1f232b; --bg-3: #2a2f3a;
  --border: #2f3540; --text: #e6e8ec; --muted: #8b94a3;
  --accent: #6da7e7; --green: #5ac26b; --red: #d96b6b;
}
* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: var(--bg); color: var(--text); margin: 0; font-size: 14px; }
header { background: var(--bg-2); border-bottom: 1px solid var(--border);
  padding: 1em 1.5em; position: sticky; top: 0; z-index: 10; }
h1 { margin: 0 0 0.4em; font-size: 1.15em; font-weight: 600; }
.meta { color: var(--muted); font-size: 0.85em; margin-bottom: 0.5em; }
#search { display: block; width: 100%; max-width: 480px; padding: 0.5em 0.8em;
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); font-size: 0.95em; }
#search:focus { outline: none; border-color: var(--accent); }
.tabs { display: flex; gap: 0.4em; background: var(--bg-2);
  border-bottom: 1px solid var(--border); padding: 0 1em; overflow-x: auto;
  position: sticky; top: 110px; z-index: 9; }
.tab { padding: 0.7em 1em; cursor: pointer; color: var(--muted);
  border-bottom: 2px solid transparent; user-select: none; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 500; }
.content { padding: 1.2em 1.5em 4em; }
.tab-content { display: none; }
.tab-content.active { display: block; }
.subcat { margin-bottom: 1.8em; }
.subcat h2 { color: var(--muted); font-size: 0.82em; text-transform: uppercase;
  letter-spacing: 0.08em; border-bottom: 1px solid var(--border);
  padding: 0.5em 0; margin: 1em 0 0.5em; font-weight: 600; }
.recipe { background: var(--bg-2); border-left: 3px solid transparent;
  margin-bottom: 0.4em; padding: 0.6em 1em; border-radius: 4px;
  cursor: pointer; transition: background 0.1s; }
.recipe:hover { background: var(--bg-3); }
.recipe.pos { border-left-color: var(--green); }
.recipe.neg { border-left-color: var(--red); }
.recipe-summary { display: grid;
  grid-template-columns: 1fr 95px 65px 90px 65px;
  align-items: center; gap: 0.5em; }
.recipe-name { font-weight: 500; }
.recipe-summary > div:not(.recipe-name) {
  text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.pos .recipe-profit { color: var(--green); font-weight: 500; }
.neg .recipe-profit { color: var(--red); font-weight: 500; }
.recipe-inline { color: var(--muted); font-size: 0.86em; margin-top: 0.35em;
  font-variant-numeric: tabular-nums; }
.recipe-detail { display: none; background: var(--bg); margin: 0 0 0.5em;
  padding: 1em 1.2em; border-radius: 4px; border-left: 3px solid var(--accent); }
.recipe-detail.open { display: block; }
.detail-section { margin-bottom: 0.7em; }
.detail-section:last-child { margin-bottom: 0; }
.detail-label { color: var(--muted); font-size: 0.78em; text-transform: uppercase;
  letter-spacing: 0.06em; margin-bottom: 0.35em; font-weight: 600; }
.detail-line { display: flex; gap: 0.5em; padding: 0.18em 0;
  font-variant-numeric: tabular-nums; }
.detail-line .name { flex: 1; }
.detail-line .num { color: var(--muted); }
.detail-line.total { border-top: 1px solid var(--border); margin-top: 0.3em;
  padding-top: 0.4em; font-weight: 500; }
.detail-line.total .num { color: var(--text); }
.recipe.hidden { display: none; }
.notes { color: var(--muted); font-style: italic; font-size: 0.85em; margin-top: 0.5em; }
.col-headers { background: transparent !important; cursor: default !important;
  border-left: 3px solid transparent !important; padding: 0.3em 1em !important; }
.col-headers .recipe-summary > div { color: var(--muted); font-size: 0.72em;
  text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
.col-headers .recipe-name { text-align: left; }
.no-match { color: var(--muted); padding: 2em 1em; text-align: center;
  font-style: italic; display: none; }
"""

JS = """
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content').forEach(c =>
    c.classList.toggle('active', c.dataset.tab === name));
  document.querySelectorAll('.no-match').forEach(n => n.style.display = 'none');
}
function toggle(el) { el.nextElementSibling.classList.toggle('open'); }
function searchFilter(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.recipe:not(.col-headers)').forEach(r => {
    const text = r.dataset.search || '';
    r.classList.toggle('hidden', q && !text.includes(q));
  });
  document.querySelectorAll('.subcat').forEach(s => {
    const visible = s.querySelector('.recipe:not(.hidden):not(.col-headers)');
    s.style.display = visible ? '' : 'none';
  });
  document.querySelectorAll('.tab-content').forEach(c => {
    const visible = c.querySelector('.recipe:not(.hidden):not(.col-headers)');
    const noMatch = c.querySelector('.no-match');
    if (noMatch) noMatch.style.display = (q && !visible) ? '' : 'none';
  });
}
"""


def render_detail(recipe, margin):
    parts = ['<div class="detail-section"><div class="detail-label">Buy</div>']
    for line in margin["input_lines"]:
        qty_prefix = f"{line['qty']}× " if line["qty"] > 1 else ""
        unit_str = f" @ {fmt_gp(line['unit_price'])}" if line["qty"] > 1 else ""
        parts.append(
            f'<div class="detail-line"><span class="name">{qty_prefix}'
            f'{html.escape(line["name"])}{unit_str}</span>'
            f'<span class="num">{fmt_gp(line["line_total"])}</span></div>'
        )
    parts.append(
        f'<div class="detail-line total"><span class="name">Total cost</span>'
        f'<span class="num">{fmt_gp(margin["input_cost"])}</span></div></div>'
    )

    parts.append('<div class="detail-section"><div class="detail-label">Sell</div>')
    for line in margin["output_lines"]:
        qty_prefix = f"{line['qty']}× " if line["qty"] > 1 else ""
        unit_str = f" @ {fmt_gp(line['unit_price'])}" if line["qty"] > 1 else ""
        tax_str = (
            f' <span style="color:var(--red)">(-{fmt_gp(line["line_tax"])} tax)</span>'
            if line["line_tax"] else ""
        )
        parts.append(
            f'<div class="detail-line"><span class="name">{qty_prefix}'
            f'{html.escape(line["name"])}{unit_str}{tax_str}</span>'
            f'<span class="num">{fmt_gp(line["line_total"])}</span></div>'
        )
    parts.append(
        f'<div class="detail-line total"><span class="name">Net revenue (after tax)</span>'
        f'<span class="num">{fmt_gp(margin["output_revenue"] - margin["tax"])}</span>'
        f'</div></div>'
    )

    profit = margin["profit"]
    profit_color = "var(--green)" if profit > 0 else "var(--red)" if profit < 0 else "inherit"
    parts.append(
        f'<div class="detail-line total" style="font-size:1.05em">'
        f'<span class="name">Profit per craft</span>'
        f'<span class="num" style="color:{profit_color};font-weight:600">'
        f'{fmt_gp(profit)}</span></div>'
    )

    if recipe.xp:
        gp_per_xp = round(profit / recipe.xp)
        parts.append(
            f'<div class="detail-line"><span class="name">XP per craft</span>'
            f'<span class="num">{recipe.xp:g} XP — {fmt_gp(gp_per_xp)} per XP</span></div>'
        )

    if margin["buy_limit"]:
        parts.append(
            f'<div class="detail-line"><span class="name">Buy limit (4hr)</span>'
            f'<span class="num">{margin["buy_limit"]:,} crafts → '
            f'max {fmt_gp(margin["max_4hr_profit"])} profit / 4hr</span></div>'
        )

    if recipe.notes:
        parts.append(f'<div class="notes">{html.escape(recipe.notes)}</div>')

    age = age_minutes(margin.get("oldest_data_ts"))
    if age is not None:
        age_str = f"{age:.0f} min" if age >= 1 else f"{age * 60:.0f} sec"
        parts.append(f'<div class="notes">Price data: {age_str} old</div>')

    return "".join(parts)


def render_recipe(recipe, margin):
    profit = margin["profit"]
    klass = "pos" if profit > 0 else "neg" if profit < 0 else ""

    def line_str(line):
        qty = f"{line['qty']}× " if line["qty"] > 1 else ""
        return f"{qty}{line['name']}: {fmt_gp(line['unit_price'])}"

    inputs_inline = " + ".join(line_str(l) for l in margin["input_lines"])
    outputs_inline = " + ".join(line_str(l) for l in margin["output_lines"])
    inline = f"{inputs_inline} → {outputs_inline}"

    detail_html = render_detail(recipe, margin)
    search_text = " ".join(
        [recipe.name, recipe.subcategory, recipe.notes]
        + [l["name"] for l in margin["input_lines"]]
        + [l["name"] for l in margin["output_lines"]]
    ).lower()

    xp_str = f"{recipe.xp:g}" if recipe.xp else "—"
    gp_xp_str = fmt_gp(round(profit / recipe.xp)) if recipe.xp else "—"
    limit_str = f"{margin['buy_limit']:,}" if margin["buy_limit"] is not None else "—"

    return (
        f'<div class="recipe {klass}" data-search="{html.escape(search_text)}" '
        f'onclick="toggle(this)">'
        f'<div class="recipe-summary">'
        f'<div class="recipe-name">{html.escape(recipe.name)}</div>'
        f'<div class="recipe-profit">{fmt_gp(profit)}</div>'
        f'<div>{xp_str}</div>'
        f'<div>{gp_xp_str}</div>'
        f'<div>{limit_str}</div>'
        f'</div>'
        f'<div class="recipe-inline">{html.escape(inline)}</div>'
        f'</div>'
        f'<div class="recipe-detail">{detail_html}</div>'
    )


COL_HEADERS = (
    '<div class="recipe col-headers"><div class="recipe-summary">'
    '<div class="recipe-name">Recipe</div>'
    '<div>Profit</div><div>XP</div><div>GP / XP</div><div>4hr limit</div>'
    '</div></div>'
)


def render(rows, generated_at):
    by_cat = {}
    for r, m in rows:
        by_cat.setdefault(r.category, []).append((r, m))
    categories = sorted(by_cat.keys())

    tabs_html = "\n".join(
        f'<div class="tab{" active" if i == 0 else ""}" '
        f'data-tab="{html.escape(c)}" onclick="showTab(\'{html.escape(c)}\')">'
        f'{html.escape(c)} <span style="opacity:0.6">({len(by_cat[c])})</span>'
        f'</div>'
        for i, c in enumerate(categories)
    )

    tab_contents = []
    for i, cat in enumerate(categories):
        by_sub: dict[str, list] = {}
        for r, m in by_cat[cat]:
            by_sub.setdefault(r.subcategory, []).append((r, m))

        sub_blocks = []
        for sub in sorted(by_sub.keys()):
            sub_rows = sorted(by_sub[sub], key=lambda x: -x[1]["profit"])
            recipes_html = "\n".join(render_recipe(r, m) for r, m in sub_rows)
            sub_blocks.append(
                f'<div class="subcat"><h2>{html.escape(sub)}</h2>'
                f'{COL_HEADERS}{recipes_html}</div>'
            )

        active = " active" if i == 0 else ""
        tab_contents.append(
            f'<div class="tab-content{active}" data-tab="{html.escape(cat)}">'
            f'{"".join(sub_blocks)}'
            f'<div class="no-match">No recipes match your search in this category.</div>'
            f'</div>'
        )

    strategy_label = (
        "instant (insta-buy + insta-sell — conservative)"
        if MARGIN_STRATEGY == "instant"
        else "patient (buy low, sell high — optimistic)"
    )

    return (
        f"<!DOCTYPE html>\n<html lang='en'>\n<head>\n"
        f"<meta charset='utf-8'>\n<title>OSRS Margin Tracker</title>\n"
        f"<style>{CSS}</style>\n</head>\n<body>\n"
        f"<header>\n<h1>OSRS Margin Tracker</h1>\n"
        f"<div class='meta'>Generated {html.escape(generated_at)} · "
        f"{len(rows)} recipes priced · Strategy: {html.escape(strategy_label)}</div>\n"
        f"<input id='search' type='search' "
        f"placeholder='Search recipes, ingredients, notes...' "
        f"oninput='searchFilter(this.value)'>\n</header>\n"
        f"<div class='tabs'>{tabs_html}</div>\n"
        f"<div class='content'>{''.join(tab_contents)}</div>\n"
        f"<script>{JS}</script>\n</body>\n</html>"
    )


def main():
    print("Fetching prices and item mapping...")
    rows = gather()
    print(f"Rendering {len(rows)} recipes to {OUTPUT_FILE}...")
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    Path(OUTPUT_FILE).write_text(render(rows, generated_at), encoding="utf-8")
    print(f"Done. Open {OUTPUT_FILE} in your browser.")


if __name__ == "__main__":
    main()
