import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { GE_LIMITS_STORAGE_KEY, GE_LIMIT_WINDOW_MS } from '../utils/constants';

// Tracks "I just hit my 4hr GE buy limit on this item" entries.
//
// Entry shape: { id, name, startedAt }   // startedAt = ms epoch
// When (now - startedAt) >= GE_LIMIT_WINDOW_MS the limit is "ready" again.
// We deliberately don't auto-delete ready entries so the user can choose
// when to clear them (or just leave them as a reminder).
//
// The provider exposes a `now` timestamp that re-ticks every 30 s so any
// consumer rendering countdowns updates without each component setting up
// its own interval.

const GELimitsContext = createContext({
  entries: [],
  now: Date.now(),
  isTracked: () => false,
  mark: () => {},
  clear: () => {},
  clearAll: () => {},
});

export const useGELimits = () => useContext(GELimitsContext);

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(GE_LIMITS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function GELimitsProvider({ children }) {
  const [entries, setEntries] = useState(loadFromStorage);
  const [now, setNow] = useState(() => Date.now());

  // Re-tick every 30 s so countdowns stay roughly accurate without burning CPU.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(GE_LIMITS_STORAGE_KEY, JSON.stringify(entries));
    } catch { /* localStorage unavailable */ }
  }, [entries]);

  const isTracked = useCallback(
    (id) => entries.some((e) => e.id === id),
    [entries]
  );

  // Mark an item as "just bought the buy limit". If the entry already
  // exists, replace it (resets the countdown to now).
  const mark = useCallback((id, name) => {
    setEntries((prev) => {
      const others = prev.filter((e) => e.id !== id);
      return [...others, { id, name, startedAt: Date.now() }];
    });
  }, []);

  const clear = useCallback((id) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clearAll = useCallback(() => setEntries([]), []);

  const value = useMemo(
    () => ({ entries, now, isTracked, mark, clear, clearAll }),
    [entries, now, isTracked, mark, clear, clearAll]
  );

  return (
    <GELimitsContext.Provider value={value}>
      {children}
    </GELimitsContext.Provider>
  );
}

// Helper: how much of the 4hr window remains, in ms (negative if ready).
export function msRemaining(entry, now) {
  return entry.startedAt + GE_LIMIT_WINDOW_MS - now;
}

export function isReady(entry, now) {
  return msRemaining(entry, now) <= 0;
}
