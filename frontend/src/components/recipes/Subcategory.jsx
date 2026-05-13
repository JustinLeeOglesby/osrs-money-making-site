import ColHeaders from './ColHeaders';
import Recipe from './Recipe';

// One named group of recipes (e.g. "Smelt bars", "Enchant amulets").
// Renders its own column header so the table-like layout repeats per
// group even though it isn't a real HTML <table>.
export default function Subcategory({ name, recipes, favorites, onToggleFavorite }) {
  return (
    <div className="subcat">
      <h2>{name}</h2>
      <ColHeaders />
      {recipes.map((r, i) => (
        <Recipe
          key={`${r.name}-${i}`}
          r={r}
          isFavorite={favorites.has(r.name)}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </div>
  );
}
