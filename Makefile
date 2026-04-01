.PHONY: setup wasm app dev build clean help ensure-go ensure-node

GO_VERSION := 1.22.5
GO_LOCAL := $(CURDIR)/.local/go
GO_BIN := $(GO_LOCAL)/bin/go
NODE_MIN := 18

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ensure-node ensure-go wasm app ## First-time setup: install deps + build WASM

ensure-node:
	@if ! command -v node >/dev/null 2>&1; then \
		echo "Error: Node.js is required but not found. Install Node.js $(NODE_MIN)+ from https://nodejs.org"; \
		exit 1; \
	fi
	@NODE_VER=$$(node -v | sed 's/v//' | cut -d. -f1); \
	if [ "$$NODE_VER" -lt "$(NODE_MIN)" ]; then \
		echo "Error: Node.js $(NODE_MIN)+ required, found $$(node -v)"; \
		exit 1; \
	fi
	@echo "Node.js $$(node -v) OK"

ensure-go:
	@if command -v go >/dev/null 2>&1; then \
		echo "Go $$(go version | awk '{print $$3}') found"; \
	elif [ -x "$(GO_BIN)" ]; then \
		echo "Using local Go at $(GO_BIN)"; \
	else \
		echo "Go not found — installing Go $(GO_VERSION) locally..."; \
		mkdir -p $(CURDIR)/.local; \
		ARCH=$$(uname -m); \
		case "$$ARCH" in \
			x86_64)  GOARCH=amd64 ;; \
			aarch64|arm64) GOARCH=arm64 ;; \
			*) echo "Unsupported arch: $$ARCH"; exit 1 ;; \
		esac; \
		OS=$$(uname -s | tr '[:upper:]' '[:lower:]'); \
		URL="https://go.dev/dl/go$(GO_VERSION).$$OS-$$GOARCH.tar.gz"; \
		echo "Downloading $$URL ..."; \
		curl -fsSL "$$URL" | tar -xz -C $(CURDIR)/.local; \
		echo "Go $(GO_VERSION) installed to $(GO_LOCAL)"; \
	fi

# Resolve which go binary to use
GO = $(shell command -v go 2>/dev/null || echo "$(GO_BIN)")

wasm: ensure-go ## Build Go WASM pathfinder
	@echo "Building WASM pathfinder..."
	cd wasm && GOOS=js GOARCH=wasm $(GO) build -o ../app/public/pathfinder.wasm .
	cp "$$($(GO) env GOROOT)/lib/wasm/wasm_exec.js" app/public/wasm_exec.js

app: ensure-node ## Install frontend dependencies
	@echo "Installing frontend dependencies..."
	cd app && npm install

dev: ## Start dev server (run setup first)
	cd app && npx vite --host 0.0.0.0 --port 5173

build: ## Production build
	cd app && npx vite build

clean: ## Remove build artifacts
	rm -f app/public/pathfinder.wasm app/public/wasm_exec.js
	rm -rf app/node_modules app/dist
	rm -rf .local/go
