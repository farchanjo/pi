import type http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import {
	brotliCompressSync,
	brotliDecompressSync,
	gunzipSync,
	gzipSync,
	zstdCompressSync,
	zstdDecompressSync,
} from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import {
	COMPRESSION_LEVEL_HEADER,
	COMPRESSION_MODE_HEADER,
	type CompressionRequestInit,
	closeProviderFetch,
	DEFAULT_COMPRESSION_OPTIONS,
	providerFetch,
	setProviderFetch,
} from "../src/http.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Throwaway self-signed localhost certificate (valid until 2126) for these tests only; not a credential.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgshDH8NMKiDy0wD1R
7GaTil/WSPM33JaTUG0PcH6z6B+hRANCAASX9LpbABv42+5mEc8Q2NTht6C2YPhi
s25xsxHZ5rciQS1CXAMfppSRjq9ycsnZjBD9oxy/zxRXkUzrjo0uYzLr
-----END PRIVATE KEY-----`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUQzVFEQltn+/MaYeqLwAqzkY8KXMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAxMjA4MzczMVoYDzIxMjYwOTE4
MDgzNzMxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAASX9LpbABv42+5mEc8Q2NTht6C2YPhis25xsxHZ5rciQS1CXAMfppSR
jq9ycsnZjBD9oxy/zxRXkUzrjo0uYzLro28wbTAdBgNVHQ4EFgQUbQCQegyl6vFO
t3SrSnVgB+IztoEwHwYDVR0jBBgwFoAUbQCQegyl6vFOt3SrSnVgB+IztoEwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAJF6diUGbjEmEhRgS93rHXyyzIPv3dMpoAYUbsw5JwujAiBc
uv5tg1CsZE/JyRZMmTHmyQ7VXeTplMM5adE00TDoJg==
-----END CERTIFICATE-----`;

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

type TestServer = http2.Http2SecureServer | https.Server;

interface SeenRequest {
	version: string;
	encoding: string;
	decodedBytes: number;
}

let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;
let savedTlsReject: string | undefined;

beforeAll(() => {
	savedTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
		(typeof PROXY_ENV_KEYS)[number],
		string | undefined
	>;
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const) delete process.env[key];
	process.env.NO_PROXY = "127.0.0.1";
});

