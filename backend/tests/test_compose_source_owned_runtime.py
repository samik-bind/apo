# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnusedCallResult=false, reportAttributeAccessIssue=false

"""Source-owned Compose topology contract.

The retired Bundled Executor service, its volumes, and the task-source cache
must be absent from docker-compose.yml. The database volume and source-owned
control-plane configuration must remain.
"""

from __future__ import annotations

from pathlib import Path

import pytest

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]

_COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.yml"


@pytest.mark.skipif(yaml is None, reason="PyYAML not installed")
class TestSourceOwnedComposeTopology:
    def _data(self) -> dict:
        return yaml.safe_load(_COMPOSE.read_text())  # type: ignore[union-attr]

    def test_executor_service_is_absent(self) -> None:
        services = self._data().get("services", {})
        assert "executor" not in services, "retired executor service still declared"

    def test_obsolete_volumes_are_absent(self) -> None:
        volumes = self._data().get("volumes", {})
        for vol in ("task_source_cache", "apo_executor_state", "apo_executor_bootstrap"):
            assert vol not in volumes, f"retired volume '{vol}' still declared"

    def test_backend_has_no_task_source_or_executor_mounts(self) -> None:
        backend = self._data().get("services", {}).get("backend", {})
        vol_strs = backend.get("volumes", [])
        for forbidden in ("task_source_cache", "executor_bootstrap", "executor_state"):
            for v in vol_strs:
                assert forbidden not in str(v), f"backend mounts retired volume '{forbidden}'"

    def test_backend_has_no_retired_env_vars(self) -> None:
        backend = self._data().get("services", {}).get("backend", {})
        env = backend.get("environment", [])
        env_text = " ".join(env) if isinstance(env, list) else str(env)
        for forbidden in ("APO_BUNDLED_EXECUTOR_ENABLED", "TASK_SOURCE_CACHE_DIR"):
            assert forbidden not in env_text, f"backend declares retired env var '{forbidden}'"

    def test_database_volume_is_preserved(self) -> None:
        volumes = self._data().get("volumes", {})
        assert "apo_db" in volumes, "database volume must be preserved"

    def test_backend_mounts_database(self) -> None:
        backend = self._data().get("services", {}).get("backend", {})
        vol_strs = [str(v) for v in backend.get("volumes", [])]
        assert any("apo_db" in v for v in vol_strs), "backend must mount the database volume"

    def test_backend_healthcheck_is_preserved(self) -> None:
        backend = self._data().get("services", {}).get("backend", {})
        assert "healthcheck" in backend, "backend healthcheck must be preserved"

    def test_scheduler_env_is_preserved(self) -> None:
        backend = self._data().get("services", {}).get("backend", {})
        env = backend.get("environment", [])
        env_text = " ".join(env) if isinstance(env, list) else str(env)
        assert "SCHEDULER_ENABLED" in env_text, "scheduler configuration must be preserved"
