# Quickstart: .NET

`HttpClient` + `System.Text.Json`, both in the base class library - no
NuGet package. Written as a file-based app (`dotnet run <file>.cs`,
top-level statements, no `.csproj`), so there is nothing to scaffold. See
`docs/quickstart/README.md` for the shared reference (body shapes,
identifier charset, timestamp window, caps, error statuses).

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` -
`METRION_API_KEY` below is that token, key prefix and secret together.

## The program

```csharp
// quickstart.cs
using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;

var ingestUrl = Environment.GetEnvironmentVariable("INGEST_URL") ?? "http://localhost:8090/api/v1/ingest";
var apiKey = Environment.GetEnvironmentVariable("METRION_API_KEY");

var body = new MetricEnvelope(
    Resource: "vps-01",
    Metrics: new[]
    {
        new MetricPoint(
            Name: "cpu.usage",
            Value: 42.5,
            Unit: "percent",
            Timestamp: DateTime.UtcNow.ToString("o"),
            Interval: 60
        ),
    }
);

var json = JsonSerializer.Serialize(body, QuickstartJsonContext.Default.MetricEnvelope);

using var client = new HttpClient();
client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", apiKey);

using var content = new StringContent(json, Encoding.UTF8, "application/json");
var response = await client.PostAsync(ingestUrl, content);
var responseBody = await response.Content.ReadAsStringAsync();

Console.WriteLine($"{(int)response.StatusCode} {responseBody}");
if (!response.IsSuccessStatusCode)
{
    Environment.Exit(1);
}

record MetricPoint(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("value")] double Value,
    [property: JsonPropertyName("unit")] string Unit,
    [property: JsonPropertyName("timestamp")] string Timestamp,
    [property: JsonPropertyName("interval")] int Interval
);

record MetricEnvelope(
    [property: JsonPropertyName("resource")] string Resource,
    [property: JsonPropertyName("metrics")] MetricPoint[] Metrics
);

// Source-generated, so serialization needs no runtime reflection - a
// file-based .NET app runs in a trimming/AOT-friendly mode by default, and
// JsonSerializer.Serialize<T> without a JsonSerializerContext throws
// "Reflection-based serialization has been disabled for this application"
// under it.
[JsonSerializable(typeof(MetricEnvelope))]
partial class QuickstartJsonContext : JsonSerializerContext;
```

## Running it

```bash
METRION_API_KEY=mtr_<prefix>_<secret> dotnet run quickstart.cs
```

Executed against a local ingest service (.NET SDK 10.0.111) with a seeded
test project and key:

```
202 {"accepted":1,"points":1}
```
