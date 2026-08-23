"""Idempotent first-user provisioning from INIT_USER_* environment variables.

uses the shared installation-initialization claim service so
bootstrap and browser setup share the same durable singleton. Bootstrap is a
no-op once the installation is initialized, even if all Users are later
deleted.
"""

# pyright: reportUnusedCallResult=false

import logging
import os

from sqlmodel import Session

from .auth import validate_password_strength
from .services.installation_initialization import (
    InstallationAlreadyInitializedError,
    claim_initial_user,
    ensure_initial_user_is_instance_admin,
    get_installation_setup_status,
)

logger = logging.getLogger(__name__)


def bootstrap_initial_user(session: Session) -> None:
    """Create the first admin user from INIT_USER_* env vars.

    Uses the shared atomic claim. Once the installation is initialized,
    bootstrap is a no-op — even if zero Users exist. Never raises; errors
    are logged and startup continues.
    """
    try:
        status = get_installation_setup_status(session)
    except Exception:
        logger.exception("Failed to read installation state during bootstrap")
        return

    if not status.setup_available:
        logger.info("Installation already initialized, skipping bootstrap")
        # #152 repair: installs initialized before /auth/setup granted the
        # admin role may have no installation admin at all. Restore it from
        # the durable initial-user record.
        if ensure_initial_user_is_instance_admin(session):
            logger.info(
                "Promoted the recorded initial user to installation admin (#152 repair)"
            )
        return

    email = os.environ.get("INIT_USER_EMAIL", "").strip()
    password = os.environ.get("INIT_USER_PASSWORD", "")
    name = os.environ.get("INIT_USER_NAME", "Admin").strip()

    if not email and not password:
        return

    if not email or not password:
        logger.warning(
            "Both INIT_USER_EMAIL and INIT_USER_PASSWORD must be set for bootstrap"
        )
        return

    error = validate_password_strength(password)
    if error is not None:
        logger.error("Bootstrap skipped — weak password: %s", error)
        return

    try:
        claim_initial_user(
            session,
            email=email,
            name=name,
            password=password,
            is_instance_admin=True,
        )
        logger.info("Bootstrapped initial admin user: %s", email)
    except InstallationAlreadyInitializedError:
        logger.info("Installation was initialized concurrently, skipping bootstrap")
    except Exception:
        logger.exception("Failed to create bootstrap user")
        try:
            session.rollback()
        except Exception:
            pass
