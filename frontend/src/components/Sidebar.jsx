import {
  FAVORITES_TAB,
  ALCH_TAB,
  FLIPPING_TAB,
  WATCHLIST_TAB,
} from '../utils/constants';
import { useWatchlist } from '../context/WatchlistContext';
import { useItemFavorites } from '../context/ItemFavoritesContext';

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
  // Combined favorites count (recipes + items) for the nav badge.
  const totalFavorites = favoritesCount + favItems.length;
  // Count entries that have at least one fired alert key.
  const alertCount = new Set(
    [...alerts].map((k) => k.split(':')[0])
  ).size;

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
