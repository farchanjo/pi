// Automatic provider HTTP transport: HTTP/2 over TLS through ALPN, request-body compression from best to worst
// (Brotli, zstd, gzip, none) at maximum quality by default, and response compression negotiated through undici's
// Accept-Encoding. The coding agent installs its own fetch (with the user's HTTP settings) and therefore keeps control;
// a bare pi-ai consumer, such as the DSH plugin, gets all of this without configuring anything.

import { promisify } from "node:util";
import { brotliCompress, constants, gzip, zstdCompress } from "node:zlib";
import { EnvHttpProxyAgent, Headers, type RequestInit, fetch as undiciFetch } from "undici";

const COMPRESSION_MIN_BYTES = 1024;
const COMPRESSION_VERDICT_TTL_MS = 10 * 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 900_000;
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;
const ACCEPT_ENCODING = "br, zstd, gzip, deflate";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
const zstdAsync = promisify(zstdCompress);

/** How a request body may be compressed. `"auto"` is best-to-worst; `"gzip"` keeps the legacy gzip-only path. */
export type CompressionMode = "auto" | "br" | "zstd" | "gzip" | "off";

/** How hard the encoders try. `"max"` is the default; `"fast"` trades ratio for CPU. */
export type CompressionLevel = "max" | "default" | "fast";

/** Compression selection for one request or as the caller's default. */
export interface CompressionOptions {
	readonly mode?: CompressionMode;
	readonly level?: CompressionLevel;
}

/** A fetch init that can carry a per-request compression override; the property never reaches the network. */
export type CompressionRequestInit = RequestInit & { readonly compression?: CompressionOptions };

/** Defaults used when neither the request nor the caller names a compression policy. */
export const DEFAULT_COMPRESSION_OPTIONS: Required<CompressionOptions> = { mode: "br", level: "max" };

/** Request headers that let a provider config (for example DSh's `cordis.patch.yml`) override compression. */
export const COMPRESSION_MODE_HEADER = "x-pi-http-compression";
export const COMPRESSION_LEVEL_HEADER = "x-pi-http-compression-level";

type RequestEncoding = "br" | "zstd" | "gzip" | "none";

/** Encoder levels per policy. The zstd ceiling is 22 and Brotli's is 11; gzip's is 9. */
const ENCODER_LEVELS: Record<CompressionLevel, { br: number; zstd: number; gzip: number }> = {
	max: { br: 11, zstd: 22, gzip: 9 },
	default: { br: 5, zstd: 3, gzip: 6 },
	fast: { br: 1, zstd: 1, gzip: 1 },
};

/** What the host had when this module loaded; a later replacement is a deliberate host override. */
const hostFetch: typeof globalThis.fetch = globalThis.fetch;

let installedProviderFetch: typeof globalThis.fetch | undefined;

/**
 * Installs the fetch provider adapters use when the caller did not pass one. The coding agent calls this with its
 * settings-aware fetch; `undefined` restores the automatic selection below.
 */
export function setProviderFetch(fetch: typeof globalThis.fetch | undefined): void {
	installedProviderFetch = fetch;
}

let dispatcher: EnvHttpProxyAgent | undefined;
let plainProviderFetch: typeof globalThis.fetch | undefined;
let compressedProviderFetch: typeof globalThis.fetch | undefined;

/**
 * The fetch provider adapters use when the caller did not pass one. A host that installed one or replaced
 * `globalThis.fetch` keeps control; otherwise this returns an HTTP/2-capable fetch with the default compression policy
 * when `compressRequest` is true.
 */
export function providerFetch(compressRequest: boolean): typeof globalThis.fetch {
	if (installedProviderFetch !== undefined) return installedProviderFetch;
	if (globalThis.fetch !== hostFetch) return globalThis.fetch;
	if (!compressRequest) {
		plainProviderFetch ??= createProviderFetch(false);
		return plainProviderFetch;
	}
	compressedProviderFetch ??= createProviderFetch(true);
	return compressedProviderFetch;
}

