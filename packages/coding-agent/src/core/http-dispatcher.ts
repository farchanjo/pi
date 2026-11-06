import {
	type CompressionLevel,
	type CompressionMode,
	fetchWithCompression,
	setProviderFetch,
} from "@earendil-works/pi-ai/http";
import * as undici from "undici";
import { createUndiciClient, createUndiciOriginDispatcher, quiet } from "./http-transport.ts";
import { Http2Origins, supportsHttp2 } from "./http2.ts";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
/** Undici’s default: an idle socket is closed after 4 s, below Node’s 5 s server keep-alive timeout. */
export const DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS = 4_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

export const HTTP_KEEP_ALIVE_TIMEOUT_CHOICES = [
	{ label: "1 sec", timeoutMs: 1_000 },
	{ label: "4 sec", timeoutMs: 4_000 },
	{ label: "15 sec", timeoutMs: 15_000 },
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
] as const;

/** How the global fetch stack talks to origins. Every option defaults to the HTTP/1.1-only behaviour pi shipped before. */
export type HttpDispatcherOptions = {
	/** HTTP header or body idle timeout; 0 disables it. `DEFAULT_HTTP_IDLE_TIMEOUT_MS` when unset. */
	readonly timeoutMs?: number;
	/**
	 * Negotiate HTTP/2 over TLS through ALPN (an HTTP/1.1-only server keeps HTTP/1.1), and probe plaintext origins for
	 * h2c, falling back to HTTP/1.1 when they do not answer. An HTTP proxy disables h2c: undici cannot tunnel it.
	 */
	readonly http2?: boolean;
	/** Request-body compression mode. `"auto"` tries Brotli, zstd, gzip, then none. */
	readonly requestCompression?: CompressionMode;
	/** Encoder effort for request compression; `"default"` (Brotli 5) when unset. */
	readonly compressionLevel?: CompressionLevel;
	/** Legacy alias: `true` means gzip only, `requestCompression: "gzip"`. */
	readonly requestGzip?: boolean;
	/**
	 * How long an idle HTTP connection stays open for reuse; undici closes it after 4 s by default. Keep it below the
	 * server's own keep-alive timeout (Node's default is 5 s), or a request can reuse a socket the server is closing.
	 */
	readonly keepAliveTimeoutMs?: number;
};

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;
let installedFetch: HttpFetch | undefined;

/**
 * Applies the global HTTP settings: one undici dispatcher for every origin (proxy-aware, HTTP/1.1 or HTTP/2 through
 * ALPN) and, when asked, a fetch wrapper that adds h2c routing and request compression.
 */
