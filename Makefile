# Pi's upstream shrinkwrap currently pins brace-expansion 5.0.9.
# Patch the development host explicitly; extension consumers supply their own Pi.
setup:
	npm ci --ignore-scripts
	npm install --prefix node_modules/@earendil-works/pi-coding-agent --no-save --ignore-scripts --omit=dev brace-expansion@5.0.12

check:
	node scripts/check-dependencies.mjs
	npx tsc -p tsconfig.json

test:
	$(MAKE) -C integration test

test-web-search:
	node --test --test-concurrency=1 integration/web-search.test.ts integration/permissions.test.ts
	$(MAKE) -C integration test-web-search-policy

test-web-search-live:
	node --test --test-concurrency=1 integration/web-search-live.test.ts
	$(MAKE) -C integration test-web-search-pi

.PHONY: setup check test test-web-search test-web-search-live

test-computer-use:
	node --test integration/computer-use.test.ts

.PHONY: test-computer-use
