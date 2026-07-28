# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportPrivateUsage=false

"""SPEC-143: executor_auth — enrollment tokens, credentials, and Attempt JWTs.

Mirrors the existing service-token / API-key patterns: SHA-256+salt hashing
(``apo_ex_`` credentials, ``apo_enroll_`` tokens), single-secret HS256 JWTs
(``task_execution_attempt`` type). Raw credentials/tokens are returned once and
only a hash/prefix persists; they never appear in logs.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import pytest
from apo.auth.api_key_auth import _get_salt
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ExecutorDB,
    ExecutorPoolDB,
    ProjectDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
)
from apo.services.executor_auth import (
    ATTEMPT_JWT_TYPE,
    CredentialHashError,
    EnrollmentError,
    create_attempt_jwt,
    decode_attempt_jwt,
    exchange_enrollment_token,
    generate_credential,
    generate_enrollment_token,
    hash_credential,
    resolve_executor_by_credential,
)
from apo.models.execution import ExecutorCapabilities
from sqlmodel import Session


def _hash(raw: str) -> str:
    return hashlib.sha256(f"{raw}:{_get_salt()}".encode()).hexdigest()


def _seed_project(session: Session, project_id: str = "proj-auth") -> None:
    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    session.flush()  # project must exist before the pool FK check
    session.add(ExecutorPoolDB(
        id="pool-1", project=project_id, name="Pool", slug="pool",
        kind="connected", enabled=True, created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    ))
    session.commit()


def _capabilities() -> ExecutorCapabilities:
    return ExecutorCapabilities(
        protocol_version=1,
        executor_version="apo-exec-1.0",
        driver_kinds=["subprocess"],
        os="linux",
        architecture="x86_64",
        runtimes={"node": "20"},
        max_concurrency=2,
    )


# ── credential hashing ────────────────────────────────────────────────────


def test_credential_hash_uses_sha256_with_salt() -> None:
    raw, prefix, h = generate_credential()
    assert raw.startswith("apo_ex_")
    assert prefix == "apo_ex_" + raw[len("apo_ex_"): len("apo_ex_") + 8]
    assert h == _hash(raw)
    assert hash_credential(raw) == h


def test_credential_hash_rejects_unprefixed_raw() -> None:
    with pytest.raises(CredentialHashError):
        hash_credential("not-a-prefixed-credential")


# ── enrollment token ──────────────────────────────────────────────────────


def test_enrollment_token_generation_persists_only_hash(session: Session) -> None:
    _seed_project(session)
    raw_token, row = generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-auth", pool_id="pool-1",
        created_by_user_id=None,
    )
    assert raw_token.startswith("apo_enroll_")
    assert row.token_hash == _hash(raw_token)
    assert row.token_prefix.startswith("apo_enroll_")
    assert row.used_at is None
    # raw token never persisted
    assert raw_token not in (row.token_hash + row.token_prefix)


def test_enrollment_exchange_is_atomic_single_use(session: Session) -> None:
    _seed_project(session)
    raw_token, _ = generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-auth", pool_id="pool-1",
    )
    executor, raw_cred, hb, lease_ttl = exchange_enrollment_token(
        session, raw_token=raw_token, name="exec-1", capabilities=_capabilities(),
    )
    assert raw_cred.startswith("apo_ex_")
    assert executor.credential_hash == _hash(raw_cred)
    assert executor.protocol_version == 1
    assert executor.max_concurrency == 2
    assert hb > 0 and lease_ttl > 0

    # second exchange of the same token fails
    with pytest.raises(Exception):
        exchange_enrollment_token(
            session, raw_token=raw_token, name="exec-2", capabilities=_capabilities(),
        )


def test_enrollment_exchange_rejects_expired_token(session: Session) -> None:
    _seed_project(session)
    raw_token, row = generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-auth", pool_id="pool-1", ttl_seconds=60,
    )
    row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    session.add(row)
    session.commit()
    with pytest.raises(Exception):
        exchange_enrollment_token(
            session, raw_token=raw_token, name="x", capabilities=_capabilities(),
        )


def test_enrollment_exchange_rejects_revoked_token(session: Session) -> None:
    _seed_project(session)
    raw_token, row = generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-auth", pool_id="pool-1",
    )
    row.revoked_at = datetime.now(timezone.utc)
    session.add(row)
    session.commit()
    with pytest.raises(Exception):
        exchange_enrollment_token(
            session, raw_token=raw_token, name="x", capabilities=_capabilities(),
        )


@pytest.mark.parametrize(
    ("name", "capabilities", "expected_kind"),
    [
        (" ", _capabilities(), "capability_invalid"),
        (
            "executor",
            _capabilities().model_copy(update={"protocol_version": 99}),
            "protocol_mismatch",
        ),
        (
            "executor",
            _capabilities().model_copy(update={"driver_kinds": ["docker"]}),
            "capability_invalid",
        ),
        (
            "executor",
            _capabilities().model_copy(update={"max_concurrency": 0}),
            "capability_invalid",
        ),
    ],
)
def test_invalid_enrollment_request_does_not_consume_token(
    session: Session,
    name: str,
    capabilities: ExecutorCapabilities,
    expected_kind: str,
) -> None:
    _seed_project(session)
    raw_token, token = generate_enrollment_token(
        session,
        scope_kind="pool",
        project_id="proj-auth",
        pool_id="pool-1",
    )
    with pytest.raises(EnrollmentError) as caught:
        exchange_enrollment_token(
            session,
            raw_token=raw_token,
            name=name,
            capabilities=capabilities,
        )
    assert caught.value.kind == expected_kind
    session.refresh(token)
    assert token.used_at is None


# ── credential resolution ─────────────────────────────────────────────────


def test_resolve_executor_by_credential_finds_enabled(session: Session) -> None:
    _seed_project(session)
    raw_token, _ = generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-auth", pool_id="pool-1",
    )
    executor, raw_cred, _, _ = exchange_enrollment_token(
        session, raw_token=raw_token, name="exec-1", capabilities=_capabilities(),
    )
    found = resolve_executor_by_credential(session, raw_cred)
    assert found is not None
    assert found.id == executor.id


def test_resolve_executor_rejects_revoked_and_unknown(session: Session) -> None:
    _seed_project(session)
    raw_token, _ = generate_enrollment_token(
        session, scope_kind="pool", project_id="proj-auth", pool_id="pool-1",
    )
    executor, raw_cred, _, _ = exchange_enrollment_token(
        session, raw_token=raw_token, name="exec-1", capabilities=_capabilities(),
    )
    executor.revoked_at = datetime.now(timezone.utc)
    session.add(executor)
    session.commit()
    assert resolve_executor_by_credential(session, raw_cred) is None
    assert resolve_executor_by_credential(session, "apo_ex_unknown") is None


# ── attempt JWT ───────────────────────────────────────────────────────────


def _seed_attempt(session: Session, *, gen: int = 1) -> TaskExecutionAttemptDB:
    _seed_project(session)
    session.add(AgentTaskBatchRunDB(
        id="b1", project="proj-auth", selection_type="single", status="queued",
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(AgentTaskRunDB(
        id="r1", batch_run_id="b1", task_id="t1", task_path="t1", status="pending",
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(TaskRevisionDB(
        id="rev1", project="proj-auth", batch_run_id="b1", materialization="bundled",
        source_type="filesystem", content_sha256="c" * 64, file_count=1,
        uncompressed_size_bytes=1, manifest_summary_json={"fileCount": 1},
        created_at=datetime.now(timezone.utc),
    ))
    session.flush()
    session.add(ExecutorDB(
        id="ex1", scope_kind="pool", project="proj-auth", executor_pool_id="pool-1",
        name="exec-1", credential_prefix="apo_ex_x", credential_hash="h",
        protocol_version=1, executor_version="v", enrolled_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc),
    ))
    session.flush()
    att = TaskExecutionAttemptDB(
        id="a1", project="proj-auth", batch_run_id="b1", task_run_id="r1",
        task_revision_id="rev1", sequence_index=0, target_kind="pool",
        executor_pool_id="pool-1", executor_id="ex1", status="leased",
        lease_generation=gen, queue_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        queued_at=datetime.now(timezone.utc),
    )
    session.add(att)
    session.commit()
    return att


def test_attempt_jwt_round_trips_claims(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # SPEC-152 made create_attempt_jwt fail closed when AUTH_SECRET is unset
    # (CI has none). Provide one so the round-trip can issue a token.
    monkeypatch.setattr("apo.services.executor_auth.AUTH_SECRET", "test-secret")
    att = _seed_attempt(session, gen=3)
    token = create_attempt_jwt(
        attempt=att, lease_generation=3, expires_in_seconds=300,
    )
    claims = decode_attempt_jwt(token)
    assert claims is not None
    assert claims["typ"] == ATTEMPT_JWT_TYPE
    assert claims["project"] == "proj-auth"
    assert claims["task_run_id"] == "r1"
    assert claims["attempt_id"] == "a1"
    assert claims["executor_id"] == "ex1"
    assert claims["lease_generation"] == 3


def test_decode_attempt_jwt_rejects_wrong_type() -> None:
    from apo.auth.service_tokens import create_agent_task_trace_token

    wrong = create_agent_task_trace_token(task_run_id="r1", project="proj-auth")
    assert decode_attempt_jwt(wrong) is None


def test_decode_attempt_jwt_rejects_garbage() -> None:
    assert decode_attempt_jwt("not-a-jwt") is None
