# Incident and postmortem context

Not a separate source: a **cross-cutting angle**. Incidents often motivate defensive code ("we added this check after the X outage"). When the target looks defensive (null checks, retry logic, timeout handling, rate limiting, feature flags, egress guards, OOM handlers), hunt for incident history inside your assigned source:

- **Long-form documents**: search for postmortems mentioning the target file, feature, or error string
- **Tracker**: look for tickets labeled `incident`, `sev-*`, `postmortem-action-item`, `reliability`
- **Chat**: search `#sev-*` and `#incident-*` channels around the dates the target code was added
- **Git**: commits with messages like "fix for incident", "add defensive check", or "revert" followed by "re-apply with..." are strong signals
- **Infrastructure observability**: formal incident records with timelines, and dashboards and monitors created as postmortem action items
- **Error tracking**: issues whose first and last seen window aligns with the target's PR ship date, and stack traces through the target
- **Analytics warehouse**: product events that classify an error condition (client-reported failures, user-visible retry events) often spike during an incident window. A drop in that event count after the target PR ships is circumstantial support that the target code resolved the user-visible symptom, even when the observability and error-tracking signal is noisy.

If you find an incident link, fetch the full postmortem. Postmortems typically have an "Action items" section that ties directly to code changes. When multiple sources corroborate (an incident ID appears in a tracker ticket, which appears in a postmortem doc, which appears in a chat thread that links to the target PR, and the warehouse error-event count drops after the fix), the evidence is especially strong.

Worth the time when the code's defensive character makes an incident-driven origin plausible. Skip it for code that doesn't look defensive.