/** Releases the sockets opened by the automatic client. A later request creates a fresh dispatcher. */
export async function closeProviderFetch(): Promise<void> {
	const current = dispatcher;
	dispatcher = undefined;
	await current?.close();
}

function createProviderFetch(compressRequest: boolean): typeof globalThis.fetch {
	const fetch = (input: Parameters<typeof undiciFetch>[0], init?: CompressionRequestInit) =>
		fetchWithCompression(input, init, { mode: compressRequest ? "br" : "off", level: "max" }, (next) =>
			undiciFetch(input, { ...next, dispatcher: getDispatcher() }),
		);
	// npm undici's Response and the Node declaration of global fetch's Response are structurally compatible here; the
	// cast is only at this boundary because the package does not compile against undici's DOM-compatible types.
	return fetch as unknown as typeof globalThis.fetch;
}

/**
 * Sends `init` through `send` with the preferred response encoding and, unless the effective mode is `"off"`, the
 * best-to-worst request-body compression chain. A server that cannot decode a body answers 400/415; the next encoding
 * is tried and the accepted one is remembered per origin so later requests do not probe again. Per-request
 * `compression`, the two control headers, and the caller's `options` are applied in that order.
 */
export async function fetchWithCompression(
	input: Parameters<typeof undiciFetch>[0],
	init: CompressionRequestInit | undefined,
	options: CompressionOptions = DEFAULT_COMPRESSION_OPTIONS,
	send: (init: RequestInit) => Promise<Awaited<ReturnType<typeof undiciFetch>>>,
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
	const headers = new Headers(init?.headers);
	const mode = init?.compression?.mode ?? parseMode(headers.get(COMPRESSION_MODE_HEADER)) ?? options.mode ?? "br";
	const level =
		init?.compression?.level ?? parseLevel(headers.get(COMPRESSION_LEVEL_HEADER)) ?? options.level ?? "max";
	headers.delete(COMPRESSION_MODE_HEADER);
	headers.delete(COMPRESSION_LEVEL_HEADER);
	if (!headers.has("accept-encoding")) headers.set("accept-encoding", ACCEPT_ENCODING);
	const requestInit: RequestInit = { ...(init ?? {}), headers };
	delete (requestInit as { compression?: CompressionOptions }).compression;

	const origin = requestOrigin(input);
	const order: RequestEncoding[] = mode === "off" ? ["none"] : compressionOrder(mode, rememberedEncoding(origin));
	let usedEncoding: RequestEncoding = "none";
	let compressedAttempt = false;
	let response: Awaited<ReturnType<typeof undiciFetch>> | undefined;
	for (const encoding of order) {
		let next = requestInit;
		if (encoding !== "none") {
			next = await compressedRequestInit(requestInit, encoding, level);
			if (next === requestInit) continue;
			compressedAttempt = true;
		}
		usedEncoding = encoding;
		response = await send(next);
		if (response.status !== 400 && response.status !== 415) break;
		await response.body?.cancel();
	}
	if (response === undefined) response = await send(requestInit);
	if (mode !== "off" && response.status < 400 && compressedAttempt) {
		rememberEncoding(origin, usedEncoding);
	}
	return response;
}

/** The encodings to try, starting at the one this origin already accepted. */
function compressionOrder(
	mode: Exclude<CompressionMode, "off">,
	remembered: RequestEncoding | undefined,
): RequestEncoding[] {
	const order: RequestEncoding[] =
		mode === "auto" || mode === "br"
			? ["br", "zstd", "gzip", "none"]
			: mode === "zstd"
				? ["zstd", "gzip", "none"]
				: ["gzip", "none"];
	const rememberedIndex = remembered === undefined ? -1 : order.indexOf(remembered);
	return order.slice(rememberedIndex >= 0 ? rememberedIndex : 0);
}

