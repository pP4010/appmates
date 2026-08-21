## What this does

<!-- One or two sentences. -->

## Why

<!-- The problem this solves, or the source URL if this is a store rule change. -->

## Checklist

- [ ] `uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest` all pass
- [ ] `node --test "web/test/*.test.js"` passes (if `web/` changed)
- [ ] Scope is one change — unrelated cleanup is in a separate PR
