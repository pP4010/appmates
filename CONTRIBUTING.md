# Contributing to AppMates

Issues and PRs welcome.

## Dev setup

```bash
git clone https://github.com/pP4010/appmates.git
cd appmates
uv sync --extra dev
```

Runs on Python 3.11+, managed with [uv](https://docs.astral.sh/uv/). The web
frontend (`web/`) is vanilla JS with no build step — edit and reload.

## Before opening a PR

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

All four must pass; CI (`.github/workflows/ci.yml`) runs the same checks
plus a web conformance suite and a CLI smoke test. If you touch
`web/`, also run the JS tests:

```bash
node --test "web/test/*.test.js"
```

## Store rule changes

When a store changes a rule, the fix is usually a one-line edit to
`src/appmates/core/specs/*.yaml` plus a bump of `last_verified` — please
include the source URL in your PR description.

## Code style

- Python: `ruff` (lint + format) and `mypy --strict` — both enforced in CI,
  no separate style guide beyond what they check.
- JS (`web/`): match the existing file's style; no framework/bundler, keep
  it that way unless discussed first in an issue.
- Keep PRs scoped to one change. Unrelated cleanup belongs in its own PR.

## Reporting a security issue

Do not open a public issue for security vulnerabilities — see
[SECURITY.md](SECURITY.md) for the disclosure process.
