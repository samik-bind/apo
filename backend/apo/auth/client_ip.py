"""Client-IP extraction for rate limiting and audit trails.

Pre-authentication endpoints (login, API-key bootstrap, hosted-access probes,
invitation acceptance) rate-limit and audit per source IP. Behind the docker
ingress the socket address is the proxy, so the first ``x-forwarded-for``
hop wins; direct connections fall back to the socket client.
"""

from fastapi import Request


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"
