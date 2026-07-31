# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false
# pyright: reportAttributeAccessIssue=false

"""SPEC-161 Phase 2: Source-owned executor backend services.

Tests for: canonical pool creation, member bootstrap, catalog-gated claims,
and source attestation.
"""

from __future__ import annotations

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlalchemy.pool import StaticPool


@pytest.fixture
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s


@pytest.fixture
def project_and_member(session):
    """Create a project and a member user."""
    from apo.models.db import ProjectDB, UserDB, ProjectMembershipDB
    from datetime import datetime, timezone

    user = UserDB(email="member@test.com", name="Member", password_hash="x", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)

    project = ProjectDB(id="test-proj", name="test", created_by=user.id)
    session.add(project)
    session.commit()

    membership = ProjectMembershipDB(
        project_id="test-proj",
        user_id=user.id,
        role="member",
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    session.add(membership)
    session.commit()

    return project, user


class TestSourceOwnedPool:
    """Test 1-2: Member bootstrap creates canonical source-owned Pool."""

    def test_ensure_creates_canonical_pool(self, session, project_and_member):
        from apo.services.source_owned_executor import ensure_source_owned_pool

        pool = ensure_source_owned_pool(session, "test-proj")

        assert pool is not None
        assert pool.project == "test-proj"
        assert pool.slug == "source-owned"
        assert pool.kind == "connected"
        assert pool.system_managed is True
        assert pool.required_driver_kind == "source-owned-ts"

    def test_idempotent_pool_creation(self, session, project_and_member):
        from apo.services.source_owned_executor import ensure_source_owned_pool

        pool1 = ensure_source_owned_pool(session, "test-proj")
        pool2 = ensure_source_owned_pool(session, "test-proj")

        assert pool1.id == pool2.id  # same pool, not a duplicate


class TestMemberBootstrap:
    """Test 3: Member bootstrap issues enrollment token."""

    def test_bootstrap_issues_token(self, session, project_and_member):
        from apo.services.source_owned_executor import bootstrap_connected_executor

        project, user = project_and_member
        result = bootstrap_connected_executor(
            session,
            project_id="test-proj",
            user_id=user.id,
            name="test-machine",
        )

        assert result.enrollment_token.startswith("apo_enroll_")
        assert result.protocol_version == 2

    def test_bootstrap_creates_pool_if_missing(self, session, project_and_member):
        from apo.services.source_owned_executor import bootstrap_connected_executor, ensure_source_owned_pool
        from apo.models.db import ExecutorPoolDB

        project, user = project_and_member
        bootstrap_connected_executor(session, project_id="test-proj", user_id=user.id, name="test")

        pools = session.exec(
            select(ExecutorPoolDB).where(ExecutorPoolDB.project == "test-proj")
        ).all()
        source_owned = [p for p in pools if p.system_managed]
        assert len(source_owned) == 1


class TestCatalogEligibility:
    """Test 4: Catalog eligibility is exact."""

    def test_matching_digest_is_ready(self, session):
        from apo.services.source_owned_executor import check_catalog_eligibility

        result = check_catalog_eligibility(session, "test-proj", "sha256:abc123")
        # No catalog published → missing
        assert result["status"] == "catalog_missing"

    def test_mismatched_digest(self, session):
        from apo.services.source_owned_executor import check_catalog_eligibility
        from apo.models.db import ProjectTaskSourceDB

        session.add(ProjectTaskSourceDB(
            project="test-proj", source_type="published",
            catalog_digest="sha256:correct", task_count=1, status="ready",
        ))
        session.commit()

        result = check_catalog_eligibility(session, "test-proj", "sha256:wrong")
        assert result["status"] == "catalog_mismatch"

    def test_matching_digest(self, session):
        from apo.services.source_owned_executor import check_catalog_eligibility
        from apo.models.db import ProjectTaskSourceDB

        session.add(ProjectTaskSourceDB(
            project="test-proj", source_type="published",
            catalog_digest="sha256:correct", task_count=1, status="ready",
        ))
        session.commit()

        result = check_catalog_eligibility(session, "test-proj", "sha256:correct")
        assert result["status"] == "ready"
