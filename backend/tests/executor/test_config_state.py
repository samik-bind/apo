# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-144: executor config (env) + ExecutorState (atomic 0600 persistence)."""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest
from apo.executor.config import (
    ConfigError,
    ExecutorConfig,
    load_config,
    is_loopback_or_internal_host,
)
from apo.executor.state import ExecutorState, StateError, load_state, save_state


def test_load_config_parses_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_CONTROL_PLANE_URL", "https://apo.example.internal")
    monkeypatch.setenv("APO_EXECUTOR_NAME", "bundled-1")
    monkeypatch.setenv("APO_EXECUTOR_MAX_CONCURRENCY", "2")
    monkeypatch.setenv("APO_EXECUTOR_DRIVER", "subprocess")
    monkeypatch.setenv("APO_EXECUTOR_TASK_USER", "appuser")
    monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", "MY_VAR,OTHER_VAR")
    cfg = load_config()
    assert cfg.control_plane_url == "https://apo.example.internal"
    assert cfg.name == "bundled-1"
    assert cfg.max_concurrency == 2
    assert cfg.driver == "subprocess"
    assert cfg.task_user == "appuser"
    assert cfg.env_allowlist == ["MY_VAR", "OTHER_VAR"]


def test_load_config_rejects_missing_control_plane_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APO_CONTROL_PLANE_URL", raising=False)
    with pytest.raises(ConfigError):
        load_config()


def test_load_config_rejects_plain_http_public_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_CONTROL_PLANE_URL", "http://apo.example.com")
    with pytest.raises(ConfigError):
        load_config()


def test_load_config_allows_loopback_http(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_CONTROL_PLANE_URL", "http://127.0.0.1:8000")
    monkeypatch.setenv("APO_EXECUTOR_NAME", "x")
    cfg = load_config()
    assert cfg.control_plane_url == "http://127.0.0.1:8000"


def test_load_config_allows_compose_internal_http(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APO_CONTROL_PLANE_URL", "http://backend:8000")
    monkeypatch.setenv("APO_EXECUTOR_NAME", "x")
    cfg = load_config()
    assert "backend" in cfg.control_plane_url


def test_is_loopback_or_internal_host() -> None:
    assert is_loopback_or_internal_host("127.0.0.1")
    assert is_loopback_or_internal_host("localhost")
    assert is_loopback_or_internal_host("backend")
    assert not is_loopback_or_internal_host("apo.example.com")


# ── state ─────────────────────────────────────────────────────────────────


def test_save_state_writes_atomically_with_restrictive_perms(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    save_state(
        path,
        ExecutorState(
            schema_version=1, executor_id="ex-1",
            executor_credential="apo_ex_secret", control_plane_url="https://x",
        ),
    )
    assert path.exists()
    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600


def test_load_state_round_trips(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    original = ExecutorState(
        schema_version=1, executor_id="ex-1",
        executor_credential="apo_ex_secret", control_plane_url="https://x",
    )
    save_state(path, original)
    loaded = load_state(path)
    assert loaded == original


def test_load_state_missing_returns_none(tmp_path: Path) -> None:
    assert load_state(tmp_path / "nope.json") is None


def test_load_state_corrupt_raises(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    path.write_text("{not json")
    with pytest.raises(StateError):
        load_state(path)


def test_save_state_replaces_existing(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    save_state(path, ExecutorState(
        schema_version=1, executor_id="ex-1",
        executor_credential="apo_ex_old", control_plane_url="https://x",
    ))
    save_state(path, ExecutorState(
        schema_version=1, executor_id="ex-1",
        executor_credential="apo_ex_new", control_plane_url="https://x",
    ))
    loaded = load_state(path)
    assert loaded is not None
    assert loaded.executor_credential == "apo_ex_new"
