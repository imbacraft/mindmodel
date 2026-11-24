// The app's own frontend: the one call the map must carry.
export function Orders() {
  return fetch('/api/orders', { method: 'GET' });
}
