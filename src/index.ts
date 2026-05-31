/**
 * @absolutejs/logs — structured log primitive for the AbsoluteJS
 * substrate.
 *
 * Closes the second part of G9 (observability triad). The runtime's
 * `onLog` callback emits per-tenant stdout/stderr lines; this
 * package gives applications a structured way to emit those lines.
 *
 * Composes with the rest of the substrate:
 *
 *   - **`@absolutejs/secrets`** — pass `redact: broker.redact` and
 *     every serialized event flows through the redactor before
 *     hitting a sink. Secrets in logs never reach disk.
 *   - **`@absolutejs/telemetry`** — pass `readTraceId:
 *     readActiveTraceId` and every event carries the active OTel
 *     trace id, correlating logs to spans.
 *   - **`@absolutejs/metrics`** — `logger.metrics()` returns a
 *     `LoggerMetrics` shape; pair with a collector subpath later.
 *
 * No hard deps either direction — both integration points are
 * function-typed options.
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// =============================================================================
// Types
// =============================================================================

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 1,
	error: 4,
	fatal: 5,
	info: 2,
	trace: 0,
	warn: 3
};

/** A single structured log event. */
export type LogEvent = {
	at: number;
	level: LogLevel;
	message: string;
	/** Tenant identifier — useful for per-tenant log isolation downstream. */
	tenant?: string;
	/** OTel trace id (typically pulled via `readActiveTraceId()`). */
	traceId?: string;
	/** Static + dynamic fields — anything JSON-serializable. */
	fields?: Record<string, unknown>;
};

/**
 * A sink consumes events. Returning a Promise lets the logger await
 * batched writers; returning void is fine for synchronous sinks like
 * stdout.
 */
export type LogSink = {
	readonly name?: string;
	write: (event: LogEvent) => Promise<void> | void;
	flush?: () => Promise<void> | void;
	close?: () => Promise<void> | void;
};

export type LoggerMetrics = {
	/** Total `logger.<level>()` calls that passed the level filter. */
	logged: Record<LogLevel, number>;
	/** Successful sink writes (one per sink per event). */
	writes: number;
	/** Sink write errors (`onError` fired). */
	writeErrors: number;
	/** Per-sink error counts (keyed by `sink.name` or `'sink-<index>'`). */
	sinkErrors: Record<string, number>;
};

export type LoggerOptions = {
	sinks: LogSink[];
	/** Default `'info'`. Events below this level are dropped before any sink runs. */
	level?: LogLevel;
	/** Static fields merged into every event. */
	fields?: Record<string, unknown>;
	/**
	 * Optional redactor applied to the SERIALIZED event JSON before each
	 * sink writes. Pass `broker.redact` from `@absolutejs/secrets` to
	 * strip known secrets out of any serialized field.
	 */
	redact?: (text: string) => string;
	/**
	 * Override for `@absolutejs/telemetry`'s `readActiveTraceId()`. Pass
	 * `readActiveTraceId` to stamp the active OTel trace id onto every
	 * event. If omitted, events have no traceId.
	 */
	readTraceId?: () => string | undefined | Promise<string | undefined>;
	/** Override `Date.now()`. Useful for tests. */
	clock?: () => number;
	/** Per-sink error handler. Default `console.warn`. */
	onError?: (error: unknown, sinkName: string, event: LogEvent) => void;
};

export type Logger = {
	trace: (message: string, fields?: Record<string, unknown>) => void;
	debug: (message: string, fields?: Record<string, unknown>) => void;
	info: (message: string, fields?: Record<string, unknown>) => void;
	warn: (message: string, fields?: Record<string, unknown>) => void;
	error: (message: string, fields?: Record<string, unknown>) => void;
	fatal: (message: string, fields?: Record<string, unknown>) => void;
	/**
	 * Return a logger that merges `fields` into every event. The child
	 * shares the parent's sinks + metrics counters (operator sees one
	 * unified view), but writes never leak back the other direction.
	 */
	child: (fields: Record<string, unknown>) => Logger;
	/**
	 * Set the level threshold at runtime. Useful for `SIGUSR2 → bump to
	 * debug` patterns during incident triage.
	 */
	setLevel: (level: LogLevel) => void;
	/** Drain pending writes by calling `sink.flush?()` on every sink. */
	flush: () => Promise<void>;
	/** Flush + close every sink. Subsequent log calls still build events but writes throw. */
	close: () => Promise<void>;
	/** Operator-shaped cumulative counters. */
	metrics: () => LoggerMetrics;
};

// =============================================================================
// createLogger
// =============================================================================

