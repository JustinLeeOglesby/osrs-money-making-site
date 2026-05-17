import { useRoguesList } from '../context/RoguesListContext';
import { ROGUES_LIST_MAX } from '../utils/constants';

// 🎒 toggle for adding/removing an item from the active Rogues' Den 27-slot
// list. Mirrors ItemFavoriteStar but for the running shopping list.
// When the list is full, attempting to add gives a tooltip hint.
export default function RoguesListToggle({ id, name }) {
  const { isOnList, add, remove, isFull } = useRoguesList();
  const on = isOnList(id);
  const disabled = !on && isFull;

  const onClick = (e) => {
    e.stopPropagation();
    if (on) {
      remove(id);
    } else if (!isFull) {
      add(id, name);
    }
  };

  return (
    <button
      className={`rogues-toggle ${on ? 'on' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={
        on
          ? "Remove from Rogues' list"
          : disabled
            ? `Rogues' list is full (${ROGUES_LIST_MAX} slots)`
            : "Add to Rogues' list"
      }
      aria-label={on ? "Remove from Rogues' list" : "Add to Rogues' list"}
    >
      🎒
    </button>
  );
}
