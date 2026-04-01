# EVT Warehouse Simulator

Discrete-event warehouse simulation for estimating throughput, weight-level balance, and operational metrics. Load a map JSON, configure bots and shifts, and run simulations.

## Prerequisites

- **Node.js** 18+ and npm
- **Go** 1.22+ (for WASM pathfinder build)

## Quick Start

```bash
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

---

# {{ site }} environment

While being on the VPN (GlobalProtect), {{ site }} related URLs/addresses can be viewed at the site index here:
[http://{{ subdomain }}.artym.net](http://{{ subdomain }}.artym.net)


#### Connect to {{ site }} mothership

To connect to the {{ site }} mothership account, create the following nats context:

```bash
NATS_ACCOUNT=mothership && mkdir -p ~/.nats-creds/{{ site }} && \
  curl http://nsc.{{ subdomain }}.artym.net/accounts/credentials/$NATS_ACCOUNT > ~/.nats-creds/{{ site }}/$NATS_ACCOUNT.creds && \
  nats context save --creds ~/.nats-creds/{{ site }}/$NATS_ACCOUNT.creds --server nats://nats.{{ subdomain }}.artym.net:4222 {{ site }}-$NATS_ACCOUNT
```

Now listen for messages:

```bash
nats sub ">" --context {{ site }}-mothership
```

#### Logs

- [{{ site }} index](https://mytra.splunkcloud.com/en-US/app/search/search?earliest=-30m%40m&latest=now&q=search%20index%3D{{ site }}&display.page.search.mode=verbose&dispatch.sample_ratio=1&workload_pool=)
- [director logs (as an example)](https://mytra.splunkcloud.com/en-US/app/search/search?earliest=-30m%40m&latest=now&q=search%20index%3D{{ site }}%20%22k8s.container.name%22%3Ddirector&display.page.search.mode=verbose&dispatch.sample_ratio=1&workload_pool=)

#### Graphs

- [Host Metrics](http://graph-pine.mytra.ai:3000/d/beovfsyo884cga/host-metrics?orgId=1&from=now-3h&to=now&timezone=America%2FLos_Angeles&var-v_db={{ site }}&var-v_host={{ site }}-kubernetes0)
- [Kubernetes Resource Metrics](http://graph-pine.mytra.ai:3000/d/deqqehlcvj20wc/k8s-resource-metrics?orgId=1&from=now-24h&to=now&timezone=America%2FLos_Angeles&var-v_db={{ site }}&var-v_host_name=$__all&var-v_namespace=$__all&var-v_pod=$__all&var-v_include_nats_creds=false)

#### Connecting to kubernetes servers

Add to your ~/.ssh/config:

```
Host {{ site }}-kubernetes*
    User kuby

Host {{ site }}-kubernetes0
    Hostname {{ site }}-kubernetes0.{{ subdomain }}.artym.net

Host {{ site }}-kubernetes1
    Hostname {{ site }}-kubernetes1.{{ subdomain }}.artym.net

Host {{ site }}-kubernetes2
    Hostname {{ site }}-kubernetes2.{{ subdomain }}.artym.net
```

# Site Deployment Config Template

This repo was generated from a template repo for site cluster deployment configs. The clusters managed herein are using [FluxCD](https://fluxcd.io/flux/concepts/#gitops) as a GitOps tool.

A site's cluster repo declares the desired state of deployments for all clusters at a site.
Flux operators are installed per cluster and each cluster is responsible for its own state reconciliation.
See [the notion page](https://www.notion.so/mytra/Software-Deployment-Management-170e7769a2cb800cafa8d284cc5de210?pvs=4) about on prem software deployment management for more details on Flux architecture & GitOps principles.

- [Directory Structure](#directory-structure)
  - [sync](#sync)
    - [sync/on-prem](#syncon-prem)
    - [sync/on-bot](#syncon-bot)
      - [sync/on-bot/bots](#syncon-botbots)
    - [sync/on-station](#syncon-station)
      - [sync/on-station/stations](#syncon-stationstations)
- [Template Variables](#template-variables)
- [Background](#historical-background)

## Directory Structure

```
sync/
├── kustomize-config.yaml              # Global kustomize configmap generation config
├── mytra-helm-charts.yaml             # Helm chart source & image pull secret
├── site-values.yaml                   # Site-level values (shared by all clusters)
├── on-prem/
│   ├── cluster-values.yaml            # On-prem cluster config (nodes, networking, storage)
│   └── kustomization/
│       ├── kustomization.yaml         # Kustomization entrypoint for on-prem
│       └── mytra-site.yaml            # HelmRelease for mytra-site
├── on-bot/
│   ├── mytra-site-bot.yaml            # HelmRelease for mytra-site-bot
│   ├── bot-default-values.yaml        # Default values shared across all bots
│   └── bots/
│       └── _template/
│           ├── kustomization.yaml     # Kustomization entrypoint for a bot
│           └── bot.yaml               # Per-bot values (name, genealogy, ip, etc.)
└── on-station/
    ├── mytra-site-station.yaml        # HelmRelease for mytra-site-station
    ├── station-default-values.yaml    # Default values shared across all stations
    └── stations/
        └── _template/
            ├── kustomization.yaml     # Kustomization entrypoint for a station
            ├── station.yaml           # Per-station values (name, opcell_id)
            └── photobooth-calibration-values.yaml  # Calibration values
