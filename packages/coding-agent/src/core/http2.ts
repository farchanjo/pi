// HTTP/2 for the global fetch stack: TLS origins negotiate it through ALPN (the server falls back to HTTP/1.1 itself),
// and plaintext origins are probed once for h2c before they are used. Undici's h2c option has no fallback, so a request
// never guesses: an origin that does not answer the probe stays on HTTP/1.1, and a verdict is cached per origin.

import { connect } from "node:http2";
import * as undici from "undici";
import { quiet } from "./http-transport.ts";

/** The h2c Client class of npm undici; a runtime with a minimal undici (Bun builtin) may not export it. */
type H2cClientConstructor = new (
	origin: string,
	options: NonNullable<ConstructorParameters<typeof undici.Client>[1]>,
) => undici.Dispatcher;

const H2CClient: H2cClientConstructor | undefined = (undici as unknown as { readonly H2CClient?: H2cClientConstructor })
	.H2CClient;

/** Whether this runtime can open HTTP/2 clients; the standalone build bundles npm undici, so it can. */
export const supportsHttp2 = H2CClient !== undefined;

/** How long a plaintext origin has to answer the probe's HTTP/2 preface. */
const PROBE_TIMEOUT_MS = 2_000;
/** How long a negative verdict stands before the origin is probed again (a gateway may start later). */
const NEGATIVE_TTL_MS = 30_000;

export type Http2Options = {
	/** Header timeout in milliseconds; 0 disables it, like the base dispatcher. */
	readonly headersTimeout: number;
	/** Body timeout in milliseconds; 0 disables it, like the base dispatcher. */
	readonly bodyTimeout: number;
	/** How long an idle HTTP/2 session stays open for reuse. */
	readonly keepAliveTimeout: number;
	/** How long one address-family attempt may take (Node's 250 ms default is short for high-latency routes). */
	readonly autoSelectFamilyAttemptTimeout: number;
};

/** What the probe decided for one origin, and when. */
type Verdict = { readonly h2c: boolean; readonly at: number };

/**
 * The h2c side of the fetch stack: per-origin verdicts and Clients. An origin that speaks h2c gets its own Client, so
 * HTTP/2 streams multiplex there; every other origin is left to the caller's dispatcher.
 */
export class Http2Origins {
	readonly #options: Http2Options;
	readonly #verdicts = new Map<string, Verdict>();
	readonly #probes = new Map<string, Promise<boolean>>();
	readonly #clients = new Map<string, undici.Dispatcher>();

	constructor(options: Http2Options) {
		this.#options = options;
	}

