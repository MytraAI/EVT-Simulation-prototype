WASM_OUT = ../app/public/pathfinder.wasm
WASM_EXEC = ../app/public/wasm_exec.js

.PHONY: build clean

build:
	GOOS=js GOARCH=wasm go build -o $(WASM_OUT) .
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(WASM_EXEC)

clean:
	rm -f $(WASM_OUT) $(WASM_EXEC)
