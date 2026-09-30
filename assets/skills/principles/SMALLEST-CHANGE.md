# P1. Smallest change, subtract first

**Rule.** Aim for the most result with the least code and complexity. Remove before you add, then build on the simpler base.

**Apply.**

- Look for deletions before additions: dead code, redundant validators, stub references, unused options. Subtraction comes before scaffolding.
- Make the smallest change that solves the problem. Fewer lines beat elegant boilerplate.
- Consolidate a decision repeated in several places behind one source of truth, and pass the result as a simple value.
- Question threading. When a task asks you to pass a new signal through types, schemas and layers, look for a more direct path first.
- Design for observed usage. No speculative validators, parsers or guards beyond what the spec demands.
- Sweat the small leaks: tiny pass-throughs, representation leaks and duplicated choices compound into permanent coordination costs.
- Cut before you polish. Reach the minimum before investing in quality.

The smallest change is the smallest correct change. A root-cause fix (P6) or a redesign (P5) can be larger than a patch: minimize the diff of the right fix, never its correctness.

**Test.** Does the diff remove anything? Would a human developer find the result exhausting to maintain? If so, it is a bad solution.

> Leave the design slightly simpler and more capable behind the same or smaller surface than you found it.
