## Signal Monitor

Automated daily fetch of water/energy/infrastructure signals from Google News RSS.

Stores results in Supabase `signals_raw` table for analysis.

### Queries monitored
Defined in `QUERIES` in `fetch-signals.js`, grouped as:
- **California water-rights jurisdiction** (US-geo): pre-1914 rights, CalWATRS/eWRIMS,
  SGMA enforcement, curtailment/seniority, paper vs wet water
- **Global**: water-rights trading, aquifer depletion, water stress, drought emergencies,
  snowpack, data-center moratoriums, data-center water/cooling, interconnection queue and
  transformer shortage, electricity rate cases for large loads, water-infrastructure attacks
- **Central Asia / CIS**: Caspian level, Aral / Syr Darya / Amu Darya, Kazakhstan / Balkhash / Ili

### Retention — read this before assuming the archive is cumulative
On each run the script deletes rows older than `RETENTION_DAYS` (default 90) **that have
`is_relevant IS NULL`**. Nothing sets `is_relevant` automatically. Unless rows are marked
by hand, the table is a rolling 90-day window, not an archive. Set `is_relevant = true`
on anything worth keeping. Override the window with the `RETENTION_DAYS` env var.

### Deduplication
Two layers:
1. `UNIQUE(title, source)` in Postgres, via `on_conflict=title,source` — exact repeats.
2. Per-query reprint collapsing on title similarity (Jaccard over content words,
   threshold 0.7) — catches wire copy filed by many outlets under one headline.
   A date-marker guard prevents recurring reports (e.g. monthly Drought.gov editions)
   from being merged into each other.
   Measured on a real day of output (1197 items): 27 collapsed, ~2%. Differently-worded
   coverage of the same story does **not** collapse; that needs content-level clustering.

### Scheduled-workflow inactivity
GitHub disables `schedule` triggers in public repos after 60 days with no repository
activity, without notice. This happened on 2026-07-08 and cost 41 days of collection.
The workflow now writes a `.last-run` heartbeat commit at most once every 6 days on
scheduled runs, which keeps the inactivity clock reset. If collection stops again, check
`gh api repos/<owner>/signal-monitor/actions/workflows` for `state: disabled_inactivity`
and re-enable with the `/enable` endpoint.

### Setup
1. Add `SUPABASE_KEY` to repository secrets
2. GitHub Actions runs daily at 06:00 UTC
3. Manual trigger available via workflow_dispatch
