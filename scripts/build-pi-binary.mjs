#!/usr/bin/env bun
// Builds pi's standalone executable. Bun resolves `import ... from "undici"` to its own undici shim, which has no
// H2CClient (and therefore no HTTP/2); the app is built against npm undici, so rewrite those import specifiers to the
// installed package before Bun bundles them. Everything else stays exactly as the previous `bun build --compile`.

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const args = process.argv.slice(2);

/** `--outfile <path>` picks the executable path; `--target bun-<platform>` cross-compiles like `bun build --compile`. */
let outfile = join(codingAgentDir, "dist", "pi");
let compileTarget;
for (let index = 0; index < args.length; index += 1) {
	const arg = args[index];
	if (arg === "--outfile") {
		const value = args[++index];
		if (value === undefined) throw new Error("--outfile needs a path");
		outfile = resolve(process.cwd(), value);
	} else if (arg === "--target") {
		const value = args[++index];
		if (value === undefined) throw new Error("--target needs a Bun target");
		compileTarget = value;
	} else {
		throw new Error(`Unknown argument: ${arg}`);
	}
}
const undiciPath = [
	join(repoRoot, "node_modules", "undici", "index.js"),
	join(codingAgentDir, "node_modules", "undici", "index.js"),
].find((path) => existsSync(path));
if (undiciPath === undefined) {
	throw new Error("undici is not installed; run npm install before building the standalone binary");
}
const undiciSpecifier = JSON.stringify(undiciPath);
const localPrefix = repoRoot + sep;
const nodeModulesSegment = `${sep}node_modules${sep}`;

/** Rewrites the bare `undici` import/require in app sources; Bun resolves it to its shim before any plugin can. */
const npmUndiciPlugin = {
	name: "npm-undici",
	setup(build) {
		build.onLoad({ filter: /\.(js|ts)$/ }, async (args) => {
			if (!args.path.startsWith(localPrefix) || args.path.includes(nodeModulesSegment)) return undefined;
			const source = await Bun.file(args.path).text();
			if (!source.includes("undici")) return undefined;
			const contents = source
				.replace(/(\bfrom\s*)(["'])undici\2/g, `$1${undiciSpecifier}`)
				.replace(/(\brequire\(\s*)(["'])undici\2(\s*\))/g, `$1${undiciSpecifier}$3`)
				.replace(/(\bimport\(\s*)(["'])undici\2(\s*\))/g, `$1${undiciSpecifier}$3`);
			return { contents, loader: args.path.endsWith(".ts") ? "ts" : "js" };
		});
	},
};

const result = await Bun.build({
	entrypoints: [
		join(codingAgentDir, "dist", "bun", "cli.js"),
		join(codingAgentDir, "src", "utils", "image-resize-worker.ts"),
		join(codingAgentDir, "src", "extensions", "codemode", "worker.ts"),
	],
	target: "bun",
	minify: true,
	plugins: [npmUndiciPlugin],
	compile: {
		outfile,
		...(compileTarget === undefined ? {} : { target: compileTarget }),
		autoloadBunfig: false,
		autoloadDotenv: false,
	},
});

if (!result.success) {
	for (const log of result.logs) console.error(log.level, log.message);
	throw new Error("Bun build failed");
}
