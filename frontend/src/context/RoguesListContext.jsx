import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { ROGUES_LIST_STORAGE_KEY, ROGUES_LIST_MAX } from '../utils/constants';

// The "running list" — a curated, stable pool of items the user is cycling
// through Martin Thwait's Lost and Found (Rogues' Den).
//
// Tiered structure (re-added after a brief unbounded-pool experiment):
//   - main:   the active set the user is currently rotating. Capped at
//             ROGUES_LIST_MAX (27, matching an OSRS inventory minus coins).
//   - backup: an overflow pool for items the user wants tracked but isn't
//             actively running right now. Uncapped. Items move freely
//             between tiers via promote/demote.
//
// Item shape: { id, name, addedAt, tier: 'main' | 'backup' }.
// Items added when main is full automatically land in backup.

const RoguesListContext = createContext({
  items: [],
  mainItems: [],
  backupItems: [],
  isOnList: () => false,
  add: () => false,
  remove: () => {},
  promote: () => false,
  demote: () => {},
  clear: () => {},
  count: 0,
  mainCount: 0,
  backupCount: 0,
  isFull: false,
});

export const useRoguesList = () => useContext(RoguesListContext);

// Migration: older saved items have no `tier` field. Walk in order, fill
// main up to ROGUES_LIST_MAX, push the rest to backup.
function migrateItems(rawItems) {
  let mainCount = 0;
  return rawItems.map((it) => {
    if (it.tier === 'main' || it.tier === 'backup') {
      if (it.tier === 'main') mainCount += 1;
      return it;
    }
    const tier = mainCount < ROGUES_LIST_MAX ? 'main' : 'backup';
    if (tier === 'main') mainCount += 1;
    return { ...it, tier };
  });
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(ROGUES_LIST_STORAGE_KEY);
    return migrateItems(raw ? JSON.parse(raw) : []);
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

  // Add a new item. Defaults to 'main' if main has room, else 'backup'.
  // Returns true on add, false if already present.
  const add = useCallback((id, name) => {
    let added = false;
    setItems((prev) => {
      if (prev.some((it) => it.id === id)) return prev;
      const mainCount = prev.filter((it) => it.tier === 'main').length;
      const tier = mainCount < ROGUES_LIST_MAX ? 'main' : 'backup';
      added = true;
      return [...prev, { id, name, addedAt: Date.now(), tier }];
    });
    return added;
  }, []);

  const remove = useCallback((id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  // Move an item from backup → main. Returns true if successful, false if
  // main is full or the item isn't in backup.
  const promote = useCallback((id) => {
    let moved = false;
    setItems((prev) => {
      const target = prev.find((it) => it.id === id);
      if (!target || target.tier !== 'backup') return prev;
      const mainCount = prev.filter((it) => it.tier === 'main').length;
      if (mainCount >= ROGUES_LIST_MAX) return prev;
      moved = true;
      return prev.map((it) => (it.id === id ? { ...it, tier: 'main' } : it));
    });
    return moved;
  }, []);

  // Move an item from main → backup. Always succeeds if item is on main.
  const demote = useCallback((id) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id && it.tier === 'main' ? { ...it, tier: 'backup' } : it))
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const mainItems = useMemo(() => items.filter((it) => it.tier === 'main'), [items]);
  const backupItems = useMemo(() => items.filter((it) => it.tier === 'backup'), [items]);

  const value = useMemo(
    () => ({
      items,
      mainItems,
      backupItems,
      isOnList,
      add,
      remove,
      promote,
      demote,
      clear,
      count: items.length,
      mainCount: mainItems.length,
      backupCount: backupItems.length,
      isFull: mainItems.length >= ROGUES_LIST_MAX,
    }),
    [items, mainItems, backupItems, isOnList, add, remove, promote, demote, clear]
  );

  return (
    <RoguesListContext.Provider value={value}>
      {children}
    </RoguesListContext.Provider>
  );
}
