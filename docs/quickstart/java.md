# Quickstart: Java

`java.net.http.HttpClient`, standard since Java 11 - no dependency, and no
build step: Java's single-file source-code launcher runs a `.java` file
directly. See `docs/quickstart/README.md` for the shared reference (body
shapes, identifier charset, timestamp window, caps, error statuses).

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` -
`METRION_API_KEY` below is that token, key prefix and secret together.

## The program

```java
// Quickstart.java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.time.format.DateTimeFormatter;

public class Quickstart {
    public static void main(String[] args) throws Exception {
        String ingestUrl = System.getenv().getOrDefault("INGEST_URL", "http://localhost:8090/api/v1/ingest");
        String apiKey = System.getenv("METRION_API_KEY");

        String timestamp = DateTimeFormatter.ISO_INSTANT.format(Instant.now());

        String body = """
            {
              "resource": "vps-01",
              "metrics": [
                {
                  "name": "cpu.usage",
                  "value": 42.5,
                  "unit": "percent",
                  "timestamp": "%s",
                  "interval": 60
                }
              ]
            }
            """.formatted(timestamp);

        HttpClient client = HttpClient.newHttpClient();
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(ingestUrl))
            .header("Authorization", "Bearer " + apiKey)
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();

        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

        System.out.println(response.statusCode() + " " + response.body());
        if (response.statusCode() != 202) {
            System.exit(1);
        }
    }
}
```

## Running it

```bash
METRION_API_KEY=mtr_<prefix>_<secret> java Quickstart.java
```

Executed against a local ingest service (OpenJDK 17.0.20.1) with a seeded
test project and key:

```
202 {"accepted":1,"points":1}
```
