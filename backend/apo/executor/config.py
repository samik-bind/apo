"""SPEC-144: Bundled Executor configuration (env-driven).

Resolves the executor process configuration from environment variables. The
Control Plane URL must be HTTPS except for loopback or Compose-internal hostnames
(where TLS terminates elsewhere). Invalid/missing required values raise
:class:`ConfigError` at startup rather than failing silently mid-run.
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from urllib.parse import urlparse


class ConfigError(ValueError):
    """Raised on invalid/missing executor configuration."""


@dataclass(frozen=True)
class ExecutorConfig:
    control_plane_url: str
    name: str
    state_dir: str
    max_concurrency: int = 1
    driver: str = "subprocess"
    task_user: str | None = None
    env_allowlist: list[str] = field(default_factory=list)
    enrollment_token: str | None = None
    workspace_root: str = "/var/lib/apo-executor/workspaces"
    task_timeout_seconds: int = 600


def is_loopback_or_internal_host(host: str) -> bool:
    """True for loopback IPs, localhost, or single-label (Compose-internal) names."""
    if host in ("localhost",):
        return True
    try:
        if ipaddress.ip_address(host).is_loopback:
            return True
    except ValueError:
        pass
    # A single-label hostname (no dots) is treated as Compose-internal.
    return "." not in host


def _require_https_or_internal(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme == "https":
        return url
    if parsed.scheme == "http" and is_loopback_or_internal_host(parsed.hostname or ""):
        return url
    raise ConfigError(
        f"APO_CONTROL_PLANE_URL must be HTTPS (or loopback/Compose-internal http): {url!r}"
    )


def load_config() -> ExecutorConfig:
    """Parse ExecutorConfig from the process environment."""
    raw_url = os.environ.get("APO_CONTROL_PLANE_URL", "").strip()
    if not raw_url:
        raise ConfigError("APO_CONTROL_PLANE_URL is required")
    url = _require_https_or_internal(raw_url)
    name = os.environ.get("APO_EXECUTOR_NAME", "").strip()
    if not name:
        raise ConfigError("APO_EXECUTOR_NAME is required")
    try:
        max_concurrency = int(os.environ.get("APO_EXECUTOR_MAX_CONCURRENCY", "1"))
    except ValueError as exc:
        raise ConfigError("APO_EXECUTOR_MAX_CONCURRENCY must be an integer") from exc
    if max_concurrency < 1:
        raise ConfigError("APO_EXECUTOR_MAX_CONCURRENCY must be positive")

    allowlist_raw = os.environ.get("APO_TASK_ENV_ALLOWLIST", "").strip()
    env_allowlist = [s.strip() for s in allowlist_raw.split(",") if s.strip()]

    return ExecutorConfig(
        control_plane_url=url.rstrip("/"),
        name=name,
        state_dir=os.environ.get("APO_EXECUTOR_STATE_DIR", "/var/lib/apo-executor"),
        max_concurrency=max_concurrency,
        driver=os.environ.get("APO_EXECUTOR_DRIVER", "subprocess"),
        task_user=os.environ.get("APO_EXECUTOR_TASK_USER") or None,
        env_allowlist=env_allowlist,
        enrollment_token=os.environ.get("APO_EXECUTOR_ENROLLMENT_TOKEN") or None,
        workspace_root=os.environ.get(
            "APO_EXECUTOR_WORKSPACE_ROOT", "/var/lib/apo-executor/workspaces"
        ),
        task_timeout_seconds=int(os.environ.get("APO_EXECUTOR_TASK_TIMEOUT_SECONDS", "600")),
    )


__all__ = ["ConfigError", "ExecutorConfig", "is_loopback_or_internal_host", "load_config"]
