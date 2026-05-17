import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { ROGUES_LIST_STORAGE_KEY, ROGUES_LIST_MAX } from '../utils/constants';

// The "27-slot list" — items the user is actively cycling at Martin Thwait's
// Lost and Found (Rogues' Den). Capped at ROGUES_LIST_MAX (27) to match the
// usable inventory slots (slot 28 holds coins for buying from the GE).
//
// Distinct from item favorites: favorites are "things I want to remember";
// the rogues list is "things I'm actively running right now". An item is
// typically added to favorites first, then promoted to the active list.

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
