import ItemSearchBar from './ItemSearchBar';

// Top-of-page header: title, metadata, refresh-prices button, and the
// global item search bar (replaces the old recipe-search input).
export default function Header({
  recipeCount,
  strategyLabel,
  refreshing,
  onRefresh,
}) {
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
      <ItemSearchBar />
    </header>
  );
}
