import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const build = require("../scripts/cliproxyapi-build.cjs") as typeof import("../scripts/cliproxyapi-build.cjs");

const root = resolve(import.meta.dir, "..");
// Assembled at runtime so that this file never contains a literal the guard would reject.
const fakeSecret = ["GOCSPX", "Z".repeat(28)].join("-");
const fakeClientId = `${"1".repeat(12)}-${"a".repeat(32)}.apps.${"googleusercontent"}.com`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "cliproxyapi-build-test-"));
}

function response(body: string | Buffer, status = 200): Response {
  return new Response(typeof body === "string" ? body : new Uint8Array(body), { status });
}

describe("CLIProxyAPI build inputs", () => {
  test("the cache lives in the per-user cache folder of each platform", () => {
    expect(build.cacheRoot({}, "darwin", "/Users/a")).toBe("/Users/a/Library/Caches/codex-superpower");
    expect(build.cacheRoot({ XDG_CACHE_HOME: "/x" }, "linux", "/home/a")).toBe("/x/codex-superpower");
    expect(build.cacheRoot({}, "linux", "/home/a")).toBe("/home/a/.cache/codex-superpower");
    expect(build.cacheRoot({ CODEX_SUPERPOWER_CACHE: "/ci/cache" }, "darwin", "/Users/a")).toBe("/ci/cache");
  });

  test("the pins name official sources with SHA-256 checksums", () => {
    const manifest = build.MANIFEST;
    expect(manifest.go.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const archive of Object.values(manifest.go.archives) as Array<{ file: string; sha256: string }>) {
      expect(archive.file).toStartWith(`go${manifest.go.version}.`);
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.antigravityClient.repository).toBe("router-for-me/CLIProxyAPI");
    expect(manifest.antigravityClient.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.antigravityClient.sha256).toMatch(/^[0-9a-f]{64}$/);
    const goMod = readFileSync(join(root, "cliproxyapi", "go.mod"), "utf8");
    const required = /^go\s+(\d+)\.(\d+)/m.exec(goMod)!;
    const pinned = manifest.go.version.split(".").map(Number);
    expect(pinned[0] * 1000 + pinned[1]).toBeGreaterThanOrEqual(Number(required[1]) * 1000 + Number(required[2]));
  });

  test("the Antigravity client is read from the pinned upstream file, cached privately, and never refetched", async () => {
    const cache = scratch();
    try {
      const source = `package antigravity\n\nconst (\n\tClientID     = "${fakeClientId}"\n\tClientSecret = "${fakeSecret}"\n\tCallbackPort = 51121\n)\n`;
      const pinned = { ...build.MANIFEST.antigravityClient };
      const original = build.MANIFEST.antigravityClient.sha256;
      build.MANIFEST.antigravityClient.sha256 = createHash("sha256").update(source).digest("hex");
      try {
        const urls: string[] = [];
        const fetchImpl = async (url: string) => { urls.push(url); return response(source); };
        const client = await build.antigravityClient({ fetchImpl, cache });
        expect(client).toEqual({ clientId: fakeClientId, clientSecret: fakeSecret });
        expect(urls).toEqual([`https://raw.githubusercontent.com/${pinned.repository}/${pinned.commit}/${pinned.path}`]);
        const cached = join(cache, `antigravity-client-${build.MANIFEST.antigravityClient.sha256.slice(0, 16)}.json`);
        expect(statSync(cached).mode & 0o777).toBe(0o600);
        expect(await build.antigravityClient({ fetchImpl: async () => { throw new Error("no network"); }, cache })).toEqual(client);
        expect(build.antigravityLdflags(client)).toBe(
          `-X ${build.ANTIGRAVITY_PACKAGE}.ClientID=${fakeClientId} -X ${build.ANTIGRAVITY_PACKAGE}.ClientSecret=${fakeSecret}`,
        );
      } finally {
        build.MANIFEST.antigravityClient.sha256 = original;
      }
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  test("a changed upstream file is refused, and only network failures are transient", async () => {
    const cache = scratch();
    try {
      await expect(build.antigravityClient({ fetchImpl: async () => response("tampered"), cache }))
        .rejects.toThrow(/does not match its pinned SHA-256/);
      await expect(build.antigravityClient({ fetchImpl: async () => { throw new TypeError("fetch failed"); }, cache }))
        .rejects.toThrow(/^\[transient\] could not download the upstream Antigravity client: fetch failed/);
      await expect(build.antigravityClient({ fetchImpl: async () => response("", 503), cache }))
        .rejects.toThrow(/^\[transient\].*HTTP 503/);
      await expect(build.antigravityClient({ fetchImpl: async () => response("", 404), cache }))
        .rejects.toThrow(/^could not download.*HTTP 404/);
      expect(() => build.parseAntigravityClient("package antigravity\n")).toThrow(/does not declare/);
      expect(() => build.antigravityLdflags({ clientId: "x -X main.Version=evil", clientSecret: "s" })).toThrow(/unexpected characters/);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  test("the pinned Go download is verified before it is unpacked, and an override must be a working Go", async () => {
    const cache = scratch();
    try {
      await expect(build.ensureGo({ env: {}, platform: "darwin", arch: "arm64", cache, fetchImpl: async () => response("not go") }))
        .rejects.toThrow(/does not match its pinned SHA-256/);
      expect(existsSync(join(cache, "toolchains", `go${build.MANIFEST.go.version}`))).toBe(false);
      await expect(build.ensureGo({ env: {}, platform: "aix", arch: "ppc64", cache })).rejects.toThrow(/No pinned Go toolchain for aix-ppc64/);
      const fakeGo = join(cache, "go");
      writeFileSync(fakeGo, "#!/bin/sh\necho 'go version go1.26.3 darwin/arm64'\n");
      chmodSync(fakeGo, 0o755);
      expect(await build.ensureGo({ env: { CODEX_SUPERPOWER_GO: fakeGo }, cache })).toEqual({ go: fakeGo, version: "1.26.3", source: "override", cache });
      await expect(build.ensureGo({ env: { CODEX_SUPERPOWER_GO: join(cache, "missing") }, cache })).rejects.toThrow(/is not a working Go toolchain/);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  test("go commands use only the local toolchain, the pinned modules and private caches", () => {
    const env = build.goEnv("/c", { PATH: "/bin" });
    expect(env).toMatchObject({ PATH: "/bin", GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly", GOPATH: "/c/gopath", GOMODCACHE: "/c/gomod", GOCACHE: "/c/gobuild" });
  });

  test("the guard finds an embedded OAuth client, and cliproxyapi/ has none", () => {
    const tree = scratch();
    try {
      mkdirSync(join(tree, "internal"), { recursive: true });
      writeFileSync(join(tree, "internal", "ok.go"), "package x\nvar ClientID string\n");
      writeFileSync(join(tree, "internal", "bad.go"), `package x\nconst s = "${fakeSecret}"\n`);
      expect(build.embeddedClientLiterals(tree)).toEqual([join("internal", "bad.go")]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
    expect(build.embeddedClientLiterals(join(root, "cliproxyapi"))).toEqual([]);
  });
});
