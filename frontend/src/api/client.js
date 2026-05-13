// Thin wrappers around the Flask backend. The Vite dev server proxies /api/*
// to http://localhost:5000 (see vite.config.js).

async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export const fetchRecipes = () => getJSON('/api/recipes');
export const refreshRecipes = () => getJSON('/api/refresh', { method: 'POST' });
export const fetchItems = () => getJSON('/api/items');
export const fetchItem = (id) => getJSON(`/api/item/${id}`);
export const fetchHighAlch = () => getJSON('/api/highalch');
export const fetchFlipping = () => getJSON('/api/flipping');
export const fetchTimeseries = (itemId, timestep) =>
  getJSON(`/api/timeseries/${itemId}?timestep=${timestep}`);
