import { useState } from 'react';
import ColHeaders from './ColHeaders';
import Recipe from './Recipe';

// One named group of recipes (e.g. "Smelt bars", "Enchant amulets").
// Renders its own column header so the table-like layout repeats per
// group even though it isn't a real HTML <table>. Clicking the h2 toggles
// the section open/closed — useful on the Favorites tab where you might
// want to collapse big categories, but harmless on the regular tabs.
export default function Subcategory({ name, recipes, favorites, onToggleFavorite }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`subcat ${open ? '' : 'collapsed'}`}>
      <h2
        className="subcat-header"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Collapse section' : 'Expand section'}
      >
        <span className="caret">{open ? '▾' : '▸'}</span>
        {name}{' '}
        <span className="subcat-count">({recipes.length})</span>
      </h2>
      {open && (
        <>
          <ColHeaders />
          {recipes.map((r, i) => (
            <Recipe
              key={`${r.name}-${i}`}
              r={r}
              isFavorite={favorites.has(r.name)}
              onToggleFavorite={onToggleFavorite}
            />
          ))}
        </>
      )}
    </div>
  );
}
