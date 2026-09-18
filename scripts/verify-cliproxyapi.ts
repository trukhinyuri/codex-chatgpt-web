// Builds and tests the CLIProxyAPI component in cliproxyapi/ with the pinned Go toolchain, which is
// downloaded from go.dev and verified on first use (scripts/cliproxyapi-build.cjs), so every Mac
// that updates itself runs the same checks as CI. It also refuses OAuth client secrets in the tree:
// they are fetched from upstream at build time instead.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { embeddedClientLiterals, ensureGo, goEnv } = require("./cliproxyapi-build.cjs") as typeof import("./cliproxyapi-build.cjs");

const root = resolve(import.meta.dir, "..");
const component = join(root, "cliproxyapi");

// Tests that depend on wall-clock timing or on the local network rather than on the code under test.
// Each one failed here only under load or without multicast, and passed on rerun.
export const FLAKY_GO_TESTS = [
  // WebRTC relay must create a DataChannel within 7 s; misses the deadline on a busy machine.
  "TestPionMediaRelayBridgesAudioAndDataChannel",
  // mDNS advertisement on the LAN; unavailable in sandboxes and on some networks.
  "TestAdvertiserAndBrowser_Integration",
];

export function requiredGoVersion(goMod: string): [number, number, number] {
  const match = /^go\s+(\d+)\.(\d+)(?:\.(\d+))?\s*$/m.exec(goMod);
  if (!match) throw new Error("cliproxyapi/go.mod does not declare a go version");
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function parseGoVersion(output: string): [number, number, number] | null {
  const match = /\bgo(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function atLeast(actual: [number, number, number], required: [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

let GO_ENV: Record<string, string | undefined> = process.env;

async function run(go: string, args: string[]): Promise<void> {
  const child = Bun.spawn([go, ...args], { cwd: component, env: GO_ENV, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`CLIProxyAPI check failed (${exitCode}): go ${args.join(" ")}`);
}

export interface GoTestFailures {
  /** Top-level test names that failed, by package. */
  tests: Map<string, Set<string>>;
  /** Packages that failed without a failing test: build errors, init panics. */
  packages: Set<string>;
}

/** Read `go test -json` output. Subtests roll up to their top-level test, which is what is rerun. */
export function goTestFailures(jsonLines: string): GoTestFailures {
  const tests = new Map<string, Set<string>>();
  const failedPackages = new Set<string>();
  for (const line of jsonLines.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { Action?: string; Package?: string; Test?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.Action !== "fail" || !event.Package) continue;
    if (event.Test) {
      const name = event.Test.split("/")[0]!;
      if (!tests.has(event.Package)) tests.set(event.Package, new Set());
      tests.get(event.Package)!.add(name);
    } else {
      failedPackages.add(event.Package);
    }
  }
  return { tests, packages: new Set([...failedPackages].filter(pkg => !tests.has(pkg))) };
}

/**
 * CLIProxyAPI's upstream does not run its tests in CI, and a few depend on timing or on global
 * state. Every failing test gets one rerun on its own; only a second failure fails the check, so a
 * real regression still blocks the update and a timing fluke does not.
 */
async function testWithOneRerun(go: string): Promise<void> {
  const child = Bun.spawn([go, "test", "-count=1", "-json", `-skip=^(${FLAKY_GO_TESTS.join("|")})$`, "./..."], {
    cwd: component, env: GO_ENV, stdin: "ignore", stdout: "pipe", stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  const failures = goTestFailures(output);
  if (exitCode === 0) return;
  // Show what failed, as plain go test output, so the update log carries the reason.
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { Action?: string; Package?: string; Test?: string; Output?: string };
      const failedTest = event.Test && failures.tests.get(event.Package ?? "")?.has(event.Test.split("/")[0]!);
      const failedPackage = !event.Test && event.Package && failures.packages.has(event.Package);
      if (event.Action === "output" && event.Output && (failedTest || failedPackage)) process.stdout.write(event.Output);
    } catch {}
  }
  if (failures.packages.size > 0) {
    throw new Error(`CLIProxyAPI packages failed to build or start: ${[...failures.packages].join(", ")}`);
  }
  if (failures.tests.size === 0) throw new Error(`go test exited with ${exitCode} without a failing test`);
  for (const [pkg, names] of failures.tests) {
    const pattern = `^(${[...names].join("|")})$`;
    console.log(`RERUN ${pkg} ${[...names].join(" ")}`);
    await run(go, ["test", "-count=1", "-run", pattern, pkg]);
    console.log(`FLAKY (passed on rerun): ${pkg} ${[...names].join(" ")}`);
  }
}

if (import.meta.main) {
  if (!existsSync(join(component, "go.mod"))) throw new Error("cliproxyapi/go.mod is missing");
  const literals = embeddedClientLiterals(component);
  if (literals.length > 0) {
    throw new Error(`cliproxyapi/ must not embed OAuth client secrets; fetch them at build time instead: ${literals.join(", ")}`);
  }
  const toolchain = await ensureGo({ log: console.log });
  const required = requiredGoVersion(readFileSync(join(component, "go.mod"), "utf8"));
  const actual = parseGoVersion(`go${toolchain.version}`);
  if (!actual || !atLeast(actual, required)) {
    throw new Error(`cliproxyapi/go.mod needs Go ${required.join(".")}; raise the toolchain pinned in scripts/cliproxyapi-build.json (now ${toolchain.version})`);
  }
  GO_ENV = goEnv(toolchain.cache);
  await run(toolchain.go, ["build", "./..."]);
  await testWithOneRerun(toolchain.go);
  console.log(`CLIPROXYAPI_VERIFY_OK go${toolchain.version}`);
}
