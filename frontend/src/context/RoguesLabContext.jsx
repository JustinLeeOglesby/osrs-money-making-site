import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { ROGUES_LAB_STORAGE_KEY } from '../utils/constants';

// "Rogues' Lab" picks — a sandbox list, distinct from the active 27-slot
// Rogues' list. The user feeds candidate picks here for evaluation; the lab
// shows verdict badges and lets them ask "why?" for individual items so we
// can calibrate the recommender against their real-world experience.
//
// Why a separate context: the lab is exploratory and should never affect
// the live cycling list. Items can move between lab and main list freely.

const RoguesLabContext = createContext({
  items: [],
  isOnLab: () => false,
  add: () => false,
  remove: () => {},
  clear: () => {},
  count: 0,
});

export const useRoguesLab = () => useContext(RoguesLabContext);

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(ROGUES_LAB_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function RoguesLabProvider({ children }) {
  const [items, setItems] = useState(loadFromStorage);

  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_LAB_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // session-only fallback
    }
  }, [items]);

  const isOnLab = useCallback(
    (id) => items.some((it) => it.id === id),
    [items]
  );

  // Returns true on successful add, false if already present.
  // No 27-slot cap here — the lab is for evaluation, not allocation.
  const add = useCallback((id, name) => {
    let added = false;
    setItems((prev) => {
      if (prev.some((it) => it.id === id)) return prev;
      added = true;
      return [...prev, { id, name, addedAt: Date.now() }];
    });
    return added;
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const value = useMemo(
    () => ({ items, isOnLab, add, remove, clear, count: items.length }),
    [items, isOnLab, add, remove, clear]
  );

  return (
    <RoguesLabContext.Provider value={value}>
      {children}
    </RoguesLabContext.Provider>
  );
}
