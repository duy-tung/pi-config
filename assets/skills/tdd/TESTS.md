# Good and bad tests

Examples use Vitest or Jest. The same shapes apply in pytest, XCTest and JUnit; pytest equivalents are at the end.

## Good: behavior through the public interface

```typescript
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

It tests what callers care about, uses the public API only, survives internal refactors, names WHAT rather than HOW, and makes one logical assertion.

## Implementation-coupled

```typescript
// BAD: asserts on an internal collaborator
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

Red flags: mocking internal collaborators, testing private methods, asserting call counts or order, a name that describes HOW, a test that breaks on a refactor that kept behavior.

```typescript
// BAD: verifies through a side channel
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: verifies through the interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

## Tautological

```typescript
// BAD: expected value recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

The undefined-import test does not catch this one: `calculateTotal` returning `undefined` would fail it. It is banned because a wrong but consistent formula passes.

## The five shapes that cannot fail for a defect

**Weak or no assertion.**

```typescript
// BAD
expect(parseConfig(raw)).toBeDefined();
// GOOD
expect(parseConfig('{"port": 8080}')).toEqual({ port: 8080 });
```

**Mock or absence only.**

```typescript
// BAD: only proves the mock was touched
await sendWelcome(user);
expect(mailer.send).toHaveBeenCalled();

// GOOD: assert the payload that crossed the boundary
await sendWelcome({ email: "ada@example.com", name: "Ada" });
expect(mailer.send).toHaveBeenCalledWith(
  expect.objectContaining({ to: "ada@example.com", subject: "Welcome, Ada" }),
);

// BAD: absence alone
expect(findUser("missing")).toBeUndefined();

// GOOD: presence on the other input, in the same test
expect(findUser("ada")?.name).toBe("Ada");
expect(findUser("missing")).toBeUndefined();
```

**Self-referential.**

```typescript
// BAD: both sides come from the code under test
expect(slugify(title)).toBe(slugify(title.trim()));
// GOOD
expect(slugify("  Hello, World! ")).toBe("hello-world");
```

**Constant pin.**

```typescript
// BAD: restates the constant
expect(LIMITS.maxTools).toBe(8);
// GOOD: exercises the mechanism that reads it
expect(() => registerTools(nineTools)).toThrow("at most 8 tools");
```

**Fixture asserts fixture.**

```typescript
// BAD: the subject never runs in the body
beforeEach(() => {
  cart = { items: [apple, pear], total: 15 };
});
test("cart total", () => {
  expect(cart.total).toBe(15);
});

// GOOD
test("cart total", () => {
  expect(totalOf([apple, pear])).toBe(15);
});
```

## Keep

- A relation across a table's rows: a key present in two tables, a parent row that exists.
- A compile-time check in a `*.test-d.ts` file.

## pytest equivalents

- Weak: `assert result`, `assert result is not None`, `assert len(items) > 0`.
- Mock only: `mock.assert_called_once()` with no argument check.
- Self-referential: `assert f(x) == f(x)`.
- Good: `assert slugify("Hello, World!") == "hello-world"`.
