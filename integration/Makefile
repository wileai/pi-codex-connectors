# Integration and scenario tests. They use the real Codex app-server and your Codex login.
# No model tokens are spent: the pi scenario uses a scripted model.

# Use the development host patched by make setup, unless explicitly overridden.
PI_BIN ?= $(abspath ../node_modules/.bin/pi)
export PI_BIN

test: test-connectors test-pi test-rpc

test-connectors:
	node --test --test-concurrency=1 codex-connectors.test.ts

test-pi:
	node --test --test-concurrency=1 pi-scenario.test.ts

.PHONY: test test-connectors test-pi

test-rpc:
	node --test --test-concurrency=1 rpc-scenario.test.ts

.PHONY: test-rpc