utils/
├── README.md
└── template_processor.py              # Replaces {{ variable }} placeholders
```

### [sync](sync)

The [sync](sync) directory holds all resources to be reconciled to clusters at the site. At the top level are files shared by all clusters:

- [sync/site-values.yaml](sync/site-values.yaml): Site-level values (name, subdomain, DNS) shared by all Helm releases across all clusters.
- [sync/kustomize-config.yaml](sync/kustomize-config.yaml): A global configuration file for [generation of configmaps](https://github.com/kubernetes-sigs/kustomize/blob/master/examples/configGeneration.md).
- [sync/mytra-helm-charts.yaml](sync/mytra-helm-charts.yaml): Defines the [Helm chart source](https://github.com/MytraAI/mytra-helm-charts) (GitRepository + HelmRepository) and the image pull secret.

#### [sync/on-prem](sync/on-prem)

Software stack resources that run on the on-prem cluster.

- [cluster-values.yaml](sync/on-prem/cluster-values.yaml): Cluster-specific configuration (nodes, ADS Net ID, TwinCAT host, MetalLB address range, NFS storage).
- [kustomization/](sync/on-prem/kustomization): Contains the Kustomization entrypoint and the [mytra-site](sync/on-prem/kustomization/mytra-site.yaml) HelmRelease.

The `mytra-site` HelmRelease merges values in this order:

1. **[site-values](sync/site-values.yaml)**: site-wide values
2. **[cluster-values](sync/on-prem/cluster-values.yaml)**: on-prem cluster config

#### [sync/on-bot](sync/on-bot)

Parent for all bot clusters.

- [mytra-site-bot.yaml](sync/on-bot/mytra-site-bot.yaml): The [mytra-site-bot](https://github.com/MytraAI/mytra-helm-charts) HelmRelease.
- [bot-default-values.yaml](sync/on-bot/bot-default-values.yaml): Default values shared across all bot deployments.

The `mytra-site-bot` HelmRelease merges values in this order:

1. **[site-values](sync/site-values.yaml)**: site-wide values
2. **[bot-default-values](sync/on-bot/bot-default-values.yaml)**: shared defaults for all bots
3. **bot-specific-values**: per-bot values from the bot's own `bot.yaml`

#### [sync/on-bot/bots](sync/on-bot/bots)

Each bot has its own directory (created from `_template/`) containing:

- **bot.yaml**: per-bot values — name, genealogy, IP address, version, ADS Net ID, foxglove device token, camera MX IDs
- **kustomization.yaml**: entrypoint that references the HelmRelease, shared values, and bot-specific values

#### [sync/on-station](sync/on-station)

Parent for all station clusters.

- [mytra-site-station.yaml](sync/on-station/mytra-site-station.yaml): The [mytra-site-station](https://github.com/MytraAI/mytra-helm-charts) HelmRelease.
- [station-default-values.yaml](sync/on-station/station-default-values.yaml): Default values shared across all station deployments.

The `mytra-site-station` HelmRelease merges values in this order:

1. **[site-values](sync/site-values.yaml)**: site-wide values
2. **[station-default-values](sync/on-station/station-default-values.yaml)**: shared defaults for all stations
3. **station-values**: per-station values from the station's own `station.yaml`
4. **photobooth-calibration-values**: per-station calibration from `photobooth-calibration-values.yaml`

#### [sync/on-station/stations](sync/on-station/stations)

Each station has its own directory (created from `_template/`) containing:

- **station.yaml**: per-station values — station name, opcell_id, cluster name
- **photobooth-calibration-values.yaml**: calibration data for the station
- **kustomization.yaml**: entrypoint that references the HelmRelease, shared values, and station-specific values

## Template Variables

Files in `sync/` use `{{ variable }}` placeholders that are replaced by `utils/template_processor.py` when creating a new site deployment config. See [utils/README.md](utils/README.md) for usage.

## [Historical] Background

See [Notion](https://www.notion.so/mytra/Software-Deployment-Management-170e7769a2cb800cafa8d284cc5de210?pvs=4#170e7769a2cb803ebfd8c5d7f0775ddb).
