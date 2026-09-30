# P8. The consumer's usage is the spec

**Rule.** Write how the consumer uses the thing before the types and the implementation. When implementation convenience conflicts with the consumer's experience, choose the experience.

**Apply.**

- Name the consumer: the end user for a UI, the colleague who imports a library or internal API, and always the engineer who maintains the code next.
- Sketch the call site or the user flow first, then derive the types and signatures from it.
- Every feature, control and option must earn its place. Ship fewer, finished features: half-finished features are worse than missing ones.
- Get the details right: feedback, transitions, alignment, spacing, and the empty, loading and error states.
- When feel decides, prototype before committing (P7).
- Explain the impact from the consumer's side before any implementation detail.

**Test.** Can you say what the consumer will notice? If not, the work or the explanation is off.

> The engineer who maintains the code next is a user too.
