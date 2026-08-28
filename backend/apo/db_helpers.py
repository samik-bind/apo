# pyright: reportUnusedFunction=false, reportDeprecated=false

from datetime import datetime, timezone
from typing import TypeVar, cast

from sqlalchemy import text
from sqlalchemy.sql.elements import ColumnElement

from sqlmodel import Session

_TColumn = TypeVar("_TColumn")


def as_column(value: object) -> ColumnElement[_TColumn]:
    return cast(ColumnElement[_TColumn], value)


def table_exists(session: Session, table_name: str) -> bool:
    """True when ``table_name`` exists in the session's database.

    Used by deletion cascades to stay robust on older schemas that predate a
    table (e.g. pre-v12 databases without corrections). The dialect is read
    from the session bind so this stays a leaf module with no import cycle.
    """
    if session.get_bind().dialect.name == "sqlite":
        row = session.execute(
            text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:n"),
            {"n": table_name},
        ).first()
    else:
        row = session.execute(
            text(
                "SELECT 1 FROM information_schema.tables WHERE table_name=:n"
            ),
            {"n": table_name},
        ).first()
    return row is not None




def ensure_utc_datetime(dt: datetime) -> datetime:
    """Normalize datetimes loaded from the database into timezone-aware UTC values."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
