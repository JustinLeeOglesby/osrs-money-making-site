"""
OSRS Margin Tracker — Flask REST API.

Run:  python osrs_margin_api.py    (defaults to http://localhost:5000)

Endpoints:
  GET  /api/recipes  - all priced recipes with margins (5-min cache)
  POST /api/refresh  - clear cache and recompute now

Pair with the React frontend in ./frontend (npm run dev -> http://localhost:5173).
"""

import json as _json
import os
import time

import requests
from flask import Flask, jsonify, request, send_from_directory, abort
from flask_cors import CORS

# Postgres is optional — only needed for the cross-device sync feature.
# Falls back gracefully if the driver or DATABASE_URL is missing (sync
# endpoints will return 503, the rest of the API works unchanged).
try:
    import psycopg2  # type: ignore
    from psycopg2.extras import RealDictCursor  # type: ignore
except ImportError:  # pragma: no cover - local dev without sync
    psycopg2 = None
    RealDictCursor = None

# Anthropic SDK is optional — only needed for the inventory-screenshot OCR
# endpoint. If the SDK isn't installed or ANTHROPIC_API_KEY isn't set, the
# OCR endpoints 503 and the rest of the app works as normal.
try:
    from anthropic import Anthropic  # type: ignore
except ImportError:  # pragma: no cover - local dev without OCR
    Anthropic = None

from osrs_herb_margins import (
    BASE_URL,
    HEADERS,
    MARGIN_STRATEGY,
    RECIPES,
    age_minutes,
    calculate_recipe_margin,
    fetch_latest_prices,
    fetch_mapping,
)

app = Flask(__name__)
CORS(app)  # frontend dev server runs on a different port

# In production (Render etc.) the built React app lives at frontend/dist.
# In local dev it usually doesn't exist — Vite serves the frontend on its
# own port 5173. We only register the catch-all route when the build is
# present so dev requests to "/" don't get hijacked.
FRONTEND_DIST = os.path.join(os.path.dirname(__file__), "frontend", "dist")
SERVE_FRONTEND = os.path.isdir(FRONTEND_DIST)

CACHE_TTL_SECONDS = 300
_cache: dict = {"payload": None, "ts": 0.0}

# Per-item price history cache. Wiki timeseries endpoint returns up to 365
# points and is fairly stable, so 5 min TTL is plenty.
TIMESERIES_TTL = 300
VALID_TIMESTEPS = {"5m", "1h", "6h", "24h"}
_ts_cache: dict = {}  # (item_id, timestep) -> (payload, ts)

# Full /mapping list rarely changes; cache for a day.
MAPPING_TTL = 60 * 60 * 24
_mapping_cache: dict = {"data": None, "ts": 0.0}

# Short cache for /latest so item-detail lookups don't hammer the wiki.
LATEST_TTL = 60
_latest_cache: dict = {"data": None, "ts": 0.0}

# /1h aggregates (hourly volume per item) — refreshed every 5 min.
HOURLY_TTL = 300
_hourly_cache: dict = {"data": None, "ts": 0.0}

# /24h aggregates — long-window baseline for anomaly detection. Refreshed
# every 30 min since this is a slow-moving average anyway.
DAILY_TTL = 30 * 60
_daily_cache: dict = {"data": None, "ts": 0.0}

# /5m aggregates — short-window "currently active" signal. The wiki refreshes
# this every 5 minutes; we cache for 60 seconds so several frontend calls in
# quick succession don't hammer the upstream. Used to distinguish items that
# are actively trading right now from items whose 1h/24h numbers reflect a
# stale spike.
FIVE_MIN_TTL = 60
_5min_cache: dict = {"data": None, "ts": 0.0}

NATURE_RUNE_ID = 561  # for high alch profit calc


def _get_mapping():
    now = time.time()
    if _mapping_cache["data"] is None or (now - _mapping_cache["ts"]) > MAPPING_TTL:
        _mapping_cache["data"] = fetch_mapping()
        _mapping_cache["ts"] = now
    return _mapping_cache["data"]


def _get_latest():
    now = time.time()
    if _latest_cache["data"] is None or (now - _latest_cache["ts"]) > LATEST_TTL:
        _latest_cache["data"] = fetch_latest_prices()
        _latest_cache["ts"] = now
    return _latest_cache["data"]


def _get_hourly():
    now = time.time()
    if _hourly_cache["data"] is None or (now - _hourly_cache["ts"]) > HOURLY_TTL:
        resp = requests.get(f"{BASE_URL}/1h", headers=HEADERS, timeout=15)
        resp.raise_for_status()
        _hourly_cache["data"] = resp.json().get("data", {})
        _hourly_cache["ts"] = now
    return _hourly_cache["data"]


def _get_5min():
    """/5m aggregates — the "currently active" signal.

    Returns {item_id_str: {avgHighPrice, highPriceVolume, avgLowPrice,
    lowPriceVolume}} reflecting the most recent 5-minute window. Used to flag
    items that have actually traded in the last few minutes vs items whose
    longer-window numbers come from a stale spike.
    """
    now = time.time()
    if _5min_cache["data"] is None or (now - _5min_cache["ts"]) > FIVE_MIN_TTL:
        resp = requests.get(f"{BASE_URL}/5m", headers=HEADERS, timeout=15)
        resp.raise_for_status()
        _5min_cache["data"] = resp.json().get("data", {})
        _5min_cache["ts"] = now
    return _5min_cache["data"]


def _get_daily():
    """24h aggregates — used as the baseline for anomaly detection.

    If the current insta-buy is wildly far from the 24h average, the displayed
    margin is probably a momentary spike that'll revert, not a real opportunity.
    Recomputing rogues metrics against the 24h average gives us a "sustainable"
    profit figure that the recommendation engine can rank on.
    """
    now = time.time()
    if _daily_cache["data"] is None or (now - _daily_cache["ts"]) > DAILY_TTL:
        resp = requests.get(f"{BASE_URL}/24h", headers=HEADERS, timeout=15)
        resp.raise_for_status()
        _daily_cache["data"] = resp.json().get("data", {})
        _daily_cache["ts"] = now
    return _daily_cache["data"]


def _build_payload() -> dict:
    prices = fetch_latest_prices()
    mapping = fetch_mapping()
    hourly = _get_hourly()
    recipes_out = []
    skipped = 0
    for r in RECIPES:
        m = calculate_recipe_margin(r, prices, mapping)
        if m is None:
            skipped += 1
            continue
        # Hourly trade volume of the *primary* output (first item). For
        # decanting recipes the secondary output is a returned vial, which
        # isn't really what you're "selling", so first-output volume is the
        # right liquidity signal.
        primary_out_id = None
        if m["output_lines"]:
            primary_out_id = m["output_lines"][0].get("item_id")
        out_hourly_volume = 0
        if primary_out_id is not None:
            hr = hourly.get(str(primary_out_id), {}) or {}
            out_hourly_volume = (
                (hr.get("highPriceVolume") or 0) + (hr.get("lowPriceVolume") or 0)
            )
        recipes_out.append(
            {
                "name": r.name,
                "category": r.category,
                "subcategory": r.subcategory,
                "isF2p": r.is_f2p,
                "xp": r.xp,
                "levelReq": r.level_req,
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
                "outputHourlyVolume": out_hourly_volume,
            }
        )

    # Recipe chain enrichment: for each recipe, find which of its inputs are
    # themselves produced by another recipe. The client uses this to show the
    # "full chain" expansion in the recipe detail view (e.g. yew longbow's
    # bow-string input is craftable from flax via the "Spin flax" recipe).
    # We only link 1-output recipes to avoid ambiguity with multi-output crafts.
    producers_by_item: dict[int, list[dict]] = {}
    for recipe in recipes_out:
        if len(recipe["outputs"]) != 1:
            continue
        out = recipe["outputs"][0]
        if out.get("item_id") is None:
            continue
        producers_by_item.setdefault(out["item_id"], []).append(
            {
                "recipeName": recipe["name"],
                "category": recipe["category"],
                "outputQty": out["qty"],
                "profit": recipe["profit"],
                "inputCost": recipe["inputCost"],
                "outputUnitPrice": out["unit_price"],
                "levelReq": recipe["levelReq"],
            }
        )
    for recipe in recipes_out:
        chain = []
        for inp in recipe["inputs"]:
            iid = inp.get("item_id")
            if iid is None:
                continue
            sources = producers_by_item.get(iid)
            if not sources:
                continue
            # Pick the most profitable producer if multiple exist.
            best = max(sources, key=lambda s: s["profit"])
            chain.append(
                {
                    "inputName": inp["name"],
                    "inputQty": inp["qty"],
                    "inputUnitPrice": inp["unit_price"],
                    "producer": best,
                }
            )
        recipe["chainSources"] = chain

    return {
        "strategy": MARGIN_STRATEGY,
        "fetchedAt": time.time(),
        "skipped": skipped,
        "recipes": recipes_out,
    }


