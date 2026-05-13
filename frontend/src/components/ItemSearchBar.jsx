import { useState, useEffect, useMemo, useRef } from 'react';
import { fetchItems } from '../api/client';
import { useItemModal } from '../context/ItemModalContext';
import ItemNameCell from './ItemNameCell';

// Global item search bar that lives in the page header. Lazy-loads the
// items list on first focus (~4000 entries from /api/items), filters
// client-side as you type, and opens the item-detail modal when you pick
// a result. Replaces the previous recipe search input.
//
// Keyboard: Esc closes the dropdown without selecting. Click anywhere
// outside also closes it.
export default function ItemSearchBar() {
  const [items, setItems] = useState(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const { open: openItemModal } = useItemModal();

  // Lazy fetch: only the first time the user actually focuses the input.
  const ensureLoaded = () => {
    if (items != null) return;
    fetchItems()
      .then((d) => setItems(d.items))
      .catch(() => setItems([]));
  };

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const results = useMemo(() => {
    if (!items || !query.trim()) return [];
    const q = query.toLowerCase();
    return items.filter((it) => it.name.toLowerCase().includes(q)).slice(0, 12);
  }, [items, query]);

  const select = (it) => {
    openItemModal(it.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="item-search-bar" ref={containerRef}>
      <input
        id="search"
        type="search"
        placeholder="Search any item..."
        value={query}
        onFocus={() => {
          ensureLoaded();
          setOpen(true);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        autoComplete="off"
      />
      {open && query.trim() && (
        <div className="item-search-dropdown">
          {items == null && (
            <div className="item-results-hint">Loading item list…</div>
          )}
          {items != null && results.length === 0 && (
            <div className="item-results-hint">No items match "{query}".</div>
          )}
          {results.map((it) => (
            <div
              key={it.id}
              className="item-row"
              onClick={() => select(it)}
            >
              <span className="item-row-name"><ItemNameCell row={it} /></span>
              {it.members && <span className="item-row-chip">M</span>}
              <span className="item-row-id">{it.id}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