	/**
	 * The dispatcher for `url`: an h2c Client when a plaintext origin answers HTTP/2 and no HTTP proxy applies,
	 * otherwise `undefined` (the caller's HTTP/1.1 dispatcher, which also negotiates HTTP/2 over TLS).
	 */
	async dispatcherFor(url: URL): Promise<undici.Dispatcher | undefined> {
		if (url.protocol !== "http:" || httpProxyApplies(url)) return undefined;
		if (!(await this.#speaksH2c(url.origin))) return undefined;
		return this.#client(url.origin);
	}

	/** Closes every h2c Client; the origin may open new ones afterwards. */
	async close(): Promise<void> {
		const clients = [...this.#clients.values()];
		this.#clients.clear();
		this.#verdicts.clear();
		await Promise.allSettled(clients.map((client) => client.close()));
	}

	/** Whether `origin` speaks h2c, probing at most once per verdict and retrying negative verdicts after a while. */
	async #speaksH2c(origin: string): Promise<boolean> {
		const verdict = this.#verdicts.get(origin);
		if (verdict !== undefined && (verdict.h2c || Date.now() - verdict.at < NEGATIVE_TTL_MS)) return verdict.h2c;
		let probe = this.#probes.get(origin);
		if (probe === undefined) {
			probe = probeH2c(origin).then((h2c) => {
				this.#verdicts.set(origin, { h2c, at: Date.now() });
				this.#probes.delete(origin);
				return h2c;
			});
			this.#probes.set(origin, probe);
		}
		return probe;
	}

	/** The h2c Client of `origin`, made on first use with the dispatcher's timeouts. */
	#client(origin: string): undici.Dispatcher {
		let client = this.#clients.get(origin);
		if (client === undefined) {
			if (H2CClient === undefined) {
				throw new Error("HTTP/2 is not available in this runtime");
			}
			client = quiet(
				new H2CClient(origin, {
					headersTimeout: this.#options.headersTimeout,
					bodyTimeout: this.#options.bodyTimeout,
					keepAliveTimeout: this.#options.keepAliveTimeout,
					autoSelectFamilyAttemptTimeout: this.#options.autoSelectFamilyAttemptTimeout,
				}),
			);
			this.#clients.set(origin, client);
		}
		return client;
	}
}

/**
 * Whether `origin` answers the HTTP/2 preface with its SETTINGS frame. A server that speaks only HTTP/1.1 answers the
 * preface with an HTTP/1.1 error or closes, both of which make Node's client emit `error` or `close`.
 */
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

/**
 * Whether the HTTP proxy of the environment applies to `url`, in which case h2c is not attempted: a CONNECT tunnel
 * carries the origin's bytes, but undici 8.12 does not mark that socket as HTTP/2, so forcing h2c would fail.
 */
function httpProxyApplies(url: URL): boolean {
	const proxy = process.env.http_proxy || process.env.HTTP_PROXY;
	if (!proxy) return false;
	const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
	return !noProxyMatches(url.hostname, url.port === "" ? 80 : Number(url.port), noProxy);
}

/**
 * Whether `NO_PROXY` lists `hostname:port`: the same rules undici's proxy agent applies (a bare `*`, an optional port,
 * a wildcard `*.domain` for subdomains only, and a plain or leading-dot domain for the apex and its subdomains).
 */
export function noProxyMatches(hostname: string, port: number, noProxy: string): boolean {
	const host = hostname
		.replace(/^\[(.+)\]$/, "$1")
		.toLowerCase()
		.replace(/^(.+)\.$/, "$1");
	for (const raw of noProxy.split(/[,\s]/)) {
		const entry = raw.trim();
		if (entry === "") continue;
		const parsed = noProxyEntry(entry);
		if (parsed.hostname === "*") {
			if (parsed.port !== 0 && parsed.port !== port) continue;
			return true;
		}
		if (parsed.port !== 0 && parsed.port !== port) continue;
		if (!parsed.wildcard && host === parsed.hostname) return true;
		if (host.slice(-(parsed.hostname.length + 1)) === `.${parsed.hostname}`) return true;
	}
	return false;
}

/** One `NO_PROXY` entry: its hostname, port (0 when none) and whether a leading `*` makes it subdomain-only. */
function noProxyEntry(entry: string): { readonly hostname: string; readonly port: number; readonly wildcard: boolean } {
	const bracketed = /^\[(.+)\]:(\d+)$/.exec(entry);
	if (bracketed !== null) {
		return {
			hostname: bracketed[1]!.toLowerCase(),
			port: Number(bracketed[2]),
			wildcard: entry.charCodeAt(0) === 42,
		};
	}
	const unbracketed = entry.replace(/^\[(.+)\]$/, "$1");
	const colon = unbracketed.indexOf(":");
	const parsed =
		colon > 0 && colon === unbracketed.lastIndexOf(":") && /^\d+$/.test(unbracketed.slice(colon + 1))
			? { hostname: unbracketed.slice(0, colon), port: Number(unbracketed.slice(colon + 1)) }
			: { hostname: unbracketed, port: 0 };
	return {
		hostname: parsed.hostname
			.replace(/^\*?\./, "")
			.replace(/^(.+)\.$/, "$1")
			.toLowerCase(),
		port: parsed.port,
		wildcard: entry.charCodeAt(0) === 42,
	};
}
