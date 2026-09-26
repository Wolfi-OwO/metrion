# Quickstart: Go

`net/http` and `encoding/json` from the standard library - no module
dependency at all. See `docs/quickstart/README.md` for the shared reference
(body shapes, identifier charset, timestamp window, caps, error statuses).

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` -
`METRION_API_KEY` below is that token, key prefix and secret together.

## The program

```go
// main.go
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

type metricPoint struct {
	Name      string  `json:"name"`
	Value     float64 `json:"value"`
	Unit      string  `json:"unit"`
	Timestamp string  `json:"timestamp"`
	Interval  int     `json:"interval"`
}

type metricEnvelope struct {
	Resource string        `json:"resource"`
	Metrics  []metricPoint `json:"metrics"`
}

func main() {
	ingestURL := os.Getenv("INGEST_URL")
	if ingestURL == "" {
		ingestURL = "http://localhost:8090/api/v1/ingest"
	}
	apiKey := os.Getenv("METRION_API_KEY")

	body := metricEnvelope{
		Resource: "vps-01",
		Metrics: []metricPoint{
			{
				Name:      "cpu.usage",
				Value:     42.5,
				Unit:      "percent",
				Timestamp: time.Now().UTC().Format(time.RFC3339),
				Interval:  60,
			},
		},
	}

	payload, err := json.Marshal(body)
	if err != nil {
		panic(err)
	}

	request, err := http.NewRequest(http.MethodPost, ingestURL, bytes.NewReader(payload))
	if err != nil {
		panic(err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		panic(err)
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		panic(err)
	}

	fmt.Println(response.StatusCode, string(responseBody))
	if response.StatusCode != http.StatusAccepted {
		os.Exit(1)
	}
}
```

`go.mod` needs only a module declaration - `module quickstart` / `go 1.21`
or later; no `require` line, since everything used is standard library.

## Running it

```bash
METRION_API_KEY=mtr_<prefix>_<secret> go run main.go
```

Executed against a local ingest service (`go1.27.0`) with a seeded test
project and key, `gofmt`-clean:

```
202 {"accepted":1,"points":1}
```
