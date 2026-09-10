# @absolutejs/logs changelog

## 0.1.0 — 2026-05-31

Initial release. Closes the second piece of G9 (observability triad)
from the second-pass PaaS audit — the substrate now has a
first-party structured log primitive.

### Added

- **`createLogger({ sinks, level, fields, redact, readTraceId, clock, onError })`**
  with six levels (`trace` → `fatal`), level filtering, runtime
  `setLevel()`, `flush()`, `close()`, `metrics()`.
- **`logger.child(fields)`** — bound-field child logger that shares
  the parent's sinks + metrics counters.
- **Tenant promotion**: `tenant` in fields becomes a top-level
  column on the event (operators expect it as a first-class key).
- **Fire-and-forget writes** — log calls stay synchronous; sink
  writes run in the background. `await logger.flush()` before
  shutdown.
- **Per-sink failure isolation** — one sink throwing doesn't block
  the others; the error fires `onError` + bumps `sinkErrors[name]`.

### Sinks

- **`consoleJsonSink({ errorThreshold?, write? })`** — one JSON line
  per event. Splits stdout/stderr by level (default threshold:
  `error`).
- **`consolePrettySink({ errorThreshold?, write? })`** — human-
  readable lines for local dev with ISO timestamp + level prefix.
- **`memorySink({ max? })`** — in-process FIFO buffer with
  `inspect()` + `clear()` for tests.
- **`rotatingFileSink({ path, maxBytes?, keep? })`** — size-based
  rotation (default 10 MB / keep 5). Writes are serialized through
  an internal lock to avoid interleaved appends; `mkdir -p` the
  parent on first write.

### Composition with the rest of the substrate

- **`@absolutejs/secrets`** — pass `redact: broker.redact` and every
  serialized event flows through the redactor before any sink sees
  it. Secrets never reach disk.
- **`@absolutejs/telemetry`** — pass `readTraceId: readActiveTraceId`
  and every event carries the active OTel trace id. Failure (no
  provider wired) silently leaves `traceId` off — never breaks the
  log line.
- **`@absolutejs/metrics`** — `logger.metrics()` exposes a
  `LoggerMetrics` shape (counts per level, total writes, write
  errors, per-sink errors). A `@absolutejs/metrics/logs` collector
  subpath is planned for the next metrics release.

### Tests

25 covering: level threshold + runtime `setLevel`; default level;
field merge (base → child → per-call); tenant promotion; metrics
counters; sink failure isolation; redact rewriting serialized
events; readTraceId (sync/async/error/undefined); close behavior
(flush + close + dropped writes); consoleJsonSink stdout/stderr
split; consolePrettySink format; rotatingFileSink (writes, size-
based rotation, keep cap, deep-mkdir).

### License

BSL-1.1 with named carveout against hosted log-management platforms
(Datadog Logs, Grafana Loki Cloud, Splunk, Elastic Cloud, etc.).
Change date: 2030-05-31 (Apache 2.0).
