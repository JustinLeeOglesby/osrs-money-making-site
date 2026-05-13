import { useItemFavorites } from '../../context/ItemFavoritesContext';
import { useItemModal } from '../../context/ItemModalContext';
import ItemFavoriteStar from '../ItemFavoriteStar';
import TabContent from '../recipes/TabContent';

// Aggregated favorites view: items (simple clickable list) on top,
// recipes below. For the live high-alch row format (price, profit,
// volume, etc), use the "★ Favorites only" filter on the High Alch tab —
// that view shares the same columns as the rest of the alch table.
export default function FavoritesTab({ recipes, favorites, onToggleFavorite }) {
  const { items: favItems } = useItemFavorites();
  const { open: openItemModal } = useItemModal();

  const hasItems = favItems.length > 0;
  const hasRecipes = recipes.length > 0;

  if (!hasItems && !hasRecipes) {
    return (
      <div className="no-match" style={{ display: 'block' }}>
        No favorites yet. Click ☆ next to any recipe or item to add it here.
      </div>
    );
  }

  return (
    <div className="favorites-tab">
      {hasItems && (
        <div className="subcat">
          <h2>Items ({favItems.length})</h2>
          <div className="notes" style={{ marginBottom: '0.5em' }}>
            For live prices and the full High Alch row format, use the
            "★ Favorites only" filter on the 🔥 High alch tab.
          </div>
          <div className="fav-items">
            {favItems.map((it) => (
              <div
                key={it.id}
                className="fav-item-row"
                onClick={() => openItemModal(it.id)}
                title="Open item details"
              >
                <ItemFavoriteStar id={it.id} name={it.name} />
                <span className="fav-item-name">{it.name}</span>
                <span className="item-row-id">id {it.id}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {hasRecipes && (
        <TabContent
          recipes={recipes}
          groupBy="category"
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
        />
      )}
      {!hasRecipes && hasItems && (
        <div className="notes" style={{ marginTop: '1em' }}>
          No favorite recipes yet — click ☆ on any recipe row to pin one here.
        </div>
      )}
    </div>
  );
}
