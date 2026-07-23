import {
	defineImplementation,
	defineManifest,
	toolFactory
} from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type {
	ConsoleJsonSinkOptions,
	ConsolePrettySinkOptions,
	Logger,
	LoggerOptions,
	RotatingFileSinkOptions
} from './index';

const tool = toolFactory<Logger>();

const levelSchema = (options: {
	default?: string;
	description: string;
	title: string;
}) =>
	Type.Union(
		[
			Type.Literal('trace'),
			Type.Literal('debug'),
			Type.Literal('info'),
			Type.Literal('warn'),
			Type.Literal('error'),
			Type.Literal('fatal')
		],
		options
	);

/* Serializable subset of LoggerOptions: level + static fields. `sinks` is
 * instance-valued → the `sink` slot; `redact` / `readTraceId` / `clock` /
 * `onError` are function-valued → wiring concerns, never settings. */
const settings = Type.Object({
	fields: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				'Static fields stamped onto every log line — service name, region, version.',
			title: 'Fields on every log line'
		})
	),
	level: Type.Optional(
		levelSchema({
			default: 'info',
			description:
				'Log lines below this level are dropped. Use debug while diagnosing, info in production.',
			title: 'Log detail level'
		})
	)
});

export const manifest = defineManifest<LoggerOptions, Logger>()({
	contract: 2,
	identity: {
		accent: '#f97316',
		category: 'observability',
		description:
			'Structured log primitive for the AbsoluteJS substrate. Levels, child loggers, pluggable sinks (console-JSON, console-pretty, memory, rotating file), optional secret redaction via `@absolutejs/secrets`, optional trace-id correlation via `@absolutejs/telemetry`, and an operator metrics surface.',
		docsUrl: 'https://github.com/absolutejs/logs',
		name: '@absolutejs/logs',
		tagline: 'Keep a clean, searchable record of what your app is doing.'
	},
	implements: [
		defineImplementation<ConsoleJsonSinkOptions>()({
			contract: 'logs/sink',
			factory: 'consoleJsonSink',
			from: '@absolutejs/logs',
			settings: Type.Object({
				errorThreshold: Type.Optional(
					levelSchema({
						default: 'error',
						description:
							'Log lines at or above this level go to stderr instead of stdout.',
						title: 'Send to stderr from'
					})
				)
			}),
			title: 'Server output, one JSON line per event (production)',
			wiring: {
				code: 'consoleJsonSink(${settings})',
				imports: [
					{ from: '@absolutejs/logs', names: ['consoleJsonSink'] }
				]
			}
		}),
		defineImplementation<ConsolePrettySinkOptions>()({
			contract: 'logs/sink',
			factory: 'consolePrettySink',
			from: '@absolutejs/logs',
			settings: Type.Object({
				errorThreshold: Type.Optional(
					levelSchema({
						default: 'error',
						description:
							'Log lines at or above this level go to stderr instead of stdout.',
						title: 'Send to stderr from'
					})
				)
			}),
			title: 'Server output, human-readable lines (development)',
			wiring: {
				code: 'consolePrettySink(${settings})',
				imports: [
					{ from: '@absolutejs/logs', names: ['consolePrettySink'] }
				]
			}
		}),
		defineImplementation<RotatingFileSinkOptions>()({
			contract: 'logs/sink',
			factory: 'rotatingFileSink',
			from: '@absolutejs/logs',
			settings: Type.Object({
				keep: Type.Optional(
					Type.Integer({
						default: 5,
						description:
							'How many rotated log files are kept before the oldest is deleted.',
						minimum: 1,
						title: 'Rotated files to keep'
					})
				),
				maxBytes: Type.Optional(
					Type.Integer({
						default: 10485760,
						description:
							'The file rotates once it grows past this many bytes. Default 10 MB.',
						minimum: 1024,
						title: 'Rotate after'
					})
				),
				path: Type.String({
					default: './var/logs/app.log',
					description:
						'File the log lines are appended to. The folder is created if missing.',
					title: 'Log file location'
				})
			}),
			title: 'A file on this machine, with size-based rotation',
			wiring: {
				code: 'rotatingFileSink(${settings})',
				imports: [
					{ from: '@absolutejs/logs', names: ['rotatingFileSink'] }
				]
			}
		})
	],
	settings,
	slots: {
		sink: {
			configPath: 'sinks',
			contract: 'logs/sink',
			description: 'Where your log lines go',
			known: [
				'@absolutejs/logs#console-json',
				'@absolutejs/logs#console-pretty',
				'@absolutejs/logs#rotating-file'
			],
			required: true
		}
	},
	tools: {
		logging_stats: tool.runtime({
			annotations: { readOnlyHint: true },
			authorization: {
				approval: 'never',
				audience: 'admin',
				effects: ['read'],
				requiredScopes: ['logs:read']
			},
			description:
				'Cumulative logger counters since the server started: lines logged per level, sink writes, and per-sink write errors.',
			handler: (_input, logger) => JSON.stringify(logger.metrics()),
			input: Type.Object({})
		}),
		set_log_level: tool.runtime({
			annotations: { idempotentHint: true },
			authorization: {
				approval: 'policy',
				audience: 'admin',
				effects: ['write'],
				idempotency: { mode: 'host' },
				requiredScopes: ['logs:configure'],
				resource: { type: 'logger-configuration' },
				reversible: false
			},
			description:
				'Change the minimum log level at runtime — bump to debug during incident triage, back to info afterwards. Lasts until the server restarts.',
			handler: ({ level }, logger) => {
				logger.setLevel(level);

				return `log level set to ${level}`;
			},
			input: Type.Object({
				level: levelSchema({
					description: 'The new minimum level.',
					title: 'Level'
				})
			})
		})
	},
	wiring: [
		{
			id: 'default',
			server: {
				code: 'const logger = createLogger({ sinks: [${slot.sink}], ...${settings} });',
				imports: [{ from: '@absolutejs/logs', names: ['createLogger'] }],
				placement: 'module-scope'
			},
			title: 'Create the logger'
		}
	]
});
