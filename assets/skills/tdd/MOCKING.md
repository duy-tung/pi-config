# When to mock

Mock at **system boundaries** only: third-party APIs (payment, email, SMS), time, and randomness. Do not mock your own modules, internal collaborators, or anything you control. Do not mock what you can run.

Pick the test double by the dependency's category (the same four categories the `codebase-design` skill uses):

| Category | Example | In tests |
|---|---|---|
| In-process | Pure computation, in-memory state | No double. Call it. |
| Local-substitutable | Postgres, the filesystem | Run the local stand-in: PGLite or SQLite, a temp directory, an in-memory filesystem. |
| Remote but owned | Your own service behind a network call | An in-memory adapter at the port; production uses the HTTP, gRPC or queue adapter. |
| True external | Stripe, Twilio | A mock adapter injected at the port. |

## When you do mock, assert what crossed the boundary

Assert the payload the mock received, or the state after the call. A mock that only records "called" passes when the subject does nothing useful.

## Design for it

**Inject dependencies.** Pass external dependencies in rather than creating them inside.

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**One function per external operation, not a generic fetcher.**

```typescript
// GOOD: each function mocks independently and returns one shape
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch("/orders", { method: "POST", body: data }),
};

// BAD: the mock needs conditional logic to answer each endpoint
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

Each mock returns one shape, test setup has no conditionals, the endpoints a test touches are visible, and each endpoint keeps its own types.
