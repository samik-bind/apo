# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""SPEC-140 ticket 04: artifact upload intents, completion, and access rules.

Two-phase uploads: create intent (idempotent on matching metadata), PUT bytes
(streamed, size+digest verified), ready summary. Terminal runs reject new
uploads; name collisions and run-total byte budgets are enforced.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import AsyncIterator
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, text
from apo.db import engine, reset_apo_file_db
from apo.models.db import AgentTaskBatchRunDB, AgentTaskDeliverableDB, AgentTaskRunDB
from apo.services.agent_task_deliverables import (
    complete_artifact_upload,
    create_artifact_upload_intent,
    load_deliverable_for_download,
    validate_deliverable_name,
    validate_sha256_hex,
)
from apo.services.artifact_stores.local import LocalArtifactStore


@pytest.fixture(autouse=True)
def setup_database(tmp_path):
    reset_apo_file_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM agent_task_deliverables"))
        session.execute(text("DELETE FROM agent_task_runs"))
        session.execute(text("DELETE FROM agent_task_batch_runs"))
        session.commit()


@pytest.fixture
def store(tmp_path) -> LocalArtifactStore:
    s = LocalArtifactStore(root=tmp_path / "store")
    asyncio.run(s.check_ready())
    return s


def _seed_run(session: Session, run_id: str = "run-1", status: str = "running") -> None:
    session.add(
        AgentTaskBatchRunDB(
            id=f"batch-{run_id}", project="p1", selection_type="manual", status="running"
        )
    )
    session.add(
        AgentTaskRunDB(
            id=run_id, batch_run_id=f"batch-{run_id}", task_id="t", task_path="p",
            status=status,
        )
    )
    session.flush()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def _aiter(data: bytes) -> AsyncIterator[bytes]:
    yield data


pytestmark = pytest.mark.asyncio


class TestNameAndDigestValidation:
    def test_valid_name_passes(self):
        assert validate_deliverable_name("verdict") == "verdict"
        assert validate_deliverable_name("v" * 255) == "v" * 255
        assert validate_deliverable_name("ünïcödé") == "ünïcödé"

    @pytest.mark.parametrize("bad", ["", "a\x00b", "a\x01b", "a\x7fb", "x" * 256])
    def test_invalid_name_rejected(self, bad: str):
        with pytest.raises(ValueError):
            validate_deliverable_name(bad)

    def test_valid_sha_passes(self):
        h = "a" * 64
        assert validate_sha256_hex(h) == h

    @pytest.mark.parametrize("bad", ["", "xyz", "A" * 64, "g" * 64, "a" * 63])
    def test_invalid_sha_rejected(self, bad: str):
        with pytest.raises(ValueError):
            validate_sha256_hex(bad)