export const createLogger = (options: LoggerOptions): Logger => {
	const clock = options.clock ?? Date.now;
	const onError =
		options.onError ??
		((error, sink, event) => {
			console.warn(`[logs] sink "${sink}" failed for ${event.level}:`, error);
		});
	const sinks = options.sinks.map((sink, index) => ({
		...sink,
		name: sink.name ?? `sink-${index}`
	}));

	const counters: LoggerMetrics = {
		logged: { debug: 0, error: 0, fatal: 0, info: 0, trace: 0, warn: 0 },
		sinkErrors: {},
		writeErrors: 0,
		writes: 0
	};

	let currentLevel = options.level ?? 'info';
	let closed = false;

	const emit = (
		level: LogLevel,
		baseFields: Record<string, unknown>,
		message: string,
		fields?: Record<string, unknown>
	): void => {
		if (closed) return;
		if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
		counters.logged[level] += 1;

		const merged = { ...baseFields, ...(fields ?? {}) };
		const event: LogEvent = {
			at: clock(),
			level,
			message,
			...(merged.tenant !== undefined && typeof merged.tenant === 'string'
				? { tenant: merged.tenant }
				: {})
		};
		// Strip `tenant` out of the fields blob if we promoted it to the
		// top-level. Same convention as `traceId` below — operators expect
		// these as first-class log columns, not buried in a nested object.
		if (event.tenant !== undefined) {
			const { tenant: _t, ...rest } = merged;
			void _t;
			if (Object.keys(rest).length > 0) event.fields = rest;
		} else if (Object.keys(merged).length > 0) {
			event.fields = merged;
		}

		// Fire-and-forget the actual write so log calls stay synchronous.
		// Errors surface via onError + sinkErrors counters.
		void writeEvent(event);
	};

	const writeEvent = async (event: LogEvent): Promise<void> => {
		if (options.readTraceId !== undefined) {
			try {
				const traceId = await options.readTraceId();
				if (traceId !== undefined) event.traceId = traceId;
			} catch {
				// readTraceId failure shouldn't break the log line — proceed
				// without it.
			}
		}

		const serialized = JSON.stringify(event);
		const finalText =
			options.redact !== undefined ? options.redact(serialized) : serialized;
		const finalEvent: LogEvent =
			finalText === serialized ? event : (JSON.parse(finalText) as LogEvent);

		await Promise.all(
			sinks.map(async (sink) => {
				try {
					await sink.write(finalEvent);
					counters.writes += 1;
				} catch (error) {
					counters.writeErrors += 1;
					counters.sinkErrors[sink.name] =
						(counters.sinkErrors[sink.name] ?? 0) + 1;
					try {
						onError(error, sink.name, finalEvent);
					} catch {
						// onError is best-effort; never let it break the logger.
					}
				}
			})
		);
	};

	const buildLogger = (baseFields: Record<string, unknown>): Logger => {
		const methods: Pick<Logger, LogLevel> = {
			debug: (m, f) => emit('debug', baseFields, m, f),
			error: (m, f) => emit('error', baseFields, m, f),
			fatal: (m, f) => emit('fatal', baseFields, m, f),
			info: (m, f) => emit('info', baseFields, m, f),
			trace: (m, f) => emit('trace', baseFields, m, f),
			warn: (m, f) => emit('warn', baseFields, m, f)
		};
		return {
			...methods,
			child: (childFields) =>
				buildLogger({ ...baseFields, ...childFields }),
			close: async () => {
				closed = true;
				for (const sink of sinks) {
					try {
						if (sink.flush) await sink.flush();
					} catch {
						/* best-effort */
					}
					try {
						if (sink.close) await sink.close();
					} catch {
						/* best-effort */
					}
				}
			},
			flush: async () => {
				for (const sink of sinks) {
					try {
						if (sink.flush) await sink.flush();
					} catch (error) {
						counters.sinkErrors[sink.name] =
							(counters.sinkErrors[sink.name] ?? 0) + 1;
						onError(error, sink.name, {
							at: clock(),
							level: 'error',
							message: '[logs] sink flush failed'
						});
					}
				}
			},
			metrics: () => ({
				logged: { ...counters.logged },
				sinkErrors: { ...counters.sinkErrors },
				writeErrors: counters.writeErrors,
				writes: counters.writes
			}),
			setLevel: (level) => {
				currentLevel = level;
			}
		};
	};

	return buildLogger(options.fields ?? {});
};

// =============================================================================
// consoleJsonSink — one JSON line per event, stdout / stderr split by level
// =============================================================================

export type ConsoleJsonSinkOptions = {
	/** Levels at or above `errorThreshold` go to stderr. Default `'error'`. */
	errorThreshold?: LogLevel;
	/** Override `process.stdout.write`. Useful for tests. */
	write?: (chunk: string, stream: 'stdout' | 'stderr') => void;
};

