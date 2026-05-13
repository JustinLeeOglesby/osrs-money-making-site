import { useItemFavorites } from '../context/ItemFavoritesContext';

// Reusable ☆/★ button for any item. Stops click propagation so it
// doesn't trigger the parent row's onClick (e.g. opening the modal).
export default function ItemFavoriteStar({ id, name }) {
  const { isFavorite, toggle } = useItemFavorites();
  const fav = isFavorite(id);
  return (
    <button
      className={`fav-btn ${fav ? 'on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        toggle(id, name);
      }}
      title={fav ? 'Remove from item favorites' : 'Add to item favorites'}
      aria-label={fav ? 'Unfavorite item' : 'Favorite item'}
    >
      {fav ? '★' : '☆'}
    </button>
  );
}
