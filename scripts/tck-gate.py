"""Fail when the a2a-tck run has a failed MUST requirement, a failed JSON-RPC or agent card test,
or fewer MUST passes than the floor (a TCK change that skips most tests must not pass).

Usage: python3 scripts/tck-gate.py [--min-must-pass N] <tck reports dir>
The reports dir holds compatibility.json and junitreport.xml. The floor defaults to 75.
"""

import argparse
import json
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("reports", nargs="?", default="reports")
parser.add_argument("--min-must-pass", type=int, default=75)
args = parser.parse_args()
reports = Path(args.reports)
compat = json.loads((reports / "compatibility.json").read_text())

levels: Counter[tuple[str, str]] = Counter()
must_failed = []
for rid, req in sorted(compat["per_requirement"].items()):
    transports = req.get("transports", {})
    status = transports.get("jsonrpc") or transports.get("agent_card") or req["status"]
    levels[(req["level"], status)] += 1
    if req["level"] == "MUST" and status in ("FAIL", "FAILED", "ERROR"):
        must_failed.append(rid)

failed_tests = []
for case in ET.parse(reports / "junitreport.xml").iter("testcase"):
    name = case.get("name", "")
    if "grpc" in name or "http_json" in name or name.endswith("_rest"):
        continue
    for child in case:
        if child.tag in ("failure", "error"):
            failed_tests.append(f"{case.get('classname', '').split('.')[-1]}::{name}: {(child.get('message') or '')[:200]}")

print("summary:", {k: v for k, v in compat["summary"].items() if k.endswith("compatibility")})
for (level, status), count in sorted(levels.items()):
    print(f"  {level:6} {status:10} {count}")
for line in failed_tests:
    print("FAILED", line)
if must_failed:
    print("MUST requirements failed:", ", ".join(must_failed))
must_pass = levels[("MUST", "PASS")]
too_few = must_pass < args.min_must_pass
if too_few:
    print(f"MUST PASS {must_pass} is below the floor {args.min_must_pass}")
raise SystemExit(1 if must_failed or failed_tests or too_few else 0)
