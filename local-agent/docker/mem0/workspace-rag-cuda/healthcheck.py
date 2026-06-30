import json
import sys
import urllib.request


def main() -> int:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return 1

    return 0 if body.get("ok") and body.get("cudaAvailable") else 1


if __name__ == "__main__":
    sys.exit(main())
