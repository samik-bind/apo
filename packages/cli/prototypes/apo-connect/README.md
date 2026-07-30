# PROTOTYPE — `apo connect` lifecycle

This throwaway prototype asks whether one explicit `apo connect` session can
make catalog publication, dashboard runner availability, source changes, queued
runs, and disconnects feel coherent without exposing Executor/Pool machinery to
the user.

It models no network or persistence. Drive the state machine with:

```bash
pnpm prototype:apo-connect
```

Delete the TUI after the lifecycle decision is captured in the eventual
connected-workspace specification.
