# Quickstart: Python

`urllib.request` from the standard library - no `requests`, nothing to
`pip install`. See `docs/quickstart/README.md` for the shared reference
(body shapes, identifier charset, timestamp window, caps, error statuses).

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` -
`METRION_API_KEY` below is that token, key prefix and secret together.

## The program

```python
# quickstart.py
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

INGEST_URL = os.environ.get("INGEST_URL", "http://localhost:8090/api/v1/ingest")
API_KEY = os.environ["METRION_API_KEY"]

body = {
    "resource": "vps-01",
    "metrics": [
        {
            "name": "cpu.usage",
            "value": 42.5,
            "unit": "percent",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "interval": 60,
        }
    ],
}

request = urllib.request.Request(
    INGEST_URL,
    data=json.dumps(body).encode("utf-8"),
    method="POST",
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    },
)

try:
    with urllib.request.urlopen(request) as response:
        print(response.status, response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    print(error.code, error.read().decode("utf-8"))
    sys.exit(1)
```

`datetime.now(timezone.utc).isoformat()` produces a `+00:00` offset rather
than a trailing `Z` - both are valid ISO-8601 UTC timestamps and the ingest
schema accepts either.

## Running it

```bash
METRION_API_KEY=mtr_<prefix>_<secret> python3 quickstart.py
```

Executed against a local ingest service (Python 3.14.7) with a seeded test
project and key:

```
202 {"accepted":1,"points":1}
```
