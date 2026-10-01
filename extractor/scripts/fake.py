"""Print a stored extraction document as if a schema had been read. For tests.

Adapted from schematerial `src/schematerial/extractors/fake.py` at commit
df3839b. Differences: the document comes from a file named on the command line
(the runner passes no stdin), and the answer uses the same envelope as the
other scripts in this folder. Standard library only.

    python -I fake.py DOCUMENT.json

stdout carries exactly one JSON document: {"ok": true, "result": <document>} or
{"ok": false, "error": {"type", "message", "name"}} together with a non-zero
exit code.
"""
from __future__ import annotations

import argparse
import json
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("document", help="JSON file holding the extraction document to print")
    args = parser.parse_args(argv)
    try:
        with open(args.document, encoding="utf-8") as handle:
            payload = {"ok": True, "result": json.load(handle)}
        code = 0
    except Exception as exc:
        payload = {"ok": False, "error": {"type": type(exc).__name__, "message": str(exc), "name": None}}
        code = 1
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False))
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
