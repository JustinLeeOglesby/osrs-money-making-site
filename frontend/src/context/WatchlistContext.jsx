import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { WATCHLIST_STORAGE_KEY, WATCHLIST_POLL_MS } from '../utils/constants';
import { fetchItem } from '../api/client';

// Shape of a watchlist entry:
//   { id, name, lowTarget, highTarget, addedAt }
//
// `lowTarget` fires when current insta-sell drops at or below the value.
// `highTarget` fires when current insta-buy rises at or above the value.
// Either may be null, but at least one should be set for alerting to do anything.
//
// Live prices are refreshed by a single polling loop in the provider — every
// WATCHLIST_POLL_MS we hit /api/item/<id> for each watched id and store the
// freshest snapshot in `prices`. Components read from there.

const WatchlistContext = createContext({
  items: [],
  prices: {},
  alerts: new Set(),
  add: () => {},
  remove: () => {},
  update: () => {},
  isWatched: () => false,
  dismissAlert: () => {},
});

export const useWatchlist = () => useContext(WatchlistContext);

function loadFromStorage() {
  try {
    const stored = localStorage.getItem(WATCHLIST_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

// Returns "low" | "high" | null depending on whether either target is crossed.
function checkAlert(entry, price) {
  if (!price) return null;
  if (entry.lowTarget != null && price.low != null && price.low <= entry.lowTarget) {
    return 'low';
  }
  if (entry.highTarget != null && price.high != null && price.high >= entry.highTarget) {
    return 'high';
  }
  return null;
}

export function WatchlistProvider({ children }) {
  const [items, setItems] = useState(loadFromStorage);
  const [prices, setPrices] = useState({}); // { id -> { high, low, ... } }
  const [dismissed, setDismissed] = useState(new Set()); // alerts the user has acked
  const lastNotifiedRef = useRef(new Set()); // alert keys we've already notified for

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(items));
    } catch { /* localStorage unavailable — session-only */ }
  }, [items]);

  // Poll prices for all watched items, then again every WATCHLIST_POLL_MS.
  useEffect(() => {
    if (items.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const updates = {};
      await Promise.all(
        items.map(async (it) => {
          try {
            const info = await fetchItem(it.id);
            updates[it.id] = info;
          } catch { /* ignore transient errors */ }
        })
      );
      if (!cancelled) setPrices((p) => ({ ...p, ...updates }));
    };
    tick();
    const id = setInterval(tick, WATCHLIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [items]);

  // Derive alert set + fire desktop notifications for newly-triggered ones.
  const alerts = useMemo(() => {
    const set = new Set();
    for (const it of items) {
      const kind = checkAlert(it, prices[it.id]);
      if (kind) set.add(`${it.id}:${kind}`);
    }
    return set;
  }, [items, prices]);

  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    for (const key of alerts) {
      if (dismissed.has(key)) continue;
      if (lastNotifiedRef.current.has(key)) continue;
      lastNotifiedRef.current.add(key);
      const [idStr, kind] = key.split(':');
      const id = Number(idStr);
      const it = items.find((x) => x.id === id);
      const p = prices[id];
      if (!it || !p) continue;
      const tag = `watchlist-${key}`;
      const body = kind === 'low'
        ? `Insta-sell dropped to ${p.low?.toLocaleString()} (target ≤ ${it.lowTarget?.toLocaleString()})`
        : `Insta-buy rose to ${p.high?.toLocaleString()} (target ≥ ${it.highTarget?.toLocaleString()})`;
      try {
        new Notification(`${it.name} hit your ${kind} target`, { body, tag });
      } catch { /* notification API quirks — ignore */ }
    }
    // Clear notification memory for entries no longer alerting (so it re-fires
    // if they cross again after a recovery).
    for (const key of [...lastNotifiedRef.current]) {
      if (!alerts.has(key)) lastNotifiedRef.current.delete(key);
    }
  }, [alerts, items, prices, dismissed]);

  const add = useCallback((id, name, { lowTarget = null, highTarget = null } = {}) => {
    setItems((prev) => {
      if (prev.some((it) => it.id === id)) return prev;
      return [...prev, { id, name, lowTarget, highTarget, addedAt: Date.now() }];
    });
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setPrices((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
  }, []);

  const update = useCallback((id, patch) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const isWatched = useCallback((id) => items.some((it) => it.id === id), [items]);

  const dismissAlert = useCallback((key) => {
    setDismissed((prev) => new Set(prev).add(key));
  }, []);

  const value = useMemo(
    () => ({ items, prices, alerts, add, remove, update, isWatched, dismissAlert }),
    [items, prices, alerts, add, remove, update, isWatched, dismissAlert]
  );

  return <WatchlistContext.Provider value={value}>{children}</WatchlistContext.Provider>;
}
