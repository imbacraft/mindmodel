// An end-to-end spec: it drives a *running* application from a browser, so its calls are the test's, not this app's.
describe('admin', () => {
  it('creates a user', () => {
    cy.request({ url: '/api/admin/users', method: 'POST' });
  });
});
