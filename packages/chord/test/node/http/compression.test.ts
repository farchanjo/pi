// Tests of Chord's answer compression: a compressible answer gains gzip when the client accepts it, keeps its bytes
// otherwise, and does not compress when the listener did not ask for it.

import { request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { contributing, served } from "./support.ts";

const page = `<p>${"x".repeat(4096)}</p>`;

const html = contributing({
	routes: {
		"GET /page": { public: true, handler: async () => ({ kind: "html", body: page }) },
	},
});

/** `GET /page` from the listener, with the given `Accept-Encoding` (none when undefined). */
async function get(
	port: number,
	acceptEncoding: string | undefined,
): Promise<{ readonly status: number; readonly encoding: string | undefined; readonly body: Buffer }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path: "/page",
				headers: {
					host: `127.0.0.1:${port}`,
					...(acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						encoding: response.headers["content-encoding"],
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		request.on("error", reject);
		request.end();
	});
}

describe("compression", () => {
	it("gzips a compressible answer when the client accepts gzip", async () => {
		const server = await served({ "@app/html": html }, { config: { compression: true } });
		try {
			const compressed = await get(server.port, "gzip");
			expect(compressed.status).toBe(200);
			expect(compressed.encoding).toBe("gzip");
			expect(gunzipSync(compressed.body).toString("utf8")).toBe(page);

			const plain = await get(server.port, undefined);
			expect(plain.encoding).toBeUndefined();
			expect(plain.body.toString("utf8")).toBe(page);
		} finally {
			await server.close();
		}
	});

	it("does not compress when the listener did not ask for it", async () => {
		const server = await served({ "@app/html": html });
		try {
			const response = await get(server.port, "gzip");
			expect(response.encoding).toBeUndefined();
			expect(response.body.toString("utf8")).toBe(page);
		} finally {
			await server.close();
		}
	});
});
