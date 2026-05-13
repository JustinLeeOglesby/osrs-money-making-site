import { useMemo } from 'react';
import Subcategory from './Subcategory';

// Renders all recipes for a tab grouped into subcategories.
//
// Props:
//   recipes          recipes to show (already filtered to the active tab)
//   groupBy          'subcategory' (default) or 'category' (used by the
//                    Favorites tab so cross-category favorites group nicely)
//   sortGroupsBy     'name' (alphabetical, default) or 'maxProfit' (used by
//                    the Decanting tab so the most profitable potion floats up)
//   favorites        Set of favorited recipe names
//   onToggleFavorite callback to toggle a name in the favorites set
//   emptyMessage     custom message when the recipe list is empty
export default function TabContent({
  recipes,
  groupBy,
  sortGroupsBy,
  favorites,
  onToggleFavorite,
  emptyMessage,
}) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const r of recipes) {
      const key = r[groupBy] || '(uncategorized)';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    for (const arr of map.values()) arr.sort((a, b) => b.profit - a.profit);
    const entries = [...map.entries()];
    if (sortGroupsBy === 'maxProfit') {
      entries.sort(
        ([, ra], [, rb]) => (rb[0]?.profit ?? -Infinity) - (ra[0]?.profit ?? -Infinity)
      );
    } else {
      entries.sort(([a], [b]) => a.localeCompare(b));
    }
    return entries;
  }, [recipes, groupBy, sortGroupsBy]);

  if (recipes.length === 0) {
    return (
      <div className="no-match" style={{ display: 'block' }}>
        {emptyMessage || 'No recipes in this category.'}
      </div>
    );
  }

  return (
    <>
      {grouped.map(([sub, rs]) => (
        <Subcategory
          key={sub}
          name={sub}
          recipes={rs}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
        />
      ))}
    </>
  );
}
