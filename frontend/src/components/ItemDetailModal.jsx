import { useEffect } from 'react';
import ItemDetail from './items/ItemDetail';

// Centered modal wrapping ItemDetail. Closes on backdrop click, the ✕
// button, or the Escape key.
export default function ItemDetailModal({ itemId, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          ×
        </button>
        <ItemDetail itemId={itemId} />
      </div>
    </div>
  );
}
