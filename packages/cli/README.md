# @apo-ai/cli

Command-line interface for [Apo](https://github.com/samikuikka/apo) — an opinionated agent testing framework.

## Installation

```bash
npm install -g @apo-ai/cli
apo --version
```

Or run without a global install:

```bash
npx @apo-ai/cli --version
```

Requires Node.js ≥ 20.

## Usage

```bash
apo --help            # list commands
apo login             # authenticate with your Apo server
apo status            # show effective backend, project, and task root
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
