check:
	npx tsc -p tsconfig.json

test:
	$(MAKE) -C integration test

.PHONY: check test
