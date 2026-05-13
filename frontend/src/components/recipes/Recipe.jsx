import { useState } from 'react';
import { fmtGp } from '../../utils/format';
import RecipeDetail from './RecipeDetail';

// Single recipe row. Collapsed shows: name + level chip, profit, XP,
// GP/XP, 4hr limit, plus a one-line ingredient summary. Clicking the row
// toggles the expanded RecipeDetail panel underneath. The ★ button
// toggles favorites without expanding the row.
export default function Recipe({ r, isFavorite, onToggleFavorite }) {
  const [open, setOpen] = useState(false);
  const klass = r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : '';

  const lineStr = (l) =>
    `${l.qty > 1 ? `${l.qty}× ` : ''}${l.name}: ${fmtGp(l.unit_price)}`;
  const inline = `${r.inputs.map(lineStr).join(' + ')} → ${r.outputs
    .map(lineStr)
    .join(' + ')}`;

  const xpStr = r.xp ? `${r.xp}` : '—';
  const gpXpStr = r.xp ? fmtGp(Math.round(r.profit / r.xp)) : '—';
  const limitStr = r.buyLimit != null ? r.buyLimit.toLocaleString() : '—';
  const volStr =
    r.outputHourlyVolume != null
      ? r.outputHourlyVolume.toLocaleString()
      : '—';
  // Mark very low volume as a warning — recipe might be a paper profit.
  const lowVolume = r.outputHourlyVolume != null && r.outputHourlyVolume < 10;

  return (
    <>
      <div className={`recipe ${klass}`} onClick={() => setOpen(!open)}>
        <div className="recipe-summary">
          <div className="recipe-name">
            <button
              className={`fav-btn ${isFavorite ? 'on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite(r.name);
              }}
              title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={isFavorite ? 'Unfavorite' : 'Favorite'}
            >
              {isFavorite ? '★' : '☆'}
            </button>
            {r.name}
            {r.levelReq && <span className="level-chip">{r.levelReq}</span>}
          </div>
          <div className="recipe-profit">{fmtGp(r.profit)}</div>
          <div>{xpStr}</div>
          <div>{gpXpStr}</div>
          <div>{limitStr}</div>
          <div
            className={lowVolume ? 'low-vol' : undefined}
            title={lowVolume ? 'Low trade volume — this profit may be hard to realize' : undefined}
          >
            {volStr}
          </div>
        </div>
        <div className="recipe-inline">{inline}</div>
      </div>
      {open && <RecipeDetail r={r} />}
    </>
  );
}