def _get_payload(force: bool = False) -> dict:
    now = time.time()
    if (
        force
        or _cache["payload"] is None
        or (now - _cache["ts"]) > CACHE_TTL_SECONDS
    ):
        _cache["payload"] = _build_payload()
        _cache["ts"] = now
    return _cache["payload"]


@app.route("/api/recipes")
def get_recipes():
    return jsonify(_get_payload())


@app.route("/api/refresh", methods=["POST"])
def refresh():
    return jsonify(_get_payload(force=True))


@app.route("/api/items")
def list_items():
    """Slim full-item list for client-side search. ~4000 entries, ~350KB.

    Includes recentMovePct (1h volatility proxy) so the search UI can
    highlight items that are currently moving.
    """
    mapping = _get_mapping()
    latest = _get_latest()
    hourly = _get_hourly()
    items = []
    for it in mapping.values():
        item_id = it["id"]
        price = latest.get(str(item_id), {})
        buy = price.get("high")
        hr = hourly.get(str(item_id), {}) or {}
        hourly_avg = hr.get("avgHighPrice")
        move = None
        if buy is not None and hourly_avg and hourly_avg > 0:
            move = round((buy - hourly_avg) / hourly_avg * 100, 2)
        items.append(
            {
                "id": item_id,
                "name": it["name"],
                "members": it.get("members", False),
                "limit": it.get("limit"),
                "icon": it.get("icon"),
                "recentMovePct": move,
            }
        )
    items.sort(key=lambda x: x["name"].lower())
    return jsonify({"items": items, "count": len(items)})


@app.route("/api/item/<int:item_id>")
def item_detail(item_id: int):
    mapping = _get_mapping()
    info = mapping.get(item_id)
    if not info:
        return jsonify({"error": "unknown item"}), 404
    latest = _get_latest().get(str(item_id), {})
    hourly = _get_hourly().get(str(item_id), {}) or {}
    hourly_avg_high = hourly.get("avgHighPrice")
    move = None
    if latest.get("high") is not None and hourly_avg_high and hourly_avg_high > 0:
        move = round((latest["high"] - hourly_avg_high) / hourly_avg_high * 100, 2)
    hourly_volume = (hourly.get("highPriceVolume") or 0) + (hourly.get("lowPriceVolume") or 0)
    return jsonify(
        {
            "id": item_id,
            "name": info["name"],
            "examine": info.get("examine"),
            "members": info.get("members", False),
            "limit": info.get("limit"),
            "value": info.get("value"),
            "lowalch": info.get("lowalch"),
            "highalch": info.get("highalch"),
            "icon": info.get("icon"),
            "high": latest.get("high"),
            "highTime": latest.get("highTime"),
            "low": latest.get("low"),
            "lowTime": latest.get("lowTime"),
            "tax": calculate_ge_tax_safe(latest.get("high")),
            "recentMovePct": move,
            "hourlyVolume": hourly_volume,
        }
    )


