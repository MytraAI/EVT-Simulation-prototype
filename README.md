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
