# @apo-ai/cli

Command-line interface for the [Apo](https://github.com/samikuikka/apo) agent testing and observability platform.

## Installation

```bash
pnpm add @apo-ai/cli
# or: npm install @apo-ai/cli
```

Requires Node.js ≥ 20.

## Usage

```bash
apo --help            # list commands
apo login             # authenticate with your Apo server
apo task list         # list published tasks
apo task run <name>   # run a task locally
apo connect           # connect as a persistent executor
```

## Configuration

The CLI reads configuration from environment variables and `~/.apo/credentials` (written by `apo login`):

| Flag | Env var | Description |
|------|---------|-------------|
| `--backend <url>` | `APO_BACKEND_URL` | Apo server URL (default: `http://localhost:8000`) |
| `--project <id>` | `APO_PROJECT_ID` | Active project |
| `--api-key <key>` | `APO_API_KEY` | API key (default: read from credentials) |
| `--dir <path>` | `APO_TASK_ROOT` | Task root directory (default: `./e2e`) |

## License

MIT
