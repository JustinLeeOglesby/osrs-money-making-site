import ItemSearchBar from './ItemSearchBar';
import { usePace } from '../context/PaceContext';
import { PACE_PRESETS } from '../utils/constants';

// Top-of-page header: title, metadata, refresh-prices button, pace selector
// (for gp/hr estimates on recipe rows), and the global item search bar.
export default function Header({
  recipeCount,
  strategyLabel,
  refreshing,
  onRefresh,
}) {
  const { pace, setPace, actionsPerHour } = usePace();
  return (
    <header>
      <h1>
        OSRS Margin Tracker{' '}
        <span style={{ opacity: 0.5, fontSize: '0.75em' }}>(React + Flask)</span>
      </h1>
      <div className="meta">
        {recipeCount} recipes priced · Strategy: {strategyLabel}
        {' · '}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          style={{
            marginLeft: '0.5em',
            padding: '0.25em 0.7em',
            background: 'var(--bg-3)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: '3px',
            cursor: refreshing ? 'wait' : 'pointer',
            fontSize: '0.9em',
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh prices'}
        </button>
      </div>
      <div className="header-controls">
        <ItemSearchBar />
        <div
          className="pace-selector"
          title={`Crafts per hour for the gp/hr estimate (currently ~${actionsPerHour}/hr)`}
        >
          <span className="pace-label">Pace:</span>
          {PACE_PRESETS.map((p) => (
            <button
              key={p.key}
              className={`range-btn ${pace === p.key ? 'active' : ''}`}
              onClick={() => setPace(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
