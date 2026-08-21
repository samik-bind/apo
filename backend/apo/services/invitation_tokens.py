"""Shared token-lifecycle engine for invitation flows.

Both invitation domains — project invitations (membership admission to an
existing Project) and hosted-access invitations (installation admission
that materializes a new Project) — use the same token mechanics: generate a
URL-safe secret, persist only its SHA-256 hash, bound it with an expiry,
expose it through a frontend accept URL, and re-attempt email delivery
best-effort with a ``link_only`` fallback.

This module owns those mechanics once. What it deliberately does **not**
own: who may issue/revoke (delegated per-domain), what acceptance creates
(membership vs. Project), and the error contracts of preview/accept — those
genuinely differ and stay in their services.
"""

# pyright: reportPrivateUsage=false, reportUnknownArgumentType=false

from __future__ import annotations

import hashlib
import logging
import os
import secrets
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Protocol

from sqlmodel import Session

from ..auth import validate_frontend_url
from .email import EmailSendError, get_email_service

logger = logging.getLogger(__name__)


class InvitationTokenRow(Protocol):
    """Structural interface every invitation token table satisfies.

    The raw token is never a column — only ``token_hash`` is persisted.
    """

    token_hash: str
    delivery_method: str
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    updated_at: datetime


def normalize_email(email: str) -> str:
    """Lowercase + strip an email for persistence and comparison."""
    return email.strip().lower()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(raw_token: str) -> str:
    """SHA-256 hex digest of a raw invitation token."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def generate_token() -> tuple[str, str]:
    """Return ``(raw_token, token_hash)``. Raw token is returned once."""
    raw = secrets.token_urlsafe(32)
    return raw, hash_token(raw)


def expiry_from_now(ttl_hours: int) -> datetime:
    return utcnow() + timedelta(hours=ttl_hours)


def build_invite_url(raw_token: str, accept_path: str) -> str:
    """Absolute frontend URL for a raw token, e.g. ``/join?token=...``."""
    base = validate_frontend_url(
        os.environ.get("FRONTEND_URL", "http://localhost:3000")
    )
    return f"{base}{accept_path}?token={raw_token}"


def is_active(invitation: InvitationTokenRow) -> bool:
    return invitation.accepted_at is None and invitation.revoked_at is None


def is_expired(invitation: InvitationTokenRow) -> bool:
    expires_at = invitation.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at < utcnow()


def rotate_token(
    session: Session,
    invitation: InvitationTokenRow,
    *,
    ttl_hours: int,
    accept_path: str,
) -> tuple[str, str]:
    """Rotate the token in place and refresh expiry (resend path).

    Persists immediately and returns ``(raw_token, invite_url)``. The raw
    token is the only copy the caller ever sees — for one delivery attempt
    and one copy-link response.
    """
    raw_token, token_hash = generate_token()
    invite_url = build_invite_url(raw_token, accept_path)
    invitation.token_hash = token_hash
    invitation.expires_at = expiry_from_now(ttl_hours)
    invitation.updated_at = utcnow()
    session.add(invitation)
    session.commit()
    session.refresh(invitation)
    return raw_token, invite_url


async def send_invitation_email(
    *,
    to_email: str,
    subject: str,
    invite_url: str,
    render: Callable[[str], tuple[str, str]],
    invitation_id: str,
    log_label: str,
) -> bool:
    """Attempt email delivery through the configured transport.

    ``render`` receives the invite URL and returns ``(html, text)``. An
    unconfigured/log-only transport and any raised ``EmailSendError`` both
    resolve to ``False`` so the caller can fall back to ``link_only``.
    """
    service = get_email_service()
    if not service.is_configured:
        return False

    html_body, text_body = render(invite_url)
    try:
        await service.send(
            to=to_email,
            subject=subject,
            html=html_body,
            text=text_body,
        )
        return True
    except EmailSendError:
        logger.warning(
            "%s email delivery failed for invitation %s", log_label, invitation_id
        )
        return False


async def reconcile_delivery_method(
    session: Session, invitation: InvitationTokenRow, delivered: bool
) -> None:
    """Persist the delivery method after a send attempt, if it changed."""
    delivery_method = "email" if delivered else "link_only"
    if invitation.delivery_method != delivery_method:
        invitation.delivery_method = delivery_method
        session.add(invitation)
        session.commit()
        session.refresh(invitation)


__all__ = [
    "InvitationTokenRow",
    "build_invite_url",
    "expiry_from_now",
    "generate_token",
    "hash_token",
    "is_active",
    "is_expired",
    "normalize_email",
    "reconcile_delivery_method",
    "rotate_token",
    "send_invitation_email",
    "utcnow",
]
