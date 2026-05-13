"""Streamlit UI for the OSRS margin tracker. Run: streamlit run osrs_margin_app.py"""

import pandas as pd
import streamlit as st

from osrs_herb_margins import (
    RECIPES,
    age_minutes,
    calculate_recipe_margin,
    fetch_latest_prices,
    fetch_mapping,
)

st.set_page_config(page_title="OSRS Margins", layout="wide")

DISPLAY_COLS = [
    "Recipe",
    "F2P",
    "Profit",
    "Breakdown",
    "XP",
    "GP/XP",
    "Buy cost",
    "Sell rev",
    "Tax",
    "Buy limit",
    "Max 4hr profit",
    "Age (min)",
]


def format_gp(n) -> str:
    if n is None:
        return "—"
    return f"{round(n):,}"


def format_breakdown(margin: dict) -> str:
    def fmt(line):
        if line["qty"] == 1:
            return f"{line['name']}: {format_gp(line['unit_price'])}"
        return (
            f"{line['qty']}x {line['name']} @ {format_gp(line['unit_price'])} "
            f"(={format_gp(line['line_total'])})"
        )

    inputs = " + ".join(fmt(line) for line in margin["input_lines"])
    outputs = " + ".join(fmt(line) for line in margin["output_lines"])
    return f"{inputs} -> {outputs}"


@st.cache_data(ttl=300)
def load_data():
    prices = fetch_latest_prices()
    mapping = fetch_mapping()
    rows = []
    for r in RECIPES:
        m = calculate_recipe_margin(r, prices, mapping)
        if m is None:
            continue
        gp_per_xp = round(m["profit"] / r.xp) if r.xp else None
        rows.append(
            {
                "Recipe": r.name,
                "Category": r.category,
                "Subcategory": r.subcategory,
                "F2P": r.is_f2p,
                "Buy cost": m["input_cost"],
                "Sell rev": m["output_revenue"],
                "Tax": m["tax"],
                "Profit": m["profit"],
                "XP": r.xp if r.xp else None,
                "GP/XP": gp_per_xp,
                "Buy limit": m["buy_limit"],
                "Max 4hr profit": m["max_4hr_profit"],
                "Age (min)": round(age_minutes(m["oldest_data_ts"]) or 0, 1),
                "Breakdown": format_breakdown(m),
                "_recipe": r,
                "_margin": m,
            }
        )
    return rows


def render_breakdown(row):
    recipe, margin = row["_recipe"], row["_margin"]
    st.divider()
    st.subheader(f"Breakdown — {recipe.name}")
    if recipe.notes:
        st.caption(recipe.notes)
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Buy cost", f"{margin['input_cost']:,}")
    c2.metric("Sell revenue", f"{margin['output_revenue']:,}")
    c3.metric("GE tax", f"{margin['tax']:,}")
    c4.metric("Profit / craft", f"{margin['profit']:,}")

    if recipe.xp:
        gp_per_xp = round(margin["profit"] / recipe.xp)
        x1, x2 = st.columns(2)
        x1.metric("XP / craft", f"{recipe.xp:g}")
        x2.metric("GP / XP", f"{gp_per_xp:,}")
    left, right = st.columns(2)
    with left:
        st.write("**Inputs**")
        st.dataframe(
            pd.DataFrame(margin["input_lines"]),
            hide_index=True,
            use_container_width=True,
        )
    with right:
        st.write("**Outputs**")
        st.dataframe(
            pd.DataFrame(margin["output_lines"]),
            hide_index=True,
            use_container_width=True,
        )


st.title("OSRS Margin Tracker")
if st.button("Refresh prices"):
    st.cache_data.clear()
    st.rerun()

rows = load_data()

st.sidebar.header("Filters")
f2p_only = st.sidebar.checkbox("F2P only")
search = st.sidebar.text_input("Search recipe name")
min_profit = st.sidebar.number_input("Min profit / craft", value=0, step=1000)

filtered = [
    r
    for r in rows
    if (not f2p_only or r["F2P"])
    and (not search or search.lower() in r["Recipe"].lower())
    and r["Profit"] >= min_profit
]

if not filtered:
    st.info("No recipes match the current filters.")
    st.stop()

# Multiple dataframes per tab each carry their own selection state across reruns.
# To pick "the row the user just clicked" we compare each df's current selection
# against what we saw on the previous rerun and use whichever changed.
if "prev_selections" not in st.session_state:
    st.session_state.prev_selections = {}

categories = sorted({r["Category"] for r in filtered})
current_selections: dict[str, int | None] = {}

tabs = st.tabs(categories)
for tab, category in zip(tabs, categories):
    with tab:
        cat_rows = [r for r in filtered if r["Category"] == category]
        subcats = sorted({r["Subcategory"] for r in cat_rows})

        tab_new_active = None
        for subcat in subcats:
            sub_rows = sorted(
                [r for r in cat_rows if r["Subcategory"] == subcat],
                key=lambda r: -r["Profit"],
            )
            st.markdown(f"#### {subcat}")
            df = pd.DataFrame([{k: r[k] for k in DISPLAY_COLS} for r in sub_rows])
            df_key = f"df_{category}_{subcat}"
            height = min(len(sub_rows) * 35 + 38, 400)
            event = st.dataframe(
                df,
                use_container_width=True,
                on_select="rerun",
                selection_mode="single-row",
                hide_index=True,
                height=height,
                key=df_key,
                column_config={
                    "Breakdown": st.column_config.Column(width="large"),
                },
            )
            cur = event.selection.rows[0] if event.selection.rows else None
            current_selections[df_key] = cur
            prev = st.session_state.prev_selections.get(df_key)
            if cur is not None and cur < len(sub_rows) and cur != prev:
                tab_new_active = sub_rows[cur]

        active_key = f"active_{category}"
        if tab_new_active is not None:
            st.session_state[active_key] = tab_new_active

        active = st.session_state.get(active_key)
        if active is not None:
            render_breakdown(active)

st.session_state.prev_selections = current_selections
