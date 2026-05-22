import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { ROGUES_LIST_STORAGE_KEY, ROGUES_LIST_MAX } from '../utils/constants';

// Multiple named running lists, each with its own main (capped at
// ROGUES_LIST_MAX) and backup tiers. Lets the user separate strategies —
// e.g., a "high volume" list and a "low buy-limit / patient" list — and
// switch between them. Stocks (qty + N + buy override) stay GLOBAL,
// keyed by item id, so the same item shows the same stock count
// regardless of which list it's currently on.
//
// Storage shape:
//   { lists: [{ id, name, items: [{id, name, addedAt, tier}] }],
//     activeListId: 'main' }
//
// Migration: prior versions saved a bare array of items at the top level.
// On load we wrap that into a single list named "Main".

const RoguesListContext = createContext({
  lists: [],
  activeListId: null,
  activeList: null,
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
  // List management
  switchList: () => {},
  createList: () => null,
  renameList: () => {},
  duplicateList: () => null,
  deleteList: () => {},
});

export const useRoguesList = () => useContext(RoguesListContext);

function makeListId() {
  return `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultState() {
  return {
    lists: [{ id: 'main', name: 'Main', items: [] }],
    activeListId: 'main',
  };
}

// Per-list migration: items without explicit tier get assigned in order —
// first ROGUES_LIST_MAX into main, rest into backup.
function migrateItemTiers(rawItems) {
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
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // Old shape: top-level array of items.
    if (Array.isArray(parsed)) {
      return {
        lists: [{ id: 'main', name: 'Main', items: migrateItemTiers(parsed) }],
        activeListId: 'main',
      };
    }
    // New shape: {lists, activeListId}. Sanity-fill defaults.
    if (parsed && Array.isArray(parsed.lists) && parsed.lists.length > 0) {
      const lists = parsed.lists.map((l) => ({
        id: l.id || makeListId(),
        name: l.name || 'List',
        items: migrateItemTiers(l.items || []),
      }));
      const activeListId =
        lists.some((l) => l.id === parsed.activeListId)
          ? parsed.activeListId
          : lists[0].id;
      return { lists, activeListId };
    }
    return defaultState();
  } catch {
    return defaultState();
  }
}

export function RoguesListProvider({ children }) {
  const [state, setState] = useState(loadFromStorage);

  useEffect(() => {
    try {
      localStorage.setItem(ROGUES_LIST_STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* session-only fallback */
    }
  }, [state]);

  // --- Active list + derived data ---
  const activeList = useMemo(
    () => state.lists.find((l) => l.id === state.activeListId) || state.lists[0],
    [state]
  );
  const items = activeList?.items || [];
  const mainItems = useMemo(() => items.filter((it) => it.tier === 'main'), [items]);
  const backupItems = useMemo(() => items.filter((it) => it.tier === 'backup'), [items]);

  // --- Helpers that mutate items inside the active list ---
  const updateActiveItems = useCallback((fn) => {
    setState((prev) => {
      const lists = prev.lists.map((l) =>
        l.id === prev.activeListId ? { ...l, items: fn(l.items) } : l
      );
      return { ...prev, lists };
    });
  }, []);

  const isOnList = useCallback((id) => items.some((it) => it.id === id), [items]);

  const add = useCallback((id, name) => {
    let added = false;
    updateActiveItems((prevItems) => {
      if (prevItems.some((it) => it.id === id)) return prevItems;
      const mainCount = prevItems.filter((it) => it.tier === 'main').length;
      const tier = mainCount < ROGUES_LIST_MAX ? 'main' : 'backup';
      added = true;
      return [...prevItems, { id, name, addedAt: Date.now(), tier }];
    });
    return added;
  }, [updateActiveItems]);

  const remove = useCallback((id) => {
    updateActiveItems((prevItems) => prevItems.filter((it) => it.id !== id));
  }, [updateActiveItems]);

  const promote = useCallback((id) => {
    let moved = false;
    updateActiveItems((prevItems) => {
      const target = prevItems.find((it) => it.id === id);
      if (!target || target.tier !== 'backup') return prevItems;
      const mainCount = prevItems.filter((it) => it.tier === 'main').length;
      if (mainCount >= ROGUES_LIST_MAX) return prevItems;
      moved = true;
      return prevItems.map((it) => (it.id === id ? { ...it, tier: 'main' } : it));
    });
    return moved;
  }, [updateActiveItems]);

  const demote = useCallback((id) => {
    updateActiveItems((prevItems) =>
      prevItems.map((it) => (it.id === id && it.tier === 'main' ? { ...it, tier: 'backup' } : it))
    );
  }, [updateActiveItems]);

  const clear = useCallback(() => updateActiveItems(() => []), [updateActiveItems]);

  // --- List management ---
  const switchList = useCallback((id) => {
    setState((prev) =>
      prev.lists.some((l) => l.id === id) ? { ...prev, activeListId: id } : prev
    );
  }, []);

  const createList = useCallback((name) => {
    const trimmed = (name || '').trim() || 'New list';
    const newId = makeListId();
    setState((prev) => ({
      lists: [...prev.lists, { id: newId, name: trimmed, items: [] }],
      activeListId: newId,
    }));
    return newId;
  }, []);

  const renameList = useCallback((id, name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    setState((prev) => ({
      ...prev,
      lists: prev.lists.map((l) => (l.id === id ? { ...l, name: trimmed } : l)),
    }));
  }, []);

  // Duplicate a list (items included). Active list switches to the copy.
  const duplicateList = useCallback((id) => {
    const newId = makeListId();
    setState((prev) => {
      const source = prev.lists.find((l) => l.id === id);
      if (!source) return prev;
      const copy = {
        id: newId,
        name: `${source.name} (copy)`,
        items: source.items.map((it) => ({ ...it })),
      };
      return {
        lists: [...prev.lists, copy],
        activeListId: newId,
      };
    });
    return newId;
  }, []);

  const deleteList = useCallback((id) => {
    setState((prev) => {
      // Always keep at least one list around.
      if (prev.lists.length <= 1) return prev;
      const lists = prev.lists.filter((l) => l.id !== id);
      const activeListId =
        prev.activeListId === id ? lists[0].id : prev.activeListId;
      return { lists, activeListId };
    });
  }, []);

  const value = useMemo(
    () => ({
      lists: state.lists,
      activeListId: state.activeListId,
      activeList,
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
      switchList,
      createList,
      renameList,
      duplicateList,
      deleteList,
    }),
    [
      state,
      activeList,
      items,
      mainItems,
      backupItems,
      isOnList,
      add,
      remove,
      promote,
      demote,
      clear,
      switchList,
      createList,
      renameList,
      duplicateList,
      deleteList,
    ]
  );

  return (
    <RoguesListContext.Provider value={value}>
      {children}
    </RoguesListContext.Provider>
  );
}
