# Databricks analytics and system tables

## What this source contains

Databricks is the product-analytics, data-pipeline, and warehouse-telemetry layer. It complements infrastructure observability: Datadog is the *infra and runtime* view, Databricks is the *product and data* view (what users did, which experiments ran, how feature usage evolved, where a threshold constant came from).

The table names below come from an example warehouse. Yours will differ: probe before you trust a name.

- **Product analytics events.** A raw event table (`your_warehouse.events.analytics_track_event` in the example) and typed, deduplicated per-event dbt models in `<your_analytics_db>.<schema>.<table>`. User behavior: feature invocations, clicks, accepts and rejects, submissions, client-reported errors.
- **Usage and billing events.** `your_warehouse.events.usage_event` and its staging model, `your_warehouse.events.raw_model_event` and its staging model. For cost- or volume-driven decisions.
- **Experiment and feature-flag data.** Exposure and outcome tables. **The schema is company-specific.** Probe with `SHOW TABLES` before assuming names.
- **System tables.** `system.query.history`, `system.compute.warehouses`, `system.billing.*`, `system.access.audit`. Answer "was this query expensive?", "how often did anyone run this?", "when did warehouse load spike?"
- **dbt lineage.** Models in `<your_analytics_db>.<schema>` reveal what pipelines depend on a table or field. Upstream changes frequently motivate consumer-code changes.
- **Databricks notebooks.** Exploratory analyses engineers wrote before code changes. **Not queryable through the SQL server.** If you suspect the rationale lives in a notebook, name it as a gap.

## How to search it

Use the Databricks SQL MCP server (Pi's built-in MCP; its tools are called directly as `mcp__<server>__<tool>`); adapt for Snowflake, BigQuery, ClickHouse, or dbt. Primary tool: `execute_sql_read_only`. If it returns a `statement_id`, poll with `poll_sql_result` rather than re-running.

**Orient before querying.** Schemas are company-specific. Probe before trusting a table name:

```sql
SHOW TABLES IN <your_analytics_db>.<schema> LIKE '*<keyword>*';
DESCRIBE TABLE <your_analytics_db>.<schema>.stg_<event>;
```

**Time-bound every query.** These tables are huge and unconstrained scans time out. Filter on the event timestamp (`_timestamp` in the example) or `start_time` (`system.query.history`) with a window bracketing the ship date, typically about 30 days before and after, wider only for a strong reason.

**Prefer typed dbt models over the raw table.** The typed models are deduplicated, typed, and clustered; the raw table has duplicates and untyped JSON properties. In the example warehouse the model name pattern is `stg_<source>_<event_name_with_underscores>`, where `<source>` is `app`, `backend`, `website`, or `cli`. Confirm the exact model name with `SHOW TABLES` when a pattern alone doesn't resolve it. Drop to the raw table only when there's no dbt model yet, or you need events from inside the dbt refresh lag.

**Column conventions** in the example warehouse's typed models (knowing your own saves a `DESCRIBE` round trip):

- `_timestamp`, `_id`, `_auth_id`, `_request_id`, `event_name`: standard on every model
- `properties_<name>`: typed, underscore-cased event properties (`properties_entrypoint`, `properties_size_bytes`, and so on)
- `context_team_id`, `context_client_version`, `context_country`, `context_client_os`: pre-extracted client context

### Investigation patterns that tend to pay off

Pick the table and column combination that matches the target:

1. **Event usage trajectory.** Daily counts on the relevant model across a window of about 30 days either side of the PR merge. A step function from zero to steady volume within a day or two of the merge is strong circumstantial evidence the PR launched the feature. A decay to zero suggests a deprecation or deletion.
2. **Guard-rail or defensive-check origin.** The distribution (median, p99, max) of the relevant property column in the 14 days *before* the PR. A p99 that matches the target's threshold constant suggests the number was chosen from data.
3. **Experiment or feature-flag lookup.** `SHOW TABLES ... LIKE '*experiment*'` to find the exposure table, then pull exposure counts by variant for the relevant flag key near the PR date.
4. **Query-history evidence for migrations, backfills, or performance rewrites.** `system.query.history` filtered by `statement_text ILIKE '%<table_or_symbol>%'` with a tight `start_time` window surfaces the expensive queries that likely motivated the change (sort by `total_duration_ms`, or aggregate `SUM(read_bytes)` and `COUNT(*)`).
5. **dbt lineage.** If the target reads from or writes into a dbt model, the model's own git history (in this repo) often carries the rationale. Hand that lead back to the source control investigator rather than chasing it yourself.

## What good evidence looks like here

Beyond the pattern shapes above:

- An error-classifying event's count drops to near zero in the days after a defensive-code PR. Suggests the PR resolved that error class
- An exposure table row names the target's feature-flag key with a "shipped" or "concluded" decision around the PR ship date

## Common pitfalls

- **Instrumented is not caused.** An event's existence means someone cared enough to log it, not that the target code exists *because* of it. Pair it with a PR or commit citation from the source control investigator before claiming causation.
- **Silent instrumentation changes.** A step function in event volume may mean a new event started being logged, not that user behavior changed. Check for instrumentation PRs in the same window before reading the ramp as a feature-launch signal.
- **Schema drift.** Event properties evolve. A column on the typed model today may not have existed when the target was written. Older data may carry the property only inside the raw JSON properties.
- **dbt refresh lag.** The typed models are rebuilt on a schedule (often hourly or daily). For events from the last few hours, fall back to the raw tables and deduplicate by event ID.
- **Company-specific tables.** Experiment, feature-flag, billing, and usage tables vary. Reporting a result from a table whose existence you never confirmed is a classic failure mode. Probe with `SHOW TABLES` and `DESCRIBE TABLE` first.
- **Retention cliff.** If the relevant window predates the table's retention or the dbt model's creation date, that's a *gap*, not a null result. Name it explicitly so the synthesizer doesn't read "no results" as "no activity."
- **Notebooks aren't queryable.** The SQL server can't see Databricks notebooks. If you suspect the rationale lives in one, return a gap.

## What to return

For each relevant finding:

- Type (product event, experiment exposure, usage or billing event, system-table row, dbt model)
- Fully qualified table name and the exact query you ran
- Time window queried
- Compact numeric summary (counts, percentiles, first and last seen timestamps). **Don't dump raw rows.**
- Temporal correlation with the target's ship date (for example "first row 2024-08-15, PR #49074 merged 2024-08-14")
- Relevance and strength: direct, circumstantial, or weak
