#!/usr/bin/env python3
"""Extract empirical pick-time distributions from Grainger W004 SFDC outbound.

Reads all 4 quarterly CSVs directly from gs://solution-design-raw/ via DuckDB's
httpfs extension + GCS S3-compatibility API. Classifies picks into 5 categories
aligned with Grainger's Master Code Definitions:

    Category           SFDC filter                         Meaning
    ─────────────────  ──────────────────────────────────  ───────────────────────────
    full_case_conv     Pick Type='Unit' AND TYP='CON1'     Bulk Conveyables, Pallets
    casepick_conv      Pick Type='Unit' AND TYP='CON2'     Bulk Conveyables, Top-Offs
    full_case_ncv      Pick Type='Unit' AND TYP IN         Bulk Non-conveyables,
                        ('NC01','LTL1','LTL2','LTL3','      Pallets / LTL / Raw
                         NRAW','LRAW')
    casepick_ncv       Pick Type='Unit' AND TYP IN         Non-conveyables, Top-Offs
                        ('NC02','NC03')                      / Mixed SKUs
    pallet_out         Pick Type='Pallet'                  Entire pallet shipped out

Emits two parquet files in --output:
    pick_time_samples.parquet  — raw SECONDS_ON_TASK samples per sim_type
                                  (capped at --samples-per-type rows, uniform sampled)
                                  Schema: (sim_type, sec_on_task, target_qty, cases_per_line)
    pick_time_summary.parquet  — per-category stats (n, mean, p5, p50, p95, std)
                                  for display / chart annotation.

Outliers (SECONDS_ON_TASK outside [1, 600] seconds) dropped as operator-break noise.

Usage:
    extract_pick_times.py --output output/empirical/
"""

from __future__ import annotations

import argparse
import logging
import subprocess
import time
from pathlib import Path

import duckdb

logger = logging.getLogger(__name__)

BUCKET_PATH = "s3://solution-design-raw/machine_readable_data"
OUTBOUND_FILES = [
    f"{BUCKET_PATH}/SFDC - Raw Outbound Data (Jan-Mar 2025).csv",
    f"{BUCKET_PATH}/SFDC - Raw Outbound Data (Apr - Jun 2025).csv",
    f"{BUCKET_PATH}/SFDC - Raw Outbound Data (Jul - Sept 2025).csv",
    f"{BUCKET_PATH}/SFDC - Raw Outbound Data (Oct - Dec 2025).csv",
]

SEC_ON_TASK_MIN = 1.0
SEC_ON_TASK_MAX = 600.0


def get_gcloud_token() -> str:
    try:
        return subprocess.check_output(
            ["gcloud", "auth", "application-default", "print-access-token"],
            text=True, stderr=subprocess.PIPE,
        ).strip()
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            "Failed to get GCS token. Run: gcloud auth application-default login\n"
            f"stderr: {exc.stderr.strip()}"
        ) from None


def setup_gcs(db: duckdb.DuckDBPyConnection) -> None:
    db.execute("INSTALL httpfs; LOAD httpfs;")
    token = get_gcloud_token()
    db.execute(f"""
        CREATE OR REPLACE SECRET gcs_secret (
            TYPE S3, KEY_ID 'GOOG', SECRET 'unused',
            ENDPOINT 'storage.googleapis.com', URL_STYLE 'path',
            EXTRA_HTTP_HEADERS MAP {{ 'Authorization': 'Bearer {token}' }}
        )
    """)


