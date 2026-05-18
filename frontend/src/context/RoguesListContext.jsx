import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { ROGUES_LIST_STORAGE_KEY, ROGUES_LIST_MAX } from '../utils/constants';

// The "running list" — a curated, stable pool of items the user is cycling
// through Martin Thwait's Lost and Found (Rogues' Den). Originally capped at
// 27 to match an OSRS inventory; that constraint was dropped once we realized
// the working unit is "items I'm always buying," not "items in my bag right
// now." Pool size is now driven by playstyle math (target throughput / supply
// per item × buffer); the UI shows coverage ratio but doesn't hard-cap adds.
//
// Distinct from item favorites: favorites are "things I want to remember";
// the running list is "things I'm actively cycling right now."

const RoguesListContext = createContext({
  items: [],
  isOnList: () => false,
  add: () => false,
  remove: () => {},
  clear: () => {},
  count: 0,
  isFull: false,
});

export const useRoguesList = () => useContext(RoguesListContext);

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(ROGUES_LIST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function RoguesListProvider({ children }) {
  const [items, setItems] = useState(loadFromStorage);

  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_LIST_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // session-only fallback
    }
  }, [items]);

  const isOnList = useCallback(
    (id) => items.some((it) => it.id === id),
    [items]
  );

  // Returns true on successful add, false if list is full or item already present.
  const add = useCallback((id, name) => {
    let added = false;
    setItems((prev) => {
      if (prev.some((it) => it.id === id)) return prev;
      if (prev.length >= ROGUES_LIST_MAX) return prev;
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
    () => ({
      items,
      isOnList,
      add,
      remove,
      clear,
      count: items.length,
      isFull: items.length >= ROGUES_LIST_MAX,
    }),
    [items, isOnList, add, remove, clear]
  );

  return (
    <RoguesListContext.Provider value={value}>
      {children}
    </RoguesListContext.Provider>
  );
}
