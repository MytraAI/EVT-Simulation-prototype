# Template Parser

Here's a sample script with all the available variables:

```bash
python utils/template_processor.py \
  --site site_name \
  --subdomain site_subdomain \
  --dns_recursive_nameservers 127.0.0.1:53 \
  --nodes '["site_name-kubernetes0", "site_name-kubernetes1", "site_name-kubernetes2"]' \
  --ads_net_id 10.10.10.10.1.1 \
  --twin_cat_host 10.10.10.10 \
  --metallb_address_range_start 127.0.0.1 \
  --metallb_address_range_end 127.0.0.10 \
  --nfs_server 127.0.0.1
```

An actual example:

```bash
python utils/template_processor.py \
  --site hil \
  --subdomain hil \
  --dns_recursive_nameservers 10.100.192.11:53 \
  --nodes '["hil-kuberentes0"]' \
  --ads_net_id 10.100.200.10.1.1 \
  --twin_cat_host 10.100.200.10 \
  --metallb_address_range_start 10.100.202.40 \
  --metallb_address_range_end 10.100.202.49 \
  --nfs_server 10.100.202.30
```

### Variables

| Variable | File | Required | Description |
|---|---|---|---|
| `site` | `site-values.yaml` | Yes | Site name |
| `subdomain` | `site-values.yaml` | | Site subdomain |
| `dns_recursive_nameservers` | `site-values.yaml` | Yes | DNS recursive nameservers (e.g. `10.100.192.11:53`) |
| `nodes` | `cluster-values.yaml` | | Cluster node list |
| `ads_net_id` | `cluster-values.yaml` | | ADS Net ID |
| `twin_cat_host` | `cluster-values.yaml` | | TwinCAT host address |
| `metallb_address_range_start` | `cluster-values.yaml` | | MetalLB load balancer start address (e.g. `10.100.200.40`) |
| `metallb_address_range_end` | `cluster-values.yaml` | | MetalLB load balancer end address (e.g. `10.100.200.49`) |
| `nfs_server` | `cluster-values.yaml` | | NFS server address (inferred if not specified) |
