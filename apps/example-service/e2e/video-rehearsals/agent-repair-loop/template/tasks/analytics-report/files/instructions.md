# Analytics report task

These are **synthetic demo metrics**. They are not real customer, maintainer, or
business data.

## Required workflow

1. `read_file` with `path: "metrics.json"` — load the raw facts.
2. `compute` — derive each metric below from the raw values. Do not do arithmetic
   in your head; call `compute` for each calculation.
3. Write the final report.

## Required metrics

The report MUST contain all of these, each computed from `metrics.json`:

- **Active users**: the `active_users` value.
- **Active-user growth**: `(active_users - previous_active_users) / previous_active_users`, as a percent.
- **30-day retention**: `retained_users_day_30 / eligible_retention_cohort`, as a percent.
- **Revenue**: the `revenue_usd` value.
- **Revenue growth**: `(revenue_usd - previous_revenue_usd) / previous_revenue_usd`, as a percent.

## Report rules

- Quote each computed value with its label so a reader can tell the two growth
  figures and the retention figure apart.
- Do not invent causal explanations (e.g. why retention changed). Only state
  what the supplied metrics support.
