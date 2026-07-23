# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""SPEC-140 ticket 03: bounded check result storage.

``checks_json`` must stay bounded so a large Deliverable repeated across many
judge assertions cannot OOM the row or the list/detail query. Oversized values
become explicit ``TruncatedCheckValue`` markers; the final normalized payload
stays under the cap; truncation is data, never a silent ellipsis.
"""

from __future__ import annotations

import hashlib
import json

from apo.models.schemas import TruncatedCheckValue
from apo.services.check_result_storage import (
    JUDGE_SEGMENT_LIMIT,
    RECEIVED_VALUE_LIMIT,
    STRING_FIELD_LIMIT,
    TOTAL_CHECKS_LIMIT,
    normalize_checks_for_storage,
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class TestNormalizeChecks:
    def test_small_checks_pass_through_unchanged(self):
        checks = [
            {"name": "x", "pass": True, "received": "ok"},
            {"name": "y", "pass": False, "received": {"k": "v"}},
        ]
        out = normalize_checks_for_storage(checks)
        assert out == checks

    def test_oversized_received_value_becomes_truncated_marker(self):
        big = "x" * (RECEIVED_VALUE_LIMIT + 1000)
        encoded = json.dumps(big).encode("utf-8")
        raw_sha = _sha(encoded)
        checks = [{"name": "big-received", "pass": True, "received": big}]

        out = normalize_checks_for_storage(checks)
        assert len(out) == 1
        received = out[0]["received"]
        assert isinstance(received, dict)
        assert received["kind"] == "truncated"
        # size_bytes covers the value's persisted (JSON-encoded) form.
        assert received["size_bytes"] == len(encoded)
        assert received["sha256"] == raw_sha
        assert isinstance(received["preview"], str)
        assert len(received["preview"]) <= RECEIVED_VALUE_LIMIT

    def test_repeated_large_bodies_become_bounded(self):
        """Five judge assertions each carrying the same 1 MiB body stay bounded."""
        big = "y" * (1024 * 1024)
        checks = [
            {
                "name": f"judge-{i}",
                "pass": i % 2 == 0,
                "received": big,
                "judge_prompt": big,
                "judge_response": big,
            }
            for i in range(5)
        ]

        out = normalize_checks_for_storage(checks)
        serialized = json.dumps(out)
        # No 1 MiB substring survives — every big body became a marker.
        assert "y" * 1024 not in serialized
        # Total payload stays under the cap.
        assert len(serialized.encode("utf-8")) <= TOTAL_CHECKS_LIMIT
        # Each check still has a verdict and a name.
        assert all("pass" in c and "name" in c for c in out)

    def test_judge_prompt_and_response_are_truncated(self):
        prompt = "p" * (JUDGE_SEGMENT_LIMIT + 500)
        response = "r" * (JUDGE_SEGMENT_LIMIT + 500)
        checks = [
            {
                "name": "j",
                "pass": True,
                "received": "small",
                "judge_prompt": prompt,
                "judge_response": response,
            }
        ]
        out = normalize_checks_for_storage(checks)
        serialized = json.dumps(out)
        assert "p" * 1024 not in serialized
        assert "r" * 1024 not in serialized

    def test_string_fields_are_capped(self):
        long_instruction = "i" * (STRING_FIELD_LIMIT + 1000)
        long_expected = "e" * (STRING_FIELD_LIMIT + 1000)
        long_reasoning = "g" * (STRING_FIELD_LIMIT + 1000)
        checks = [
            {
                "name": "c",
                "pass": False,
                "received": "small",
                "instruction": long_instruction,
                "expected": long_expected,
                "reasoning": long_reasoning,
            }
        ]
        out = normalize_checks_for_storage(checks)
        # Each capped field is no longer than the limit.
        assert len(out[0]["instruction"]) <= STRING_FIELD_LIMIT  # type: ignore[arg-type]
        assert len(out[0]["expected"]) <= STRING_FIELD_LIMIT  # type: ignore[arg-type]
        assert len(out[0]["reasoning"]) <= STRING_FIELD_LIMIT  # type: ignore[arg-type]
        # And none retained the full oversized body.
        assert len(out[0]["instruction"]) == STRING_FIELD_LIMIT  # type: ignore[arg-type]

    def test_truncated_marker_matches_schema(self):
        big = "z" * (RECEIVED_VALUE_LIMIT + 10)
        encoded = json.dumps(big).encode("utf-8")
        out = normalize_checks_for_storage([{"name": "n", "pass": True, "received": big}])
        marker = out[0]["received"]
        # Validate against the TruncatedCheckValue schema shape.
        parsed = TruncatedCheckValue.model_validate(marker)
        assert parsed.kind == "truncated"
        assert parsed.size_bytes == len(encoded)

    def test_empty_and_none_checks_are_safe(self):
        assert normalize_checks_for_storage([]) == []
        assert normalize_checks_for_storage(None) == []  # type: ignore[arg-type]

    def test_non_dict_entries_are_dropped(self):
        checks = [
            {"name": "good", "pass": True, "received": "ok"},
            "not a dict",  # type: ignore[list-item]
            None,  # type: ignore[list-item]
        ]
        out = normalize_checks_for_storage(checks)
        assert len(out) == 1
        assert out[0]["name"] == "good"

    def test_total_payload_under_cap_with_many_checks(self):
        """Many modest checks never accidentally exceed the total cap."""
        checks = [
            {"name": f"c-{i}", "pass": True, "received": "x" * 100} for i in range(200)
        ]
        out = normalize_checks_for_storage(checks)
        assert len(json.dumps(out).encode("utf-8")) <= TOTAL_CHECKS_LIMIT
