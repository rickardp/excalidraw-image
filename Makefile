# excalidraw-image — top-level Makefile.
#
# Build, test, and release helpers for the JS bundle, Rust shell, fixtures,
# and parity gates.

.DEFAULT_GOAL := help

.PHONY: help bootstrap core fonts dev rust parity audit deno-test test clean

help:
	@echo "excalidraw-image — available targets:"
	@echo ""
	@echo "  make bootstrap   Install Node, Rust, and Deno dependencies."
	@echo "  make core        Build dist/core.mjs via esbuild (J-010)."
	@echo "  make fonts       Regenerate src/core/font-assets.mjs from npm (FNT-001)."
	@echo "  make dev         Run the Deno dev loop on tests/fixtures/basic-shapes.excalidraw."
	@echo "  make rust        Build the Rust shell (target/release/excalidraw-image)."
	@echo "  make parity      Diff Deno vs Rust output on every fixture (R-007)."
	@echo "  make audit       Fail if dist/core.mjs pulls forbidden imports (J-011)."
	@echo "  make deno-test   Smoke-test dist/core.mjs under Deno (J-012)."
	@echo "  make test        Run vitest, cargo test, and the parity gate."
	@echo "  make clean       Remove build outputs (dist/, target/, node_modules/.cache)."
	@echo ""
	@echo "Run 'make <target>' to invoke one."

bootstrap:
	npm ci
	# Populate crates/excalidraw-image-fonts-*/fonts/ from node_modules.
	# Those dirs are gitignored — see src/scripts/sync-fonts.mjs.
	npm run sync-fonts
	cargo fetch
	deno cache src/core/dev.mjs

core:
	node src/scripts/build-core.mjs

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

# Deno-vs-Rust byte-identity gate. The real gate lives in
# `crates/excalidraw-image/tests/parity.rs`; it spawns `deno run
# tests/rust/deno-run.mjs <fixture>` and the release binary per fixture and
# compares stdout byte-for-byte. Depends on `core` because both hosts load
# `dist/core.mjs`.
parity: core
	# `--features cjk-full` so the Rust side has every Xiaolai shard
	# loaded (common + long-tail), matching what Deno's dev path reads
	# from node_modules. With only `cjk` (165 shards) Rust would diverge
	# on any fixture that hits CJK Ext A or compatibility ideographs.
	cargo test -p excalidraw-image --release --features cjk-full --test parity

# J-011: CI gate against forbidden imports in dist/core.mjs. Requires a
# fresh dist/meta.json, so build core first.
audit: core
	npm run audit
	npm run check:fonts

# D-004: regenerate committed SVG goldens. Manual-intent operation; not part
# of `make test`. Run when a change to the export path is intentional.
goldens: core
	node src/scripts/regen-goldens.mjs

# J-012: smoke test for the shipped bundle under Deno. Imports dist/core.mjs
# directly (not src/core/**), so it validates the esbuild alias + stub chain.
# Depends on core to guarantee the bundle is current.
deno-test: core
	deno test --allow-read tests/deno/

# vitest with --passWithNoTests so phase 0 has no failures from an empty suite.
# cargo test runs against the R-001 placeholder crate; parity is a no-op today.
test: audit deno-test
	npx vitest run --passWithNoTests
	cargo test
	$(MAKE) parity

# Keep node_modules/ intact — that's what `make bootstrap` rebuilds. Wipe only
# derived caches and build outputs.
clean:
	rm -rf dist/ target/ node_modules/.cache