export function configureHttpDispatcher(options: HttpDispatcherOptions = {}): void {
	const resolved = resolveOptions(options);
	const dispatcher = quiet(
		new undici.EnvHttpProxyAgent({
			allowH2: resolved.http2 && supportsHttp2,
			// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
			proxyTunnel: true,
			bodyTimeout: resolved.timeoutMs,
			keepAliveTimeout: resolved.keepAliveTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: resolved.timeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch || globalThis.fetch === undici.fetch
			: globalThis.fetch === installedGlobalFetch || globalThis.fetch === undici.fetch;
	if (!shouldInstallGlobals) {
		// The wrapper is ours, the override is deliberate: stop using our connections, leave the override alone.
		setProviderFetch(globalThis.fetch);
		void installedFetch?.close();
		installedFetch = undefined;
		return;
	}
	undici.install?.();
	if (resolved.http2 || resolved.requestCompression !== "off") {
		installedFetch ??= new HttpFetch(undici.fetch);
		installedFetch.configure(resolved);
		// The installed fetch is npm undici's; the global declaration comes from the Node types' undici copy.
		globalThis.fetch = installedFetch.fetch as unknown as typeof globalThis.fetch;
	} else {
		void installedFetch?.close();
		installedFetch = undefined;
	}
	installedGlobalFetch = globalThis.fetch;
	setProviderFetch(globalThis.fetch);
}

/** What the dispatcher reads of a settings manager (structural, so this module does not import it). */
export type HttpSettingsSource = {
	getHttpIdleTimeoutMs(): number;
	getHttpKeepAliveTimeoutMs(): number;
	getHttp2Enabled(): boolean;
	getHttpRequestCompression(): CompressionMode;
	getHttpCompressionLevel(): CompressionLevel;
};

/** Applies the HTTP settings of `settings` to the global dispatcher. */
export function configureHttpDispatcherFromSettings(settings: HttpSettingsSource): void {
	configureHttpDispatcher({
		timeoutMs: settings.getHttpIdleTimeoutMs(),
		keepAliveTimeoutMs: settings.getHttpKeepAliveTimeoutMs(),
		http2: settings.getHttp2Enabled(),
		requestCompression: settings.getHttpRequestCompression(),
		compressionLevel: settings.getHttpCompressionLevel(),
	});
}

/**
 * Closes the connections the fetch wrapper opened and forgets the installed wrapper, so the next configure installs
 * one again. The global fetch is left alone: a test that restores its own fetch decides that.
 */
export async function closeHttpDispatcher(): Promise<void> {
	const wrapper = installedFetch;
	const installed = installedGlobalFetch;
	installedFetch = undefined;
	installedGlobalFetch = undefined;
	setProviderFetch(undefined);
	// Leave npm undici's fetch installed (the module's baseline), not the wrapper, so the next configure wraps again.
	if (installed !== undefined && globalThis.fetch === installed)
		globalThis.fetch = undici.fetch as unknown as typeof globalThis.fetch;
	await wrapper?.close();
}

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function formatHttpKeepAliveTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_KEEP_ALIVE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

/** The dispatcher's options with every default applied. */
type ResolvedHttpOptions = {
	readonly timeoutMs: number;
	readonly keepAliveTimeoutMs: number;
	readonly http2: boolean;
	readonly requestCompression: CompressionMode;
	readonly compressionLevel: CompressionLevel;
};

function resolveOptions(options: HttpDispatcherOptions): ResolvedHttpOptions {
	const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	const normalized = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalized === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const keepAliveTimeoutMs = options.keepAliveTimeoutMs ?? DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS;
	if (!Number.isFinite(keepAliveTimeoutMs) || keepAliveTimeoutMs <= 0) {
		throw new Error(`Invalid HTTP keep-alive timeout: ${String(keepAliveTimeoutMs)}`);
	}
	return {
		timeoutMs: normalized,
		keepAliveTimeoutMs: Math.floor(keepAliveTimeoutMs),
		http2: options.http2 === true,
		requestCompression: options.requestCompression ?? (options.requestGzip === true ? "gzip" : "off"),
		compressionLevel: options.compressionLevel ?? "default",
	};
}

/** What npm undici's fetch takes as input; the installed global fetch is that implementation. */
type FetchInput = Parameters<typeof undici.fetch>[0];
type FetchInit = undici.RequestInit;

/**
 * The global fetch with the settings that cannot live in a dispatcher: h2c routing per plaintext origin (the base
 * dispatcher negotiates TLS through ALPN itself) and gzip request bodies. One instance serves every reconfiguration;
 * a caller's own `dispatcher` is never replaced.
 */
class HttpFetch {
	readonly #base: typeof undici.fetch;
	#options: ResolvedHttpOptions;
	#origins: Http2Origins | undefined;

	constructor(base: typeof undici.fetch) {
		this.#base = base;
		this.#options = {
			timeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
			keepAliveTimeoutMs: DEFAULT_HTTP_KEEP_ALIVE_TIMEOUT_MS,
			http2: false,
			requestCompression: "off",
			compressionLevel: "default",
		};
	}

	readonly fetch = (input: FetchInput, init?: FetchInit): Promise<undici.Response> =>
		fetchWithCompression(
			input,
			init,
			{ mode: this.#options.requestCompression, level: this.#options.compressionLevel },
			async (requestInit) => {
				let next = requestInit;
				if (this.#origins !== undefined && next.dispatcher === undefined) {
					const url = requestUrl(input);
					if (url?.protocol === "http:") {
						const dispatcher = await this.#origins.dispatcherFor(url);
						if (dispatcher !== undefined) next = { ...next, dispatcher };
					}
				}
				return this.#base(input, next);
			},
		);

	/** Applies new settings: h2c clients are reused while enabled and closed when it is turned off. */
	configure(options: ResolvedHttpOptions): void {
		this.#options = options;
		if (options.http2 && supportsHttp2) {
			this.#origins ??= new Http2Origins({
				headersTimeout: options.timeoutMs,
				bodyTimeout: options.timeoutMs,
				keepAliveTimeout: options.keepAliveTimeoutMs,
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			});
			return;
		}
		const origins = this.#origins;
		this.#origins = undefined;
		void origins?.close();
	}

	close(): Promise<void> {
		return this.#origins?.close() ?? Promise.resolve();
	}
}

/** The URL `input` asks for, or undefined when it is not absolute (fetch rejects it itself). */
function requestUrl(input: FetchInput): URL | undefined {
	try {
		if (typeof input === "string") return new URL(input);
		if (input instanceof URL) return input;
		if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") {
			return new URL(input.url);
		}
		return undefined;
	} catch {
		return undefined;
	}
}
