# pyright: reportUnknownMemberType=false, reportArgumentType=false

"""Shared SQLAlchemy column handles for the runs package.

These ``_as_column(cast(object, Model.attr))`` expressions are pure
derivations from SQLModel attributes — they exist so call sites get a typed
``ColumnElement[T]`` instead of the untyped ``InstrumentedAttribute`` that
pyright/SQLAlchemy produced natively. Centralizing them here lets
``crud.py`` and ``list_query.py`` share one source of truth instead of
each keeping a private copy.
"""

from datetime import datetime
from typing import cast

from sqlalchemy.orm import defer
from sqlalchemy.sql.elements import ColumnElement

from ...db_helpers import as_column
from ...models import LoggedCallDB, RunDB, RunMetricDB


RUN_ID_COL: ColumnElement[str] = as_column(cast(object, RunDB.id))
RUN_PROJECT_COL: ColumnElement[str] = as_column(cast(object, RunDB.project))
RUN_CREATED_AT_COL: ColumnElement[datetime] = as_column(
    cast(object, RunDB.created_at)
)
RUN_PRIMARY_MODEL_COL: ColumnElement[str | None] = as_column(
    cast(object, RunDB.primary_model)
)
RUN_EXTERNAL_ID_COL: ColumnElement[str | None] = as_column(
    cast(object, RunDB.external_id)
)
RUN_DURATION_MS_COL: ColumnElement[float | None] = as_column(
    cast(object, RunDB.duration_ms)
)
RUN_CALL_COUNT_COL: ColumnElement[int] = as_column(cast(object, RunDB.call_count))
RUN_FLOW_NAME_COL: ColumnElement[str | None] = as_column(
    cast(object, RunDB.flow_name)
)
RUN_ENVIRONMENT_COL: ColumnElement[str] = as_column(cast(object, RunDB.environment))
RUN_SESSION_ID_COL: ColumnElement[str | None] = as_column(
    cast(object, RunDB.session_id)
)
RUN_USER_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.user_id))
RUN_METRIC_SCORE_COL: ColumnElement[float | None] = as_column(
    cast(object, RunMetricDB.score)
)
LOGGED_CALL_STEP_INDEX_COL: ColumnElement[int | None] = as_column(
    cast(object, LoggedCallDB.step_index)
)
LOGGED_CALL_CREATED_AT_COL: ColumnElement[datetime] = as_column(
    cast(object, LoggedCallDB.created_at)
)
LOGGED_CALL_LEVEL_COL: ColumnElement[str | None] = as_column(
    cast(object, LoggedCallDB.level)
)
RUN_METRIC_RUN_ID_COL: ColumnElement[str | None] = as_column(
    cast(object, RunMetricDB.run_id)
)
RUN_METRIC_PROJECT_COL: ColumnElement[str] = as_column(
    cast(object, RunMetricDB.project)
)
LOGGED_CALL_RUN_ID_COL: ColumnElement[str | None] = as_column(
    cast(object, LoggedCallDB.run_id)
)
LOGGED_CALL_PROJECT_COL: ColumnElement[str] = as_column(
    cast(object, LoggedCallDB.project)
)
LOGGED_CALL_MODEL_COL: ColumnElement[str | None] = as_column(
    cast(object, LoggedCallDB.model)
)
LOGGED_CALL_ID_COL: ColumnElement[str | None] = as_column(
    cast(object, LoggedCallDB.id)
)

# Defer the heaviest LoggedCallDB columns on list/preview/metrics paths that
# only read scalar fields or short previews. Lazy-loaded on access.
CALL_LIGHT = (
    defer(LoggedCallDB.messages),
    defer(LoggedCallDB.tool_parameters),
    defer(LoggedCallDB.tool_result),
    defer(LoggedCallDB.cost_breakdown),
    defer(LoggedCallDB.raw_usage),
)
