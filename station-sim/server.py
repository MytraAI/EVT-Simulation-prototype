#!/usr/bin/env python3
"""Station sim web server.

Serves the static HTML/JS UI and provides REST endpoints that invoke
the CP-SAT solver for live scheduling and fleet sweeps.

Endpoints:
  GET  /                      → index.html
  GET  /<file>                → static files (graphs, schedules, etc.)
  POST /api/solve             → compute optimal schedule (body: JSON config)
  POST /api/sweep             → run fleet size sweep (body: JSON config)
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATION_SIM_DIR = Path(__file__).parent
CPSAT_DIR = STATION_SIM_DIR.parent / "cmd" / "calibrate" / "cpsat"
DEFAULT_MAP = "/home/pranav42/loom/grainger-pilot-04102026-graph.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def run_solver(params: dict, sweep: bool = False) -> dict:
    """Invoke solver.py as a subprocess and return parsed JSON output."""
    args = [
        sys.executable,
        str(CPSAT_DIR / "solver.py"),
        "--map", params.get("map", DEFAULT_MAP),
        "--service-time", str(params.get("serviceTime", 46)),
        "--time-buffer", str(params.get("timeBuffer", 2)),
        "--xy-speed", str(params.get("xySpeed", 1.5)),
        "--xy-accel", str(params.get("xyAccel", 1.5)),
        "--loaded-accel", str(params.get("loadedAccel", 0.3)),
    ]

    slice_mode = params.get("slice", "south")
    args += ["--slice", slice_mode]

    # Optional per-subtype service times (only for matching slice)
    for k, cli_flag in [
        ("svcCaseConv",        "--svc-case-conv"),
        ("svcCaseNcv",         "--svc-case-ncv"),
        ("svcCasepickConv",    "--svc-casepick-conv"),
        ("svcCasepickNcvBin",  "--svc-casepick-ncv-bin"),
        ("svcCasepickNcvRepal","--svc-casepick-ncv-repal"),
        ("dropConveyor",       "--drop-conveyor"),
        ("dropBin",            "--drop-bin"),
        ("dropRepal",          "--drop-repal"),
    ]:
        if params.get(k) is not None:
            args += [cli_flag, str(params[k])]

    if params.get("pez"):
        args.append("--pez")
        args += ["--pez-time", str(params.get("pezTime", 9))]

    if sweep:
        args.append("--sweep")
        args += ["--sweep-max-bots", str(params.get("maxBots", 6))]
        args += ["--sweep-max-waves", str(params.get("maxWaves", 3))]
        out_path = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        args += ["-o", out_path]
    else:
        args += ["--bots", str(params.get("bots", 4))]
        args += ["--waves", str(params.get("waves", 2))]
        out_path = tempfile.NamedTemporaryFile(suffix=".json", delete=False).name
        args += ["-o", out_path]

    logger.info("Running: %s", " ".join(args))
    t0 = time.time()
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True,
            cwd=str(CPSAT_DIR), timeout=600,
        )
    except subprocess.TimeoutExpired:
        return {"error": "Solver timed out (>10 minutes)"}
    elapsed = time.time() - t0
    logger.info("Solver finished in %.1fs (exit=%d)", elapsed, proc.returncode)

    if proc.returncode != 0:
        return {
            "error": f"Solver exited with code {proc.returncode}",
            "stderr": proc.stderr[-2000:],
            "stdout": proc.stdout[-2000:],
        }

    try:
        with open(out_path) as f:
            result = json.load(f)
    except Exception as e:
        return {"error": f"Failed to read solver output: {e}",
                "stderr": proc.stderr[-2000:]}
    finally:
        try:
            os.unlink(out_path)
        except OSError:
            pass

    result["_elapsed_s"] = round(elapsed, 2)
    result["_log"] = proc.stderr[-3000:]
    return result


class StationSimHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, file_path: Path):
        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return
        ctype = {
            ".html": "text/html", ".js": "application/javascript",
            ".css": "text/css", ".json": "application/json",
        }.get(file_path.suffix, "application/octet-stream")
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        # Strip /station-sim/ prefix for backward compatibility
        if path.startswith("/station-sim/"):
            path = path[len("/station-sim"):]
        elif path == "/station-sim":
            path = "/"
        if path == "/" or path == "":
            self._send_static(STATION_SIM_DIR / "index.html")
            return
        # Security: only serve files inside STATION_SIM_DIR
        rel = path.lstrip("/")
        target = (STATION_SIM_DIR / rel).resolve()
        try:
            target.relative_to(STATION_SIM_DIR.resolve())
        except ValueError:
            self.send_error(403)
            return
        self._send_static(target)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path not in ("/api/solve", "/api/sweep"):
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            params = json.loads(body) if body else {}
        except json.JSONDecodeError as e:
            self._send_json({"error": f"Invalid JSON: {e}"}, status=400)
            return

        try:
            result = run_solver(params, sweep=(url.path == "/api/sweep"))
            self._send_json(result)
        except Exception as e:
            logger.error("Handler error: %s", traceback.format_exc())
            self._send_json({"error": str(e)}, status=500)


def main():
    port = int(os.environ.get("PORT", "8090"))
    host = os.environ.get("HOST", "0.0.0.0")
    server = ThreadingHTTPServer((host, port), StationSimHandler)
    logger.info("Station sim server listening on %s:%d", host, port)
    logger.info("Serving files from %s", STATION_SIM_DIR)
    logger.info("Solver at %s", CPSAT_DIR / "solver.py")
    logger.info("Default map: %s", DEFAULT_MAP)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down")


if __name__ == "__main__":
    main()
