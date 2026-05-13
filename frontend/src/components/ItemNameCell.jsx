import { VOLATILITY_THRESHOLD } from '../utils/constants';
import ItemFavoriteStar from './ItemFavoriteStar';

// Displays an item name plus a favorite ★ toggle and an inline ⚡
// volatility badge when its `recentMovePct` field has moved more than the
// configured threshold against the last-hour average insta-buy price.
// The "up" variant shades gold, the "down" variant blue.
//
// The favorite star is shown when the row has an `id` field (which all
// item-table rows do) — for non-item contexts (no id), it's hidden.
export default function ItemNameCell({ row }) {
  const move = row.recentMovePct;
  const isVolatile = move != null && Math.abs(move) >= VOLATILITY_THRESHOLD;
  return (
    <>
      {row.id != null && <ItemFavoriteStar id={row.id} name={row.name} />}
      {row.name}
      {isVolatile && (
        <span
          className={`volatility-badge ${move > 0 ? 'up' : 'down'}`}
          data-tooltip={`Recent move: ${move > 0 ? '+' : ''}${move}% (current price vs last-hour avg insta-buy)`}
        >
          ⚡ {move > 0 ? '+' : ''}
          {move}%
        </span>
      )}
    </>
  );
}