def stage_outbound(db: duckdb.DuckDBPyConnection) -> None:
    """Single scan of the 4 outbound CSVs. Materializes `stage` with all
    downstream columns including a reconstructed confirm_ts timestamp that
    the sequencing step depends on — so emit_sequence doesn't need to rescan.
    """
    logger.info("Streaming outbound CSVs from GCS…")
    t0 = time.time()
    db.execute(f"""
        CREATE OR REPLACE TABLE stage AS
        WITH raw AS (
            SELECT
                "User"                              AS user_id,
                "Pick Type"                         AS pick_type_raw,
                TYP                                 AS typ,
                SBT                                 AS sbt,
                TRY_CAST(TARGET_QUANTITY AS DOUBLE) AS target_qty,
                TRY_CAST("Cases/Line" AS DOUBLE)    AS cases_per_line,
                TRY_CAST(MASTER_PACK_QTY AS DOUBLE) AS mp_qty,
                TRY_CAST(SECONDS_ON_TASK AS DOUBLE) AS sec_on_task,
                CONFIRMATION_DATE_LOCAL             AS d_raw,
                "Confirm Hour"                      AS hr_raw,
                CONFIRMATION_TIME_LOCAL             AS t_raw,
                ACTIVITY
            FROM read_csv_auto({OUTBOUND_FILES!r}, all_varchar=true, header=true,
                               filename=true, union_by_name=true, sample_size=-1)
            WHERE ACTIVITY = 'PICK'
        ),
        parsed AS (
            SELECT *,
                CASE
                    WHEN pick_type_raw = 'Pallet'                                    THEN 'pallet_out'
                    WHEN pick_type_raw = 'Unit' AND typ = 'CON1'                     THEN 'full_case_conv'
                    WHEN pick_type_raw = 'Unit' AND typ = 'CON2'                     THEN 'casepick_conv'
                    WHEN pick_type_raw = 'Unit' AND typ IN ('NC01','LTL1','LTL2','LTL3','NRAW','LRAW')
                                                                                     THEN 'full_case_ncv'
                    WHEN pick_type_raw = 'Unit' AND typ IN ('NC02','NC03')           THEN 'casepick_ncv'
                    ELSE 'other'
                END AS sim_type,
                TRY_CAST(STRPTIME(d_raw, '%d/%m/%Y') AS DATE)         AS confirm_date,
                TRY_CAST(hr_raw AS INTEGER)                           AS confirm_hour,
                TRY_CAST(SPLIT_PART(t_raw, ':', 1) AS INTEGER)        AS confirm_min,
                TRY_CAST(SPLIT_PART(SPLIT_PART(t_raw, ':', 2), '.', 1) AS INTEGER) AS confirm_sec
            FROM raw
            WHERE sec_on_task IS NOT NULL
        )
        SELECT
            user_id, pick_type_raw, typ, sbt,
            target_qty, cases_per_line, mp_qty, sec_on_task,
            sim_type, confirm_date, confirm_hour, confirm_min, confirm_sec,
            -- Reconstruct full timestamp as seconds-since-epoch to avoid expensive
            -- INTERVAL arithmetic in the window function (which was the slow step).
            CASE WHEN confirm_date IS NOT NULL
                  AND confirm_hour BETWEEN 0 AND 23
                  AND confirm_min  BETWEEN 0 AND 59
                  AND confirm_sec  BETWEEN 0 AND 59
                THEN EXTRACT(EPOCH FROM confirm_date)::BIGINT
                     + confirm_hour * 3600
                     + confirm_min  * 60
                     + confirm_sec
            END AS confirm_ts_s
        FROM parsed
        WHERE sec_on_task BETWEEN {SEC_ON_TASK_MIN} AND {SEC_ON_TASK_MAX}
    """)
    n, n_ts = db.execute("SELECT COUNT(*), COUNT(confirm_ts_s) FROM stage").fetchone()
    logger.info("  staged %d PICK rows (%d with parseable timestamp) in %.1fs",
                n, n_ts, time.time() - t0)


def emit_summary(db: duckdb.DuckDBPyConnection, out_dir: Path) -> None:
    out = out_dir / "pick_time_summary.parquet"
    db.execute(f"""
        COPY (
            SELECT sim_type,
                   COUNT(*) AS n,
                   AVG(sec_on_task) AS mean_s,
                   STDDEV_POP(sec_on_task) AS std_s,
                   QUANTILE_CONT(sec_on_task, 0.05) AS p5_s,
                   QUANTILE_CONT(sec_on_task, 0.25) AS p25_s,
                   QUANTILE_CONT(sec_on_task, 0.50) AS p50_s,
                   QUANTILE_CONT(sec_on_task, 0.75) AS p75_s,
                   QUANTILE_CONT(sec_on_task, 0.95) AS p95_s,
                   MIN(sec_on_task) AS min_s,
                   MAX(sec_on_task) AS max_s
            FROM stage
            WHERE sim_type != 'other'
            GROUP BY sim_type
            ORDER BY sim_type
        ) TO '{out}' (FORMAT PARQUET)
    """)
    logger.info("  wrote %s", out)
    logger.info("  Per-category summary (seconds):")
    logger.info("    %-18s %10s %7s %7s %7s %7s %7s",
                "sim_type", "n", "mean", "p5", "p50", "p95", "std")
    for r in db.execute(f"SELECT sim_type, n, ROUND(mean_s,1), ROUND(p5_s,1), ROUND(p50_s,1), ROUND(p95_s,1), ROUND(std_s,1) FROM read_parquet('{out}') ORDER BY sim_type").fetchall():
        logger.info("    %-18s %10d %7.1f %7.1f %7.1f %7.1f %7.1f", *r)


