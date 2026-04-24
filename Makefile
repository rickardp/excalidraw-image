# excalidraw-image — top-level Makefile.
#
# Most targets are stubs during scaffolding (task P-001). They print a
# "not-yet-implemented" line and exit 0 so that downstream tasks can wire
# them in one at a time without breaking existing dev loops.

.DEFAULT_GOAL := help

.PHONY: help bootstrap core fonts dev rust parity test clean

help:
	@echo "excalidraw-image — available targets:"
	@echo ""
	@echo "  make bootstrap   Install Node, Rust, and Deno dependencies."
	@echo "  make core        Build dist/core.mjs via esbuild."
	@echo "  make fonts       Regenerate src/core/font-assets.mjs from npm."
	@echo "  make dev         Run the Deno dev loop on a fixture."
	@echo "  make rust        Build the Rust shell (target/release/excalidraw-image)."
	@echo "  make parity      Diff Deno output vs Rust output on every fixture."
	@echo "  make test        Run JS unit tests, cargo test, and the parity gate."
	@echo "  make clean       Remove build outputs."
	@echo ""
	@echo "Run 'make <target>' to invoke one."

bootstrap:
	npm ci && cargo fetch && deno cache src/core/dev.mjs

core:
	@echo "not-yet-implemented: core"

fonts:
	@echo "not-yet-implemented: fonts"

dev:
	@echo "not-yet-implemented: dev"

rust:
	@echo "not-yet-implemented: rust"

parity:
	@echo "not-yet-implemented: parity"

test:
	@echo "not-yet-implemented: test"

clean:
	rm -rf dist target
