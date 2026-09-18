import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLAKY_GO_TESTS, atLeast, goTestFailures, looksLikeBuildFailure, parseGoVersion, requiredGoVersion } from "../scripts/verify-cliproxyapi";

const component = join(import.meta.dir, "..", "cliproxyapi");

describe("CLIProxyAPI verification", () => {
  test("reads the Go version the component requires", () => {
    expect(requiredGoVersion("module x\n\ngo 1.26.0\n")).toEqual([1, 26, 0]);
    expect(requiredGoVersion("module x\ngo 1.27\n")).toEqual([1, 27, 0]);
    expect(() => requiredGoVersion("module x\n")).toThrow(/does not declare/);
    expect(requiredGoVersion(readFileSync(join(component, "go.mod"), "utf8"))[0]).toBe(1);
  });

  test("compares toolchain versions numerically", () => {
    expect(parseGoVersion("go version go1.27.1 darwin/arm64")).toEqual([1, 27, 1]);
    expect(parseGoVersion("go version devel")).toBeNull();
    expect(atLeast([1, 27, 1], [1, 26, 0])).toBe(true);
    expect(atLeast([1, 26, 0], [1, 26, 0])).toBe(true);
    expect(atLeast([1, 9, 9], [1, 26, 0])).toBe(false);
  });

  test("every skipped Go test exists, so the list cannot hide a renamed one", async () => {
    const declared = new Set<string>();
    for await (const file of new Bun.Glob("**/*_test.go").scan({ cwd: component })) {
      for (const match of readFileSync(join(component, file), "utf8").matchAll(/^func (Test\w+)\(/gm)) declared.add(match[1]);
    }
    for (const name of FLAKY_GO_TESTS) expect(declared.has(name)).toBe(true);
  });

  test("failing tests roll up to what is rerun; build failures are never retried", () => {
    const lines = [
      { Action: "run", Package: "p/a", Test: "TestOne" },
      { Action: "fail", Package: "p/a", Test: "TestOne/sub" },
      { Action: "fail", Package: "p/a", Test: "TestOne" },
      { Action: "fail", Package: "p/a", Test: "TestTwo" },
      { Action: "fail", Package: "p/a" },
      { Action: "pass", Package: "p/b" },
      { Action: "fail", Package: "p/c" },
    ].map(event => JSON.stringify(event)).join("\n") + "\nnot json\n";
    const failures = goTestFailures(lines);
    expect([...failures.tests.get("p/a")!]).toEqual(["TestOne", "TestTwo"]);
    expect([...failures.packages]).toEqual(["p/c"]);
  });

  test("a silent package failure looks like a timing fluke; a compiler diagnostic never does", () => {
    // The real Windows incident this distinguishes from a build error: internal/runtime/executor
    // failed three times in CI with only this bare summary line, no compiler diagnostic, no goroutine
    // dump (https://github.com/trukhinyuri/codex-superpower/actions/runs/35394177013/job/105759101078).
    const silentTimeout = 'FAIL\tgithub.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor\t600.124s\n';
    expect(looksLikeBuildFailure(silentTimeout)).toBe(false);

    const compileError = '# github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor\n./codex_executor.go:42:2: undefined: notARealSymbol\nFAIL\tgithub.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor [build failed]\n';
    expect(looksLikeBuildFailure(compileError)).toBe(true);

    const importCycle = 'import cycle not allowed\npackage github.com/router-for-me/CLIProxyAPI/v7/internal/runtime/executor\n';
    expect(looksLikeBuildFailure(importCycle)).toBe(true);

    const missingPackage = 'cannot find package "github.com/does/not/exist" in any module\n';
    expect(looksLikeBuildFailure(missingPackage)).toBe(true);
  });

  test("the component keeps the upstream module path so subtree syncs apply cleanly", () => {
    expect(readFileSync(join(component, "go.mod"), "utf8")).toMatch(/^module github\.com\/router-for-me\/CLIProxyAPI\/v7$/m);
  });
});
