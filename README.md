# EVT Warehouse Simulator

Discrete-event warehouse simulation for estimating throughput, weight-level balance, and operational metrics. Load a map JSON, configure bots and shifts, and run simulations.

## Prerequisites

- **Node.js** 18+ and npm
- **Go** — auto-installed locally by `make setup` if not found

### Installing Node.js

**macOS** (via Homebrew):
```bash
brew install node
```

**Linux** (Ubuntu/Debian):
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Any platform**: Download from https://nodejs.org

### Go (optional)

Go is only needed to build the WASM pathfinder. If Go is not installed, `make setup` will automatically download Go 1.23.4 to a local `.local/go` directory — no system install required.

To install Go system-wide instead:

**macOS**: `brew install go`

**Linux**: `sudo apt-get install golang-go` or download from https://go.dev/dl

## Quick Start

```bash
git clone https://github.com/MytraAI/EVT-Simulation-prototype.git
cd EVT-Simulation-prototype
make setup   # install deps + build WASM (first time only)
make dev     # start dev server on port 5173
```

Open http://localhost:5173 — the EVT map loads automatically.

To see all available commands:

```bash
make help
```

## Running a Single Shift

1. Set parameters in the left sidebar:
   - **Bots**: count, speed
   - **Operation Times**: station pick/drop, position pick/drop
   - **Shift**: mode, pallet count, initial fill %
2. Click **Apply & Reset**
3. Click **Play** to watch bots animate, or **Step** for one tick at a time
4. Use speed buttons (1x through Max) to control playback speed
5. Simulation auto-pauses when the shift completes
6. Results appear in the green box at the bottom: pallets/hr, inducted, retrieved, time

## Running a Multi-Shift Eval

For validated throughput numbers across multiple shifts:

1. Set **Eval shifts** (e.g. 5) in the Shift section
2. Click **Run Eval (N shifts)** — runs all shifts instantly (no animation)
3. Results table shows per-shift metrics and averages across all shifts
4. Pallets carry over between shifts so later shifts reflect a realistic warehouse state

## Shift Modes

| Mode | Description |
|------|-------------|
| **Mixed** | Random induct/retrieve. Orders follow 5:3:1 ratio (high:med:low velocity SKUs) |
| **Fill-Drain** | Fills N/2 pallets, then drains N/2 |
| **Pure Induct** | Only stores pallets (capped at empty positions) |
| **Pure Retrieve** | Only retrieves pallets (capped at available pallets) |

## How Position Selection Works

The simulator uses a scoring algorithm for pallet placement:

- **Weight-level enforcement** (50pts): Ground level fills first (4000 lbs capacity), then L2 (3000 lbs), L3 (2000 lbs), L4 (1000 lbs). Heavy pallets are kept low.
- **Bottom-up fill** (30pts): Lower levels must be >70% full before upper levels are used.
- **Velocity-aisle proximity** (25pts): High velocity SKUs placed nearest to aisles for fast retrieval. Low velocity goes deep.
- **Blocker minimization** (20pts): Avoids positions that would block access to existing pallets.
- **Radial balance** (15pts): Distributes weight evenly left/right and front/back.

## Key Metrics

- **Pallets/hr** — calculated at shift end from total completed / elapsed time
- **Weight-Level Parity** — are heavy pallets on lower levels? (quadratic penalty score)
- **Radial Balance** — weight imbalance between left/right and front/back
- **Level Weight Distribution** — per-level fill %, weight, and capacity
- **Bot Utilization** — % time busy vs idle
- **SKU Distribution** — count per SKU with velocity class (H/M/L)

## Loading Custom Maps

- **Drag & drop** any map JSON onto the upload area in the sidebar
- Or place it in `app/public/` and add it to the `BUILT_IN_MAPS` array in `app/src/components/ConfigPanel.tsx`

## Project Structure

```
app/                    React + Vite frontend
  src/
    components/         UI components (App, Viewport, ConfigPanel, Controls, MetricsPanel)
    simulation/         Sim engine, bot state machine, position selector, WASM bridge
    graph/              Map JSON loader and types
    metrics/            Health score calculations
wasm/                   Go WASM pathfinder (Dijkstra with direction-dependent costs)
EVT_3_31_21.json        Sample warehouse map
```

## Rebuilding WASM

If you change the Go pathfinding code:

```bash
cd wasm && make build
```

Outputs `pathfinder.wasm` and `wasm_exec.js` to `app/public/`.

## Troubleshooting

**`npm install` fails with EACCES / permission errors:**

npm's global cache directory may be owned by root. Fix with:

```bash
sudo chown -R $(whoami) ~/.npm
```

**WASM build fails with "wasm_exec.js not found":**

Your Go version may be too old. Run `make clean` and `make setup` to re-download a compatible Go version, or install Go 1.23+ manually.

**"WebGL context could not be created" in browser:**

The 3D view requires WebGL. If your browser has GPU acceleration disabled, the app falls back to a 2D canvas view automatically. To enable WebGL in Chrome: go to `chrome://settings/system` and enable "Use graphics acceleration when available".

**Port 5173 already in use:**

Kill the existing process or use a different port:

```bash
cd app && npx vite --port 3000
```
