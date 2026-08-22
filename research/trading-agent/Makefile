# OCT trading-agent research — task shortcuts.
# Uses uv (https://docs.astral.sh/uv/). Falls back to plain python/pip if you prefer.
#
#   make sync       # create the venv + install dev deps (uv)
#   make lint       # ruff check
#   make format     # ruff format
#   make typecheck  # mypy (strict)
#   make test       # pytest
#   make check      # lint + typecheck + test  (run before opening a PR)

.PHONY: sync lint format typecheck test check clean

sync:
	uv sync --extra dev

lint:
	uv run ruff check .

format:
	uv run ruff format .

typecheck:
	uv run mypy

test:
	uv run pytest

check: lint typecheck test

clean:
	rm -rf .mypy_cache .ruff_cache .pytest_cache **/__pycache__ dist build