export const consoleJsonSink = (
	options: ConsoleJsonSinkOptions = {}
): LogSink => {
	const threshold = LEVEL_RANK[options.errorThreshold ?? 'error'];
	const write =
		options.write ??
		((chunk, stream) => {
			if (stream === 'stderr') process.stderr.write(chunk);
			else process.stdout.write(chunk);
		});
	return {
		name: 'console-json',
		write: (event) => {
			const stream = LEVEL_RANK[event.level] >= threshold ? 'stderr' : 'stdout';
			write(`${JSON.stringify(event)}\n`, stream);
		}
	};
};

// =============================================================================
// consolePrettySink — human-readable lines for dev
// =============================================================================

export type ConsolePrettySinkOptions = {
	errorThreshold?: LogLevel;
	write?: (chunk: string, stream: 'stdout' | 'stderr') => void;
};

const LEVEL_PREFIX: Record<LogLevel, string> = {
	debug: 'DEBUG',
	error: 'ERROR',
	fatal: 'FATAL',
	info: 'INFO ',
	trace: 'TRACE',
	warn: 'WARN '
};

const formatTime = (ms: number): string => new Date(ms).toISOString();

export const consolePrettySink = (
	options: ConsolePrettySinkOptions = {}
): LogSink => {
	const threshold = LEVEL_RANK[options.errorThreshold ?? 'error'];
	const write =
		options.write ??
		((chunk, stream) => {
			if (stream === 'stderr') process.stderr.write(chunk);
			else process.stdout.write(chunk);
		});
	return {
		name: 'console-pretty',
		write: (event) => {
			const stream = LEVEL_RANK[event.level] >= threshold ? 'stderr' : 'stdout';
			const parts: string[] = [
				formatTime(event.at),
				LEVEL_PREFIX[event.level],
				event.message
			];
			if (event.tenant !== undefined) parts.push(`tenant=${event.tenant}`);
			if (event.traceId !== undefined) parts.push(`trace=${event.traceId}`);
			if (event.fields !== undefined && Object.keys(event.fields).length > 0) {
				parts.push(JSON.stringify(event.fields));
			}
			write(`${parts.join(' ')}\n`, stream);
		}
	};
};

// =============================================================================
// memorySink — in-process FIFO for tests + in-process tailing
// =============================================================================

export type MemorySinkOptions = { max?: number };

export type MemorySink = LogSink & {
	inspect: () => ReadonlyArray<LogEvent>;
	clear: () => void;
};

export const memorySink = (options: MemorySinkOptions = {}): MemorySink => {
	const max = options.max ?? 1000;
	const events: LogEvent[] = [];
	return {
		clear: () => {
			events.length = 0;
		},
		inspect: () => [...events],
		name: 'memory',
		write: (event) => {
			events.push(event);
			while (events.length > max) events.shift();
		}
	};
};

// =============================================================================
// rotatingFileSink — size-based rotation, kept-history cap
// =============================================================================

export type RotatingFileSinkOptions = {
	path: string;
	/** Rotate when the current file exceeds this many bytes. Default 10 MB. */
	maxBytes?: number;
	/** Number of rotated files to keep. Default 5. */
	keep?: number;
};

export const rotatingFileSink = (
	options: RotatingFileSinkOptions
): LogSink => {
	const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
	const keep = options.keep ?? 5;
	let writeLock: Promise<void> = Promise.resolve();
	let dirEnsured = false;

	const rotateIfNeeded = async (): Promise<void> => {
		let size = 0;
		try {
			size = (await stat(options.path)).size;
		} catch {
			return; // file doesn't exist yet — nothing to rotate
		}
		if (size < maxBytes) return;
		// Shift .keep-1 → .keep, ..., .1 → .2, current → .1
		for (let i = keep - 1; i >= 1; i -= 1) {
			try {
				await rename(`${options.path}.${i}`, `${options.path}.${i + 1}`);
			} catch {
				/* missing intermediate is fine */
			}
		}
		try {
			await rename(options.path, `${options.path}.1`);
		} catch {
			/* concurrent rotation — ignore */
		}
	};

	return {
		close: async () => {
			await writeLock;
		},
		flush: async () => {
			await writeLock;
		},
		name: 'rotating-file',
		write: async (event) => {
			const next = writeLock.then(async () => {
				if (!dirEnsured) {
					await mkdir(dirname(options.path), { recursive: true });
					dirEnsured = true;
				}
				await rotateIfNeeded();
				await appendFile(options.path, `${JSON.stringify(event)}\n`);
			});
			writeLock = next.catch(() => {});
			return next;
		}
	};
};
