// Process-wide fetch for the server and session workers: npm undici, optionally with HTTP/2 (ALPN over TLS, h2c on
// plaintext origins) and gzip request bodies. The HTTP/2 and compression rules mirror the coding agent's
// packages/coding-agent/src/core/http{2,-compression}.ts; p2 cannot import that package, so they live here.
import { EventEmitter } from "node:events";
import { connect } from "node:http2";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { Agent, Client, type Dispatcher, H2CClient, Headers, install, Pool, setGlobalDispatcher } from "undici";

const ignoreError = (_error: unknown): void => {};

// Undici can emit an internal "error" while terminating a mid-stream fetch body; the body
// still rejects through its reader. Without a listener, EventEmitter would crash the process.
function quiet<T extends Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", ignoreError);
	return dispatcher;
}

const client = (origin: string | URL, options: object): Dispatcher =>
	quiet(new Client(origin, options as Client.Options));

const gzipAsync = promisify(gzip);
const GZIP_MIN_BYTES = 1024;
const PROBE_TIMEOUT_MS = 2_000;
const NEGATIVE_TTL_MS = 30_000;

/** How an origin answered the h2c probe, and when. */
type Verdict = { readonly h2c: boolean; readonly at: number };

/** The h2c side of the fetch stack: one Client per origin that answers HTTP/2, others stay on HTTP/1.1. */
class H2cOrigins {
	readonly verdicts = new Map<string, Verdict>();
	readonly probes = new Map<string, Promise<boolean>>();
	readonly clients = new Map<string, Dispatcher>();
	readonly keepAliveTimeout: number;

	constructor(keepAliveTimeout: number) {
		this.keepAliveTimeout = keepAliveTimeout;
	}

	/** The h2c Client for `url`, or undefined when the origin stays on the HTTP/1.1 dispatcher. */
	async dispatcherFor(url: URL): Promise<Dispatcher | undefined> {
		if (url.protocol !== "http:") return undefined;
		if (!(await this.speaksH2c(url.origin))) return undefined;
		let found = this.clients.get(url.origin);
		if (found === undefined) {
			found = quiet(new H2CClient(url.origin, { keepAliveTimeout: this.keepAliveTimeout }));
			this.clients.set(url.origin, found);
		}
		return found;
	}

	async close(): Promise<void> {
		const clients = [...this.clients.values()];
		this.clients.clear();
		this.verdicts.clear();
		await Promise.allSettled(clients.map((found) => found.close()));
	}

	async speaksH2c(origin: string): Promise<boolean> {
		const verdict = this.verdicts.get(origin);
		if (verdict !== undefined && (verdict.h2c || Date.now() - verdict.at < NEGATIVE_TTL_MS)) return verdict.h2c;
		let probe = this.probes.get(origin);
		if (probe === undefined) {
			probe = probeH2c(origin).then((h2c) => {
				this.verdicts.set(origin, { h2c, at: Date.now() });
				this.probes.delete(origin);
				return h2c;
			});
			this.probes.set(origin, probe);
		}
		return probe;
	}
}

/** Whether `origin` answers the HTTP/2 preface with its SETTINGS frame; an HTTP/1.1 server errors or closes. */
function probeH2c(origin: string): Promise<boolean> {
	return new Promise((resolve) => {
		const session = connect(origin);
		let settled = false;
		const finish = (h2c: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			session.destroy();
			resolve(h2c);
		};
		const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
		timer.unref();
		session.on("error", () => finish(false));
		session.on("close", () => finish(false));
		session.on("remoteSettings", () => finish(true));
	});
}

