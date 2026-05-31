/**
 * Tests for @absolutejs/logs.
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	consoleJsonSink,
	consolePrettySink,
	createLogger,
	LOG_LEVELS,
	memorySink,
	rotatingFileSink,
	type LogEvent,
	type LogSink
} from '../src/index';

const flushTicks = async (): Promise<void> => {
	// Logger writes are fire-and-forget; let pending microtasks settle.
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

// =============================================================================
// core logger
// =============================================================================

describe('createLogger — emission + filtering', () => {
	test('emits levels at or above the threshold', async () => {
		const sink = memorySink();
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.trace('nope');
		log.debug('also nope');
		log.info('hi');
		log.warn('uh oh');
		log.error('bad');
		log.fatal('worse');
		await log.flush();
		await flushTicks();
		const events = sink.inspect();
		expect(events.map((e) => e.level)).toEqual([
			'info',
			'warn',
			'error',
			'fatal'
		]);
	});

	test('default level is info', async () => {
		const sink = memorySink();
		const log = createLogger({ sinks: [sink] });
		log.debug('skipped');
		log.info('kept');
		await flushTicks();
		expect(sink.inspect().map((e) => e.level)).toEqual(['info']);
	});

	test('setLevel updates the threshold at runtime', async () => {
		const sink = memorySink();
		const log = createLogger({ level: 'error', sinks: [sink] });
		log.info('skipped');
		log.setLevel('debug');
		log.info('kept');
		await flushTicks();
		expect(sink.inspect().map((e) => e.message)).toEqual(['kept']);
	});

	test('fields merge: base + child + per-call', async () => {
		const sink = memorySink();
		const log = createLogger({
			fields: { service: 'api' },
			level: 'info',
			sinks: [sink]
		});
		const child = log.child({ requestId: 'req_1' });
		child.info('processing', { userId: 'u_42' });
		await flushTicks();
		const event = sink.inspect()[0];
		expect(event?.fields).toEqual({
			requestId: 'req_1',
			service: 'api',
			userId: 'u_42'
		});
	});

	test('tenant is promoted to a top-level field', async () => {
		const sink = memorySink();
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.info('hi', { tenant: 'acme', userId: 'u_1' });
		await flushTicks();
		const event = sink.inspect()[0];
		expect(event?.tenant).toBe('acme');
		// tenant should NOT also appear inside fields
		expect(event?.fields).toEqual({ userId: 'u_1' });
	});

	test('clock override stamps a deterministic at', async () => {
		const sink = memorySink();
		const log = createLogger({
			clock: () => 1_700_000_000_000,
			level: 'info',
			sinks: [sink]
		});
		log.info('hi');
		await flushTicks();
		expect(sink.inspect()[0]?.at).toBe(1_700_000_000_000);
	});
});

// =============================================================================
// metrics
// =============================================================================

describe('logger.metrics', () => {
	test('counts logged calls by level + writes per sink', async () => {
		const sinkA = memorySink();
		const sinkB = memorySink();
		const log = createLogger({
			level: 'info',
			sinks: [sinkA, sinkB]
		});
		log.info('one');
		log.warn('two');
		log.error('three');
		await flushTicks();
		const m = log.metrics();
		expect(m.logged.info).toBe(1);
		expect(m.logged.warn).toBe(1);
		expect(m.logged.error).toBe(1);
		expect(m.logged.debug).toBe(0);
		// 3 events × 2 sinks = 6 writes
		expect(m.writes).toBe(6);
		expect(m.writeErrors).toBe(0);
	});

	test('sink throws → counted in writeErrors + sinkErrors', async () => {
		const broken: LogSink = {
			name: 'broken',
			write: () => {
				throw new Error('disk full');
			}
		};
		const captured: Array<{ sink: string; error: unknown }> = [];
		const log = createLogger({
			level: 'info',
			onError: (error, sink) => captured.push({ error, sink }),
			sinks: [broken]
		});
		log.info('boom');
		await flushTicks();
		const m = log.metrics();
		expect(m.writeErrors).toBe(1);
		expect(m.sinkErrors.broken).toBe(1);
		expect(captured).toHaveLength(1);
		expect((captured[0]?.error as Error).message).toBe('disk full');
	});

	test('one sink failure does not block the other sinks', async () => {
		const good = memorySink();
		const broken: LogSink = {
			name: 'broken',
			write: () => {
				throw new Error('nope');
			}
		};
		const log = createLogger({
			level: 'info',
			onError: () => {},
			sinks: [broken, good]
		});
		log.info('hi');
		await flushTicks();
		expect(good.inspect()).toHaveLength(1);
		expect(log.metrics().writeErrors).toBe(1);
	});
});

// =============================================================================
// redact + readTraceId integration
// =============================================================================

describe('redact + readTraceId integration', () => {
	test('redact rewrites the serialized event before sinks see it', async () => {
		const sink = memorySink();
		const log = createLogger({
			level: 'info',
			redact: (text) => text.replaceAll('sk_live_xyz', '[REDACTED:STRIPE]'),
			sinks: [sink]
		});
		log.info('sending payment', { stripeKey: 'sk_live_xyz' });
		await flushTicks();
		const event = sink.inspect()[0];
		expect(event?.fields?.stripeKey).toBe('[REDACTED:STRIPE]');
	});

	test('readTraceId stamps traceId onto every event', async () => {
		const sink = memorySink();
		const log = createLogger({
			level: 'info',
			readTraceId: () => 'trace-abc-123',
			sinks: [sink]
		});
		log.info('hi');
		await flushTicks();
		expect(sink.inspect()[0]?.traceId).toBe('trace-abc-123');
	});

	test('readTraceId returning undefined leaves traceId off', async () => {
		const sink = memorySink();
		const log = createLogger({
			level: 'info',
			readTraceId: () => undefined,
			sinks: [sink]
		});
		log.info('hi');
		await flushTicks();
		expect(sink.inspect()[0]?.traceId).toBeUndefined();
	});

	test('readTraceId throwing does NOT break the log call', async () => {
		const sink = memorySink();
		const log = createLogger({
			level: 'info',
			readTraceId: () => {
				throw new Error('otel not initialized');
			},
			sinks: [sink]
		});
		log.info('hi');
		await flushTicks();
		expect(sink.inspect()).toHaveLength(1);
		expect(sink.inspect()[0]?.traceId).toBeUndefined();
	});

	test('async readTraceId is awaited', async () => {
		const sink = memorySink();
		const log = createLogger({
			level: 'info',
			readTraceId: async () => 'async-trace',
			sinks: [sink]
		});
		log.info('hi');
		await flushTicks();
		await flushTicks();
		expect(sink.inspect()[0]?.traceId).toBe('async-trace');
	});
});

// =============================================================================
// close()
// =============================================================================

describe('close', () => {
	test('flush + close every sink that implements them', async () => {
		const flushed: string[] = [];
		const closed: string[] = [];
		const sink: LogSink = {
			close: () => {
				closed.push('a');
			},
			flush: () => {
				flushed.push('a');
			},
			name: 'a',
			write: () => {}
		};
		const log = createLogger({ level: 'info', sinks: [sink] });
		await log.close();
		expect(flushed).toEqual(['a']);
		expect(closed).toEqual(['a']);
	});

	test('subsequent log calls after close are dropped (no throw)', async () => {
		const sink = memorySink();
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.info('before');
		await log.close();
		log.info('after');
		await flushTicks();
		expect(sink.inspect().map((e) => e.message)).toEqual(['before']);
	});
});

// =============================================================================
// consoleJsonSink
// =============================================================================

describe('consoleJsonSink', () => {
	test('emits one JSON line per event', async () => {
		const out: string[] = [];
		const err: string[] = [];
		const sink = consoleJsonSink({
			write: (chunk, stream) => {
				if (stream === 'stdout') out.push(chunk);
				else err.push(chunk);
			}
		});
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.info('one');
		log.warn('two');
		log.error('three');
		await flushTicks();
		expect(out.length + err.length).toBe(3);
		// info + warn go to stdout, error to stderr by default.
		expect(out).toHaveLength(2);
		expect(err).toHaveLength(1);
		expect(out[0]).toMatch(/^\{.+\}\n$/);
		const parsed = JSON.parse(out[0]!);
		expect(parsed.level).toBe('info');
		expect(parsed.message).toBe('one');
	});

	test('errorThreshold splits stdout/stderr', async () => {
		const out: string[] = [];
		const err: string[] = [];
		const sink = consoleJsonSink({
			errorThreshold: 'warn',
			write: (chunk, stream) => {
				(stream === 'stdout' ? out : err).push(chunk);
			}
		});
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.info('info');
		log.warn('warn');
		log.error('error');
		await flushTicks();
		expect(out).toHaveLength(1);
		expect(err).toHaveLength(2);
	});
});

// =============================================================================
// consolePrettySink
// =============================================================================

describe('consolePrettySink', () => {
	test('formats events for humans', async () => {
		const out: string[] = [];
		const sink = consolePrettySink({
			write: (chunk) => out.push(chunk)
		});
		const log = createLogger({
			clock: () => 1_700_000_000_000,
			level: 'info',
			sinks: [sink]
		});
		log.info('hello', { tenant: 'acme', userId: 'u_1' });
		await flushTicks();
		expect(out[0]).toContain('INFO');
		expect(out[0]).toContain('hello');
		expect(out[0]).toContain('tenant=acme');
		expect(out[0]).toContain('userId');
	});
});

// =============================================================================
// rotatingFileSink — needs real filesystem
// =============================================================================

describe('rotatingFileSink', () => {
	let tmpDir: string;
	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), 'abslogs-'));
	});
	afterAll(async () => {
		await rm(tmpDir, { force: true, recursive: true });
	});

	test('writes events as one JSON line each', async () => {
		const path = join(tmpDir, 'app.log');
		const sink = rotatingFileSink({ keep: 3, maxBytes: 1_000_000, path });
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.info('one');
		log.info('two');
		await log.flush();
		await flushTicks();
		const text = await readFile(path, 'utf8');
		const lines = text.trim().split('\n');
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).message).toBe('one');
		expect(JSON.parse(lines[1]!).message).toBe('two');
	});

	test('rotates when current file exceeds maxBytes', async () => {
		const path = join(tmpDir, 'rotate.log');
		const sink = rotatingFileSink({ keep: 3, maxBytes: 200, path });
		const log = createLogger({ level: 'info', sinks: [sink] });
		// Each event is ~80 bytes — three events ≈ 240 bytes → triggers rotation.
		log.info('a long enough event to trigger rotation past the byte threshold');
		log.info('a long enough event to trigger rotation past the byte threshold');
		log.info('a long enough event to trigger rotation past the byte threshold');
		log.info('a long enough event to trigger rotation past the byte threshold');
		await log.flush();
		await flushTicks();
		const entries = await readdir(tmpDir);
		expect(entries).toContain('rotate.log');
		expect(entries.some((e) => e.startsWith('rotate.log.'))).toBe(true);
	});

	test('keeps only the configured number of rotated files', async () => {
		const path = join(tmpDir, 'keep.log');
		const sink = rotatingFileSink({ keep: 2, maxBytes: 100, path });
		const log = createLogger({ level: 'info', sinks: [sink] });
		for (let i = 0; i < 12; i += 1) {
			log.info(`event-${i}-${'x'.repeat(60)}`);
			await log.flush();
		}
		await flushTicks();
		const entries = (await readdir(tmpDir)).filter((e) =>
			e.startsWith('keep.log')
		);
		// Current + .1 + .2 = at most 3; .3+ should not exist.
		expect(entries).not.toContain('keep.log.3');
	});

	test('mkdir -p the parent directory on first write', async () => {
		const deepPath = join(tmpDir, 'a', 'b', 'c', 'nested.log');
		const sink = rotatingFileSink({ path: deepPath });
		const log = createLogger({ level: 'info', sinks: [sink] });
		log.info('hi');
		await log.flush();
		await flushTicks();
		const exists = await stat(deepPath).then(
			() => true,
			() => false
		);
		expect(exists).toBe(true);
	});
});

// =============================================================================
// LOG_LEVELS export sanity
// =============================================================================

test('LOG_LEVELS is ordered low→high', () => {
	expect(LOG_LEVELS).toEqual([
		'trace',
		'debug',
		'info',
		'warn',
		'error',
		'fatal'
	]);
});

// =============================================================================
// Type-only smoke: LogEvent has the expected shape (compile-time)
// =============================================================================

test('LogEvent shape compiles', () => {
	const event: LogEvent = {
		at: 1,
		level: 'info',
		message: 'x',
		tenant: 't',
		traceId: 'tr',
		fields: { a: 1 }
	};
	expect(event.level).toBe('info');
});
