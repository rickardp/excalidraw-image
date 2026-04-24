# excalidraw-image — top-level Makefile.
#
# Targets either run their real command or a guarded placeholder that prints
# "not-yet-implemented (<task-id>)" and exits 0 until the downstream tooling
# (J-010, FNT-001, R-007, etc.) lands. See PLAN.md §8.1 and TASKS.md P-004.

.DEFAULT_GOAL := help

.PHONY: help bootstrap core fonts dev rust parity test clean

help:
	@echo "excalidraw-image — available targets:"
	@echo ""
	@echo "  make bootstrap   Install Node, Rust, and Deno dependencies."
	@echo "  make core        Build dist/core.mjs via esbuild (J-010)."
	@echo "  make fonts       Regenerate src/core/font-assets.mjs from npm (FNT-001)."
	@echo "  make dev         Run the Deno dev loop on tests/fixtures/basic-shapes.excalidraw."
	@echo "  make rust        Build the Rust shell (target/release/excalidraw-image)."
	@echo "  make parity      Diff Deno vs Rust output on every fixture (R-007)."
	@echo "  make test        Run vitest, cargo test, and the parity gate."
	@echo "  make clean       Remove build outputs (dist/, target/, node_modules/.cache)."
	@echo ""
	@echo "Run 'make <target>' to invoke one."

bootstrap:
	npm ci && cargo fetch && deno cache src/core/dev.mjs

# J-010 will add src/scripts/build-core.mjs. Until then we echo a placeholder
# and exit 0 so downstream targets (e.g. `make test`) stay green.
core:
	@test -f src/scripts/build-core.mjs \
		&& node src/scripts/build-core.mjs \
		|| echo "not-yet-implemented (J-010)"

# FNT-001 will add src/scripts/build-font-assets.mjs. Same guard pattern as core.
fonts:
	@test -f src/scripts/build-font-assets.mjs \
		&& node src/scripts/build-font-assets.mjs \
		|| echo "not-yet-implemented (FNT-001)"

# The current src/core/dev.mjs stub (from P-003) intentionally exits 2 to
# signal "not wired up yet" — see J-009. We let that exit code propagate so
# the failure is visible; `make dev` will exit non-zero until J-009 lands.
dev:
	deno run --allow-read src/core/dev.mjs tests/fixtures/basic-shapes.excalidraw

rust:
	cargo build --release -p excalidraw-image

# R-007 implements the real Deno-vs-Rust byte-diff gate. Placeholder until then.
parity:
	@echo "not-yet-implemented (R-007)"

# vitest with --passWithNoTests so phase 0 has no failures from an empty suite.
# cargo test runs against the R-001 placeholder crate; parity is a no-op today.
test:
	npx vitest run --passWithNoTests
	cargo test
	$(MAKE) parity

# Keep node_modules/ intact — that's what `make bootstrap` rebuilds. Wipe only
# derived caches and build outputs.
clean:
	rm -rf dist/ target/ node_modules/.cache
