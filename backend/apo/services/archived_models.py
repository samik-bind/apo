"""Models a project has retired from its filter dropdowns.

The model palette on the Runs and Tasks pages is derived from the distinct
``configured_model`` values on runs, so one run of a model puts it in those
dropdowns permanently. Archiving removes it from the lists.

Presence of an ``archived_model`` row is the state — there is no flag to read.
That makes un-archiving and the auto-unarchive on a fresh run the same DELETE.

Archiving is display-only: nothing here is consulted when filtering runs, so a
shared link or a saved view pinned to an archived model keeps working.
"""

from __future__ import annotations

from sqlmodel import Session, select

from ..models.db import ArchivedModelDB


def load_archived_models(session: Session, project_id: str) -> set[str]:
    """The project's archived model names, for flagging facet payloads."""
    rows = session.exec(
        select(ArchivedModelDB.model).where(ArchivedModelDB.project_id == project_id)
    ).all()
    return set(rows)


def set_model_archived(
    session: Session,
    project_id: str,
    model: str,
    *,
    archived: bool,
    user_id: str | None = None,
) -> None:
    """Archive or un-archive one model. Idempotent in both directions.

    Stages on the session; the caller commits.
    """
    existing = session.exec(
        select(ArchivedModelDB).where(
            ArchivedModelDB.project_id == project_id,
            ArchivedModelDB.model == model,
        )
    ).first()

    if archived:
        if existing is None:
            session.add(
                ArchivedModelDB(
                    project_id=project_id,
                    model=model,
                    archived_by_user_id=user_id,
                )
            )
    elif existing is not None:
        session.delete(existing)
