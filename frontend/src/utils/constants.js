// App-wide constants. Keep tab-name strings here so they can be referenced
// in the sidebar nav and the content router without typo drift.

export const FAVORITES_TAB = '★ Favorites';
export const ALCH_TAB = '🔥 High alch';
export const FLIPPING_TAB = '💰 Flipping';
export const WATCHLIST_TAB = '👁 Watchlist';
export const GE_LIMITS_TAB = '📅 GE limits';
export const CHAIN_TAB = '🔗 Chain explorer';
export const SHOPS_TAB = '🏪 Shop trades';
export const ROGUES_LIST_TAB = '🎒 Rogues’ list';
export const ROGUES_LAB_TAB = '🧪 Rogues’ lab';
export const ALERTS_TAB = '🔔 Profit alerts';

// Rogues' Den "running list" — a curated, stable pool of priority items
// the user keeps cycling. Sized to their playstyle (hours/day × sells/hour ÷
// 4 × buy_limit), not a fixed cap. We keep this constant as a soft target
// only (used for legacy compat); the UI no longer caps adds.
export const ROGUES_LIST_MAX = 100;
// Buy-limit threshold separating "priority" items (low limit, high margin)
// from "fallback" items (high volume, always-on, lower margin). Users can
// override in the lab settings.
export const ROGUES_PRIORITY_LIMIT_MAX = 125;
export const ROGUES_LIST_STORAGE_KEY = 'osrs-margin-rogues-list';
export const ROGUES_LAB_STORAGE_KEY = 'osrs-margin-rogues-lab-picks';
export const ROGUES_LAB_SETTINGS_KEY = 'osrs-margin-rogues-lab-settings';
// Per-item stock + sells/session tracking, used by the Stock Equalizer
// section of the Running List tab. Shape: { [item_id]: { qty, n } }
export const ROGUES_STOCKS_STORAGE_KEY = 'osrs-margin-rogues-stocks';
// Items with hourly volume below this are flagged as "thin liquidity" so the
// user can spot rec'd picks that look juicy on paper but won't fill.
// (This is the default — the lab UI lets the user override it.)
export const ROGUES_VOLUME_FLOOR = 100;

// Default values for the lab's tunable thresholds. The lab UI lets the user
// override these so they can experiment with the recommender's behavior
// without round-tripping through code changes.
// Recipe profit alerts — watch recipes that are usually unprofitable but
// occasionally cross break-even, and get a browser notification when one
// flips into the profit zone. Default threshold is +1 gp ("just barely
// worth doing").
export const RECIPE_ALERTS_STORAGE_KEY = 'osrs-margin-recipe-alerts';
export const RECIPE_ALERTS_STATE_KEY = 'osrs-margin-recipe-alerts-state';
export const RECIPE_ALERT_THRESHOLD = 1;
// Auto-poll the recipes endpoint every N ms while at least one alert is set.
// 10 minutes balances "catch random flips" with "don't hammer Render's free
// tier or the wiki API."
export const RECIPE_ALERT_POLL_MS = 10 * 60 * 1000;

export const ROGUES_LAB_DEFAULTS = {
  hoursActive: 1.0,           // active cycling time per day
  volumeFloor: 100,            // min hourly volume to call a pick "strong"
  strongGpHrMin: 100000,       // realistic gp/hr threshold for 👍 verdict
  anomalyPct: 15,              // |price - 24h-avg| % above this → ⚠ verdict
  phaseBPremiumPct: 30,        // Phase B daily must beat active by ≥ this % to override
  autoRefreshSec: 0,           // 0 = off, otherwise interval in seconds
  cyclingEfficiency: 0.6,      // % of theoretical max session rate user actually sustains
  priorityLimitMax: 125,       // buy-limit cap for "priority" tier in the running list
};

// GE buy-limit reset window in milliseconds.
export const GE_LIMIT_WINDOW_MS = 4 * 60 * 60 * 1000;

// Pace presets: how many recipe "actions" (one full inventory worth of
// processing, banking included) the user typically completes per hour.
// Used to convert per-craft profit into a realistic gp/hour figure.
export const PACE_PRESETS = [
  { key: 'afk',     label: 'AFK',     actionsPerHour: 300 },
  { key: 'steady',  label: 'Steady',  actionsPerHour: 1200 },
  { key: 'focused', label: 'Focused', actionsPerHour: 2000 },
  { key: 'max',     label: 'Max',     actionsPerHour: 3000 },
];
export const DEFAULT_PACE = 'steady';

export const FAVORITES_STORAGE_KEY = 'osrs-margin-favorites';
export const ITEM_FAVORITES_STORAGE_KEY = 'osrs-margin-item-favorites';
export const WATCHLIST_STORAGE_KEY = 'osrs-margin-watchlist';
export const GE_LIMITS_STORAGE_KEY = 'osrs-margin-ge-limits';
export const PACE_STORAGE_KEY = 'osrs-margin-pace';

// Price-position thresholds (24h range). Lower 25% = "low" band; upper 25% = "high".
export const PRICE_POSITION_LOW = 0.25;
export const PRICE_POSITION_HIGH = 0.75;

// Watchlist polling interval (ms). 60s is a balance: alerts fire promptly
// without hammering the wiki's caches.
export const WATCHLIST_POLL_MS = 60_000;

// URL-safe slug for a tab name. Strips emojis / punctuation and lowercases.
// Examples: "★ Favorites" → "favorites", "🔥 High alch" → "high-alch".
export const tabToSlug = (tab) =>
  tab
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Volatility threshold for showing the ⚡ indicator. Items whose insta-buy
// price has moved more than VOLATILITY_THRESHOLD% vs the last hour's avg
// insta-buy get flagged.
export const VOLATILITY_THRESHOLD = 5;

// 24h/Week/Month → wiki timeseries timestep + max points to keep
export const RANGE_OPTIONS = [
  { key: '24h',   label: '24h',   timestep: '5m',  maxPoints: 288 }, // 24 * 12
  { key: 'week',  label: 'Week',  timestep: '1h',  maxPoints: 168 }, // 7 * 24
  { key: 'month', label: 'Month', timestep: '6h',  maxPoints: 124 }, // ~31 * 4
];
