"""SPEC-140: ArtifactStore backend implementations.

- ``LocalArtifactStore``: the zero-configuration default, a directory tree
  under the persistent ``/app/data`` volume.
- ``S3ArtifactStore``: optional S3-compatible backend (Ticket 09).
"""

from __future__ import annotations

from apo.services.artifact_stores.local import LocalArtifactStore

__all__ = ["LocalArtifactStore"]
