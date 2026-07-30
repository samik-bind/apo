# Task execution remains in the source-owning environment

Apo's native private-Task runtime uses the TypeScript CLI for both one-shot Caller Execution and persistent Connected Executor execution. The Control Plane coordinates typed Task identities, leases, traces, and results, but never requires repository credentials, Task source bytes, filesystem paths, commands, or environment values; this trades server-side reproducibility for a smaller and more trustworthy customer-source boundary, with per-Attempt source attestation preserving honest provenance.