def calculate_ge_tax_safe(price):
    if price is None or price < 50:
        return 0
    return min(price // 100, 5_000_000)


# Martin Thwait's Lost and Found — Rogues' Den shop pricing.
# Source: OSRS wiki. Buys items at 100% of highalch for the first sale,
# drops 2% per subsequent sale, floors at 60% of highalch. Stock decays
# 1 item / minute (irrelevant for per-session profit).
ROGUES_START_PCT = 1.00
ROGUES_STEP_PCT = 0.02
ROGUES_FLOOR_PCT = 0.60
ROGUES_FLOOR_SALE_INDEX = int((ROGUES_START_PCT - ROGUES_FLOOR_PCT) / ROGUES_STEP_PCT) + 1  # 21

# Real-world timings for the optimization. Each click sells one batch from
# the available sizes — you can't sell arbitrary counts, only multiples of
# 5 by combining "sell 5", "sell 10", and "sell 50" actions.
ROGUES_HOP_SECONDS = 10        # world hop + walk back to Martin
ROGUES_CLICK_SECONDS = 2       # per "sell X" click (regardless of batch size)
ROGUES_BATCH_SIZES = (50, 10, 5)


def _clicks_for_n_sales(n: int) -> int:
    """Greedy minimum clicks to sell exactly n items using batches of 5/10/50.

    Examples: 5 → 1 click, 10 → 1 click, 15 → 2, 20 → 2, 25 → 3, 50 → 1,
    55 → 2, 60 → 2. Only multiples of 5 are achievable.
    """
    clicks = 0
    remaining = n
    for batch in ROGUES_BATCH_SIZES:
        clicks += remaining // batch
        remaining %= batch
    return clicks


def _rogues_metrics(highalch: int, ge_buy: int, ge_limit: int | None) -> dict:
    """Compute Rogues' Den (Martin Thwait) profitability per item.

    Picks the *optimal* number of sales per session — the count that
    maximises gp/hour, accounting for: (a) the price drop of 2% per item
    sold, (b) the world-hop time to reset the shop, and (c) the fact that
    you can only sell in batches of 5/10/50 so click cost isn't linear in
    items sold (selling 50 takes one click, selling 45 takes five).

    Returns:
        sellsPerSession    optimal #items per session (multiple of 5)
        profitPerSession   gp earned in one optimised session
        alwaysProfitable   True if even the 60% floor still beats GE buy
        floorMargin        gp per sale at the floor (may be negative)
        totalProfit4hr     gp if you exhaust your 4hr GE buy limit
        optimalGpPerHr     realistic gp/hour at the optimal pace
    """
    floor_price = highalch * ROGUES_FLOOR_PCT
    floor_margin = floor_price - ge_buy
    always_profitable = floor_margin > 0

    # Margin for sales 1..21 (descent). Includes negatives — the optimizer
    # will simply not pick an N where it'd be uneconomical.
    descent_margins = [
        highalch * (ROGUES_START_PCT - ROGUES_STEP_PCT * (n - 1)) - ge_buy
        for n in range(1, ROGUES_FLOOR_SALE_INDEX + 1)
    ]

    def margin_at(n: int) -> float:
        """Margin for the nth sale (1-indexed). Sales > 21 stay at floor."""
        if n <= len(descent_margins):
            return descent_margins[n - 1]
        return floor_margin

    # If even the first sale is unprofitable, bail.
    if margin_at(1) <= 0:
        return {
            "sellsPerSession": 0,
            "profitPerSession": 0,
            "alwaysProfitable": False,
            "floorMargin": int(round(floor_margin)),
            "totalProfit4hr": 0,
            "optimalGpPerHr": 0,
        }

    HOP_S = ROGUES_HOP_SECONDS
    CLICK_S = ROGUES_CLICK_SECONDS

    # No-loss cap: only consider Ns where every single sale is still profitable.
    # Margins decrease monotonically, so as long as the Nth sale is profitable
    # all earlier ones are too. We refuse to recommend an N where even one
    # individual sale is at a loss, even if the aggregate gp/hr math says it'd
    # be marginally faster — that's psychologically uncomfortable and the
    # gp/hr edge is usually tiny.
    max_profitable_n = 0
    for n in range(5, 61, 5):  # check multiples of 5 only
        if always_profitable or margin_at(n) > 0:
            max_profitable_n = n
        else:
            break

    # Search achievable N values (multiples of 5) within the no-loss cap.
    best_n = 5
    best_gp_per_hr = 0.0
    best_profit = 0.0
    cumulative = 0.0
    for n in range(1, max_profitable_n + 1):
        cumulative += margin_at(n)
        if n % 5 != 0:
            continue  # only multiples of 5 are achievable with sell batches
        clicks = _clicks_for_n_sales(n)
        time_s = HOP_S + clicks * CLICK_S
        gp_per_hr = cumulative / time_s * 3600
        if gp_per_hr > best_gp_per_hr:
            best_gp_per_hr = gp_per_hr
            best_n = n
            best_profit = cumulative

    sells_per_session = best_n
    profit_per_session = best_profit
    optimal_gp_per_hr = best_gp_per_hr

    # Alternative: if the floor itself is profitable, you can skip world
    # hops entirely and just mass-sell 50 at a time at the floor rate.
    # Compare that steady-state rate against the session-hop optimum.
    if always_profitable:
        floor_only_gp_per_hr = 50 * floor_margin / CLICK_S * 3600
        if floor_only_gp_per_hr > optimal_gp_per_hr:
            optimal_gp_per_hr = floor_only_gp_per_hr

    # Total profit when you exhaust the 4hr GE buy limit (assumes ample
    # game time — the limit caps how many you can source, not how fast you
    # can offload them).
    if not ge_limit:
        total_4hr = profit_per_session
    elif always_profitable:
        # One long session: 21 descent + (limit-21) floor sales
        descent_count = min(ge_limit, len(descent_margins))
        descent_profit = sum(descent_margins[:descent_count])
        remaining = max(0, ge_limit - len(descent_margins))
        total_4hr = descent_profit + remaining * floor_margin
    else:
        # Session-hop using the optimal N.
        full_sessions = ge_limit // sells_per_session
        remainder_items = ge_limit % sells_per_session
        # Remainder rounded down to nearest 5 (only sellable counts).
        remainder_items -= remainder_items % 5
        remainder_profit = sum(margin_at(i) for i in range(1, remainder_items + 1))
        total_4hr = full_sessions * profit_per_session + remainder_profit

    # Margin of the LAST recommended sale — actionable per-sale info that
    # answers "if I sell N items, what does the Nth one net me?"
    last_sale_margin = margin_at(sells_per_session) if sells_per_session > 0 else 0

    return {
        "sellsPerSession": sells_per_session,
        "profitPerSession": int(round(profit_per_session)),
        "lastSaleMargin": int(round(last_sale_margin)),
        "alwaysProfitable": always_profitable,
        "floorMargin": int(round(floor_margin)),
        "totalProfit4hr": int(round(total_4hr)),
        "optimalGpPerHr": int(round(optimal_gp_per_hr)),
    }


@app.route("/api/flipping")
def flipping():
    """Live "buy low, sell high" candidates.

    For every item with both a current insta-buy (high) and insta-sell (low),
    compute:
      margin = high - low - GE tax(high)
      ROI    = margin / low  (percent)
      profit_at_limit = margin * GE 4hr limit

    Filtered to items with non-trivial margin AND meaningful hourly volume so
    pages aren't drowned by stale low-liquidity items. Returns the list sorted
    by profit-at-limit descending.
    """
    mapping = _get_mapping()
    latest = _get_latest()
    hourly = _get_hourly()
    fivemin = _get_5min()

    results = []
    for item_id_str, price_data in latest.items():
        try:
            item_id = int(item_id_str)
        except ValueError:
            continue
        info = mapping.get(item_id)
        if not info:
            continue
        high = price_data.get("high")
        low = price_data.get("low")
        if high is None or low is None or high <= low:
            continue
        limit = info.get("limit")
        hr = hourly.get(item_id_str, {}) or {}
        volume = (hr.get("highPriceVolume") or 0) + (hr.get("lowPriceVolume") or 0)
        # Skip items with effectively no liquidity — their prices are stale.
        if volume < 5:
            continue
        # Outlier protection: a single lucky/misclick trade can leave the
        # `high` from /latest wildly inflated (e.g. Snake hide normally
        # trades around 195 but one insta-sell hours ago hit 2000). Your
        # sell at that price will never fill.
        #
        # Reference price (in priority order):
        #   1. avgHighPrice — buyers actually paid this in the last hour
        #   2. avgLowPrice  — sellers accepted this when no buys happened
        #   3. /latest low  — last resort, the most recent insta-sell
        # Anything more than 1.5x the reference is treated as an outlier
        # and capped to the reference itself (NOT 1.5x — the realistic
        # market clearing price is the reference, not a generous multiple).
        hourly_avg_high = hr.get("avgHighPrice")
        hourly_avg_low = hr.get("avgLowPrice")
        reference_price = hourly_avg_high or hourly_avg_low or low
        sanity_capped = False
        effective_high = high
        if reference_price and reference_price > 0 and high > reference_price * 1.5:
            effective_high = int(round(reference_price))
            sanity_capped = True
        if effective_high <= low:
            continue
        tax = calculate_ge_tax_safe(effective_high)
        margin = effective_high - low - tax
        if margin <= 0:
            continue
        roi = (margin / low) * 100 if low > 0 else 0
        profit_at_limit = margin * limit if limit else None
        recent_move_pct = None
        if hourly_avg_high and hourly_avg_high > 0:
            recent_move_pct = round((high - hourly_avg_high) / hourly_avg_high * 100, 2)
        fm = fivemin.get(item_id_str, {}) or {}
        recent_5m_volume = (fm.get("highPriceVolume") or 0) + (fm.get("lowPriceVolume") or 0)
        results.append(
            {
                "id": item_id,
                "name": info["name"],
                "members": info.get("members", False),
                "high": high,
                "effectiveHigh": effective_high,
                "low": low,
                "margin": margin,
                "tax": tax,
                "roi": round(roi, 2),
                "limit": limit,
                "hourlyVolume": volume,
                "profitAtLimit": profit_at_limit,
                "recentMovePct": recent_move_pct,
                "sanityCapped": sanity_capped,
                "highTime": price_data.get("highTime"),
                "lowTime": price_data.get("lowTime"),
                "recent5mVolume": recent_5m_volume,
            }
        )
    results.sort(key=lambda r: r.get("profitAtLimit") or 0, reverse=True)
    return jsonify({"items": results, "count": len(results)})


@app.route("/api/highalch")
def high_alch():
    """Best items to high alch right now, plus Rogues' Den metrics.

    profit_per_alch = highalch - insta_buy_price - nature_rune_price
    Filters out items with no high alch value or no current insta-buy price.
    Rogues' Den fields are present on every row; filter on roguesProfitPerSession > 0
    client-side to surface good Rogues' candidates.
    """
    mapping = _get_mapping()
    latest = _get_latest()
    hourly = _get_hourly()
    daily = _get_daily()
    fivemin = _get_5min()

    nature_entry = latest.get(str(NATURE_RUNE_ID), {})
    nature_price = nature_entry.get("high") or nature_entry.get("low") or 0

    # Iterate the full /mapping so items missing from /latest (no very recent
    # trades) can still appear if at least one side of a price is available.
    # For the buy side, prefer `high` (the actual insta-buy you'd pay) but
    # fall back to `low` when only that's quoted — that's slightly optimistic
    # but better than dropping the row entirely.
    results = []
    for item_id, info in mapping.items():
        highalch = info.get("highalch")
        if not highalch or highalch <= 0:
            continue
        item_id_str = str(item_id)
        price_data = latest.get(item_id_str, {}) or {}
        high = price_data.get("high")
        low = price_data.get("low")
        buy_price = high if high is not None else low
        if buy_price is None:
            continue  # no GE quote at all — can't compute profit
        profit_per = highalch - buy_price - nature_price
        limit = info.get("limit")
        hr = hourly.get(item_id_str, {}) or {}
        volume = (hr.get("highPriceVolume") or 0) + (hr.get("lowPriceVolume") or 0)
        total_profit_at_limit = profit_per * limit if limit else None
        rogues = _rogues_metrics(highalch, buy_price, limit)
        # Include the row if EITHER method is profitable. Straight high-alch
        # burns a nature rune per cast, so an item priced above (alch − nature)
        # loses money via high alch but can still profit at Martin Thwait's
        # shop (no rune cost, pays full alch on the first sale). The frontend
        # mode filter then shows only items profitable in the active mode.
        if profit_per <= 0 and rogues["profitPerSession"] <= 0:
            continue

        # Volatility proxy: how far has the current insta-buy moved from the
        # average insta-buy of the last hour? Positive = price spiking up,
        # negative = price diving. Free (uses /1h which is already cached).
        hourly_avg_high = hr.get("avgHighPrice")
        if hourly_avg_high and hourly_avg_high > 0:
            recent_move_pct = round((buy_price - hourly_avg_high) / hourly_avg_high * 100, 2)
        else:
            recent_move_pct = None

        # Anomaly detection: recompute the Rogues' Den metrics against the
        # 24h-average insta-buy price. If the item is still profitable at that
        # baseline, the current margin is "sustainable" and not a spike. If
        # the rec engine ranks by `sustainableGpPerHr` instead of `roguesGpPerHr`,
        # it stops being fooled by momentary insta-sell crashes that look juicy
        # for ~10 minutes and then disappear.
        daily_entry = daily.get(item_id_str, {}) or {}
        daily_avg_high = daily_entry.get("avgHighPrice")
        if daily_avg_high and daily_avg_high > 0:
            price_vs_24h_pct = round((buy_price - daily_avg_high) / daily_avg_high * 100, 2)
            sustainable = _rogues_metrics(highalch, int(daily_avg_high), limit)
            sustainable_profit = sustainable["profitPerSession"]
            sustainable_gp_per_hr = sustainable["optimalGpPerHr"]
            sustainable_alch_profit = highalch - daily_avg_high - nature_price
        else:
            price_vs_24h_pct = None
            sustainable_profit = None
            sustainable_gp_per_hr = None
            sustainable_alch_profit = None

        # Volume-bound "realistic" gp/hr.
        #
        # The theoretical optimalGpPerHr assumes you can always source N items
        # per session, but if N=50 and only 200 items trade per hour total, you
        # can only run 4 sessions/hour realistically, not the click-bound 300.
        # We cap the displayed gp/hr by the rate at which the market actually
        # turns over the item. We use the 24h volume (averaged to per-hour) for
        # stability — the /1h figure is too spiky to make ranking decisions on.
        daily_total_vol_24h = (
            (daily_entry.get("highPriceVolume") or 0)
            + (daily_entry.get("lowPriceVolume") or 0)
        )
        daily_vol_per_hr = daily_total_vol_24h / 24.0 if daily_total_vol_24h else 0
        sells_per_session = rogues["sellsPerSession"]
        if sells_per_session > 0 and daily_vol_per_hr > 0 and rogues["profitPerSession"] > 0:
            # How many sessions per hour the market actually supports
            volume_bound_sessions_per_hr = daily_vol_per_hr / sells_per_session
            volume_bound_gp_per_hr = volume_bound_sessions_per_hr * rogues["profitPerSession"]
            realistic_gp_per_hr = min(rogues["optimalGpPerHr"], volume_bound_gp_per_hr)
            # True = the volume cap is the bottleneck, not click speed; useful UI hint
            volume_bottlenecked = volume_bound_gp_per_hr < rogues["optimalGpPerHr"]
        else:
            realistic_gp_per_hr = 0
            volume_bottlenecked = False

        # Sustainable + volume-realistic gp/hr. Same volume cap applied to the
        # sustainable (24h-price) profit per session — protects against the
        # "phantom profit AND can't actually source it" combo.
        if (
            sustainable_profit
            and sustainable_profit > 0
            and sells_per_session > 0
            and daily_vol_per_hr > 0
            and sustainable_gp_per_hr
        ):
            sust_vol_bound = (daily_vol_per_hr / sells_per_session) * sustainable_profit
            sustainable_realistic_gp_per_hr = min(sustainable_gp_per_hr, sust_vol_bound)
        else:
            sustainable_realistic_gp_per_hr = 0

        # ============================================================
        # Two-phase model: A = insta-buy during active session, B = patient
        # GE offer placed while logged off (3-4 hr fill window).
        # ============================================================
        # Phase A uses the current `high` price (insta-buy) — same as the
        # base `rogues*` fields above. We mirror them under `phaseA*` names so
        # the lab UI can reason about both phases symmetrically.
        phase_a_buy_price = buy_price
        phase_a = rogues
        phase_a_realistic_gp_per_hr = realistic_gp_per_hr

        # Phase B uses `avg24hLow` — the insta-sell price averaged over 24h,
        # which is approximately what a patient GE buy offer will fill at.
        daily_avg_low = daily_entry.get("avgLowPrice")
        phase_b_buy_price = int(daily_avg_low) if daily_avg_low and daily_avg_low > 0 else None
        if phase_b_buy_price and phase_b_buy_price > 0:
            phase_b = _rogues_metrics(highalch, phase_b_buy_price, limit)
            phase_b_alch_profit = highalch - phase_b_buy_price - nature_price
            # Phase B's volume constraint is much weaker than Phase A's — orders
            # have hours to fill, not seconds. We still compute a volume-aware
            # gp/hr but use a longer window (24h volume directly, not /hour).
            # The constraint check is: "will the user's order fill in their 3-4hr
            # offline window?" — i.e., does 24h volume comfortably exceed N?
            # If yes, use the theoretical gp/hr. If no, scale down.
            pb_sells = phase_b["sellsPerSession"]
            if pb_sells > 0 and daily_total_vol_24h > 0:
                # Required items per offline cycle (assume user runs 4 sessions/day
                # so ~6h between cycles is conservative; the 24h volume should cover
                # ~4 * N of them in a day on average).
                items_per_day_needed = pb_sells * 4
                if daily_total_vol_24h >= items_per_day_needed:
                    phase_b_realistic_gp_per_hr = phase_b["optimalGpPerHr"]
                else:
                    # Throttle by fill probability
                    fill_ratio = daily_total_vol_24h / items_per_day_needed
                    phase_b_realistic_gp_per_hr = phase_b["optimalGpPerHr"] * fill_ratio
            else:
                phase_b_realistic_gp_per_hr = 0
        else:
            phase_b = None
            phase_b_alch_profit = None
            phase_b_realistic_gp_per_hr = 0

        # Spread: how wide is the bid-ask right now? Tight spread → Phase A
        # gains nothing by waiting. Wide spread → Phase B captures the gap.
        if high is not None and low is not None and low > 0:
            spread_pct = round((high - low) / low * 100, 2)
        else:
            spread_pct = None

        # Phase C — limit-cadence cycling. Items that fill near-instantly at
        # the insta-buy price (same buy price as Phase A) but where the GE
        # 4-hour buy limit, not market volume, is the binding constraint.
        # The user logs in every ~4 hours to refresh inventory up to the
        # limit, cycles via Rogues' Den, logs out.
        #
        # Daily ceiling = 4 cycles × limit × avg-profit-per-item (at Phase A
        # buy price, optimal N). This is *independent* of how many hours the
        # user is active — they hit the limit fast and then have to wait.
        phase_c_buy_price = phase_a_buy_price
        if (
            limit
            and phase_a["sellsPerSession"] > 0
            and phase_a["profitPerSession"] > 0
        ):
            phase_a_avg_profit_per_item = (
                phase_a["profitPerSession"] / phase_a["sellsPerSession"]
            )
            phase_c_items_per_cycle = limit
            phase_c_profit_per_cycle = int(round(phase_a_avg_profit_per_item * limit))
            phase_c_daily_profit = phase_c_profit_per_cycle * 4
        else:
            phase_c_items_per_cycle = None
            phase_c_profit_per_cycle = None
            phase_c_daily_profit = None

        # Suggested phase: which strategy makes the most sense for this item?
        # Decision is based on daily profit, assuming a default active window
        # of 1 hour/day server-side (the lab tab re-classifies client-side
        # using the user's actual `hoursActive` setting).
        #
        # Three options compared:
        #   - Phase A daily = realistic_gp_per_hr × 1h (volume-bound active cycling)
        #   - Phase B daily = phase_b_realistic_gp_per_hr × 1h (patient-offer + active selling)
        #   - Phase C daily = 4 × limit × avg-profit-per-item (limit-bound, time-independent)
        #
        # Phase C "wins" against A when limit binds before volume does. Phase B
        # wins when its patience premium exceeds the active model by ≥30%.
        DEFAULT_HOURS_ACTIVE = 1
        suggested_phase = None
        suggested_phase_reason = None
        phase_a_daily = realistic_gp_per_hr * DEFAULT_HOURS_ACTIVE
        phase_b_daily = (
            phase_b_realistic_gp_per_hr * DEFAULT_HOURS_ACTIVE
            if phase_b_realistic_gp_per_hr
            else 0
        )
        phase_c_daily = phase_c_daily_profit or 0

        # The active-cycling outcome is constrained by whichever ceiling
        # binds first: Phase A's market-volume ceiling or Phase C's GE-limit
        # ceiling. They're the same strategy (insta-buy active cycling) with
        # different limiting factors — we use the lower one as the achievable
        # daily profit and label the item accordingly.
        if phase_a_daily > 0 and phase_c_daily > 0:
            if phase_c_daily < phase_a_daily:
                active_daily = phase_c_daily
                active_phase = "C"
                active_reason = (
                    f"GE 4hr buy limit ({limit}/cycle) binds before market volume; "
                    f"cycle on the 4-hour cadence"
                )
            else:
                active_daily = phase_a_daily
                active_phase = "A"
                active_reason = "Volume-bound active cycling at insta-buy price"
        elif phase_c_daily > 0:
            # No usable volume data, but we know the GE limit and the item
            # is profitable per session → fall back to Phase C estimation.
            active_daily = phase_c_daily
            active_phase = "C"
            active_reason = (
                f"Limit-cadence cycling ({limit}/cycle, 4× daily); volume data sparse"
            )
        elif phase_a_daily > 0:
            active_daily = phase_a_daily
            active_phase = "A"
            active_reason = "Volume-bound active cycling at insta-buy price"
        else:
            active_daily = 0
            active_phase = None
            active_reason = None

        # Compare patient (B) vs best-active (A or C)
        if phase_b_daily > 0 and active_daily > 0:
            if phase_b_daily >= active_daily * 1.30:
                suggested_phase = "B"
                gain_pct = round((phase_b_daily / active_daily - 1) * 100)
                suggested_phase_reason = (
                    f"Patient offer captures +{gain_pct}% more daily profit vs active cycling"
                )
            elif spread_pct is not None and spread_pct < 3:
                suggested_phase = active_phase
                suggested_phase_reason = (
                    f"Spread is tight ({spread_pct}%) — no patience premium worth waiting for. "
                    + (active_reason or "")
                )
            else:
                suggested_phase = active_phase
                suggested_phase_reason = active_reason
        elif active_daily > 0:
            suggested_phase = active_phase
            suggested_phase_reason = active_reason
        elif phase_b_daily > 0:
            suggested_phase = "B"
            suggested_phase_reason = "Only profitable via patient GE offer at typical low"

        # Buy-limit headroom: how many sessions of N items can you cycle before
        # hitting the 4-hour GE buy limit? If > "sessions per active period"
        # (~80 for a 20-min session) the limit isn't binding.
        if limit and sells_per_session > 0:
            buy_limit_sessions = limit // sells_per_session
        else:
            buy_limit_sessions = None

        results.append(
            {
                "id": item_id,
                "name": info["name"],
                "members": info.get("members", False),
                "highalch": highalch,
                "buyPrice": buy_price,
                "lowPrice": price_data.get("low"),
                "natureRunePrice": nature_price,
                "profitPerAlch": profit_per,
                "limit": limit,
                "hourlyVolume": volume,
                "totalProfitAtLimit": total_profit_at_limit,
                "icon": info.get("icon"),
                "roguesSellsPerSession": rogues["sellsPerSession"],
                "roguesProfitPerSession": rogues["profitPerSession"],
                "roguesLastSaleMargin": rogues["lastSaleMargin"],
                "roguesAlwaysProfitable": rogues["alwaysProfitable"],
                "roguesFloorMargin": rogues["floorMargin"],
                "roguesTotalProfit4hr": rogues["totalProfit4hr"],
                "roguesGpPerHr": rogues["optimalGpPerHr"],
                "recentMovePct": recent_move_pct,
                "avg24hBuyPrice": int(daily_avg_high) if daily_avg_high else None,
                "priceVs24hPct": price_vs_24h_pct,
                "sustainableRoguesProfit": sustainable_profit,
                "sustainableRoguesGpPerHr": sustainable_gp_per_hr,
                "sustainableAlchProfit": sustainable_alch_profit,
                "realisticRoguesGpPerHr": int(round(realistic_gp_per_hr)),
                "sustainableRealisticGpPerHr": int(round(sustainable_realistic_gp_per_hr)),
                "dailyVolumePerHr": int(round(daily_vol_per_hr)),
                "volumeBottlenecked": volume_bottlenecked,
                # --- Two-phase trading model (insta-buy vs patient GE offer) ---
                "phaseABuyPrice": phase_a_buy_price,
                "phaseAProfitPerSession": phase_a["profitPerSession"],
                "phaseASellsPerSession": phase_a["sellsPerSession"],
                "phaseAGpPerHr": phase_a["optimalGpPerHr"],
                "phaseARealisticGpPerHr": int(round(phase_a_realistic_gp_per_hr)),
                "phaseBBuyPrice": phase_b_buy_price,
                "phaseBProfitPerSession": phase_b["profitPerSession"] if phase_b else None,
                "phaseBSellsPerSession": phase_b["sellsPerSession"] if phase_b else None,
                "phaseBGpPerHr": phase_b["optimalGpPerHr"] if phase_b else None,
                "phaseBRealisticGpPerHr": int(round(phase_b_realistic_gp_per_hr)),
                "phaseBLastSaleMargin": phase_b.get("lastSaleMargin") if phase_b else None,
                "phaseBAlchProfit": phase_b_alch_profit,
                "spreadPct": spread_pct,
                "suggestedPhase": suggested_phase,
                "suggestedPhaseReason": suggested_phase_reason,
                "buyLimitSessions": buy_limit_sessions,
                # Phase C — limit-cadence cycling (4× per day at GE buy-limit cap)
                "phaseCBuyPrice": phase_c_buy_price,
                "phaseCItemsPerCycle": phase_c_items_per_cycle,
                "phaseCProfitPerCycle": phase_c_profit_per_cycle,
                "phaseCDailyProfit": phase_c_daily_profit,
                # /latest freshness — when the most recent insta-buy / insta-sell
                # actually happened. The frontend computes "Last traded ago"
                # relative to the item's typical trade cadence.
                "highTime": price_data.get("highTime"),
                "lowTime": price_data.get("lowTime"),
                # /5m currently-active signal. recent5mVolume is total trades
                # in the past 5-min window; is5mActive is the convenience bool.
                "recent5mVolume": (
                    (fivemin.get(item_id_str, {}) or {}).get("highPriceVolume") or 0
                ) + (
                    (fivemin.get(item_id_str, {}) or {}).get("lowPriceVolume") or 0
                ),
            }
        )
    results.sort(key=lambda r: r["profitPerAlch"], reverse=True)
    return jsonify({"items": results, "natureRunePrice": nature_price, "count": len(results)})


# ---------------------------------------------------------------------------
# Shop arbitrage data — NPC shops with fixed prices, compared against live GE.
# Each entry: buy from this NPC at shop_price, sell on GE for (ge_low - tax).
# Margin can be negative; the frontend shows all rows so users can monitor as
# prices shift. stock_per_world is the baseline stock before world-hopping.
# ---------------------------------------------------------------------------
_SHOP_DATA = [
    # Baba Yaga's Magic Shop — Lunar Isle (Lunar Diplomacy quest)
    {"shop": "Baba Yaga's Magic Shop", "location": "Lunar Isle", "req": "Lunar Diplomacy",
     "items": [
         {"item_id": 9075, "item_name": "Astral rune",  "shop_price": 27,   "stock": 250},
         {"item_id": 560,  "item_name": "Death rune",   "shop_price": 99,   "stock": 250},
         {"item_id": 565,  "item_name": "Blood rune",   "shop_price": 220,  "stock": 250},
         {"item_id": 566,  "item_name": "Soul rune",    "shop_price": 165,  "stock": 250},
         {"item_id": 562,  "item_name": "Chaos rune",   "shop_price": 49,   "stock": 250},
         {"item_id": 1391, "item_name": "Battlestaff",  "shop_price": 3850, "stock": 5},
     ]},
    # Amlodd's Magical Supplies — Prifddinas (Song of the Elves)
    {"shop": "Amlodd's Magical Supplies", "location": "Prifddinas", "req": "Song of the Elves",
     "items": [
         {"item_id": 564,  "item_name": "Cosmic rune",  "shop_price": 50,   "stock": 250},
     ]},
    # Elgan's Exceptional Staffs! — Prifddinas (Song of the Elves)
    {"shop": "Elgan's Exceptional Staffs!", "location": "Prifddinas", "req": "Song of the Elves",
     "items": [
         {"item_id": 1381, "item_name": "Staff of air", "shop_price": 1500, "stock": 2},
     ]},
    # Ak-Haranu's Exotic Shop — Port Phasmatys (Ghosts Ahoy)
    # Price starts at 50gp and rises 2% per item as stock depletes from 500.
    {"shop": "Ak-Haranu's Exotic Shop", "location": "Port Phasmatys", "req": "Ghosts Ahoy",
     "items": [
         {"item_id": 4740, "item_name": "Bolt rack",    "shop_price": 50,   "stock": 500,
          "notes": "Base price 50gp; rises ~2gp/item sold — hop before it surpasses GE"},
     ]},
    # Contraband Yak Produce — Jatizso (Fremennik Isles quest + pay Vanligga's tax)
    {"shop": "Contraband Yak Produce", "location": "Jatizso", "req": "Fremennik Isles",
     "items": [
         {"item_id": 10818, "item_name": "Yak-hide",       "shop_price": 55,  "stock": 25},
         {"item_id": 10816, "item_name": "Raw yak meat",   "shop_price": 2,   "stock": 50},
         {"item_id": 10814, "item_name": "Hair",           "shop_price": 2,   "stock": 50},
         {"item_id": 10820, "item_name": "Cured yak-hide", "shop_price": 110, "stock": 10},
     ]},
    # Weapons Galore — Jatizso (Fremennik Isles)
    {"shop": "Weapons Galore", "location": "Jatizso", "req": "Fremennik Isles",
     "items": [
         {"item_id": 3099, "item_name": "Mithril claws", "shop_price": 522, "stock": 4},
     ]},
    # Frankie's Fishing Emporium — Port Piscarilius (no quest required)
    {"shop": "Frankie's Fishing Emporium", "location": "Port Piscarilius", "req": "None",
     "items": [
         {"item_id": 383, "item_name": "Raw shark",     "shop_price": 170, "stock": 25},
         {"item_id": 371, "item_name": "Raw swordfish", "shop_price": 80,  "stock": 50},
         {"item_id": 377, "item_name": "Raw lobster",   "shop_price": 70,  "stock": 50},
         {"item_id": 359, "item_name": "Raw tuna",      "shop_price": 40,  "stock": 100},
         {"item_id": 353, "item_name": "Raw mackerel",  "shop_price": 15,  "stock": 250},
     ]},
    # Obli's General Store — Shilo Village (Shilo Village quest)
    {"shop": "Obli's General Store", "location": "Shilo Village", "req": "Shilo Village quest",
     "items": [
         {"item_id": 973, "item_name": "Charcoal", "shop_price": 67, "stock": 50},
         {"item_id": 970, "item_name": "Papyrus",  "shop_price": 15, "stock": 50},
         {"item_id": 975, "item_name": "Machete",  "shop_price": 60, "stock": 50},
     ]},
    # Jiminua's Jungle Store — Tai Bwo Wannai, Karamja (no quest required)
    {"shop": "Jiminua's Jungle Store", "location": "Tai Bwo Wannai", "req": "None",
     "items": [
         {"item_id": 973, "item_name": "Charcoal",      "shop_price": 58,  "stock": 50},
         {"item_id": 970, "item_name": "Papyrus",       "shop_price": 13,  "stock": 50},
         {"item_id": 175, "item_name": "Antipoison(3)", "shop_price": 374, "stock": 10},
     ]},
    # Lletya Seamstress — Lletya, Tirannwn (partial Elf quest access)
    {"shop": "Lletya Seamstress", "location": "Lletya", "req": "Mourning's End Part I access",
     "items": [
         {"item_id": 1763, "item_name": "Red dye",    "shop_price": 6, "stock": 10},
         {"item_id": 1765, "item_name": "Yellow dye", "shop_price": 6, "stock": 10},
         {"item_id": 1767, "item_name": "Blue dye",   "shop_price": 6, "stock": 10},
         {"item_id": 1769, "item_name": "Orange dye", "shop_price": 6, "stock": 10},
         {"item_id": 1771, "item_name": "Green dye",  "shop_price": 6, "stock": 10},
         {"item_id": 1773, "item_name": "Purple dye", "shop_price": 6, "stock": 10},
     ]},
    # Guinevere's Dyes — Prifddinas, Ithell district (Song of the Elves)
    # Same items as Lletya Seamstress — second world-hoppable source
    {"shop": "Guinevere's Dyes", "location": "Prifddinas", "req": "Song of the Elves",
     "items": [
         {"item_id": 1763, "item_name": "Red dye",    "shop_price": 6, "stock": 10},
         {"item_id": 1765, "item_name": "Yellow dye", "shop_price": 6, "stock": 10},
         {"item_id": 1767, "item_name": "Blue dye",   "shop_price": 6, "stock": 10},
         {"item_id": 1769, "item_name": "Orange dye", "shop_price": 6, "stock": 10},
         {"item_id": 1771, "item_name": "Green dye",  "shop_price": 6, "stock": 10},
         {"item_id": 1773, "item_name": "Purple dye", "shop_price": 6, "stock": 10},
     ]},
    # Stonemason — Keldagrim (started The Giant Dwarf)
    # Also: Stonecutter Outpost in Varlamore sells the same items at the same prices.
    {"shop": "Stonemason", "location": "Keldagrim", "req": "Started The Giant Dwarf",
     "items": [
         {"item_id": 3420,  "item_name": "Limestone brick", "shop_price": 26,        "stock": 1000},
         {"item_id": 8784,  "item_name": "Gold leaf",       "shop_price": 130_000,   "stock": 20},
         {"item_id": 8786,  "item_name": "Marble block",    "shop_price": 325_000,   "stock": 20},
         {"item_id": 8788,  "item_name": "Magic stone",     "shop_price": 975_000,   "stock": 10},
         {"item_id": 26266, "item_name": "Condensed gold",  "shop_price": 10_400_000,"stock": 10},
     ]},
    # Garden Centre — Falador Park + Farming Guild (Farming Guild needs 45 Farming + Hosidius)
    # Two instances of the shop = 2× stock per hop cycle (40 of each item per world)
    {"shop": "Garden Centre", "location": "Falador / Farming Guild", "req": "None (45 Farm for Guild)",
     "items": [
         {"item_id": 8417, "item_name": "Bagged dead tree",         "shop_price": 1000,   "stock": 40, "notes": "2 shops per world (Falador + Guild)"},
         {"item_id": 8419, "item_name": "Bagged nice tree",         "shop_price": 2000,   "stock": 40},
         {"item_id": 8421, "item_name": "Bagged oak tree",          "shop_price": 5000,   "stock": 40},
         {"item_id": 8423, "item_name": "Bagged willow tree",       "shop_price": 10000,  "stock": 40},
         {"item_id": 8425, "item_name": "Bagged maple tree",        "shop_price": 15000,  "stock": 40},
         {"item_id": 8427, "item_name": "Bagged yew tree",          "shop_price": 20000,  "stock": 40},
         {"item_id": 8429, "item_name": "Bagged magic tree",        "shop_price": 50000,  "stock": 40},
         {"item_id": 8431, "item_name": "Bagged plant 1",           "shop_price": 1000,   "stock": 40},
         {"item_id": 8433, "item_name": "Bagged plant 2",           "shop_price": 5000,   "stock": 40},
         {"item_id": 8435, "item_name": "Bagged plant 3",           "shop_price": 10000,  "stock": 40},
         {"item_id": 8437, "item_name": "Thorny hedge (bagged)",    "shop_price": 5000,   "stock": 40},
         {"item_id": 8439, "item_name": "Nice hedge (bagged)",      "shop_price": 10000,  "stock": 40},
         {"item_id": 8441, "item_name": "Small box hedge (bagged)", "shop_price": 15000,  "stock": 40},
         {"item_id": 8443, "item_name": "Topiary hedge (bagged)",   "shop_price": 20000,  "stock": 40},
         {"item_id": 8445, "item_name": "Fancy hedge (bagged)",     "shop_price": 25000,  "stock": 40},
         {"item_id": 8447, "item_name": "Tall fancy hedge (bagged)","shop_price": 50000,  "stock": 40},
         {"item_id": 8449, "item_name": "Tall box hedge (bagged)",  "shop_price": 100000, "stock": 40},
         {"item_id": 8451, "item_name": "Bagged flower",            "shop_price": 5000,   "stock": 40},
         {"item_id": 8453, "item_name": "Bagged daffodils",         "shop_price": 10000,  "stock": 40},
         {"item_id": 8455, "item_name": "Bagged bluebells",         "shop_price": 15000,  "stock": 40},
         {"item_id": 8457, "item_name": "Bagged sunflower",         "shop_price": 5000,   "stock": 40},
         {"item_id": 8459, "item_name": "Bagged marigolds",         "shop_price": 10000,  "stock": 40},
         {"item_id": 8461, "item_name": "Bagged roses",             "shop_price": 15000,  "stock": 40},
     ]},
    # Dargaud's Bows and Arrows (Ranging Guild, 40 Ranged) +
    # Hickton's Archery Emporium (Catherby, no req) — same prices, two world-hop sources
    {"shop": "Dargaud's / Hickton's", "location": "Ranging Guild + Catherby", "req": "40 Ranged (Dargaud's only)",
     "items": [
         {"item_id": 39, "item_name": "Bronze arrowtips", "shop_price": 1,   "stock": 1500},
         {"item_id": 40, "item_name": "Iron arrowtips",   "shop_price": 2,   "stock": 1200},
         {"item_id": 41, "item_name": "Steel arrowtips",  "shop_price": 6,   "stock": 900},
         {"item_id": 42, "item_name": "Mithril arrowtips","shop_price": 16,  "stock": 600},
         {"item_id": 43, "item_name": "Adamant arrowtips","shop_price": 40,  "stock": 400},
         {"item_id": 44, "item_name": "Rune arrowtips",   "shop_price": 200, "stock": 250},
     ]},
    # Lliann's Wares — Prifddinas, Ithell district (Song of the Elves)
    {"shop": "Lliann's Wares", "location": "Prifddinas", "req": "Song of the Elves",
     "items": [
         {"item_id": 24003, "item_name": "Elven boots",        "shop_price": 10000, "stock": 50},
         {"item_id": 24006, "item_name": "Elven gloves",       "shop_price": 10000, "stock": 50},
         {"item_id": 24009, "item_name": "Elven top (yellow)", "shop_price": 5000,  "stock": 100},
         {"item_id": 24012, "item_name": "Elven skirt (yellow)","shop_price": 5000, "stock": 100},
         {"item_id": 24015, "item_name": "Elven top (white)",  "shop_price": 5000,  "stock": 100},
         {"item_id": 24018, "item_name": "Elven skirt (white)","shop_price": 5000,  "stock": 100},
     ]},
    # Artima's Crafting Supplies — Civitas illa Fortis, Varlamore (no requirement)
    {"shop": "Artima's Crafting Supplies", "location": "Civitas illa Fortis", "req": "None",
     "items": [
         {"item_id": 1597,  "item_name": "Necklace mould",  "shop_price": 5,   "stock": 4},
         {"item_id": 11065, "item_name": "Bracelet mould",  "shop_price": 5,   "stock": 4},
         {"item_id": 1595,  "item_name": "Amulet mould",    "shop_price": 5,   "stock": 4},
         {"item_id": 1592,  "item_name": "Ring mould",      "shop_price": 5,   "stock": 4},
         {"item_id": 5523,  "item_name": "Tiara mould",     "shop_price": 100, "stock": 4},
     ]},
    # Lidio's Fine Groceries — Warriors' Guild (130 combined Attack+Strength or 99 in either)
    {"shop": "Lidio's Fine Groceries", "location": "Warriors' Guild", "req": "130 Attack+Strength",
     "items": [
         {"item_id": 2289, "item_name": "Plain pizza",        "shop_price": 48, "stock": 5},
         {"item_id": 6705, "item_name": "Potato with cheese", "shop_price": 9,  "stock": 10},
     ]},
    # Aleck's Hunter Emporium — Yanille (no requirement)
    {"shop": "Aleck's Hunter Emporium", "location": "Yanille", "req": "None",
     "items": [
         {"item_id": 10025, "item_name": "Magic box", "shop_price": 720, "stock": 30},
     ]},
    # Darkmeyer Meat Shop — Darkmeyer (Sins of the Father + Vyre noble clothing)
    {"shop": "Darkmeyer Meat Shop", "location": "Darkmeyer", "req": "Sins of the Father + Vyre clothing",
     "items": [
         {"item_id": 24782, "item_name": "Raw mystery meat", "shop_price": 1, "stock": 25},
         {"item_id": 2136,  "item_name": "Raw bear meat",    "shop_price": 1, "stock": 10},
     ]},
    # Aurel's Supplies — Burgh de Rott (In Aid of the Myreque)
    {"shop": "Aurel's Supplies", "location": "Burgh de Rott", "req": "In Aid of the Myreque",
     "items": [
         {"item_id": 3363, "item_name": "Thin snail", "shop_price": 6, "stock": 10},
     ]},
    # Sawmill / Construction Supplies — Lumber Yard Varrock + 3 other locations (no req)
    {"shop": "Sawmill Operator", "location": "Lumber Yard (Varrock) + 3 others", "req": "None",
     "items": [
         {"item_id": 1539, "item_name": "Steel nails", "shop_price": 3, "stock": 1000,
          "notes": "4 world-hoppable shop locations"},
     ]},
    # Zaff's Superior Staffs! — Varrock (Varrock Diary for higher daily limits)
    # Daily allotment (personal per-account limit, not world-shared stock)
    {"shop": "Zaff's Superior Staffs!", "location": "Varrock", "req": "Varrock Diary (any tier)",
     "items": [
         {"item_id": 1391, "item_name": "Battlestaff", "shop_price": 7000, "stock": 120,
          "notes": "Daily personal limit: 15 (Easy) / 30 (Med) / 60 (Hard) / 120 (Elite diary)"},
     ]},
]

# Flatten shop data into a single list for the endpoint.
SHOP_ITEMS = []
for _shop in _SHOP_DATA:
    for _item in _shop["items"]:
        SHOP_ITEMS.append({
            "shop":       _shop["shop"],
            "location":   _shop["location"],
            "req":        _shop["req"],
            "item_id":    _item["item_id"],
            "item_name":  _item["item_name"],
            "shop_price": _item["shop_price"],
            "stock":      _item["stock"],
            "notes":      _item.get("notes", ""),
        })

_shops_cache: dict = {"payload": None, "ts": 0.0}
SHOPS_TTL = 60  # refresh live GE prices every 60 s


@app.route("/api/shops")
def shops():
    """NPC shop arbitrage — buy from shop, sell on GE.

    Returns every tracked shop item with its current GE sell price and margin.
    Margin can be negative (item currently not profitable) — the frontend shows
    all rows so the user can monitor as GE prices shift.
    """
    now = time.time()
    cached = _shops_cache["payload"]
    if cached and (now - _shops_cache["ts"]) < SHOPS_TTL:
        return jsonify(cached)

    latest = _get_latest()
    hourly = _get_hourly()

    results = []
    for s in SHOP_ITEMS:
        item_id = s["item_id"]
        price_data = latest.get(str(item_id), {}) or {}
        # Use "low" (insta-sell, what you'd actually get right now) as the
        # conservative GE sell price.  Fall back to "high" if low is absent.
        ge_sell = price_data.get("low") or price_data.get("high")
        ge_high = price_data.get("high")

        hr = hourly.get(str(item_id), {}) or {}
        volume = (hr.get("highPriceVolume") or 0) + (hr.get("lowPriceVolume") or 0)

        if ge_sell:
            tax = calculate_ge_tax_safe(ge_sell)
            net_sell = ge_sell - tax
            margin = net_sell - s["shop_price"]
            roi = round((margin / s["shop_price"]) * 100, 1) if s["shop_price"] > 0 else None
        else:
            tax = net_sell = margin = roi = None

        results.append({
            "shop":       s["shop"],
            "location":   s["location"],
            "req":        s["req"],
            "itemId":     item_id,
            "itemName":   s["item_name"],
            "shopPrice":  s["shop_price"],
            "stock":      s["stock"],
            "notes":      s["notes"],
            "geSell":     ge_sell,
            "geHigh":     ge_high,
            "tax":        tax,
            "netSell":    net_sell,
            "margin":     margin,
            "roi":        roi,
            "hourlyVolume": volume,
        })

    results.sort(key=lambda r: r["margin"] if r["margin"] is not None else -999999, reverse=True)
    payload = {"items": results, "count": len(results)}
    _shops_cache["payload"] = payload
    _shops_cache["ts"] = now
    return jsonify(payload)


@app.route("/api/timeseries/<int:item_id>")
def get_timeseries(item_id: int):
    timestep = request.args.get("timestep", "5m")
    if timestep not in VALID_TIMESTEPS:
        return jsonify({"error": f"invalid timestep, must be one of {sorted(VALID_TIMESTEPS)}"}), 400
    key = (item_id, timestep)
    now = time.time()
    cached = _ts_cache.get(key)
    if cached and (now - cached[1]) < TIMESERIES_TTL:
        return jsonify(cached[0])
    try:
        resp = requests.get(
            f"{BASE_URL}/timeseries",
            params={"id": item_id, "timestep": timestep},
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return jsonify({"error": f"upstream error: {e}"}), 502
    _ts_cache[key] = (data, now)
    return jsonify(data)


# ---------------------------------------------------------------------------
# Cross-device sync — Postgres-backed key/value store keyed by SHA-256 of a
# user-chosen passphrase. No accounts; the passphrase is the auth. Backend
# never sees the plaintext (frontend hashes client-side).
#
# Schema (single table):
#   passphrase_hash  TEXT primary key  (64 hex chars, lower)
#   data_json        TEXT              (the JSON blob — favorites, lists, etc.)
#   updated_at       TIMESTAMP
#
# Endpoints:
#   GET  /api/sync/<hash>           → {data, updatedAt} or {data: None, updatedAt: None}
#   POST /api/sync/<hash> {data}    → {updatedAt}
# ---------------------------------------------------------------------------

DATABASE_URL = os.environ.get("DATABASE_URL")
_db_schema_initialized = False
SYNC_MAX_PAYLOAD_BYTES = 1_000_000  # 1 MB — way more than this app will ever need


def _sync_enabled() -> bool:
    return DATABASE_URL is not None and psycopg2 is not None


def _open_db():
    """Open a fresh Postgres connection. Caller closes."""
    return psycopg2.connect(DATABASE_URL)


def _ensure_sync_schema() -> None:
    global _db_schema_initialized
    if _db_schema_initialized or not _sync_enabled():
        return
    conn = _open_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS sync_data (
                    passphrase_hash TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()
        _db_schema_initialized = True
    finally:
        conn.close()


def _valid_hash(h: str) -> bool:
    return (
        isinstance(h, str)
        and len(h) == 64
        and all(c in "0123456789abcdef" for c in h.lower())
    )


@app.route("/api/sync/<phash>", methods=["GET"])
def sync_get(phash: str):
    if not _valid_hash(phash):
        return jsonify({"error": "invalid hash format"}), 400
    if not _sync_enabled():
        return jsonify({"error": "sync not configured on this server"}), 503
    _ensure_sync_schema()
    conn = _open_db()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT data_json, updated_at FROM sync_data WHERE passphrase_hash = %s",
                (phash.lower(),),
            )
            row = cur.fetchone()
    finally:
        conn.close()
    if row is None:
        return jsonify({"data": None, "updatedAt": None})
    return jsonify(
        {
            "data": _json.loads(row["data_json"]),
            "updatedAt": row["updated_at"].isoformat(),
        }
    )


@app.route("/api/sync/<phash>", methods=["POST"])
def sync_post(phash: str):
    if not _valid_hash(phash):
        return jsonify({"error": "invalid hash format"}), 400
    if not _sync_enabled():
        return jsonify({"error": "sync not configured on this server"}), 503
    body = request.get_json(silent=True) or {}
    data = body.get("data")
    if data is None:
        return jsonify({"error": "missing data"}), 400
    payload = _json.dumps(data)
    if len(payload) > SYNC_MAX_PAYLOAD_BYTES:
        return jsonify({"error": "data too large"}), 413
    _ensure_sync_schema()
    conn = _open_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO sync_data (passphrase_hash, data_json, updated_at)
                VALUES (%s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (passphrase_hash) DO UPDATE
                SET data_json = EXCLUDED.data_json, updated_at = CURRENT_TIMESTAMP
                RETURNING updated_at
                """,
                (phash.lower(), payload),
            )
            updated_at = cur.fetchone()[0]
            conn.commit()
    finally:
        conn.close()
    return jsonify({"updatedAt": updated_at.isoformat()})


@app.route("/api/sync/status")
def sync_status():
    """Frontend probe — tells the UI whether sync is available on this server."""
    return jsonify({"enabled": _sync_enabled()})


# ---------------------------------------------------------------------------
# Inventory OCR — accepts an OSRS inventory screenshot, calls Claude vision,
# returns a structured list of {name, quantity} entries that the Stock
# Equalizer can use to auto-fill quantities.
# ---------------------------------------------------------------------------

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
# Cap inbound base64 image size at ~5MB encoded (Anthropic's effective limit).
OCR_MAX_BASE64_BYTES = 7_000_000
_anthropic_client = None


def _ocr_enabled() -> bool:
    return Anthropic is not None and ANTHROPIC_API_KEY is not None


def _get_anthropic():
    global _anthropic_client
    if _anthropic_client is None and _ocr_enabled():
        _anthropic_client = Anthropic(api_key=ANTHROPIC_API_KEY)
    return _anthropic_client


# Structured-output schema. Claude returns this via tool use so we get
# guaranteed parsable JSON, no regex/heuristics on free-form text.
_OCR_TOOL_SCHEMA = {
    "name": "report_inventory",
    "description": (
        "Report each item visible in the OSRS inventory screenshot. "
        "Use the exact in-game item name and expand any OSRS number "
        "abbreviations (10K, 1.5M, 1B) into integers."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": (
                                "Exact OSRS item name as it would appear in the GE "
                                "(e.g. 'Dragon arrowtips', 'Headless arrow', 'Rune arrow')."
                            ),
                        },
                        "quantity": {
                            "type": "integer",
                            "description": (
                                "Stack count as an integer. OSRS uses abbreviations: "
                                "'10K' -> 10000, '1.5M' -> 1500000, '1B' -> 1000000000. "
                                "An item with no visible number = 1."
                            ),
                            "minimum": 1,
                        },
                        "slot": {
                            "type": "integer",
                            "description": (
                                "1-indexed inventory slot (1-28), left to right, top to bottom. "
                                "Optional — include only if you can clearly determine position."
                            ),
                        },
                        "confidence": {
                            "type": "string",
                            "enum": ["high", "medium", "low"],
                            "description": (
                                "high = item icon and number both crisp; "
                                "medium = some ambiguity; "
                                "low = guessed or partially obscured."
                            ),
                        },
                    },
                    "required": ["name", "quantity"],
                },
            },
        },
        "required": ["items"],
    },
}

_OCR_PROMPT_BASE = (
    "This is a screenshot of an Old School RuneScape inventory. "
    "For every visible item, return its name and stack quantity via the "
    "report_inventory tool. Use exact OSRS item names so they match GE listings. "
    "Expand abbreviated numbers (10K, 1.5M, 1B). If an item icon has no visible "
    "stack number, the quantity is 1. Mark each entry's confidence based on "
    "icon clarity and number legibility. Do not invent items — only report "
    "what you can actually see."
)


def _build_ocr_prompt(expected_items):
    """Append an "answer key" of likely items to the prompt when the frontend
    passes its running list. This dramatically improves item identification —
    Claude no longer has to guess from icon alone; it picks the closest match
    from a constrained set of N items the user is actually tracking.
    """
    if not expected_items:
        return _OCR_PROMPT_BASE
    bullet_list = "\n".join(f"  - {name}" for name in expected_items if name)
    return (
        _OCR_PROMPT_BASE
        + "\n\nThe user is actively cycling the following items at Martin Thwait's shop. "
        + "Most or all items visible in the screenshot should match one of these — "
        + "use the EXACT name from this list when an item matches:\n"
        + bullet_list
        + "\n\nIf you see an item that's clearly NOT on this list, return its actual OSRS "
        + "name and mark confidence as 'low'."
    )


@app.route("/api/ocr/status")
def ocr_status():
    """Frontend probe — tells the UI whether OCR is available."""
    return jsonify({"enabled": _ocr_enabled(), "model": ANTHROPIC_MODEL if _ocr_enabled() else None})


@app.route("/api/ocr/inventory", methods=["POST"])
def ocr_inventory():
    if not _ocr_enabled():
        return jsonify({"error": "OCR not configured on this server (set ANTHROPIC_API_KEY)"}), 503

    body = request.get_json(silent=True) or {}
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        return jsonify({"error": "missing image"}), 400
    # Tolerate data-URL prefix from the frontend's FileReader output.
    if image_b64.startswith("data:"):
        try:
            header, image_b64 = image_b64.split(",", 1)
        except ValueError:
            return jsonify({"error": "malformed data URL"}), 400
    if len(image_b64) > OCR_MAX_BASE64_BYTES:
        return jsonify({"error": "image too large (>5MB)"}), 413

    media_type = body.get("media_type") or "image/png"
    if media_type not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
        return jsonify({"error": f"unsupported media type: {media_type}"}), 400

    # Optional list of item names the user is actively tracking. When present,
    # we use it as an answer-key for Claude — the model picks from a known
    # 27-item set instead of guessing from icon alone. Big accuracy win.
    expected_items = body.get("expectedItems") or []
    if not isinstance(expected_items, list):
        expected_items = []
    # Cap the list to keep the prompt reasonable.
    expected_items = [str(s) for s in expected_items[:60] if isinstance(s, str)]
    prompt_text = _build_ocr_prompt(expected_items)

    client = _get_anthropic()
    try:
        resp = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=4096,
            tools=[_OCR_TOOL_SCHEMA],
            tool_choice={"type": "tool", "name": "report_inventory"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_b64,
                            },
                        },
                        {"type": "text", "text": prompt_text},
                    ],
                }
            ],
        )
    except Exception as e:  # broad — surface upstream errors to the UI
        return jsonify({"error": f"Anthropic API error: {e}"}), 502

    # Pull the tool_use block out. There should be exactly one given we forced tool_choice.
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use" and block.name == "report_inventory":
            return jsonify(
                {
                    "items": block.input.get("items", []),
                    "model": ANTHROPIC_MODEL,
                    "inputTokens": resp.usage.input_tokens,
                    "outputTokens": resp.usage.output_tokens,
                }
            )
    return jsonify({"error": "no tool_use block in response"}), 502


if SERVE_FRONTEND:
    # Catch-all that serves the built React app. Order matters: /api/* routes
    # registered above take priority over this because they were declared
    # first. Anything not matching those falls through to here, and we serve
    # the asset on disk if present, otherwise index.html (SPA routing).
    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_frontend(path: str):
        if path.startswith("api/"):
            abort(404)
        target = os.path.join(FRONTEND_DIST, path)
        if path and os.path.isfile(target):
            return send_from_directory(FRONTEND_DIST, path)
        return send_from_directory(FRONTEND_DIST, "index.html")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
