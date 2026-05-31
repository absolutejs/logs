# @absolutejs/logs

Structured log primitive for the AbsoluteJS substrate. Levels, child
loggers, sinks (console-JSON, console-pretty, memory, rotating file),
optional secret redaction via
[`@absolutejs/secrets`](https://github.com/absolutejs/secrets),
optional trace-id correlation via
[`@absolutejs/telemetry`](https://github.com/absolutejs/telemetry).

## Install

```bash
bun add @absolutejs/logs
```

## Quick start

```ts
import { createLogger, consoleJsonSink, rotatingFileSink } from '@absolutejs/logs';
import { readActiveTraceId } from '@absolutejs/telemetry';

const log = createLogger({
  level: 'info',
  fields: { service: 'api', region: 'us-east-2' },
  sinks: [
    consoleJsonSink(),
    rotatingFileSink({ path: '/var/log/api/app.log', maxBytes: 10_000_000, keep: 5 }),
  ],
  redact: (text) => broker.redact(text),     // @absolutejs/secrets
  readTraceId: readActiveTraceId,            // @absolutejs/telemetry
});

log.info('User signed in', { userId: 'u_42', tenant: 'acme' });
// → {"at":1700000000000,"level":"info","message":"User signed in","tenant":"acme","traceId":"abc123","fields":{"service":"api","region":"us-east-2","userId":"u_42"}}

const requestLog = log.child({ requestId: req.id });
requestLog.warn('rate limit exceeded', { remaining: 0 });
// Same as parent, plus requestId in fields.
```

## Levels

`trace` → `debug` → `info` → `warn` → `error` → `fatal`. Filter at
`level`; bump at runtime with `log.setLevel('debug')` (SIGUSR2-style
incident triage).

## Sinks

| Sink | Purpose |
| --- | --- |
| `consoleJsonSink()` | One JSON line per event. stdout for `< errorThreshold`, stderr above. |
| `consolePrettySink()` | Human-readable lines for local dev. |
| `memorySink()` | In-process FIFO buffer. `.inspect()` + `.clear()` for tests. |
| `rotatingFileSink({ path, maxBytes, keep })` | Append-only file with size-based rotation. |

Custom sinks just implement `LogSink`: `{ name?, write, flush?, close? }`.

## Composition

- **`@absolutejs/secrets` redaction.** Pass `redact: broker.redact` and
  every serialized event flows through the redactor before hitting a
  sink. Secrets never reach disk.
- **`@absolutejs/telemetry` trace correlation.** Pass `readTraceId:
  readActiveTraceId` and every event carries the active OTel trace id.
  Failure (no provider wired) silently leaves `traceId` off — never
  breaks the log line.
- **`@absolutejs/metrics` exposure.** `logger.metrics()` returns a
  `LoggerMetrics` shape. A `@absolutejs/metrics/logs` collector
  subpath is planned for the next release.

## Metrics

```ts
logger.metrics();
// {
//   logged: { trace: 0, debug: 0, info: 100, warn: 5, error: 2, fatal: 0 },
//   writes: 214,          // 107 events × 2 sinks
//   writeErrors: 0,
//   sinkErrors: {}
// }
```

## Operator notes

- **Fire-and-forget writes.** `log.info(...)` is synchronous and
  returns immediately; sink writes run in the background. Use
  `await log.flush()` before shutdown.
- **Per-sink failures don't block others.** One sink throwing
  bumps `sinkErrors[name]` and calls `onError`; the rest still
  receive the event. Same shape as `@absolutejs/audit`.
- **Closed loggers drop calls silently.** Once `await log.close()`
  has run, further `log.info(...)` calls are no-ops — no throw,
  no buffer.

## License

BSL-1.1 with named carveout against hosted log-management platforms.
Change date: 2030-05-31 (Apache 2.0).
