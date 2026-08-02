# Version Task definitions separately from execution source

This refines the source-owned boundary in ADR 0005: Apo stores the bounded
Task Definition Source (`*.eval.ts`) as a private, immutable, content-addressed
Task Definition Revision, while the application workspace remains local and is
represented only by an Execution Revision attestation. Task Catalog publication
selects the current Definition Revision and each Task Run pins the exact
Revision it used; the Control Plane stores the definition as inert text and
never executes it.

Keeping definitions metadata-only made historical Runs unable to show what was
tested, while uploading a repository or Execution Bundle would violate the
source-owned trust boundary. Attaching source text directly to every result
would duplicate data and leave pre-execution failures without a definition, so
definitions are persisted before execution and Runs reference them by identity.
