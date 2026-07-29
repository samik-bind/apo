#!/usr/bin/env python3
# pyright: reportAny=false, reportUnusedCallResult=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""Generate mock runs data for testing and development.

Creates realistic mock traces (root span + 1-3 generation spans) and
ingests them via the OTLP trace endpoint — the canonical write path.

Usage:
    python scripts/generate_mock_runs.py               # Use cached data if available
    python scripts/generate_mock_runs.py --regenerate   # Force regeneration
    python scripts/generate_mock_runs.py --runs 50      # Generate 50 runs

Auth: OTLP requires API key auth. Set APO_PUBLIC_KEY / APO_SECRET_KEY
env vars, or pass --public-key / --secret-key.
"""

import argparse
import asyncio
import json
import os
import random
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

BACKEND_URL = "http://localhost:8000"
PROJECT = "example-service"
FLOW_NAME = "joke-flow"
NUM_RUNS = 30
DELAY_BETWEEN_RUNS = 0.5
CACHE_FILE = Path(__file__).parent.parent / "data" / "mock_runs_cache.json"

TOPICS = [
    "programming", "cats", "coffee", "space exploration",
    "AI", "startup life", "photography", "cooking",
    "gardening", "music", "travel", "books",
]

MODELS = [
    "gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet-20241022",
    "claude-3-haiku-20240307", "llama-3.1-70b",
]

OUTPUT_TEMPLATES = [
    "Why did the {topic} enthusiast cross the road? To get to the better implementation on the other side!",
    "I asked my computer to tell me a joke about {topic}. It said: '404: Humor not found.' But then it processed a funny one about debugging and coffee!",
    "Here's a joke about {topic}: Why do programmers prefer dark mode? Because light attracts bugs!",
    "The best thing about {topic}? It's like a good commit message - clear, concise, and makes everyone smile!",
    "Want to hear a joke about {topic}? It's a bit like AI training data - you'll need a lot of iterations to get it right!",
]

ENVIRONMENTS = ["production", "staging", "development"]
STATUSES = ["success", "success", "success", "success", "error"]


# ── OTLP typed-value helpers ─────────────────────────────────────────────


def _str_attr(key: str, value: str) -> dict[str, object]:
    return {"key": key, "value": {"stringValue": str(value)}}


def _int_attr(key: str, value: int) -> dict[str, object]:
    return {"key": key, "value": {"intValue": str(int(value))}}


def _double_attr(key: str, value: float) -> dict[str, object]:
    return {"key": key, "value": {"doubleValue": float(value)}}


def _str_array_attr(key: str, items: list[str]) -> dict[str, object]:
    return {
        "key": key,
        "value": {"arrayValue": {"values": [{"stringValue": s} for s in items]}},
    }


def _kvlist_attr(key: str, pairs: list[dict[str, object]]) -> dict[str, object]:
    return {"key": key, "value": {"kvlistValue": {"values": pairs}}}


def _message_value(role: str, content: str) -> dict[str, object]:
    return {
        "kvlistValue": {"values": [
            _str_attr("role", role),
            _str_attr("content", content),
        ]},
    }


def _nano(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return str(int(dt.timestamp()) * 1_000_000_000 + dt.microsecond * 1_000)


def _hex_trace_id() -> str:
    return uuid.uuid4().hex


def _hex_span_id() -> str:
    return uuid.uuid4().hex[:16]


# ── Mock data generation ─────────────────────────────────────────────────


def generate_mock_run_data(run_idx: int) -> dict[str, object]:
    """Generate an OTLP trace (root span + generation spans) for one run."""
    trace_id = _hex_trace_id()
    root_span_id = _hex_span_id()
    topic = random.choice(TOPICS)
    model = random.choice(MODELS)
    environment = random.choice(ENVIRONMENTS)
    status = random.choice(STATUSES)
    num_calls = random.randint(1, 3)

    created_at = datetime.now(timezone.utc) - timedelta(
        hours=random.randint(0, 72),
        minutes=random.randint(0, 59),
    )
    root_end = created_at + timedelta(seconds=random.randint(1, 5))

    # Root span — becomes the RunDB row (trace-level fields) + a SPAN observation.
    root_attrs: list[dict[str, object]] = [
        _str_attr("apo.trace.name", FLOW_NAME),
        _str_attr("apo.run.task_id", f"task-{run_idx}"),
        _str_attr("apo.run.version", "1.0.0"),
        _str_attr("apo.run.user_id", f"user-{random.randint(1, 5)}"),
        _str_attr("apo.run.environment", environment),
        _str_attr("apo.run.external_id", f"external-{run_idx}"),
        _str_array_attr("apo.trace.tags", ["mock", "generated", environment]),
        _kvlist_attr("apo.trace.metadata", [
            _str_attr("source", "mock_generator"),
            _str_attr("test_data", "true"),
        ]),
    ]

    root_span: dict[str, object] = {
        "traceId": trace_id,
        "spanId": root_span_id,
        "name": FLOW_NAME,
        "kind": 0,
        "startTimeUnixNano": _nano(created_at),
        "endTimeUnixNano": _nano(root_end),
        "attributes": root_attrs,
    }

    spans: list[dict[str, object]] = [root_span]

    for call_idx in range(num_calls):
        prompt_tokens = random.randint(50, 200)
        completion_tokens = random.randint(30, 150)
        latency_ms = random.randint(500, 3000)

        call_start = created_at + timedelta(milliseconds=call_idx * 100)
        call_end = call_start + timedelta(milliseconds=latency_ms)

        input_data = {
            "topic": topic,
            "style": random.choice(["funny", "witty", "dry", "pun"]),
            "length": random.choice(["short", "medium", "long"]),
        }

        if status == "error":
            output_data = {
                "error": "Failed to generate joke",
                "error_type": "RateLimitError",
            }
            span_status: dict[str, object] = {
                "code": 2,
                "message": "RateLimitError: Failed to generate joke",
            }
        else:
            output_data = {
                "joke": random.choice(OUTPUT_TEMPLATES).format(topic=topic),
                "topic": topic,
            }
            span_status = {"code": 1}

        cost = round(
            (prompt_tokens / 1000) * 0.00015
            + (completion_tokens / 1000) * 0.0006,
            6,
        )

        call_attrs: list[dict[str, object]] = [
            _str_attr("gen_ai.request.model", model),
            _str_attr("gen_ai.system", "openai"),
            _int_attr("gen_ai.usage.input_tokens", prompt_tokens),
            _int_attr("gen_ai.usage.output_tokens", completion_tokens),
            _double_attr("apo.observation.cost.amount", cost),
            {
                "key": "gen_ai.input.messages",
                "value": {"arrayValue": {"values": [
                    _message_value("user", json.dumps(input_data)),
                ]}},
            },
            {
                "key": "gen_ai.output.messages",
                "value": {"arrayValue": {"values": [
                    _message_value("assistant", json.dumps(output_data)),
                ]}},
            },
        ]

        spans.append({
            "traceId": trace_id,
            "spanId": _hex_span_id(),
            "parentSpanId": root_span_id,
            "name": "generate-joke",
            "kind": 0,
            "startTimeUnixNano": _nano(call_start),
            "endTimeUnixNano": _nano(call_end),
            "status": span_status,
            "attributes": call_attrs,
        })

    return {
        "resourceSpans": [{
            "resource": {
                "attributes": [_str_attr("service.name", "mock-generator")],
            },
            "scopeSpans": [{
                "scope": {"name": "generate_mock_runs.py"},
                "spans": spans,
            }],
        }],
    }


async def ingest_otlp(
    payload: dict[str, object],
    client: httpx.AsyncClient,
    auth: tuple[str, str],
    backend_url: str,
) -> bool:
    try:
        response = await client.post(
            f"{backend_url}/api/public/otel/v1/traces",
            json=payload,
            auth=auth,
            timeout=30.0,
        )
        response.raise_for_status()
        accepted = response.headers.get("X-Otlp-Accepted", "?")
        rejected = response.headers.get("X-Otlp-Rejected", "0")
        print(f"  + Accepted: {accepted}, Rejected: {rejected}")
        return True
    except Exception as e:
        print(f"  x Failed to ingest: {e}")
        return False


def save_to_cache(all_runs: list[dict[str, object]]) -> None:
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CACHE_FILE, "w") as f:
        json.dump(all_runs, f, indent=2)
    print(f"Saved {len(all_runs)} runs to cache: {CACHE_FILE}")


def load_from_cache() -> list[dict[str, object]] | None:
    if not CACHE_FILE.exists():
        return None
    with open(CACHE_FILE) as f:
        return json.load(f)


def generate_all_runs(num_runs: int) -> list[dict[str, object]]:
    return [generate_mock_run_data(i) for i in range(num_runs)]


def _span_count(payload: dict[str, object]) -> int:
    resource_spans = payload.get("resourceSpans")
    if not isinstance(resource_spans, list) or not resource_spans:
        return 0
    first = resource_spans[0]
    if not isinstance(first, dict):
        return 0
    scope_spans = first.get("scopeSpans")
    if not isinstance(scope_spans, list) or not scope_spans:
        return 0
    first_scope = scope_spans[0]
    if not isinstance(first_scope, dict):
        return 0
    spans = first_scope.get("spans")
    if not isinstance(spans, list):
        return 0
    return len(spans)


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate mock runs data via OTLP trace endpoint",
    )
    parser.add_argument("--runs", type=int, default=NUM_RUNS, help="Number of runs to generate")
    parser.add_argument("--regenerate", action="store_true", help="Force regeneration, ignore cache")
    parser.add_argument("--cache-only", action="store_true", help="Only generate cache, don't ingest")
    parser.add_argument(
        "--public-key",
        default=os.environ.get("APO_PUBLIC_KEY"),
        help="API public key (or APO_PUBLIC_KEY env)",
    )
    parser.add_argument(
        "--secret-key",
        default=os.environ.get("APO_SECRET_KEY"),
        help="API secret key (or APO_SECRET_KEY env)",
    )
    parser.add_argument("--backend-url", default=BACKEND_URL, help="Backend URL")
    args = parser.parse_args()

    public_key = args.public_key
    secret_key = args.secret_key

    if not args.regenerate:
        cached = load_from_cache()
        if cached is not None:
            print(f"Found {len(cached)} cached runs in {CACHE_FILE}")
            use_cache = input("Use cached data? (Y/n): ").strip().lower()
            if use_cache != "n":
                all_runs = cached[:args.runs]
                print(f"Using {len(all_runs)} cached runs")
            else:
                print("Regenerating...")
                all_runs = generate_all_runs(args.runs)
                save_to_cache(all_runs)
        else:
            print("No cache found, generating new data...")
            all_runs = generate_all_runs(args.runs)
            save_to_cache(all_runs)
    else:
        print("Regenerating data...")
        all_runs = generate_all_runs(args.runs)
        save_to_cache(all_runs)

    if args.cache_only:
        print(f"Cache updated with {len(all_runs)} runs")
        return

    if not public_key or not secret_key:
        print("No API keys provided. The OTLP endpoint requires authentication.")
        print("Set APO_PUBLIC_KEY and APO_SECRET_KEY env vars, or pass --public-key/--secret-key.")
        return

    assert public_key is not None and secret_key is not None
    auth: tuple[str, str] = (public_key, secret_key)

    print(f"Ingesting {len(all_runs)} mock traces via OTLP for project '{PROJECT}'")
    print(f"Target: {args.backend_url}/api/public/otel/v1/traces")
    print()

    async with httpx.AsyncClient() as client:
        try:
            await client.get(f"{args.backend_url}/api/health", timeout=5.0)
            print("Backend is running")
        except Exception as e:
            print(f"Backend is not accessible: {e}")
            print("Start the backend first: cd backend && python -m uvicorn apo.main:app --reload")
            return

        print()

        success_count = 0
        for i, payload in enumerate(all_runs):
            n = _span_count(payload)
            print(f"[{i+1}/{len(all_runs)}] Ingesting trace with {n} spans...")
            if await ingest_otlp(payload, client, auth, args.backend_url):
                success_count += 1
            if i < len(all_runs) - 1:
                await asyncio.sleep(DELAY_BETWEEN_RUNS)

        print()
        print(f"Successfully ingested {success_count}/{len(all_runs)} traces")
        print()
        print("View your runs at: http://localhost:3002/runs")


if __name__ == "__main__":
    asyncio.run(main())
