import { useState, useEffect, useMemo } from 'react';

import { fetchRecipes, refreshRecipes } from './api/client';
import { ItemModalContext } from './context/ItemModalContext';
import { WatchlistProvider } from './context/WatchlistContext';
import { ItemFavoritesProvider } from './context/ItemFavoritesContext';
import { GELimitsProvider } from './context/GELimitsContext';
import { PaceProvider } from './context/PaceContext';
import { RoguesListProvider } from './context/RoguesListContext';
import { RoguesLabProvider } from './context/RoguesLabContext';
import { SyncProvider } from './context/SyncContext';
import { RecipeAlertsProvider, useRecipeAlerts } from './context/RecipeAlertsContext';
import {
  FAVORITES_TAB,
  ALCH_TAB,
  FLIPPING_TAB,
  WATCHLIST_TAB,
  GE_LIMITS_TAB,
  CHAIN_TAB,
  SHOPS_TAB,
  ROGUES_LIST_TAB,
  ROGUES_LAB_TAB,
  ALERTS_TAB,
  FAVORITES_STORAGE_KEY,
  RECIPE_ALERT_POLL_MS,
  tabToSlug,
} from './utils/constants';

import Header from './components/Header';
import Sidebar from './components/Sidebar';
import ItemDetailModal from './components/ItemDetailModal';
import TabContent from './components/recipes/TabContent';
import HighAlchTab from './components/alch/HighAlchTab';
import FlippingTab from './components/flipping/FlippingTab';
import WatchlistTab from './components/watchlist/WatchlistTab';
import FavoritesTab from './components/favorites/FavoritesTab';
import GELimitsTab from './components/gelimits/GELimitsTab';
import ChainExplorer from './components/chain/ChainExplorer';
import ShopsTab from './components/shops/ShopsTab';
import RoguesListTab from './components/rogueslist/RoguesListTab';
import RoguesLabTab from './components/rogueslab/RoguesLabTab';
import AlertsTab from './components/alerts/AlertsTab';

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

  // All addressable tabs (pinned + dynamic categories) and slug ↔ tab maps.
  // The maps are used to read the active tab from the URL on load and to
  // push a new URL whenever the user picks a different tab.
  const allTabs = useMemo(
    () => [FAVORITES_TAB, WATCHLIST_TAB, ALCH_TAB, FLIPPING_TAB, GE_LIMITS_TAB, CHAIN_TAB, SHOPS_TAB, ROGUES_LIST_TAB, ROGUES_LAB_TAB, ALERTS_TAB, ...categories],
    [categories]
  );
  const slugToTab = useMemo(() => {
    const m = new Map();
    for (const t of allTabs) m.set(tabToSlug(t), t);
    return m;
  }, [allTabs]);

  // Initial activation: URL wins if it names a real tab, otherwise fall back
  // to Favorites (if any exist) or the first category.
  useEffect(() => {
    if (activeTab) return;
    const slug = window.location.pathname.slice(1).split('/')[0];
    const fromUrl = slug && slugToTab.get(slug);
    if (fromUrl) {
      setActiveTab(fromUrl);
      return;
    }
    if (favorites.size > 0) setActiveTab(FAVORITES_TAB);
    else if (categories.length) setActiveTab(categories[0]);
  }, [categories, activeTab, favorites, slugToTab]);

  // Push the URL when the user switches tabs, so refresh + back/forward work.
  useEffect(() => {
    if (!activeTab) return;
    const newPath = '/' + tabToSlug(activeTab);
    if (window.location.pathname !== newPath) {
      window.history.pushState({}, '', newPath);
    }
  }, [activeTab]);

  // Browser back/forward navigation: pull the tab back out of the URL.
  useEffect(() => {
    const onPop = () => {
      const slug = window.location.pathname.slice(1).split('/')[0];
      const tab = slugToTab.get(slug);
      if (tab) setActiveTab(tab);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [slugToTab]);

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
    <SyncProvider>
    <RecipeAlertsProvider>
    <ItemFavoritesProvider>
    <RoguesListProvider>
    <RoguesLabProvider>
    <GELimitsProvider>
    <PaceProvider>
    <WatchlistProvider>
    <ItemModalContext.Provider value={modalCtx}>
      <AlertChecker
        recipes={payload.recipes}
        onAutoRefresh={() => fetchRecipes().then(setPayload).catch(() => {})}
      />
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
          ) : activeTab === GE_LIMITS_TAB ? (
            <GELimitsTab key={GE_LIMITS_TAB} />
          ) : activeTab === CHAIN_TAB ? (
            <ChainExplorer key={CHAIN_TAB} />
          ) : activeTab === SHOPS_TAB ? (
            <ShopsTab key={SHOPS_TAB} />
          ) : activeTab === ROGUES_LIST_TAB ? (
            <RoguesListTab key={ROGUES_LIST_TAB} />
          ) : activeTab === ROGUES_LAB_TAB ? (
            <RoguesLabTab key={ROGUES_LAB_TAB} />
          ) : activeTab === ALERTS_TAB ? (
            <AlertsTab key={ALERTS_TAB} payload={payload} />
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
    </PaceProvider>
    </GELimitsProvider>
    </RoguesLabProvider>
    </RoguesListProvider>
    </ItemFavoritesProvider>
    </RecipeAlertsProvider>
    </SyncProvider>
  );
}

// AlertChecker runs the recipe-alerts transition detector on every payload
// update and also drives the 10-minute auto-poll while at least one alert is
// set. It renders nothing — pure side-effects. Lives inside the provider
// tree so it can read `items` and call `checkAndFireAlerts` from context.
function AlertChecker({ recipes, onAutoRefresh }) {
  const { items, checkAndFireAlerts } = useRecipeAlerts();

  // Run transition detection whenever recipes update.
  useEffect(() => {
    if (!recipes || items.length === 0) return;
    checkAndFireAlerts(recipes);
  }, [recipes, items, checkAndFireAlerts]);

  // Background auto-poll. Only runs when at least one alert is set, so users
  // who don't use the feature don't pay for unnecessary polling.
  useEffect(() => {
    if (items.length === 0) return;
    const id = setInterval(onAutoRefresh, RECIPE_ALERT_POLL_MS);
    return () => clearInterval(id);
  }, [items.length, onAutoRefresh]);

  return null;
}
