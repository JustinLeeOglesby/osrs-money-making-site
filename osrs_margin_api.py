"""
OSRS Margin Tracker — Flask REST API.

Run:  python osrs_margin_api.py    (defaults to http://localhost:5000)

Endpoints:
  GET  /api/recipes  - all priced recipes with margins (5-min cache)
  POST /api/refresh  - clear cache and recompute now

Pair with the React frontend in ./frontend (npm run dev -> http://localhost:5173).
"""

import os
import time

import requests
from flask import Flask, jsonify, request, send_from_directory, abort
from flask_cors import CORS

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


def _rogues_metrics(highalch: int, ge_buy: int, ge_limit: int | None) -> dict:
    """Compute Rogues' Den (Martin Thwait) profitability per item.

    Returns sellsPerSession (#items sold at profit before break-even or floor),
    profitPerSession (gp from one continuous shop session),
    alwaysProfitable (True if floor price still beats GE buy),
    floorMargin (gp per sale at the 60% floor — may be negative),
    totalProfit4hr (best-case profit if you session-hop to use the full GE limit).
    """
    floor_price = highalch * ROGUES_FLOOR_PCT
    floor_margin = floor_price - ge_buy

    # Enumerate per-sale margins until either non-profitable or hitting the floor.
    margins = []
    for n in range(1, ROGUES_FLOOR_SALE_INDEX + 1):
        shop_price = highalch * (ROGUES_START_PCT - ROGUES_STEP_PCT * (n - 1))
        m = shop_price - ge_buy
        if m <= 0:
            break
        margins.append(m)
    sells_per_session = len(margins)
    profit_per_session = sum(margins)
    always_profitable = floor_margin > 0

    # Total profit at full 4hr GE buy limit.
    if not ge_limit or sells_per_session == 0:
        total_4hr = profit_per_session
    elif always_profitable:
        # Sell all 21 above-floor items once, then unlimited floor sales (assume
        # one fully replenished shop in 4hrs is enough — restock is 1/min so
        # 240 floor-rate sales are available, plenty for any GE limit).
        if ge_limit <= sells_per_session:
            total_4hr = sum(margins[:ge_limit])
        else:
            total_4hr = profit_per_session + (ge_limit - sells_per_session) * floor_margin
    else:
        # Break-even reached above the floor. Session-hop to clear the GE limit.
        # Each session sells `sells_per_session` items at `profit_per_session`.
        full_sessions = ge_limit // sells_per_session
        remainder = ge_limit % sells_per_session
        total_4hr = full_sessions * profit_per_session + sum(margins[:remainder])

    return {
        "sellsPerSession": sells_per_session,
        "profitPerSession": int(round(profit_per_session)),
        "alwaysProfitable": always_profitable,
        "floorMargin": int(round(floor_margin)),
        "totalProfit4hr": int(round(total_4hr)),
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
        tax = calculate_ge_tax_safe(high)
        margin = high - low - tax
        if margin <= 0:
            continue
        limit = info.get("limit")
        hr = hourly.get(item_id_str, {}) or {}
        volume = (hr.get("highPriceVolume") or 0) + (hr.get("lowPriceVolume") or 0)
        # Skip items with effectively no liquidity — their prices are stale.
        if volume < 5:
            continue
        roi = (margin / low) * 100 if low > 0 else 0
        profit_at_limit = margin * limit if limit else None
        hourly_avg_high = hr.get("avgHighPrice")
        recent_move_pct = None
        if hourly_avg_high and hourly_avg_high > 0:
            recent_move_pct = round((high - hourly_avg_high) / hourly_avg_high * 100, 2)
        results.append(
            {
                "id": item_id,
                "name": info["name"],
                "members": info.get("members", False),
                "high": high,
                "low": low,
                "margin": margin,
                "tax": tax,
                "roi": round(roi, 2),
                "limit": limit,
                "hourlyVolume": volume,
                "profitAtLimit": profit_at_limit,
                "recentMovePct": recent_move_pct,
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
        if profit_per <= 0:
            continue
        limit = info.get("limit")
        hr = hourly.get(item_id_str, {}) or {}
        volume = (hr.get("highPriceVolume") or 0) + (hr.get("lowPriceVolume") or 0)
        total_profit_at_limit = profit_per * limit if limit else None
        rogues = _rogues_metrics(highalch, buy_price, limit)

        # Volatility proxy: how far has the current insta-buy moved from the
        # average insta-buy of the last hour? Positive = price spiking up,
        # negative = price diving. Free (uses /1h which is already cached).
        # True 24h volatility would need historical accumulation per item.
        hourly_avg_high = hr.get("avgHighPrice")
        if hourly_avg_high and hourly_avg_high > 0:
            recent_move_pct = round((buy_price - hourly_avg_high) / hourly_avg_high * 100, 2)
        else:
            recent_move_pct = None
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
                "roguesAlwaysProfitable": rogues["alwaysProfitable"],
                "roguesFloorMargin": rogues["floorMargin"],
                "roguesTotalProfit4hr": rogues["totalProfit4hr"],
                "recentMovePct": recent_move_pct,
            }
        )
    results.sort(key=lambda r: r["profitPerAlch"], reverse=True)
    return jsonify({"items": results, "natureRunePrice": nature_price, "count": len(results)})


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
