// Browser fallback for the provider HTTP transport: the page's fetch already negotiates compression, and browsers have
// no Node sockets for HTTP/2. The Node build uses http.ts, which is selected by the package's browser map.

/** How a request body may be compressed. */
export type CompressionMode = "auto" | "br" | "zstd" | "gzip" | "off";

/** How hard the encoders try. */
export type CompressionLevel = "max" | "default" | "fast";

/** Compression selection for one request or as the caller's default. */
export interface CompressionOptions {
	mode?: CompressionMode;
	level?: CompressionLevel;
}

/** A request init that may carry a compression preference; the browser leaves it unused. */
export type CompressionRequestInit = RequestInit & { compression?: CompressionOptions };

export const DEFAULT_COMPRESSION_OPTIONS = {
	mode: "auto",
	level: "default",
} as const satisfies Required<CompressionOptions>;
export const COMPRESSION_MODE_HEADER = "x-pi-http-compression";
export const COMPRESSION_LEVEL_HEADER = "x-pi-http-compression-level";

let installedFetch: typeof globalThis.fetch | undefined;

/** Set by the host when it wants all requests to use its own fetch. */
export function setProviderFetch(fetch: typeof globalThis.fetch | undefined): void {
	installedFetch = fetch;
}

/** Returns the host's fetch or the page's fetch; there is no dispatcher to install in a browser. */
export function providerFetch(requestGzip: boolean): typeof globalThis.fetch {
	void requestGzip;
	return installedFetch ?? globalThis.fetch;
}

/** Sends through the page's fetch; request-body compression is left to the page. */
export function fetchWithCompression(
	input: Parameters<typeof globalThis.fetch>[0],
	init: CompressionRequestInit | undefined,
	options: CompressionOptions,
	send: (init: RequestInit) => Promise<Response>,
): Promise<Response> {
	void input;
	void options;
	const requestInit = { ...(init ?? {}) };
	delete requestInit.compression;
	return send(requestInit);
}

/** Nothing to release: the browser owns the connections. */
export function closeProviderFetch(): Promise<void> {
	return Promise.resolve();
}
