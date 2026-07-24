# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false

"""SPEC-144: bounded subprocess output ring buffers + driver result types."""

from __future__ import annotations

from apo.executor.bounded_output import BoundedOutput
from apo.executor.drivers.base import DriverResult


def test_bounded_output_empty_decodes_to_empty_string() -> None:
    out = BoundedOutput(max_bytes=64)
    assert out.tail() == ""
    assert out.byte_len() == 0


def test_bounded_output_appends_and_decodes() -> None:
    out = BoundedOutput(max_bytes=64)
    out.append(b"hello ")
    out.append(b"world")
    assert out.tail() == "hello world"
    assert out.byte_len() == 11


def test_bounded_output_retains_only_last_max_bytes() -> None:
    out = BoundedOutput(max_bytes=8)
    out.append(b"0123456789abcdef")  # 16 bytes
    assert out.byte_len() == 8
    assert out.tail() == "89abcdef"


def test_bounded_output_caps_across_many_appends() -> None:
    out = BoundedOutput(max_bytes=10)
    for _ in range(100):
        out.append(b"abcdefghij")  # 10 bytes each
    assert out.byte_len() == 10
    assert out.tail() == "abcdefghij"


def test_invalid_utf_8_produces_safe_replacement_without_raising() -> None:
    out = BoundedOutput(max_bytes=64)
    out.append(b"\xff\xfe\xfd")  # invalid UTF-8 continuations
    # Must not raise; replacement char(s) are acceptable.
    decoded = out.tail()
    assert isinstance(decoded, str)


def test_multibyte_split_at_boundary_does_not_raise() -> None:
    out = BoundedOutput(max_bytes=4)
    # 'é' is 2 UTF-8 bytes (0xc3 0xa9). Feed 5 bytes so the head byte is cut.
    out.append(b"a\xc3\xa9\xc3")  # 'a','é', then a lone 0xc3
    decoded = out.tail()  # last 4 bytes = '\xc3\xa9\xc3' -> trailing 0xc3 incomplete
    assert isinstance(decoded, str)
    assert out.byte_len() <= 4


def test_driver_result_defaults() -> None:
    r = DriverResult(
        task_result=None, exit_code=None, timed_out=False, cancelled=False,
        failure_kind=None, error_message=None, stdout_tail="", stderr_tail="",
        driver_metadata={},
    )
    assert r.task_result is None
    assert r.failure_kind is None
    assert r.stdout_tail == ""
