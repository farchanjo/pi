// HTTP helpers shared by the server's routes (Node).
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

/** A JSON response: the status, `Content-Type`, then `headers` (a `Set-Cookie`, say), and the body as JSON. */
export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, { "Content-Type": "application/json", ...headers });
	response.end(JSON.stringify(body));
}

/** The value of the request's cookie `name` (the first one), if it carries one. */
export function cookieValue(request: IncomingMessage, name: string): string | undefined {
	const prefix = `${name}=`;
	return (request.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(prefix))
		?.slice(prefix.length);
}

/**
 * A state-changing request from a page of this origin: exactly its `Origin` header, which a cross-site form or fetch
 * cannot send. (A missing `Origin` does not count.)
 */
export const fromOrigin = (request: IncomingMessage, origin: { readonly origin: string }): boolean =>
	request.headers.origin === origin.origin;

/** Bodies these statuses do not carry, so there is nothing to compress. */
const BODYLESS = new Set([204, 205, 304]);

/** Below this, gzip's header and the CPU cost more than the bytes it saves. */
const MIN_GZIP_BYTES = 1024;

/**
 * Makes `response` gzip a whole body above 1 KiB whose type compresses when the request accepts gzip: `writeHead` is
 * held until the body is known, then sent with `Content-Encoding: gzip`, `Vary: Accept-Encoding` and the compressed
 * length. Streaming writes are sent uncompressed; the wrapper stays out of the way once headers are sent.
 */
export function enableCompression(request: IncomingMessage, response: ServerResponse): void {
	if (response.headersSent) return;
	const baseWriteHead = response.writeHead.bind(response);
	const baseWrite = response.write.bind(response);
	const baseEnd = response.end.bind(response);
	let status = response.statusCode;
	let statusMessage: string | undefined;
	let head: OutgoingHttpHeaders | string[] | undefined;
	let sent = false;
	let ended = false;

	const currentHeaders = (): OutgoingHttpHeaders => {
		const extra = head === undefined || Array.isArray(head) ? {} : head;
		const merged: OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries({ ...response.getHeaders(), ...extra })) {
			merged[name.toLowerCase()] = value;
		}
		return merged;
	};
	const send = (headers: OutgoingHttpHeaders): void => {
		if (sent) return;
		sent = true;
		if (Array.isArray(head)) baseWriteHead(status, head);
		else if (statusMessage === undefined) baseWriteHead(status, headers);
		else baseWriteHead(status, statusMessage, headers);
	};

	response.writeHead = ((nextStatus: number, messageOrHeaders?: unknown, maybeHeaders?: unknown) => {
		if (sent) return baseWriteHead(nextStatus, messageOrHeaders as never, maybeHeaders as never);
		status = nextStatus;
		if (typeof messageOrHeaders === "string") {
			statusMessage = messageOrHeaders;
			head = maybeHeaders as OutgoingHttpHeaders | string[] | undefined;
		} else {
			statusMessage = undefined;
			head = messageOrHeaders as OutgoingHttpHeaders | string[] | undefined;
		}
		return response;
	}) as typeof response.writeHead;

	// A chunked write starts the response: compression only applies to a whole body known at `end`.
	response.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
		if (!sent) send(currentHeaders());
		return (baseWrite as (chunk: unknown, encoding: unknown, callback: unknown) => boolean)(
			chunk,
			encoding,
			callback,
		);
	}) as typeof response.write;

	response.flushHeaders = (() => {
		send(currentHeaders());
		return response;
	}) as typeof response.flushHeaders;

	response.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
		if (ended) return response;
		ended = true;
		const done = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
		const body = typeof chunk === "function" ? undefined : chunk;
		const headers = currentHeaders();
		const bytes = bodyBytes(body);
		const type = headerText(headers["content-type"]);
		if (bytes !== undefined && bytes.byteLength >= MIN_GZIP_BYTES && type !== undefined) {
			const acceptable =
				!Array.isArray(head) &&
				acceptsGzip(headerText(request.headers["accept-encoding"])) &&
				!BODYLESS.has(status) &&
				request.method !== "HEAD" &&
				headers["content-encoding"] === undefined &&
				headers["content-range"] === undefined &&
				compressibleType(type);
			if (acceptable) {
				const compressed = gzipSync(bytes);
				headers["content-encoding"] = "gzip";
				headers["content-length"] = String(compressed.byteLength);
				headers.vary = headerText(headers.vary)?.toLowerCase().includes("accept-encoding")
					? headers.vary
					: `${headerText(headers.vary) ?? ""}${headers.vary === undefined ? "" : ", "}Accept-Encoding`;
				send(headers);
				baseEnd(compressed, done as (() => void) | undefined);
				return response;
			}
		}
		send(headers);
		if (body === undefined) baseEnd(done as (() => void) | undefined);
		else if (typeof encoding === "string")
			(baseEnd as (body: unknown, encoding: string, callback?: unknown) => void)(body, encoding, done);
		else baseEnd(body as string | Buffer, done as (() => void) | undefined);
		return response;
	}) as typeof response.end;
}

/** `body` as bytes for the whole-body types a route ends with; undefined when it is not one. */
function bodyBytes(body: unknown): Uint8Array | undefined {
	if (typeof body === "string") return Buffer.from(body);
	if (Buffer.isBuffer(body)) return body;
	if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	return undefined;
}

/** The string form of a header value, if it has one. */
function headerText(value: string | string[] | number | undefined): string | undefined {
	return typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : value?.toString();
}

/** Whether an `Accept-Encoding` header accepts `gzip` (a missing or zero quality refuses it; `*` accepts it). */
function acceptsGzip(acceptEncoding: string | undefined): boolean {
	if (acceptEncoding === undefined) return false;
	for (const part of acceptEncoding.split(",")) {
		const [coding = "", ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
		if (coding !== "gzip" && coding !== "*") continue;
		const quality = parameters.find((parameter) => parameter.startsWith("q="));
		if (quality === undefined || Number(quality.slice(2)) > 0) return true;
	}
	return false;
}

/** Whether a `Content-Type` is worth gzipping: text and the structured types, but never an event stream. */
function compressibleType(contentType: string): boolean {
	const type = contentType.split(";")[0]!.trim().toLowerCase();
	if (type === "text/event-stream") return false;
	return (
		type.startsWith("text/") ||
		type === "application/json" ||
		type === "application/javascript" ||
		type === "application/xml" ||
		type === "application/manifest+json" ||
		type === "image/svg+xml" ||
		type.endsWith("+json") ||
		type.endsWith("+xml")
	);
}