afterAll(async () => {
	await closeProviderFetch();
	for (const key of PROXY_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (savedTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTlsReject;
});

afterEach(async () => {
	await closeProviderFetch();
});

describe("provider HTTP transport", () => {
	it("sends Brotli request bodies by default over HTTP/2", async () => {
		let seen: SeenRequest | undefined;
		let sessions = 0;
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: true }, (request, response) =>
			readBody(request, (body, encoding) => {
				seen = { version: request.httpVersion, encoding, decodedBytes: decoded(body, encoding).byteLength };
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ ok: true }));
			}),
		);
		server.on("session", () => {
			sessions += 1;
		});
		const port = await listening(server);
		const payload = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] });
		const fetch = providerFetch(true);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await fetch(`https://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: payload,
			});
			expect(response.status).toBe(200);
			await response.text();
		}

		expect(seen).toEqual({ version: "2.0", encoding: "br", decodedBytes: Buffer.byteLength(payload) });
		expect(sessions).toBe(1);
		await closeProviderFetch();
		await closing(server);
	});

	it("sends Brotli request bodies over HTTP/1.1 too", async () => {
		let seen: SeenRequest | undefined;
		const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (body, encoding) => {
				seen = { version: request.httpVersion, encoding, decodedBytes: decoded(body, encoding).byteLength };
				response.end("ok");
			}),
		);
		const port = await listening(server);
		const payload = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] });

		const response = await providerFetch(true)(`https://127.0.0.1:${port}/`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: payload,
		});
		expect(await response.text()).toBe("ok");
		expect(seen).toEqual({ version: "1.1", encoding: "br", decodedBytes: Buffer.byteLength(payload) });

		await closeProviderFetch();
		await closing(server);
	});

	it("decompresses gzip responses over HTTP/2 and HTTP/1.1", async () => {
		const responseText = "compressed response body ".repeat(100);
		for (const protocol of ["h2", "h1"] as const) {
			let seen: { version: string; acceptEncoding: string } | undefined;
			const handler = (
				request: http.IncomingMessage | http2.Http2ServerRequest,
				response: http.ServerResponse | http2.Http2ServerResponse,
			) => {
				seen = {
					version: request.httpVersion,
					acceptEncoding: request.headers["accept-encoding"] ?? "",
				};
				response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
				response.end(gzipSync(responseText));
			};
			const server: TestServer =
				protocol === "h2"
					? http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, handler)
					: https.createServer({ key: TLS_KEY, cert: TLS_CERT }, handler);
			const port = await listening(server);

			const response = await providerFetch(false)(`https://127.0.0.1:${port}/`);
			expect(seen?.version).toBe(protocol === "h2" ? "2.0" : "1.1");
			expect(seen?.acceptEncoding).toBe("br, zstd, gzip, deflate");
			expect(response.headers.get("content-encoding")).toBe("gzip");
			expect(await response.text()).toBe(responseText);

			await closeProviderFetch();
			await closing(server);
		}
	});

	it("negotiates and decompresses Brotli responses over HTTP/2 and HTTP/1.1", async () => {
		const responseText = "brotli response body ".repeat(100);
		for (const protocol of ["h2", "h1"] as const) {
			let seen: { version: string; acceptEncoding: string } | undefined;
			const handler = (
				request: http.IncomingMessage | http2.Http2ServerRequest,
				response: http.ServerResponse | http2.Http2ServerResponse,
			) => {
				seen = {
					version: request.httpVersion,
					acceptEncoding: request.headers["accept-encoding"] ?? "",
				};
				response.writeHead(200, { "content-type": "text/plain", "content-encoding": "br" });
				response.end(brotliCompressSync(responseText));
			};
			const server: TestServer =
				protocol === "h2"
					? http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, handler)
					: https.createServer({ key: TLS_KEY, cert: TLS_CERT }, handler);
			const port = await listening(server);

			const response = await providerFetch(false)(`https://127.0.0.1:${port}/`);
			expect(seen?.version).toBe(protocol === "h2" ? "2.0" : "1.1");
			expect(seen?.acceptEncoding).toContain("br");
			expect(response.headers.get("content-encoding")).toBe("br");
			expect(await response.text()).toBe(responseText);

			await closeProviderFetch();
			await closing(server);
		}
	});

	it("negotiates and decompresses zstd responses over HTTP/2 and HTTP/1.1", async () => {
		const responseText = "zstd response body ".repeat(100);
		for (const protocol of ["h2", "h1"] as const) {
			let seen: { version: string; acceptEncoding: string } | undefined;
			const handler = (
				request: http.IncomingMessage | http2.Http2ServerRequest,
				response: http.ServerResponse | http2.Http2ServerResponse,
			) => {
				seen = {
					version: request.httpVersion,
					acceptEncoding: request.headers["accept-encoding"] ?? "",
				};
				response.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
				response.end(zstdCompressSync(responseText));
			};
			const server: TestServer =
				protocol === "h2"
					? http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, handler)
					: https.createServer({ key: TLS_KEY, cert: TLS_CERT }, handler);
			const port = await listening(server);

			const response = await providerFetch(false)(`https://127.0.0.1:${port}/`);
			expect(seen?.version).toBe(protocol === "h2" ? "2.0" : "1.1");
			expect(seen?.acceptEncoding).toContain("zstd");
			expect(response.headers.get("content-encoding")).toBe("zstd");
			expect(await response.text()).toBe(responseText);

			await closeProviderFetch();
			await closing(server);
		}
	});

	it("defaults to best-to-worst compression at the default effort", () => {
		expect(DEFAULT_COMPRESSION_OPTIONS).toEqual({ mode: "br", level: "default" });
	});

	it("honors a per-request compression override", async () => {
		let encoding: string | undefined;
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (_body, requestEncoding) => {
				encoding = requestEncoding;
				response.end("ok");
			}),
		);
		const port = await listening(server);
		const init = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] }),
			compression: { mode: "off" },
		} satisfies CompressionRequestInit;

		const response = await providerFetch(true)(`https://127.0.0.1:${port}/`, init);
		expect(await response.text()).toBe("ok");
		expect(encoding ?? "").toBe("");

		await closeProviderFetch();
		await closing(server);
	});

	it("applies compression control headers and strips them before sending", async () => {
		let encoding: string | undefined;
		let modeHeader: string | undefined;
		let levelHeader: string | undefined;
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (_body, requestEncoding) => {
				encoding = requestEncoding;
				modeHeader = request.headers[COMPRESSION_MODE_HEADER.toLowerCase()] as string | undefined;
				levelHeader = request.headers[COMPRESSION_LEVEL_HEADER.toLowerCase()] as string | undefined;
				response.end("ok");
			}),
		);
		const port = await listening(server);

		const response = await providerFetch(true)(`https://127.0.0.1:${port}/`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[COMPRESSION_MODE_HEADER]: "gzip",
				[COMPRESSION_LEVEL_HEADER]: "fast",
			},
			body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] }),
		});
		expect(await response.text()).toBe("ok");
		expect(encoding).toBe("gzip");
		expect(modeHeader).toBeUndefined();
		expect(levelHeader).toBeUndefined();

		await closeProviderFetch();
		await closing(server);
	});

	it.each([
		["br", ["br"]],
		["zstd", ["br", "zstd"]],
		["gzip", ["br", "zstd", "gzip"]],
	] as const)("streams deltas with %s request and response compression", async (encoding, expectedEncodings) => {
		const encodings: string[] = [];
		const responseEncodings: string[] = [];
		let sessions = 0;
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (_body, requestEncoding) => {
				encodings.push(requestEncoding);
				if (requestEncoding !== encoding) {
					response.statusCode = 400;
					response.end("cannot decode");
					return;
				}
				const chunks = ["A", "B", "C"].map(
					(content) =>
						`data: ${JSON.stringify({
							id: "chatcmpl-compressed",
							object: "chat.completion.chunk",
							created: 0,
							model: "test-model",
							choices: [{ index: 0, delta: { content }, finish_reason: null }],
						})}\n\n`,
				);
				chunks.push(
					`data: ${JSON.stringify({
						id: "chatcmpl-compressed",
						object: "chat.completion.chunk",
						created: 0,
						model: "test-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 3 },
					})}\n\n`,
				);
				chunks.push("data: [DONE]\n\n");
				const sse = chunks.join("");
				const compressed =
					encoding === "br"
						? brotliCompressSync(sse)
						: encoding === "zstd"
							? zstdCompressSync(sse)
							: gzipSync(sse);
				response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": encoding });
				response.end(compressed);
			}),
		);
		server.on("session", () => {
			sessions += 1;
		});
		const port = await listening(server);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: `https://127.0.0.1:${port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const events = await collect(
			streamOpenAICompletions(
				model,
				normalizeContext({ messages: [{ role: "user", content: "x".repeat(2048), timestamp: 1 }] }),
				{
					apiKey: "test-key",
					onResponse: ({ headers }) => {
						const value = Object.entries(headers ?? {}).find(
							([key]) => key.toLowerCase() === "content-encoding",
						)?.[1];
						if (value !== undefined) responseEncodings.push(value);
					},
				},
			),
		);

		expect(encodings).toEqual(expectedEncodings);
		expect(responseEncodings).toEqual([encoding]);
		expect(deltas(events)).toEqual(["A", "B", "C"]);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.content.find((block) => block.type === "text")).toMatchObject({
				type: "text",
				text: "ABC",
			});
		}
		expect(sessions).toBe(1);

		await closeProviderFetch();
		await closing(server);
	});

	it("streams deltas over HTTP/2 without request compression", async () => {
		let encoding: string | undefined;
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (_body, requestEncoding) => {
				encoding = requestEncoding;
				const chunks = ["A", "B", "C"].map(
					(content) =>
						`data: ${JSON.stringify({
							id: "chatcmpl-plain",
							object: "chat.completion.chunk",
							created: 0,
							model: "test-model",
							choices: [{ index: 0, delta: { content }, finish_reason: null }],
						})}\n\n`,
				);
				chunks.push(
					`data: ${JSON.stringify({
						id: "chatcmpl-plain",
						object: "chat.completion.chunk",
						created: 0,
						model: "test-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n`,
					"data: [DONE]\n\n",
				);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(chunks.join(""));
			}),
		);
		const port = await listening(server);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: `https://127.0.0.1:${port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const events = await collect(
			streamOpenAICompletions(
				model,
				normalizeContext({ messages: [{ role: "user", content: "x".repeat(2048), timestamp: 1 }] }),
				{ apiKey: "test-key", headers: { "x-pi-http-compression": "off" } },
			),
		);

		expect(encoding ?? "").toBe("");
		expect(deltas(events)).toEqual(["A", "B", "C"]);
		expect(events.at(-1)?.type).toBe("done");

		await closeProviderFetch();
		await closing(server);
	});

	it("multiplexes concurrent Brotli SSE streams over one HTTP/2 session", async () => {
		const seen: Record<string, SeenRequest> = {};
		const starts: Record<string, number> = {};
		const ends: Record<string, number> = {};
		let sessions = 0;
		const streamIds = new Set<number>();
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) => {
			readBody(request, (body, encoding) => {
				const decodedBody = decoded(body, encoding);
				const label = decodedBody.toString().includes("oneone") ? "one" : "two";
				seen[label] = { version: request.httpVersion, encoding, decodedBytes: decodedBody.byteLength };
				starts[label] = Date.now();
				void (async () => {
					response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					for (const letter of ["A", "B", "C"]) {
						response.write(
							`data: ${JSON.stringify({
								id: `chatcmpl-${label}`,
								object: "chat.completion.chunk",
								created: 0,
								model: "test-model",
								choices: [{ index: 0, delta: { content: `${label}${letter}` }, finish_reason: null }],
							})}\n\n`,
						);
						await new Promise((resolve) => setTimeout(resolve, 40));
					}
					response.write(
						`data: ${JSON.stringify({
							id: `chatcmpl-${label}`,
							object: "chat.completion.chunk",
							created: 0,
							model: "test-model",
							choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							usage: { prompt_tokens: 1, completion_tokens: 3 },
						})}\n\n`,
					);
					response.write("data: [DONE]\n\n");
					ends[label] = Date.now();
					response.end();
				})();
			});
		});
		server.on("session", () => {
			sessions += 1;
		});
		server.on("stream", (stream) => {
			if (stream.id !== undefined) streamIds.add(stream.id);
		});
		const port = await listening(server);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: `https://127.0.0.1:${port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const context = (label: string) =>
			normalizeContext({
				messages: [{ role: "user", content: label.repeat(2048), timestamp: 1 }],
			});
		const [one, two] = await Promise.all([
			collect(streamOpenAICompletions(model, context("one"), { apiKey: "test-key" })),
			collect(streamOpenAICompletions(model, context("two"), { apiKey: "test-key" })),
		]);

		expect(seen.one).toMatchObject({ version: "2.0", encoding: "br" });
		expect(seen.two).toMatchObject({ version: "2.0", encoding: "br" });
		expect(deltas(one)).toEqual(["oneA", "oneB", "oneC"]);
		expect(deltas(two)).toEqual(["twoA", "twoB", "twoC"]);
		expect(sessions).toBe(1);
		expect(streamIds.size).toBe(2);
		expect(Math.max(starts.one, starts.two)).toBeLessThan(Math.min(ends.one, ends.two));

		await closeProviderFetch();
		await closing(server);
	});

	it("uses the fetch installed by the host", () => {
		const custom = (() => Promise.resolve(new Response("ok"))) as typeof globalThis.fetch;
		setProviderFetch(custom);
		try {
			expect(providerFetch(true)).toBe(custom);
		} finally {
			setProviderFetch(undefined);
		}
	});

	it("does not replace a fetch installed by the host", () => {
		const original = globalThis.fetch;
		const custom = (() => Promise.resolve(new Response("ok"))) as typeof globalThis.fetch;
		globalThis.fetch = custom;
		try {
			expect(providerFetch(true)).toBe(custom);
		} finally {
			globalThis.fetch = original;
		}
	});

	it("streams only incremental text deltas over the automatic transport", async () => {
		let seen: SeenRequest | undefined;
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: true }, (request, response) =>
			readBody(request, (body, encoding) => {
				seen = { version: request.httpVersion, encoding, decodedBytes: decoded(body, encoding).byteLength };
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				for (const content of ["A", "B", "C"]) {
					response.write(
						`data: ${JSON.stringify({
							id: "chatcmpl-test",
							object: "chat.completion.chunk",
							created: 0,
							model: "test-model",
							choices: [{ index: 0, delta: { content }, finish_reason: null }],
						})}\n\n`,
					);
				}
				response.write(
					`data: ${JSON.stringify({
						id: "chatcmpl-test",
						object: "chat.completion.chunk",
						created: 0,
						model: "test-model",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 3 },
					})}\n\n`,
				);
				response.write("data: [DONE]\n\n");
				response.end();
			}),
		);
		const port = await listening(server);
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: `https://127.0.0.1:${port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4_096,
		};
		const events: AssistantMessageEvent[] = [];
		for await (const event of streamOpenAICompletions(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "x".repeat(2048), timestamp: 1 }],
			}),
			{ apiKey: "test-key" },
		)) {
			events.push(event);
		}

		expect(seen).toMatchObject({ version: "2.0", encoding: "br" });
		expect(seen?.decodedBytes).toBeGreaterThan(2048);
		const deltas = events
			.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta",
			)
			.map((event) => event.delta);
		expect(deltas).toEqual(["A", "B", "C"]);
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.message.content.find((block) => block.type === "text")).toMatchObject({
				type: "text",
				text: "ABC",
			});
		}

		await closeProviderFetch();
		await closing(server);
	});

	it.each([400, 415])("falls back from Brotli to zstd to gzip on %i", async (status) => {
		const encodings: string[] = [];
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: true }, (request, response) =>
			readBody(request, (_body, encoding) => {
				encodings.push(encoding);
				if (encoding === "br" || encoding === "zstd") {
					response.statusCode = status;
					response.end("unsupported media type");
					return;
				}
				response.end("ok");
			}),
		);
		const port = await listening(server);
		const payload = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] });

		const response = await providerFetch(true)(`https://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: payload,
		});
		expect(await response.text()).toBe("ok");
		expect(encodings).toEqual(["br", "zstd", "gzip"]);

		await closeProviderFetch();
		await closing(server);
	});

	it("falls back to no compression when Brotli, zstd, and gzip are rejected", async () => {
		const encodings: string[] = [];
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: true }, (request, response) =>
			readBody(request, (_body, encoding) => {
				encodings.push(encoding);
				if (encoding === "br" || encoding === "zstd" || encoding === "gzip") {
					response.statusCode = 400;
					response.end("cannot decode");
					return;
				}
				response.end("ok");
			}),
		);
		const port = await listening(server);

		const response = await providerFetch(true)(`https://127.0.0.1:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] }),
		});
		expect(await response.text()).toBe("ok");
		expect(encodings).toEqual(["br", "zstd", "gzip", ""]);

		await closeProviderFetch();
		await closing(server);
	});

	it("remembers Brotli and zstd rejection and reuses gzip on the same HTTP/2 session", async () => {
		const encodings: string[] = [];
		let sessions = 0;
		const streamIds = new Set<number>();
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (_body, encoding) => {
				encodings.push(encoding);
				if (encoding === "br" || encoding === "zstd") {
					response.statusCode = 400;
					response.end("unsupported media type");
					return;
				}
				response.end("ok");
			}),
		);
		server.on("session", () => {
			sessions += 1;
		});
		server.on("stream", (stream) => {
			if (stream.id !== undefined) streamIds.add(stream.id);
		});
		const port = await listening(server);
		const fetch = providerFetch(true);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await fetch(`https://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] }),
			});
			expect(response.status).toBe(200);
			await response.text();
		}

		expect(encodings).toEqual(["br", "zstd", "gzip", "gzip"]);
		expect(sessions).toBe(1);
		expect(streamIds.size).toBe(4);

		await closeProviderFetch();
		await closing(server);
	});

	it("remembers no compression after Brotli, zstd, and gzip are all rejected", async () => {
		const encodings: string[] = [];
		let sessions = 0;
		const streamIds = new Set<number>();
		const server = http2.createSecureServer({ key: TLS_KEY, cert: TLS_CERT }, (request, response) =>
			readBody(request, (_body, encoding) => {
				encodings.push(encoding);
				if (encoding === "br" || encoding === "zstd" || encoding === "gzip") {
					response.statusCode = 400;
					response.end("cannot decode");
					return;
				}
				response.end("ok");
			}),
		);
		server.on("session", () => {
			sessions += 1;
		});
		server.on("stream", (stream) => {
			if (stream.id !== undefined) streamIds.add(stream.id);
		});
		const port = await listening(server);
		const fetch = providerFetch(true);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await fetch(`https://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2048) }] }),
			});
			expect(response.status).toBe(200);
			await response.text();
		}

		expect(encodings).toEqual(["br", "zstd", "gzip", "", ""]);
		expect(sessions).toBe(1);
		expect(streamIds.size).toBe(5);

		await closeProviderFetch();
		await closing(server);
	});
});

/** Binds `server` on a loopback port and returns the real port. */
async function listening(server: TestServer): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Server did not bind to a TCP port");
	return address.port;
}

/** Closes `server` once its connections are gone. */
async function closing(server: TestServer): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Buffers `request` and hands the raw body and its content encoding to `handle`. */
function readBody(
	request: http.IncomingMessage | http2.Http2ServerRequest,
	handle: (body: Buffer, encoding: string) => void,
): void {
	const chunks: Buffer[] = [];
	request.on("data", (chunk: Buffer) => chunks.push(chunk));
	request.on("end", () => handle(Buffer.concat(chunks), request.headers["content-encoding"] ?? ""));
}

/** The bytes a request carried, before any transfer encoding in the test's own helper. */
function decoded(body: Buffer, encoding: string): Buffer {
	if (encoding === "br") return brotliDecompressSync(body);
	if (encoding === "gzip") return gunzipSync(body);
	if (encoding === "zstd") return zstdDecompressSync(body);
	return body;
}

/** Drains an assistant event stream into an array for assertions. */
async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** The text carried by each incremental text event. */
function deltas(events: AssistantMessageEvent[]): string[] {
	return events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta")
		.map((event) => event.delta);
}
