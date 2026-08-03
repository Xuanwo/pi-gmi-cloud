#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function fail(message) {
	console.error(`check-package: ${message}`);
	process.exit(1);
}

if (pkg.type !== "module") fail('package.json "type" must be "module"');
if (!pkg.engines?.node) fail('package.json missing "engines.node"');
if (!Array.isArray(pkg.files) || pkg.files.length === 0) fail('package.json missing "files"');
if (!pkg.pi?.extensions?.length) fail('package.json missing "pi.extensions"');
if (!pkg.peerDependencies?.["@earendil-works/pi-ai"]) {
	fail('package.json missing peerDependency "@earendil-works/pi-ai"');
}
if (!pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]) {
	fail('package.json missing peerDependency "@earendil-works/pi-coding-agent"');
}

const extensionEntries = pkg.pi.extensions;
for (const entry of extensionEntries) {
	if (typeof entry !== "string" || entry.includes("*") || entry.startsWith("!")) {
		// Keep the published entry explicit so helper modules under extensions/ are not loaded as providers.
		fail(`pi.extensions entry must be an explicit file path, got: ${entry}`);
	}
	if (!entry.endsWith("gmi-cloud.ts") && !entry.endsWith("gmi-cloud.js")) {
		fail(`unexpected pi.extensions entry: ${entry}`);
	}
}

const tempDir = mkdtempSync(join(tmpdir(), "pi-gmi-cloud-pack-"));
try {
	const packName = execFileSync("npm", ["pack", "--json", "--pack-destination", tempDir], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const packed = JSON.parse(packName);
	const filename = packed[0]?.filename;
	if (!filename) fail("npm pack did not return a filename");

	const tarball = join(tempDir, filename);
	const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^package\//, ""));

	const required = [
		"package.json",
		"README.md",
		"LICENSE",
		"extensions/gmi-cloud.ts",
		"extensions/gmi-catalog.ts",
	];
	for (const file of required) {
		if (!listing.includes(file)) fail(`packed tarball missing ${file}`);
	}

	const forbiddenPrefixes = ["tests/", "scripts/", "node_modules/", ".github/"];
	const forbiddenExact = ["tsconfig.json", "package-lock.json"];
	for (const file of listing) {
		if (forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
			fail(`packed tarball unexpectedly includes ${file}`);
		}
		if (forbiddenExact.includes(file)) {
			fail(`packed tarball unexpectedly includes ${file}`);
		}
	}

	execFileSync("tar", ["-xzf", tarball, "-C", tempDir]);
	const packedPkg = JSON.parse(readFileSync(join(tempDir, "package", "package.json"), "utf8"));
	if (!packedPkg.pi?.extensions?.includes("./extensions/gmi-cloud.ts")) {
		fail('packed package.json must declare pi.extensions ["./extensions/gmi-cloud.ts"]');
	}

	console.log(`check-package: ok (${listing.length} files in ${filename})`);
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}
