#!/usr/bin/env python3
"""Extract the southbound-zone slice from a Grainger pilot graph.

Slice definition: level 1, grid_y <= 12 — the 4 south stations (grid_y=0,
y_m ≈ 0.51m) plus their 2 travel rows (1-2) and 10 buffer rows (3-12).

Axis convention matches cmd/calibrate/zone.go: grid_y = 0 is SOUTH,
grid_y = 46 is NORTH.

Usage:
    python scripts/extract-south-slice.py <input-graph.json> <output-slice.json> [--label LABEL]

The emitted slice carries metadata.source_graph + metadata.variant for
downstream traceability.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ZONE_MAX_GY = 12


def extract(input_path: Path, label: str) -> dict:
    with open(input_path) as f:
        data = json.load(f)

    keep: set[str] = set()
    nodes_out = []
    for n in data["nodes"]:
        if n.get("level", 1) == 1 and n.get("y", 0) <= ZONE_MAX_GY:
            keep.add(n["id"])
            nodes_out.append(n)

    edges_out = [e for e in data["edges"] if e["a"] in keep and e["b"] in keep]

    metadata = dict(data.get("metadata", {}))
    metadata.update({
        "source_graph": input_path.name,
        "variant": label,
        "slice": "south",
        "slice_max_gy": ZONE_MAX_GY,
    })

    return {"nodes": nodes_out, "edges": edges_out, "metadata": metadata}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", type=Path, help="Input pilot graph JSON")
    ap.add_argument("output", type=Path, help="Output slice JSON")
    ap.add_argument("--label", default=None,
                    help="Variant label (defaults to input filename stem minus 'grainger-pilot-')")
    args = ap.parse_args()

    label = args.label or args.input.stem.replace("grainger-pilot-", "")
    sliced = extract(args.input, label)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(sliced, f)
    print(f"{args.input.name} → {args.output} "
          f"({len(sliced['nodes'])} nodes, {len(sliced['edges'])} edges, label={label!r})")


if __name__ == "__main__":
    main()
