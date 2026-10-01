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

.PHONY: setup check test
