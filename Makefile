.PHONY: setup wasm app dev build clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: wasm app ## First-time setup: install deps + build WASM

wasm: ## Build Go WASM pathfinder
	@echo "Building WASM pathfinder..."
	cd wasm && make build

app: ## Install frontend dependencies
	@echo "Installing frontend dependencies..."
	cd app && npm install

dev: ## Start dev server (run setup first)
	cd app && npx vite --host 0.0.0.0 --port 5173

build: ## Production build
	cd app && npx vite build

clean: ## Remove build artifacts
	cd wasm && make clean
	rm -rf app/node_modules app/dist
