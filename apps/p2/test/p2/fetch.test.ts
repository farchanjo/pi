import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createH2cServer, createSecureServer } from "node:http2";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { closeFetch, configureFetch } from "../../src/runtime/fetch.ts";

// Throwaway self-signed localhost certificate (valid until 2126) for this test only; not a credential.
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgshDH8NMKiDy0wD1R
7GaTil/WSPM33JaTUG0PcH6z6B+hRANCAASX9LpbABv42+5mEc8Q2NTht6C2YPhi
s25xsxHZ5rciQS1CXAMfppSRjq9ycsnZjBD9oxy/zxRXkUzrjo0uYzLr
-----END PRIVATE KEY-----`;
const cert = `-----BEGIN CERTIFICATE-----
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

// Node 26's bundled fetch negotiates HTTP/2 via ALPN; configureFetch must stay on HTTP/1.1 and still decompress.
test("configureFetch installs an HTTP/1.1 fetch that decodes compressed responses", async (t) => {
	const server = createSecureServer({ key, cert, allowHTTP1: true }, (request, response) => {
		response.setHeader("x-http-version", request.httpVersion);
		response.setHeader("content-encoding", "gzip");
		response.end(gzipSync(`hello ${request.url}`));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	t.after(async () => {
		if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
		server.close();
		await once(server, "close");
	});
	const bundled = globalThis.fetch;
	configureFetch();
	assert.notEqual(globalThis.fetch, bundled);
	const { port } = server.address() as AddressInfo;
	for (const path of ["/a", "/b"]) {
		const response = await fetch(`https://localhost:${port}${path}`);
		assert.equal(response.headers.get("x-http-version"), "1.1");
		assert.equal(await response.text(), `hello ${path}`);
	}
});

test("configureFetch negotiates HTTP/2 over TLS when enabled", async (t) => {
	const server = createSecureServer({ key, cert, allowHTTP1: true }, (request, response) => {
		response.setHeader("x-http-version", request.httpVersion);
		response.end("tls");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
	t.after(async () => {
		await closeFetch();
		if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
		server.close();
		await once(server, "close");
	});
	configureFetch({ http2: true });
	const { port } = server.address() as AddressInfo;
	const response = await fetch(`https://localhost:${port}/`);
	assert.equal(response.headers.get("x-http-version"), "2.0");
	assert.equal(await response.text(), "tls");
});

test("configureFetch uses h2c for plaintext origins that answer HTTP/2", async (t) => {
	const server = createH2cServer((request, response) => {
		response.setHeader("x-http-version", request.httpVersion);
		response.end("h2c");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await closeFetch();
		server.close();
		await once(server, "close");
	});
	configureFetch({ http2: true });
	const { port } = server.address() as AddressInfo;
	const response = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(response.headers.get("x-http-version"), "2.0");
	assert.equal(await response.text(), "h2c");
});

test("configureFetch keeps HTTP/1.1 connections alive for reuse", async (t) => {
	const sockets = new Set<unknown>();
	const server = createServer((request, response) => {
		sockets.add(request.socket);
		response.end("ok");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await closeFetch();
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	});
	configureFetch({ keepAliveTimeoutMs: 30_000 });
	const { port } = server.address() as AddressInfo;
	assert.equal(await fetch(`http://127.0.0.1:${port}/a`).then((r) => r.text()), "ok");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(await fetch(`http://127.0.0.1:${port}/b`).then((r) => r.text()), "ok");
	assert.equal(sockets.size, 1);
});

test("configureFetch gzip-compresses request bodies above a threshold", async (t) => {
	const received: { encoding: string | undefined; body: string }[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const raw = Buffer.concat(chunks);
			const encoding = request.headers["content-encoding"];
			received.push({ encoding, body: (encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8") });
			response.end("ok");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		await closeFetch();
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	});
	configureFetch({ requestGzip: true });
	const { port } = server.address() as AddressInfo;
	const large = "a".repeat(4096);
	assert.equal(await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: large }).then((r) => r.text()), "ok");
	assert.equal(
		await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "small" }).then((r) => r.text()),
		"ok",
	);
	assert.deepEqual(received, [
		{ encoding: "gzip", body: large },
		{ encoding: undefined, body: "small" },
	]);
});
