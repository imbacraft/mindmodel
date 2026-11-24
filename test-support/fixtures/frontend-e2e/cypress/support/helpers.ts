// A Cypress helper that seeds another application: the shape that inflated an unmatched frontend-call count.
export const reset = () => fetch('/api/seed/reset', { method: 'POST' });
