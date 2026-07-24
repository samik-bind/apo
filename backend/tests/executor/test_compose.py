# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-144: docker-compose executor service structure invariants.

Asserts the rendered Compose keeps the Executor process isolated: separate
service, no published ports, no database/source-cache mount, HTTP-only, default
concurrency one, and the bootstrap/state volumes separated per the spec.
"""

from __future__ import annotations

from pathlib import Path

import pytest

try:
    import yaml  # PyYAML is a sqlmodel/fastapi transitive? fall back if absent.
except ImportError:  # pragma: no cover
    yaml = None  # type: ignore[assignment]

_COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.yml"


@pytest.mark.skipif(yaml is None, reason="PyYAML not installed")
def test_executor_service_is_present_and_isolated() -> None:
    data = yaml.safe_load(_COMPOSE.read_text())  # type: ignore[union-attr]
    services = data["services"]
    assert "executor" in services
    ex = services["executor"]

    # Reuses the backend image, runs the connect command, root supervisor.
    assert ex["build"]["dockerfile"] == "backend/Dockerfile"
    assert ex["command"] == ["python", "-m", "apo.executor", "connect"]
    assert ex["user"] == "0:0"

    # Never internet-published.
    assert "ports" not in ex

    # HTTP-only: no database or task-source cache mount.
    mounted = {v.split(":")[0] for v in ex["volumes"]}
    assert "apo_db" not in mounted
    assert "task_source_cache" not in mounted
    assert "apo_executor_state" in mounted
    assert "apo_executor_bootstrap" in mounted

    # Default concurrency one.
    env = {e.split("=", 1)[0]: e.split("=", 1)[1] for e in ex["environment"] if "=" in e}
    assert env["APO_CONTROL_PLANE_URL"].startswith("http://backend:")
    assert env["APO_EXECUTOR_DRIVER"] == "subprocess"
    assert "1" in env["APO_EXECUTOR_MAX_CONCURRENCY"]


@pytest.mark.skipif(yaml is None, reason="PyYAML not installed")
def test_executor_state_and_bootstrap_volumes_are_named() -> None:
    data = yaml.safe_load(_COMPOSE.read_text())  # type: ignore[union-attr]
    volumes = set(data.get("volumes", {}))
    assert "apo_executor_state" in volumes
    assert "apo_executor_bootstrap" in volumes
