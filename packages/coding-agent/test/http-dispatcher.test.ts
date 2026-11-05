import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync, zstdCompressSync } from "node:zlib";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHttpProxySettings, closeHttpDispatcher, configureHttpDispatcher } from "../src/core/http-dispatcher.ts";
import { noProxyMatches } from "../src/core/http2.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY"] as const;
const DISPATCHER_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

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

/** Binds `server` on a loopback port and returns the real port. */
async function listening(server: http.Server | http2.Http2Server | http2.Http2SecureServer): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Server did not bind to a TCP port");
	return address.port;
}

/** Closes `server` once its connections are gone. */
async function closing(server: http.Server | http2.Http2Server | http2.Http2SecureServer): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("http proxy settings", () => {
	let savedEnv: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("applies httpProxy to HTTP_PROXY and HTTPS_PROXY", () => {
		applyHttpProxySettings("http://127.0.0.1:7890");

		expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
		expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("does not override existing proxy env vars", () => {
		process.env.HTTP_PROXY = "http://env-http:8080";
		process.env.HTTPS_PROXY = "http://env-https:8080";

		applyHttpProxySettings("http://settings:7890");

		expect(process.env.HTTP_PROXY).toBe("http://env-http:8080");
		expect(process.env.HTTPS_PROXY).toBe("http://env-https:8080");
	});

	it("ignores empty values", () => {
		applyHttpProxySettings("   ");

		expect(process.env.HTTP_PROXY).toBeUndefined();
		expect(process.env.HTTPS_PROXY).toBeUndefined();
	});
});

describe("http dispatcher", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedProxyEnv: Record<(typeof DISPATCHER_PROXY_ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		savedProxyEnv = Object.fromEntries(DISPATCHER_PROXY_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
			(typeof DISPATCHER_PROXY_ENV_KEYS)[number],
			string | undefined
		>;
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			delete process.env[key];
		}
	});

	afterEach(async () => {
		await closeHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of DISPATCHER_PROXY_ENV_KEYS) {
			const value = savedProxyEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("tunnels proxied HTTP origins", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") {
			throw new Error("Origin did not bind to a TCP port");
		}

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}

				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") {
			throw new Error("Proxy did not bind to a TCP port");
		}

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		const dispatcher = undici.getGlobalDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).not.toHaveLength(0);
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});

	it("allows two seconds for HTTPS connection attempts without changing the Node default", async () => {
		// Preserve a deliberate host fetch override while testing the dispatcher itself.
		globalThis.fetch = async () => {
			throw new Error("Unexpected global fetch");
		};
		const originalAttemptTimeoutMs = net.getDefaultAutoSelectFamilyAttemptTimeout();
		const connectSpy = vi.spyOn(tls, "connect").mockImplementation(() => {
			throw new Error("Connection captured");
		});

		configureHttpDispatcher();
		await expect(undici.fetch("https://example.invalid")).rejects.toThrow();

		expect(connectSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				autoSelectFamilyAttemptTimeout: 2_000,
			}),
		);
		expect(connectSpy.mock.calls[0]?.[0]).not.toHaveProperty("autoSelectFamily");
		expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(originalAttemptTimeoutMs);
	});

	it("negotiates HTTP/2 over TLS when enabled", async () => {
		const server = http2.createSecureServer(
			{ key: TLS_KEY, cert: TLS_CERT, allowHTTP1: true },
			(request, response) => {
				response.setHeader("x-http-version", request.httpVersion);
				response.end("tls");
			},
		);
		const port = await listening(server);
		const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		try {
			configureHttpDispatcher({ http2: true });
			const response = await fetch(`https://127.0.0.1:${port}/`);
			expect(await response.text()).toBe("tls");
			expect(response.headers.get("x-http-version")).toBe("2.0");
		} finally {
			if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
			else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
			await closing(server);
		}
	});

	it("uses h2c for plaintext origins that answer HTTP/2 and HTTP/1.1 for the rest", async () => {
		const versions: string[] = [];
		const h2c = http2.createServer((request, response) => {
			versions.push(request.httpVersion);
			response.end("h2c");
		});
		const h1 = http.createServer((request, response) => {
			versions.push(request.httpVersion);
			response.end("h1");
		});
		const h2cPort = await listening(h2c);
		const h1Port = await listening(h1);
		try {
			configureHttpDispatcher({ http2: true });
			await expect(fetch(`http://127.0.0.1:${h2cPort}/a`).then((response) => response.text())).resolves.toBe("h2c");
			await expect(fetch(`http://127.0.0.1:${h1Port}/b`).then((response) => response.text())).resolves.toBe("h1");
			await expect(fetch(`http://127.0.0.1:${h2cPort}/c`).then((response) => response.text())).resolves.toBe("h2c");
			expect(versions).toEqual(["2.0", "1.1", "2.0"]);
		} finally {
			await closeHttpDispatcher();
			await Promise.all([closing(h2c), closing(h1)]);
		}
	});

	it("decodes gzip responses over h2c", async () => {
		const server = http2.createServer((_request, response) => {
			response.setHeader("content-encoding", "gzip");
			response.end(gzipSync("compressed over h2c"));
		});
		const port = await listening(server);
		try {
			configureHttpDispatcher({ http2: true });
			await expect(fetch(`http://127.0.0.1:${port}/`).then((response) => response.text())).resolves.toBe(
				"compressed over h2c",
			);
		} finally {
			await closeHttpDispatcher();
			await closing(server);
		}
	});

	it("gzip-compresses request bodies above a threshold", async () => {
		const received: { encoding: string | undefined; body: string }[] = [];
		const server = http.createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const raw = Buffer.concat(chunks);
				const encoding = request.headers["content-encoding"];
				received.push({ encoding, body: (encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8") });
				response.end("ok");
			});
		});
		const port = await listening(server);
		try {
			configureHttpDispatcher({ requestGzip: true });
			const large = "a".repeat(4096);
			await expect(
				fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: large }).then((response) => response.text()),
			).resolves.toBe("ok");
			await expect(
				fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "small" }).then((response) => response.text()),
			).resolves.toBe("ok");
			expect(received).toEqual([
				{ encoding: "gzip", body: large },
				{ encoding: undefined, body: "small" },
			]);
		} finally {
			server.closeAllConnections();
			await closing(server);
		}
	});

	it("uses best-to-worst compression in auto mode", async () => {
		const received: { encoding: string | undefined; body: string }[] = [];
		const server = http.createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const raw = Buffer.concat(chunks);
				const encoding = request.headers["content-encoding"];
				const body = encoding === "br" ? brotliDecompressSync(raw) : raw;
				received.push({ encoding, body: body.toString("utf8") });
				response.end("ok");
			});
		});
		const port = await listening(server);
		try {
			configureHttpDispatcher({ requestCompression: "auto" });
			const large = "a".repeat(4096);
			await expect(
				fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: large }).then((response) => response.text()),
			).resolves.toBe("ok");
			expect(received).toEqual([{ encoding: "br", body: large }]);
		} finally {
			await closeHttpDispatcher();
			server.closeAllConnections();
			await closing(server);
		}
	});

	it.each([
		["br", ["br"]],
		["zstd", ["br", "zstd"]],
		["gzip", ["br", "zstd", "gzip"]],
	] as const)("streams deltas with %s request and response compression", async (encoding, expectedEncodings) => {
		const encodings: string[] = [];
		const server = http.createServer((request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const requestEncoding = request.headers["content-encoding"] ?? "";
				encodings.push(requestEncoding);
				if (requestEncoding !== encoding) {
					response.statusCode = 400;
					response.end("cannot decode");
					return;
				}
				const sse = ["A", "B", "C"]
					.map(
						(content) =>
							`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
					)
					.join("")
					.concat(
						`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
						"data: [DONE]\n\n",
					);
				const compressed =
					encoding === "br"
						? brotliCompressSync(sse)
						: encoding === "zstd"
							? zstdCompressSync(sse)
							: gzipSync(sse);
				response.writeHead(200, { "content-type": "text/event-stream", "content-encoding": encoding });
				response.end(compressed);
			});
		});
		const port = await listening(server);
		try {
			configureHttpDispatcher({ requestCompression: "auto", compressionLevel: "max" });
			const response = await fetch(`http://127.0.0.1:${port}/`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "x".repeat(2048),
			});
			expect(response.headers.get("content-encoding")).toBe(encoding);
			const text = await response.text();
			const deltas = text
				.split("\n")
				.filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
				.map((line) => JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] })
				.flatMap((event) => event.choices?.[0]?.delta?.content ?? []);
			expect(encodings).toEqual(expectedEncodings);
			expect(deltas).toEqual(["A", "B", "C"]);
		} finally {
			await closeHttpDispatcher();
			server.closeAllConnections();
			await closing(server);
		}
	});

	it("reinstalls the fetch wrapper after closeHttpDispatcher", async () => {
		let encoding: string | undefined;
		const server = http.createServer((request, response) => {
			encoding = request.headers["content-encoding"];
			request.resume();
			request.on("end", () => response.end("ok"));
		});
		const port = await listening(server);
		try {
			configureHttpDispatcher({ http2: true });
			await closeHttpDispatcher();
			configureHttpDispatcher({ requestGzip: true });
			const large = "a".repeat(4096);
			await expect(
				fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: large }).then((response) => response.text()),
			).resolves.toBe("ok");
			expect(encoding).toBe("gzip");
		} finally {
			server.closeAllConnections();
			await closing(server);
		}
	});

	it("reuses an idle HTTP/1.1 connection within its keep-alive timeout", async () => {
		const sockets = new Set<unknown>();
		const server = http.createServer((request, response) => {
			sockets.add(request.socket);
			response.end("ok");
		});
		const port = await listening(server);
		try {
			configureHttpDispatcher({ http2: true, keepAliveTimeoutMs: 30_000 });
			await expect(fetch(`http://127.0.0.1:${port}/a`).then((response) => response.text())).resolves.toBe("ok");
			// Undici releases a finished connection on a later tick; the next immediate fetch may race that pool.
			await new Promise((resolve) => setTimeout(resolve, 50));
			await expect(fetch(`http://127.0.0.1:${port}/b`).then((response) => response.text())).resolves.toBe("ok");
			expect(sockets.size).toBe(1);
		} finally {
			server.closeAllConnections();
			await closing(server);
		}
	});

	it("matches NO_PROXY entries like undici's proxy agent", () => {
		expect(noProxyMatches("localhost", 80, "localhost")).toBe(true);
		expect(noProxyMatches("api.localhost", 80, "*.localhost")).toBe(true);
		expect(noProxyMatches("localhost", 80, "*.localhost")).toBe(false);
		expect(noProxyMatches("example.com", 443, "example.com:443")).toBe(true);
		expect(noProxyMatches("example.com", 80, "example.com:443")).toBe(false);
		expect(noProxyMatches("example.com", 80, "other.com, .example.com")).toBe(true);
		expect(noProxyMatches("example.com", 80, "*")).toBe(true);
		expect(noProxyMatches("example.com", 80, "*:443")).toBe(false);
		expect(noProxyMatches("127.0.0.1", 80, "127.0.0.1")).toBe(true);
		expect(noProxyMatches("::1", 80, "[::1]")).toBe(true);
	});
});
