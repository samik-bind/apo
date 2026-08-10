# Analytics report task

These are **synthetic demo metrics**. They are not real customer, maintainer, or
business data.

## Required workflow

You MUST ground every number in the input files by calling tools in this order:

1. `list_files` — discover the available inputs. You do not know the filenames
   ahead of time; this call is required.
2. `read_file` — read the file that contains the product metrics (the one whose
   name `list_files` returned).
3. `compute` — derive the metrics below from the raw values. Do not do arithmetic
   in your head; call `compute` for each calculation.
4. Write the final report.

## Required metrics

The metrics file contains these raw fields (call `list_files` then `read_file`
to see them):

- `active_users` and `previous_active_users`
- `eligible_retention_cohort` and `retained_users_day_30`
- `revenue_usd` and `previous_revenue_usd`

The report MUST contain all of these, each computed via the `compute` tool:

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
