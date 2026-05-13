import { createContext, useContext } from 'react';

// Any descendant can call useItemModal().open(itemId) to pop a global
// item-detail modal. App owns the state + renders the modal at the root.
export const ItemModalContext = createContext({ open: () => {} });

export const useItemModal = () => useContext(ItemModalContext);