def emit_samples(db: duckdb.DuckDBPyConnection, out_dir: Path, samples_per_type: int) -> None:
    """Emit raw SECONDS_ON_TASK samples per sim_type, capped at `samples_per_type`.

    Uniform random sampling per category. run_sweep draws from these to set
    each bot's service time stochastically.
    """
    out = out_dir / "pick_time_samples.parquet"
    db.execute(f"""
        COPY (
            WITH ranked AS (
                SELECT sim_type,
                       sec_on_task,
                       target_qty,
                       cases_per_line,
                       typ,
                       ROW_NUMBER() OVER (PARTITION BY sim_type
                                          ORDER BY random()) AS rn
                FROM stage
                WHERE sim_type != 'other'
            )
            SELECT sim_type, sec_on_task, target_qty, cases_per_line, typ
            FROM ranked
            WHERE rn <= {samples_per_type}
            ORDER BY sim_type, rn
        ) TO '{out}' (FORMAT PARQUET)
    """)
    logger.info("  wrote %s", out)
    rows = db.execute(f"""
        SELECT sim_type, COUNT(*) FROM read_parquet('{out}') GROUP BY 1 ORDER BY 1
    """).fetchall()
    logger.info("  Sample counts per sim_type:")
    for r in rows:
        logger.info("    %-18s n=%d", r[0], r[1])


def emit_sequence(db: duckdb.DuckDBPyConnection, out_dir: Path) -> None:
    """Sequencing-conditional p(sec_on_task | sim_type, prev_type).

    Operates on `stage` (already has sim_type + confirm_ts_s). No re-scan.
    Partitions by (user_id, confirm_date) to avoid crossing shift boundaries.
    Gap capped at 900s to exclude breaks.
    """
    out = out_dir / "pick_time_sequence.parquet"
    logger.info("Computing sequencing-conditional distribution…")
    t0 = time.time()
    db.execute(f"""
        COPY (
            WITH seq AS (
                SELECT user_id, confirm_date, sim_type, sec_on_task, confirm_ts_s,
                       LAG(sim_type)    OVER w AS prev_type,
                       LAG(confirm_ts_s) OVER w AS prev_ts_s
                FROM stage
                WHERE sim_type != 'other'
                  AND confirm_ts_s IS NOT NULL
                WINDOW w AS (PARTITION BY user_id, confirm_date ORDER BY confirm_ts_s)
            ),
            filt AS (
                SELECT sim_type, prev_type, sec_on_task
                FROM seq
                WHERE prev_type IS NOT NULL
                  AND confirm_ts_s > prev_ts_s
                  AND confirm_ts_s - prev_ts_s BETWEEN 0 AND 900
            )
            SELECT
                sim_type,
                prev_type,
                COUNT(*) AS n,
                AVG(sec_on_task) AS mean_s,
                QUANTILE_CONT(sec_on_task, 0.05) AS p5_s,
                QUANTILE_CONT(sec_on_task, 0.50) AS p50_s,
                QUANTILE_CONT(sec_on_task, 0.95) AS p95_s
            FROM filt
            GROUP BY sim_type, prev_type
            ORDER BY sim_type, prev_type
        ) TO '{out}' (FORMAT PARQUET)
    """)
    logger.info("  wrote %s in %.1fs", out, time.time() - t0)
    logger.info("  Sequencing (current × previous) medians:")
    for r in db.execute(f"SELECT sim_type, prev_type, n, ROUND(p50_s,1) FROM read_parquet('{out}') ORDER BY 1,2").fetchall():
        logger.info("    %-18s ← %-18s n=%8d p50=%6.1f", r[0], r[1], r[2], r[3])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", default="output/empirical")
    ap.add_argument("--samples-per-type", type=int, default=20000,
                    help="Max raw samples kept per sim_type (uniform)")
    ap.add_argument("--skip-sequence", action="store_true",
                    help="Skip the sequencing-conditional table")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    db = duckdb.connect()
    setup_gcs(db)
    stage_outbound(db)
    emit_summary(db, out_dir)
    emit_samples(db, out_dir, args.samples_per_type)
    if not args.skip_sequence:
        emit_sequence(db, out_dir)

    logger.info("Done. Artifacts: %s", ", ".join(p.name for p in out_dir.glob("*.parquet")))


if __name__ == "__main__":
    main()
