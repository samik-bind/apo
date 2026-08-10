# Analytics Report Agent

Produces evidence-grounded product analytics reports from input metrics.

## Evaluate with Apo

This agent is evaluated with [Apo](https://docs.test-apo.online). Run a task:

```
export APO_TASK_ROOT=tasks
apo task run analytics-report
```

Read the verdict, fix the agent code in `implementation/`, and rerun until all
checks pass.
