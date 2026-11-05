// The server's optional HTTP/2 cleartext listener and gzip answers: the same routes over h2c on their own port, and a
// compressible page that arrives gzipped when the client asks for it.
import assert from "node:assert/strict";
import { type IncomingHttpHeaders, request } from "node:http";
import { type ClientHttp2Session, connect } from "node:http2";
import { after, before, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { type Fixture, startFixture, webBundle } from "./helpers.ts";

/** `GET path` over HTTP/1.1, collecting the body as bytes (no decompression). */
function rawGet(
	port: number,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: Buffer; readonly headers: IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const outgoing = request({ host: "127.0.0.1", port, path, headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () =>
				resolve({
					status: response.statusCode ?? 0,
					body: Buffer.concat(chunks),
					headers: response.headers,
				}),
			);
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

describe("http2 and compression", () => {
	let fixture: Fixture;
	before(async () => {
		fixture = await startFixture({ web: true, h2cPort: 0 });
	});
	after(async () => {
		await fixture?.close();
	});

	it("serves the routes over HTTP/2 cleartext on the configured port", async () => {
		const h2cPort = fixture.server.h2cPort;
		assert.notEqual(h2cPort, undefined);
		const session: ClientHttp2Session = connect(`http://127.0.0.1:${h2cPort}`);
		try {
			const response = await new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
				const outgoing = session.request({
					":path": "/health",
					":method": "GET",
					":authority": `127.0.0.1:${h2cPort}`,
				});
				let status = 0;
				let body = "";
				outgoing.setEncoding("utf8");
				outgoing.on("response", (headers) => {
					status = Number(headers[":status"]);
				});
				outgoing.on("data", (chunk: string) => {
					body += chunk;
				});
				outgoing.on("end", () => resolve({ status, body }));
				outgoing.on("error", reject);
			});
			assert.equal(response.status, 200);
			assert.deepEqual(JSON.parse(response.body), { ok: true, name: "p2" });
		} finally {
			session.close();
		}
	});

	it("gzips a compressible answer when the client accepts gzip", async () => {
		const bundle = await webBundle(fixture.server.port);
		const script = await rawGet(fixture.server.port, bundle.script, { "accept-encoding": "gzip" });
		assert.equal(script.status, 200);
		assert.equal(script.headers["content-encoding"], "gzip");
		assert(gunzipSync(script.body).length > 1024);

		const plain = await rawGet(fixture.server.port, bundle.script);
		assert.equal(plain.headers["content-encoding"], undefined);
		assert.equal(plain.body.length, gunzipSync(script.body).length);
	});
});