/** The fetch init with a gzipped body, or the same init when the body is absent, small, or streamed. */
async function compressedInit(init: RequestInit | undefined): Promise<RequestInit | undefined> {
	const body = init?.body;
	if (body === null || body === undefined) return init;
	const method = (init?.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") return init;
	const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
	if (headers.has("content-encoding")) return init;
	const bytes = await bodyBytes(body);
	if (bytes === undefined || bytes.byteLength < GZIP_MIN_BYTES) return init;
	const compressed = await gzipAsync(bytes);
	headers.set("content-encoding", "gzip");
	headers.delete("content-length");
	return { ...init, body: compressed, headers };
}

async function bodyBytes(body: BodyInit): Promise<Uint8Array | undefined> {
	if (typeof body === "string") return Buffer.from(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	return undefined;
}

type P2FetchInit = RequestInit & { readonly dispatcher?: Dispatcher };

/** What `configureFetch` installs: the wrapper, its h2c Clients, and the options it was built with. */
type ConfiguredFetch = {
	readonly http2: boolean;
	readonly requestGzip: boolean;
	readonly origins: H2cOrigins | undefined;
};

let configured: ConfiguredFetch | undefined;

/**
 * Installs npm undici's fetch, like the coding agent's dispatcher.
 *
 * Node 26's bundled fetch negotiates HTTP/2, one shared session per origin. After that
 * session dies, it can keep handing new requests to it: every provider request to the
 * origin fails at once with `ERR_HTTP2_INVALID_SESSION` ("fetch failed") or hangs until the
 * process exits. Over HTTP/1.1 a failed connection is dropped and the next request opens another.
 * Call once per process, before any provider request.
 *
 * `http2` enables ALPN over TLS and a per-origin h2c probe with HTTP/1.1 fallback; `requestGzip`
 * gzips request bodies above 1 KiB. Both default to `P2_HTTP2` and `P2_HTTP_REQUEST_GZIP` being `1`.
 */
export function configureFetch(
	options: { http2?: boolean; requestGzip?: boolean; keepAliveTimeoutMs?: number } = {},
): void {
	const http2 = options.http2 ?? process.env.P2_HTTP2 === "1";
	const requestGzip = options.requestGzip ?? process.env.P2_HTTP_REQUEST_GZIP === "1";
	const keepAliveTimeoutMs =
		options.keepAliveTimeoutMs ??
		(process.env.P2_HTTP_KEEP_ALIVE_TIMEOUT_MS === undefined
			? 4_000
			: Number(process.env.P2_HTTP_KEEP_ALIVE_TIMEOUT_MS));
	if (!Number.isFinite(keepAliveTimeoutMs) || keepAliveTimeoutMs <= 0) {
		throw new Error(`Invalid P2 keep-alive timeout: ${String(keepAliveTimeoutMs)}`);
	}
	const previous = configured;
	configured = {
		http2,
		requestGzip,
		origins: http2 ? new H2cOrigins(keepAliveTimeoutMs) : undefined,
	};
	if (previous?.origins !== undefined) void previous.origins.close();

	setGlobalDispatcher(
		quiet(
			new Agent({
				allowH2: http2,
				keepAliveTimeout: keepAliveTimeoutMs,
				factory: (origin, options) =>
					(options as Pool.Options).connections === 1
						? client(origin, options)
						: quiet(new Pool(origin, { ...(options as Pool.Options), factory: client })),
			}),
		),
	);
	// Keep fetch and the dispatcher on the same undici: Node's bundled fetch over npm undici's
	// dispatcher can skip response decompression.
	install();
	const base = globalThis.fetch;
	globalThis.fetch =
		http2 || requestGzip
			? async (input: RequestInfo | URL, init?: RequestInit) => {
					const settings = configured;
					if (settings === undefined) return base(input, init);
					let next: P2FetchInit | undefined = settings.requestGzip ? await compressedInit(init) : init;
					if (settings.origins !== undefined && next?.dispatcher === undefined) {
						const url = requestUrl(input);
						if (url?.protocol === "http:") {
							const dispatcher = await settings.origins.dispatcherFor(url);
							if (dispatcher !== undefined) next = { ...next, dispatcher };
						}
					}
					return base(input, next);
				}
			: base;
}

/** Closes the h2c Clients; later requests open new ones. */
export async function closeFetch(): Promise<void> {
	const settings = configured;
	configured = undefined;
	await settings?.origins?.close();
}

function requestUrl(input: RequestInfo | URL): URL | undefined {
	try {
		if (typeof input === "string") return new URL(input);
		if (input instanceof URL) return input;
		return new URL(input.url);
	} catch {
		return undefined;
	}
}
