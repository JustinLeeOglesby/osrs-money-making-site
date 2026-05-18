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
} from '../utils/constants';
import { useWatchlist } from '../context/WatchlistContext';
import { useItemFavorites } from '../context/ItemFavoritesContext';
import { useGELimits, isReady } from '../context/GELimitsContext';
import { useRoguesList } from '../context/RoguesListContext';
import { useRoguesLab } from '../context/RoguesLabContext';
import { useRecipeAlerts } from '../context/RecipeAlertsContext';

// Left-nav sidebar. "Pinned" section holds the always-available special
// tabs (favorites / item search / high alch); "Categories" holds the
// dynamic recipe categories (Smithing, Herblore, etc.). Driven entirely
// by props — App owns the active tab + selection state.
export default function Sidebar({
  activeTab,
  onSelectTab,
  favoritesCount,
  categories,
  recipeCountByCategory,
}) {
  const { items: watchedItems, alerts } = useWatchlist();
  const { items: favItems } = useItemFavorites();
  const { entries: geLimitEntries, now: geLimitsNow } = useGELimits();
  const { count: roguesCount } = useRoguesList();
  const { count: labCount } = useRoguesLab();
  const { items: alertItems, triggered: alertTriggered } = useRecipeAlerts();
  // Combined favorites count (recipes + items) for the nav badge.
  const totalFavorites = favoritesCount + favItems.length;
  // Count entries that have at least one fired alert key.
  const alertCount = new Set(
    [...alerts].map((k) => k.split(':')[0])
  ).size;
  // Number of GE limit timers that have rolled over to "ready" — shown as
  // a red badge so the user knows they can re-buy.
  const readyCount = geLimitEntries.filter((e) => isReady(e, geLimitsNow)).length;

  return (
    <nav className="sidebar">
      <div className="sidebar-section">
        <div className="sidebar-section-label">Pinned</div>
        <NavItem
          label={FAVORITES_TAB}
          count={totalFavorites}
          active={FAVORITES_TAB === activeTab}
          onClick={() => onSelectTab(FAVORITES_TAB)}
        />
        <NavItem
          label={WATCHLIST_TAB}
          count={watchedItems.length}
          badge={alertCount > 0 ? alertCount : null}
          active={WATCHLIST_TAB === activeTab}
          onClick={() => onSelectTab(WATCHLIST_TAB)}
        />
        <NavItem
          label={ALCH_TAB}
          active={ALCH_TAB === activeTab}
          onClick={() => onSelectTab(ALCH_TAB)}
        />
        <NavItem
          label={FLIPPING_TAB}
          active={FLIPPING_TAB === activeTab}
          onClick={() => onSelectTab(FLIPPING_TAB)}
        />
        <NavItem
          label={GE_LIMITS_TAB}
          count={geLimitEntries.length}
          badge={readyCount > 0 ? readyCount : null}
          active={GE_LIMITS_TAB === activeTab}
          onClick={() => onSelectTab(GE_LIMITS_TAB)}
        />
        <NavItem
          label={CHAIN_TAB}
          active={CHAIN_TAB === activeTab}
          onClick={() => onSelectTab(CHAIN_TAB)}
        />
        <NavItem
          label={SHOPS_TAB}
          active={SHOPS_TAB === activeTab}
          onClick={() => onSelectTab(SHOPS_TAB)}
        />
        <NavItem
          label={ROGUES_LIST_TAB}
          count={roguesCount > 0 ? roguesCount : null}
          active={ROGUES_LIST_TAB === activeTab}
          onClick={() => onSelectTab(ROGUES_LIST_TAB)}
        />
        <NavItem
          label={ROGUES_LAB_TAB}
          count={labCount > 0 ? labCount : null}
          active={ROGUES_LAB_TAB === activeTab}
          onClick={() => onSelectTab(ROGUES_LAB_TAB)}
        />
        <NavItem
          label={ALERTS_TAB}
          count={alertItems.length > 0 ? alertItems.length : null}
          badge={alertTriggered.size > 0 ? alertTriggered.size : null}
          active={ALERTS_TAB === activeTab}
          onClick={() => onSelectTab(ALERTS_TAB)}
        />
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-label">Categories</div>
        {categories.map((c) => (
          <NavItem
            key={c}
            label={c}
            count={recipeCountByCategory.get(c)}
            active={c === activeTab}
            onClick={() => onSelectTab(c)}
          />
        ))}
      </div>
    </nav>
  );
}

function NavItem({ label, count, badge, active, onClick }) {
  return (
    <div className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <span style={{ display: 'inline-flex', gap: '0.3em', alignItems: 'center' }}>
        {badge != null && <span className="nav-badge">{badge}</span>}
        {count != null && <span className="nav-count">{count}</span>}
      </span>
    </div>
  );
}
