import { EventEmitter } from "node:events";
import * as undici from "undici";

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

/**
 * Keeps an undici dispatcher's internal "error" event from crashing the process: a mid-stream body failure still
 * rejects through the reader, this listener only handles EventEmitter's unhandled "error" special case.
 */
export function quiet<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

/** One quiet Client for `origin`; the base factory of the HTTP/1.1 and HTTP/2 dispatchers both use it. */
export function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return quiet(new undici.Client(origin, options as undici.Client.Options));
}

/** A quiet Client for a single connection, or a Pool of them, for `origin`. */
export function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return quiet(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}
