// Answer compression for Chord's own Node server: an answer whose type is worth compressing and whose client accepts
// gzip gains `Content-Encoding: gzip` and `Vary: Accept-Encoding`; an already encoded, ranged, bodyless or streaming
// event answer keeps its bytes. The listener applies it in `write`; the helpers stay pure so they test without a socket.

import type { Answer } from "./response.ts";

/** Bodies these statuses do not carry, so there is nothing to compress. */
const BODYLESS = new Set([204, 205, 304]);

/** Below this, gzip's header and the CPU cost more than the bytes it saves. */
const MIN_GZIP_BYTES = 1024;

/** Whether an `Accept-Encoding` header accepts `gzip` (a missing or zero quality refuses it; `*` accepts it). */
export function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
	if (acceptEncoding === null || acceptEncoding === undefined) return false;
	for (const part of acceptEncoding.split(",")) {
		const [coding = "", ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
		if (coding !== "gzip" && coding !== "*") continue;
		const quality = parameters.find((parameter) => parameter.startsWith("q="));
		if (quality === undefined || Number(quality.slice(2)) > 0) return true;
	}
	return false;
}

/** Whether `answer` to a `method` request may be gzipped: a body of a compressible type, not already encoded or ranged. */
export function compressibleAnswer(answer: Answer, method: string): boolean {
	if (method === "HEAD") return false;
	if (answer.body === null || answer.body === undefined) return false;
	if (BODYLESS.has(answer.status)) return false;
	if (answer.headers.has("content-encoding") || answer.headers.has("content-range")) return false;
	const contentType = answer.headers.get("content-type");
	return contentType !== null && compressibleType(contentType);
}

/** Whether a `Content-Type` is worth gzipping: text and the structured types, but never an event stream. */
export function compressibleType(contentType: string): boolean {
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

/** Whether a whole string body is large enough for gzip to pay for its header. */
export function compressibleSize(body: string): boolean {
	return Buffer.byteLength(body) >= MIN_GZIP_BYTES;
}

/** Sets `name` in a `[name, value, ...]` header line list, replacing an existing line case-insensitively. */
export function setHeader(lines: string[], name: string, value: string): void {
	for (let index = 0; index < lines.length; index += 2) {
		if (lines[index]!.toLowerCase() === name.toLowerCase()) {
			lines[index + 1] = value;
			return;
		}
	}
	lines.push(name, value);
}

/** Removes `name` from a `[name, value, ...]` header line list. */
export function removeHeader(lines: string[], name: string): void {
	for (let index = 0; index < lines.length; index += 2) {
		if (lines[index]!.toLowerCase() === name.toLowerCase()) {
			lines.splice(index, 2);
			return;
		}
	}
}

/** Adds `value` to the `Vary` header, keeping what the answer already varied on. */
export function appendVary(lines: string[], value: string): void {
	const found = lines.findIndex((line, index) => index % 2 === 0 && line.toLowerCase() === "vary");
	if (found === -1) {
		lines.push("Vary", value);
		return;
	}
	const existing = lines[found + 1] ?? "";
	const values = existing.split(",").map((piece) => piece.trim().toLowerCase());
	if (!values.includes(value.toLowerCase())) lines[found + 1] = `${existing}, ${value}`;
}
