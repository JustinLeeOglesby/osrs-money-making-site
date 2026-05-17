// Rogues' Den (Martin Thwait's Lost and Found) mechanics, in JS.
//
// Mirrors the Python `_rogues_metrics` so the frontend can recompute the
// optimal-N decision client-side when the user constrains max sells/session.
//
// Why client-side: the user's "max 20 per session" preference exists because
// the same world's shop won't have reset by the time they cycle back. We don't
// want to refetch the entire payload every time they nudge the slider; we have
// `highalch` and `buyPrice` already, and the descent formula is fixed, so we
// can derive everything locally.

const START_PCT = 1.0;            // shop pays 100% of high alch on sale 1
const STEP_PCT = 0.02;            // -2 percentage points per subsequent sale
const FLOOR_PCT = 0.60;           // sales 22+ floor at 60% of high alch
const FLOOR_SALE_INDEX = 21;      // last "descending" sale; 22+ is floor
const HOP_SECONDS = 10;           // typical world-hop time
const CLICK_SECONDS = 2;          // per-batch-click cost
const BATCH_SIZES = [50, 10, 5];  // shop sells in fixed batches of these sizes

// Greedy minimum clicks to sell exactly n items using batches of 5/10/50.
// 5→1, 10→1, 15→2, 50→1, 55→2, 60→2. Multiples of 5 only.
function clicksForN(n) {
  let clicks = 0;
  let remaining = n;
  for (const batch of BATCH_SIZES) {
    clicks += Math.floor(remaining / batch);
    remaining %= batch;
  }
  return clicks;
}

// Margin on the Nth sale (1-indexed). After sale 21 it's the floor.
function marginAtSale(highalch, buyPrice, n) {
  if (n <= FLOOR_SALE_INDEX) {
    return highalch * (START_PCT - STEP_PCT * (n - 1)) - buyPrice;
  }
  return highalch * FLOOR_PCT - buyPrice;
}

// Cumulative profit if you sell N items in one session.
function cumulativeProfit(highalch, buyPrice, n) {
  if (n <= 0) return 0;
  let total = 0;
  // Descent portion
  for (let i = 1; i <= Math.min(n, FLOOR_SALE_INDEX); i++) {
    total += marginAtSale(highalch, buyPrice, i);
  }
  // Floor portion
  if (n > FLOOR_SALE_INDEX) {
    total += (n - FLOOR_SALE_INDEX) * marginAtSale(highalch, buyPrice, FLOOR_SALE_INDEX + 1);
  }
  return total;
}

// Compute Rogues' Den metrics for a given (highalch, buy price) and a hard
// cap on sells/session. Returns null if no profitable N exists within the cap.
//
// Inputs:
//   highalch        — item's high alch value
//   buyPrice        — current (or 24h-avg) GE insta-buy price
//   maxSellsCap     — user's hard cap on N (e.g. 20 means never sell more than 20)
//   dailyVolPerHr   — optional, used for the volume-bound "realistic" gp/hr
//
// Returns:
//   sellsPerSession        — optimal N within the cap (multiple of 5)
//   profitPerSession       — gp earned at that N
//   gpPerHr                — click-bound theoretical gp/hr
//   realisticGpPerHr       — gp/hr capped by market volume
//   alwaysProfitable       — true if even the floor margin is positive
//   lastSaleMargin         — margin on the *last* sale at the chosen N (warns if near zero)
//   volumeBottlenecked     — true if market volume, not click speed, is the cap
export function computeRoguesMetrics(highalch, buyPrice, maxSellsCap, dailyVolPerHr = 0) {
  if (!highalch || highalch <= 0 || !buyPrice || buyPrice <= 0) return null;

  const cap = Math.min(60, Math.max(5, maxSellsCap || 60));
  const floorMargin = marginAtSale(highalch, buyPrice, FLOOR_SALE_INDEX + 1);
  const alwaysProfitable = floorMargin > 0;

  // If the first sale isn't profitable, nothing is.
  if (marginAtSale(highalch, buyPrice, 1) <= 0) {
    return {
      sellsPerSession: 0,
      profitPerSession: 0,
      gpPerHr: 0,
      realisticGpPerHr: 0,
      alwaysProfitable,
      lastSaleMargin: 0,
      volumeBottlenecked: false,
      floorMargin,
    };
  }

  // No-loss cap: highest N (in steps of 5, ≤ cap) where every sale is still
  // profitable. Margins decrease monotonically, so checking the Nth sale is
  // sufficient.
  let maxProfitableN = 0;
  for (let n = 5; n <= cap; n += 5) {
    const m = marginAtSale(highalch, buyPrice, n);
    if (alwaysProfitable || m > 0) {
      maxProfitableN = n;
    } else {
      break;
    }
  }

  if (maxProfitableN === 0) return null;

  // Optimize N over [5, 10, ..., maxProfitableN] for max gp/hr.
  let bestN = 5;
  let bestProfit = 0;
  let bestGpPerHr = 0;
  for (let n = 5; n <= maxProfitableN; n += 5) {
    const profit = cumulativeProfit(highalch, buyPrice, n);
    const timeS = HOP_SECONDS + clicksForN(n) * CLICK_SECONDS;
    const gpPerHr = (profit / timeS) * 3600;
    if (gpPerHr > bestGpPerHr) {
      bestGpPerHr = gpPerHr;
      bestProfit = profit;
      bestN = n;
    }
  }

  // Volume-bound: how many sessions can the 24h market liquidity actually support?
  let realisticGpPerHr = bestGpPerHr;
  let volumeBottlenecked = false;
  if (dailyVolPerHr > 0 && bestProfit > 0) {
    const volBoundGpPerHr = (dailyVolPerHr / bestN) * bestProfit;
    realisticGpPerHr = Math.min(bestGpPerHr, volBoundGpPerHr);
    volumeBottlenecked = volBoundGpPerHr < bestGpPerHr;
  }

  return {
    sellsPerSession: bestN,
    profitPerSession: Math.round(bestProfit),
    gpPerHr: Math.round(bestGpPerHr),
    realisticGpPerHr: Math.round(realisticGpPerHr),
    alwaysProfitable,
    lastSaleMargin: Math.round(marginAtSale(highalch, buyPrice, bestN)),
    volumeBottlenecked,
    floorMargin: Math.round(floorMargin),
  };
}
