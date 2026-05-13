// App-wide constants. Keep tab-name strings here so they can be referenced
// in the sidebar nav and the content router without typo drift.

export const FAVORITES_TAB = '★ Favorites';
export const ALCH_TAB = '🔥 High alch';
export const FLIPPING_TAB = '💰 Flipping';
export const WATCHLIST_TAB = '👁 Watchlist';

export const FAVORITES_STORAGE_KEY = 'osrs-margin-favorites';
export const ITEM_FAVORITES_STORAGE_KEY = 'osrs-margin-item-favorites';
export const WATCHLIST_STORAGE_KEY = 'osrs-margin-watchlist';

// Price-position thresholds (24h range). Lower 25% = "low" band; upper 25% = "high".
export const PRICE_POSITION_LOW = 0.25;
export const PRICE_POSITION_HIGH = 0.75;

// Watchlist polling interval (ms). 60s is a balance: alerts fire promptly
// without hammering the wiki's caches.
export const WATCHLIST_POLL_MS = 60_000;

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