/** The origin whose compression verdict was remembered, if it has not expired. */
function rememberedEncoding(origin: string | undefined): RequestEncoding | undefined {
	if (origin === undefined) return undefined;
	const verdict = compressionVerdicts.get(origin);
	if (verdict === undefined) return undefined;
	if (verdict.expiresAt <= Date.now()) {
		compressionVerdicts.delete(origin);
		return undefined;
	}
	return verdict.encoding;
}

/** Remembers the encoding this origin accepted, so later requests skip the probes. */
function rememberEncoding(origin: string | undefined, encoding: RequestEncoding): void {
	if (origin === undefined) return;
	compressionVerdicts.set(origin, { encoding, expiresAt: Date.now() + COMPRESSION_VERDICT_TTL_MS });
}

const compressionVerdicts = new Map<string, { encoding: RequestEncoding; expiresAt: number }>();

/** The origin used as the key for a compression verdict, or `undefined` when the input has no absolute URL. */
function requestOrigin(input: Parameters<typeof undiciFetch>[0]): string | undefined {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url: string }).url;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/** A recognized mode from a control header, or `undefined` for a missing/unknown value. */
function parseMode(value: string | null): CompressionMode | undefined {
	return value === "auto" || value === "br" || value === "zstd" || value === "gzip" || value === "off"
		? value
		: undefined;
}

/** A recognized level from a control header, or `undefined` for a missing/unknown value. */
function parseLevel(value: string | null): CompressionLevel | undefined {
	return value === "max" || value === "default" || value === "fast" ? value : undefined;
}

/** Whether the process has an HTTP proxy configured; undici cannot tunnel HTTP/2 through one. */
function httpProxyConfigured(): boolean {
	return ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].some((key) => {
		const value = process.env[key];
		return value !== undefined && value !== "";
	});
}

function getDispatcher(): EnvHttpProxyAgent {
	dispatcher ??= new EnvHttpProxyAgent({
		// ALPN negotiates HTTP/2 when the server supports it; a server that does not keeps HTTP/1.1. Undici cannot
		// tunnel HTTP/2 through a CONNECT proxy, so a configured proxy keeps the connection on HTTP/1.1.
		allowH2: !httpProxyConfigured(),
		// Keep HTTP origins on CONNECT tunnels as they were before Undici 8.7.
		proxyTunnel: true,
		keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
		headersTimeout: IDLE_TIMEOUT_MS,
		bodyTimeout: IDLE_TIMEOUT_MS,
		connect: { autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
	});
	return dispatcher;
}

/**
 * `init` with its body compressed using `encoding` at `level`, or `init` unchanged when there is nothing safe to
 * compress.
 */
async function compressedRequestInit(
	init: RequestInit,
	encoding: "br" | "zstd" | "gzip",
	level: CompressionLevel,
): Promise<RequestInit> {
	const body = init.body;
	if (body === null || body === undefined) return init;
	const method = (init.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD") return init;
	const headers = new Headers(init.headers);
	if (headers.has("content-encoding")) return init;
	const bytes = await bodyBytes(body);
	if (bytes === undefined || bytes.byteLength < COMPRESSION_MIN_BYTES) return init;
	const encoderLevels = ENCODER_LEVELS[level];
	const compressed =
		encoding === "br"
			? await brotliAsync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: encoderLevels.br } })
			: encoding === "zstd"
				? await zstdAsync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: encoderLevels.zstd } })
				: await gzipAsync(bytes, { level: encoderLevels.gzip });
	headers.set("content-encoding", encoding);
	headers.delete("content-length");
	return { ...init, body: compressed, headers };
}

/** The bytes `body` is made of, for the body types fetch sends whole; `undefined` for the streamed ones. */
async function bodyBytes(body: NonNullable<RequestInit["body"]>): Promise<Uint8Array | undefined> {
	if (typeof body === "string") return Buffer.from(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
	return undefined;
}
