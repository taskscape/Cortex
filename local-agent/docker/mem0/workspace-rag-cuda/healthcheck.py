"""Container health check for the CUDA embedding sidecar.

Exits 0 only when the sidecar's ``/health`` endpoint reports success and an
available CUDA device; any failure exits non-zero.
"""

import json
import sys
import urllib.request


def main() -> int:
    """Query the local sidecar health endpoint.

    Returns:
        0 when the service is healthy and CUDA is available, otherwise 1.
    """
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return 1

    return 0 if body.get("ok") and body.get("cudaAvailable") else 1


if __name__ == "__main__":
    sys.exit(main())
