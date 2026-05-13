import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { ITEM_FAVORITES_STORAGE_KEY } from '../utils/constants';

// Favorite items (high-alch picks, flipping candidates, anything worth
// remembering). Entries are stored as { id, name } so we can render them
// in the Favorites tab without needing a live fetch.
//
// Separate from recipe favorites because the data shapes differ — recipes
// are keyed by name, items by integer ID.

const ItemFavoritesContext = createContext({
  items: [],
  isFavorite: () => false,
  toggle: () => {},
});

export const useItemFavorites = () => useContext(ItemFavoritesContext);

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(ITEM_FAVORITES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function ItemFavoritesProvider({ children }) {
  const [items, setItems] = useState(loadFromStorage);

  useEffect(() => {
    try {
      localStorage.setItem(ITEM_FAVORITES_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // localStorage unavailable — session-only
    }
  }, [items]);

  const isFavorite = useCallback(
    (id) => items.some((it) => it.id === id),
    [items]
  );

  const toggle = useCallback((id, name) => {
    setItems((prev) => {
      if (prev.some((it) => it.id === id)) {
        return prev.filter((it) => it.id !== id);
      }
      return [...prev, { id, name, addedAt: Date.now() }];
    });
  }, []);

  const value = useMemo(
    () => ({ items, isFavorite, toggle }),
    [items, isFavorite, toggle]
  );

  return (
    <ItemFavoritesContext.Provider value={value}>
      {children}
    </ItemFavoritesContext.Provider>
  );
}
