"""Bundled Executor entrypoint — ``python -m apo.executor connect``."""

from __future__ import annotations

import asyncio
import logging

from apo.executor.agent import BundledExecutorAgent
from apo.executor.client import ExecutorProtocolClient
from apo.executor.config import ConfigError, load_config
from apo.executor.drivers.base import ExecutionDriver
from apo.executor.drivers.subprocess import SubprocessExecutionDriver


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s executor %(levelname)s %(message)s")
    try:
        config = load_config()
    except ConfigError as exc:
        print(f"executor: configuration error: {exc}", flush=True)
        return 2

    client = ExecutorProtocolClient(control_plane_url=config.control_plane_url)
    driver: ExecutionDriver
    if config.driver == "subprocess":
        driver = SubprocessExecutionDriver(task_user=config.task_user)
    else:
        raise ConfigError(f"unsupported APO_EXECUTOR_DRIVER: {config.driver!r}")
    agent = BundledExecutorAgent(config, client=client, driver=driver)

    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        agent.request_shutdown()
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
