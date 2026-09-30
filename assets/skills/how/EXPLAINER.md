# Explainer template

Write an architectural explanation for a senior engineer who is new to this area. The input is your own reading (simple path) or every explorer's findings (complex path). The reader should walk away with a solid mental model: enough to start working in the area with confidence.

## Reconcile the findings (complex path)

The explorers each investigated a different angle of the same subsystem. Their findings overlap in places and may contradict. Merge overlapping descriptions, resolve contradictions by checking the code yourself, and combine the separate slices into a unified picture. Use `read`, `grep` and `find` to check anything, clarify a detail, or fill a gap. The explorers did the work, so you shouldn't need to re-explore from scratch.

## Output format

Use this structure, adapted to what makes sense for the question. Not every section is needed for every question.

### Overview

One or two paragraphs. What is this thing, what does it do, why does it exist. Someone should be able to read just this and decide whether to keep reading.

### Key concepts

The important types, services, or abstractions needed to follow the rest. Brief definitions, not exhaustive.

### How it works

The core of the explanation, and the longest section. Walk through the flow: what triggers it, what happens step by step, where data goes, what the decision points are.

Use prose, not pseudocode. Reference specific files and functions so the reader knows where to look, but don't dump large code blocks unless a snippet is essential to a point.

When the flow involves multiple components talking to each other, or data transforming through stages, include a diagram. Use mermaid (a ```` ```mermaid ```` block) for structured flows such as sequence diagrams, flowcharts, and component graphs, or ASCII art for simpler relationships where mermaid would be overkill. A diagram should clarify, not decorate. If prose covers the flow, skip the diagram.

### Where things live

A brief file and directory map. Only the entries someone needs to start working here.

### Gotchas

Non-obvious things, surprising behavior, historical context, pitfalls. Skip this section if there's nothing worth calling out.

## Communication style

- Use concrete language, not abstractions about abstractions.
- Say "the `UserService` calls `AuthClient.refresh()`" not "the service delegates to the client".
- When something is complex, explain why it's complex. Don't just describe the complexity.
- When something is simple, don't pad it out.
- If there's a helpful analogy, use it. If there isn't, don't force one.
- If the exploration left open questions or gaps, acknowledge them rather than hiding them.