class TestCreateArtifactUploadIntent:
    async def test_creates_pending_intent(self, store: LocalArtifactStore):
        data = b"log contents"
        with Session(engine) as session:
            _seed_run(session)
            intent = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="verifier.log",
                media_type="text/plain", size_bytes=len(data), sha256=_sha(data),
            )
            session.commit()

        assert intent.method == "PUT"
        assert intent.upload_url == f"/v1/agent-task-artifact-uploads/{intent.id}"
        assert intent.deliverable.kind == "artifact"
        assert intent.deliverable.status == "pending"
        assert intent.deliverable.size_bytes == len(data)

    async def test_idempotent_intent_returns_same_identity(self, store: LocalArtifactStore):
        data = b"x" * 100
        with Session(engine) as session:
            _seed_run(session)
            first = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="v.log", media_type="text/plain",
                size_bytes=len(data), sha256=_sha(data),
            )
            second = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="v.log", media_type="text/plain",
                size_bytes=len(data), sha256=_sha(data),
            )
            session.commit()
        assert first.id == second.id

    async def test_conflicting_metadata_rejected(self, store: LocalArtifactStore):
        with Session(engine) as session:
            _seed_run(session)
            await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="a.log", media_type="text/plain",
                size_bytes=10, sha256=_sha(b"a" * 10),
            )
            with pytest.raises(ValueError, match="conflicting"):
                await create_artifact_upload_intent(
                    session, store, project="p1", task_run_id="run-1",
                    name="log", display_filename="b.log", media_type="text/plain",
                    size_bytes=99, sha256=_sha(b"b" * 99),
                )
            session.commit()

    async def test_terminal_run_rejects_new_upload(self, store: LocalArtifactStore):
        with Session(engine) as session:
            _seed_run(session, status="passed")
            with pytest.raises(ValueError, match="terminal"):
                await create_artifact_upload_intent(
                    session, store, project="p1", task_run_id="run-1",
                    name="log", display_filename="v.log", media_type="text/plain",
                    size_bytes=10, sha256=_sha(b"a" * 10),
                )

    async def test_oversize_item_rejected(self, store: LocalArtifactStore, monkeypatch):
        monkeypatch.setenv("APO_ARTIFACT_MAX_ITEM_BYTES", "50")
        with Session(engine) as session:
            _seed_run(session)
            with pytest.raises(ValueError, match="per-item limit"):
                await create_artifact_upload_intent(
                    session, store, project="p1", task_run_id="run-1",
                    name="log", display_filename="v.log", media_type="text/plain",
                    size_bytes=100, sha256=_sha(b"a" * 100),
                )


class TestCompleteArtifactUpload:
    async def test_upload_makes_row_ready(self, store: LocalArtifactStore):
        data = b"the quick brown fox"
        with Session(engine) as session:
            _seed_run(session)
            intent = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="v.log", media_type="text/plain",
                size_bytes=len(data), sha256=_sha(data),
            )
            summary = await complete_artifact_upload(
                session, store, project="p1", deliverable_id=intent.id,
                body_stream=_aiter(data), declared_size=len(data),
            )
            session.commit()

        assert summary.status == "ready"
        assert summary.size_bytes == len(data)
        # Object exists in the store.
        with Session(engine) as session:
            row = session.get(AgentTaskDeliverableDB, intent.id)
            assert row is not None
            assert row.status == "ready"
            assert row.storage_key is not None
            streamed = b"".join([c async for c in store.open(row.storage_key)])
            assert streamed == data

    async def test_digest_mismatch_rejected(self, store: LocalArtifactStore):
        declared = b"declared bytes"  # 14 bytes
        actual = b"different byte"  # 14 bytes, different content -> digest mismatch
        with Session(engine) as session:
            _seed_run(session)
            intent = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="v.log", media_type="text/plain",
                size_bytes=len(declared), sha256=_sha(declared),
            )
            with pytest.raises(ValueError, match="digest mismatch"):
                await complete_artifact_upload(
                    session, store, project="p1", deliverable_id=intent.id,
                    body_stream=_aiter(actual),
                    declared_size=len(actual),
                )

    async def test_size_mismatch_rejected(self, store: LocalArtifactStore):
        data = b"ten bytes"
        with Session(engine) as session:
            _seed_run(session)
            intent = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="v.log", media_type="text/plain",
                size_bytes=100, sha256=_sha(b"x" * 100),
            )
            with pytest.raises(ValueError):
                await complete_artifact_upload(
                    session, store, project="p1", deliverable_id=intent.id,
                    body_stream=_aiter(data),
                    declared_size=len(data),
                )

    async def test_cross_project_load_rejected(self, store: LocalArtifactStore):
        data = b"ok"
        with Session(engine) as session:
            _seed_run(session)
            intent = await create_artifact_upload_intent(
                session, store, project="p1", task_run_id="run-1",
                name="log", display_filename="v.log", media_type="text/plain",
                size_bytes=len(data), sha256=_sha(data),
            )
            await complete_artifact_upload(
                session, store, project="p1", deliverable_id=intent.id,
                body_stream=_aiter(data), declared_size=len(data),
            )
            session.commit()
            with pytest.raises(KeyError):
                load_deliverable_for_download(session, project="other", deliverable_id=intent.id)
