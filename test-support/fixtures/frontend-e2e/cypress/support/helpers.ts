// A Cypress helper that seeds another application: exactly the shape that inflated one app's unmatched count.
export const reset = () => fetch('/api/seed/reset', { method: 'POST' });
