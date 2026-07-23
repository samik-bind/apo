"""SPEC-140 ticket 04: request-size ASGI enforcement.

Wraps the downstream ``receive`` callable so byte limits are enforced BEFORE
Pydantic materializes a JSON body. Counts streamed bytes even when
``Content-Length`` is absent or false (chunked transfers), so a forged or
omitted header cannot bypass the cap.

Routes still re-check semantic limits in the service layer so direct service
calls and tests cannot bypass them; this middleware is the network boundary.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import Message

# SPEC-140 §Request and Storage Limits — code constants.
_RESULT_BODY_LIMIT = 10 * 1024 * 1024  # 10 MiB Task result body
_ARTIFACT_UPLOAD_LIMIT = 100 * 1024 * 1024  # 100 MiB per Artifact upload


class _BodyTooLarge(Exception):
    """Raised inside the wrapped ``receive`` once the byte cap is exceeded."""


# (method, path prefix, requires suffix, limit). The specific Deliverable
# routes are declared before any future catch-all.
_LIMITED_PATHS: tuple[tuple[str, str, str | None, int], ...] = (
    ("POST", "/v1/agent-task-runs/", "result", _RESULT_BODY_LIMIT),
    ("PUT", "/v1/agent-task-artifact-uploads/", None, _ARTIFACT_UPLOAD_LIMIT),
)


class RequestSizeMiddleware(BaseHTTPMiddleware):
    """Reject bodies that exceed the per-route byte limit before buffering."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        limit = _limit_for(request)
        if limit is None:
            return await call_next(request)

        declared = request.headers.get("content-length")
        if declared is not None:
            try:
                declared_size = int(declared)
            except ValueError:
                return _too_large(limit)
            if declared_size > limit:
                return _too_large(limit)

        receive = request.receive
        received = 0

        async def sized_receive() -> Message:
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                body = message.get("body", b"")
                received += len(body) if isinstance(body, (bytes, bytearray)) else 0
                if received > limit:
                    raise _BodyTooLarge()
            return message

        request._receive = sized_receive  # type: ignore[attr-defined]
        try:
            return await call_next(request)
        except _BodyTooLarge:
            return _too_large(limit)


def _limit_for(request: Request) -> int | None:
    method = request.method.upper()
    path = request.url.path
    for lim_method, prefix, suffix, limit in _LIMITED_PATHS:
        if method != lim_method or not path.startswith(prefix):
            continue
        if suffix is not None and not path.endswith(suffix):
            continue
        return limit
    return None


def _too_large(limit: int) -> JSONResponse:
    return JSONResponse(
        status_code=413,
        content={"detail": f"Request body exceeds the {limit} byte limit"},
    )
