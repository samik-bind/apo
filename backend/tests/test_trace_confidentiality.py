# pyright: reportAny=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false
# pyright: reportAttributeAccessIssue=false

"""Trace confidentiality — anonymous sharing removed.

These tests assert that legacy anonymous Trace routes are gone and that
authenticated Trace detail still works without publication state.
"""

from __future__ import annotations

import pytest


class TestAnonymousRoutesRemoved:
    """GET /public/traces/{id} and PATCH /v1/runs/{id}/visibility return 404."""

    def test_anonymous_trace_get_returns_404(self, client: object) -> None:
        resp = client.get("/public/traces/some-run-id?project=test")  # type: ignore[attr-defined]
        assert resp.status_code == 404
        assert b"traceId" not in resp.content
        assert b"is_public" not in resp.content

    def test_anonymous_trace_get_with_auth_still_404(self, client: object) -> None:
        resp = client.get("/public/traces/some-run-id?project=test")  # type: ignore[attr-defined]
        assert resp.status_code == 404

    def test_visibility_patch_returns_404(self, client: object) -> None:
        resp = client.patch(  # type: ignore[attr-defined]
            "/v1/runs/some-run-id/visibility?project=test",
            json={"is_public": True},
        )
        assert resp.status_code == 404


class TestPublicPathNotAnonymous:
    """/public is not in the anonymous prefix list."""

    def test_public_prefix_not_anonymous(self) -> None:
        from apo.auth.middleware import _is_public

        assert not _is_public("/public")
        assert not _is_public("/public/traces/abc")
        assert not _is_public("/public/anything")

    def test_supported_public_routes_still_anonymous(self) -> None:
        from apo.auth.middleware import _is_public

        # These must remain anonymous — they are NOT trace sharing.
        assert _is_public("/api/public/health")
        assert _is_public("/health")


class TestRunResponseOmitsIsPublic:
    """The Run response model no longer includes is_public."""

    def test_run_schema_has_no_is_public(self) -> None:
        from apo.models.schemas import Run

        assert not hasattr(Run, "is_public") or "is_public" not in Run.model_fields
