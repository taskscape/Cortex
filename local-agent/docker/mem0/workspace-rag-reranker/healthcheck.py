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

