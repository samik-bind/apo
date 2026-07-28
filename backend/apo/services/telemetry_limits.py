"""Typed, startup-validated telemetry transport limits (SPEC-150).

Owns the parsing and defaults for the hard request boundaries on the
canonical public OTLP endpoint. There is no disable flag: ``0`` never means
unlimited. A present empty, non-integer, zero, or negative value fails
startup with a message naming the offending variable.

SPEC-151 will extend this module with admission-control policies; the
transport configuration defined here remains exact and immutable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class TelemetryLimitError(RuntimeError):
    """Raised when a telemetry limit env var has an invalid value."""


@dataclass(frozen=True)
class TelemetryTransportLimits:
    """Immutable hard boundaries for one OTLP/HTTP trace request."""

    max_request_bytes: int
    max_otlp_decompressed_bytes: int
    max_otlp_spans_per_request: int
    body_timeout_seconds: int


# (env var name, attribute name, default)
_LIMIT_SPECS: tuple[tuple[str, str, int], ...] = (
    ("APO_TELEMETRY_MAX_REQUEST_BYTES", "max_request_bytes", 10_485_760),
    ("APO_OTLP_MAX_DECOMPRESSED_BYTES", "max_otlp_decompressed_bytes", 10_485_760),
    ("APO_OTLP_MAX_SPANS_PER_REQUEST", "max_otlp_spans_per_request", 2048),
    ("APO_TELEMETRY_BODY_TIMEOUT_SECONDS", "body_timeout_seconds", 30),
)


def _parse_positive_int(name: str, raw: str | None, default: int) -> int:
    """Parse a positive base-10 integer env var.

    Missing → default. Present empty, non-integer, zero, or negative →
    :class:`TelemetryLimitError` naming only ``name``.
    """
    if raw is None:
        return default
    raw = raw.strip()
    if raw == "":
        raise TelemetryLimitError(f"{name} must be a positive integer (got empty)")
    try:
        value = int(raw)
    except ValueError:
        raise TelemetryLimitError(
            f"{name} must be a positive base-10 integer (got {raw!r})"
        ) from None
    if value <= 0:
        raise TelemetryLimitError(f"{name} must be a positive integer (got {value})")
    return value


def load_telemetry_transport_limits() -> TelemetryTransportLimits:
    """Load and validate transport limits from the environment.

    Reads each variable at call time (not import time) so tests and app
    construction see current values. Raises :class:`TelemetryLimitError`
    on the first invalid variable, naming only that variable.
    """
    fields: dict[str, int] = {}
    for env_name, attr_name, default in _LIMIT_SPECS:
        fields[attr_name] = _parse_positive_int(env_name, os.environ.get(env_name), default)
    return TelemetryTransportLimits(**fields)
