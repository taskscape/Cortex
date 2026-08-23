"""Container health check for the reranker sidecar.

Fetches the local ``/health`` endpoint and exits 0 only on a 200 response with
an ``ok`` payload; otherwise prints the error and exits 1.
"""

import json
import sys
import urllib.request

try:
    with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=8) as response:
        payload = json.load(response)
    if response.status != 200 or not payload.get("ok"):
        raise RuntimeError(f"unhealthy reranker response: {payload}")
except Exception as error:
    print(error, file=sys.stderr)
    raise SystemExit(1) from error

