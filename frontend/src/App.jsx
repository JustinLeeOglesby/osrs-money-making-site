import { useState, useEffect, useMemo } from 'react';

import { fetchRecipes, refreshRecipes } from './api/client';
import { ItemModalContext } from './context/ItemModalContext';
import { WatchlistProvider } from './context/WatchlistContext';
import { ItemFavoritesProvider } from './context/ItemFavoritesContext';
import {
  FAVORITES_TAB,
  ALCH_TAB,
  FLIPPING_TAB,
  WATCHLIST_TAB,
  FAVORITES_STORAGE_KEY,
} from './utils/constants';

import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ItemDetailModal from './components/ItemDetailModal';
import TabContent from './components/recipes/TabContent';
import HighAlchTab from './components/alch/HighAlchTab';
import FlippingTab from './components/flipping/FlippingTab';
import WatchlistTab from './components/watchlist/WatchlistTab';
import FavoritesTab from './components/favorites/FavoritesTab';

// Composition root. Owns:
//   - the recipe payload (fetched from /api/recipes)
//   - active tab + recipe search text
//   - the favorites Set (persisted to localStorage)
//   - the active item-detail modal (id of the item currently shown, if any)
//
// All UI surface lives in dedicated components. Item-detail modal is wired
// through React context so anywhere in the tree can call `useItemModal().open(id)`.
export default function App() {
  // --- Recipe data ---
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // --- Active tab ---
  const [activeTab, setActiveTab] = useState(null);

  // --- Favorites (persisted across sessions) ---
  const [favorites, setFavorites] = useState(() => {
    try {
      const stored = localStorage.getItem(FAVORITES_STORAGE_KEY);
      return new Set(stored ? JSON.parse(stored) : []);
    } catch {
      return new Set();
    }
  });

  // --- Item-detail modal ---
  const [modalItemId, setModalItemId] = useState(null);
  const modalCtx = useMemo(() => ({ open: setModalItemId }), []);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
    } catch {
      // localStorage unavailable — favorites are session-only
    }
  }, [favorites]);

  const toggleFavorite = (name) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  useEffect(() => {
    fetchRecipes().then(setPayload).catch((e) => setError(e.message));
  }, []);

  // Group recipes by their top-level category for sidebar counts + content routing.
  const byCategory = useMemo(() => {
    if (!payload) return new Map();
    const map = new Map();
    for (const r of payload.recipes) {
      if (!map.has(r.category)) map.set(r.category, []);
      map.get(r.category).push(r);
    }
    return map;
  }, [payload]);

  const favoritedRecipes = useMemo(() => {
    if (!payload) return [];
    return payload.recipes.filter((r) => favorites.has(r.name));
  }, [payload, favorites]);

  const categories = useMemo(() => [...byCategory.keys()].sort(), [byCategory]);

  // Default to Favorites if any exist, otherwise the first category.
  // Note: item favorites are in their own provider, so we can't gate on
  // their count here without subscribing to the context. The recipe-side
  // check is good enough — users who only have item favorites can still
  // click into the Favorites tab manually.
  useEffect(() => {
    if (!activeTab) {
      if (favorites.size > 0) setActiveTab(FAVORITES_TAB);
      else if (categories.length) setActiveTab(categories[0]);
    }
  }, [categories, activeTab, favorites]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const fresh = await refreshRecipes();
      setPayload(fresh);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
    }
  };

  if (error) {
    return (
      <div style={{ padding: '2em', color: 'var(--red)' }}>
        Error: {error}
        <div style={{ marginTop: '1em', color: 'var(--muted)', fontSize: '0.9em' }}>
          Make sure the Flask API is running on http://localhost:5000.
        </div>
      </div>
    );
  }
  if (!payload) {
    return <div style={{ padding: '2em', color: 'var(--muted)' }}>Loading…</div>;
  }

  const strategyLabel =
    payload.strategy === 'instant'
      ? 'instant (insta-buy + insta-sell — conservative)'
      : 'patient (buy low, sell high — optimistic)';

  const recipeCountByCategory = new Map(
    [...byCategory.entries()].map(([k, v]) => [k, v.length])
  );

  return (
    <ItemFavoritesProvider>
    <WatchlistProvider>
    <ItemModalContext.Provider value={modalCtx}>
      <Header
        recipeCount={payload.recipes.length}
        strategyLabel={strategyLabel}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      />
      <div className="layout">
        <Sidebar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          favoritesCount={favoritedRecipes.length}
          categories={categories}
          recipeCountByCategory={recipeCountByCategory}
        />
        <div className="content">
          {activeTab === ALCH_TAB ? (
            <HighAlchTab key={ALCH_TAB} />
          ) : activeTab === FLIPPING_TAB ? (
            <FlippingTab key={FLIPPING_TAB} />
          ) : activeTab === WATCHLIST_TAB ? (
            <WatchlistTab key={WATCHLIST_TAB} />
          ) : activeTab === FAVORITES_TAB ? (
            <FavoritesTab
              key={FAVORITES_TAB}
              recipes={favoritedRecipes}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
            />
          ) : (
            activeTab && (
              <TabContent
                key={activeTab}
                recipes={byCategory.get(activeTab) || []}
                groupBy="subcategory"
                sortGroupsBy={activeTab === 'Decanting' ? 'maxProfit' : 'name'}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
              />
            )
          )}
        </div>
      </div>
      {modalItemId != null && (
        <ItemDetailModal
          itemId={modalItemId}
          onClose={() => setModalItemId(null)}
        />
      )}
    </ItemModalContext.Provider>
    </WatchlistProvider>
    </ItemFavoritesProvider>
  );
}
