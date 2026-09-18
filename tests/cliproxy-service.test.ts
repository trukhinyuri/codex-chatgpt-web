import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERVICE_LABEL,
  adoptService,
  launchAgentPlist,
  readServiceState,
  releaseService,
  serviceBaseUrl,
  servicePaths,
  syncService,
  type Launchctl,
} from "../src/cliproxy-service";

let root: string;
let home: string;
let agents: string;
let bundle: string;
let config: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cwg-cliproxy-service-"));
  home = join(root, "home");
  agents = join(root, "LaunchAgents");
  bundle = join(root, "bundle");
  config = join(root, "config.yaml");
  mkdirSync(home, { recursive: true });
  mkdirSync(agents, { recursive: true });
  mkdirSync(bundle, { recursive: true });
  writeFileSync(config, 'host: "127.0.0.1"\nport: 8317\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeBundle(contents: string): void {
  writeFileSync(join(bundle, "cli-proxy-api"), contents, { mode: 0o755 });
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({
    version: 1, bundled: true, binary: "cli-proxy-api", proxyVersion: "superpower-abc1234",
    sha256: createHash("sha256").update(contents).digest("hex"),
  }));
}

/** launchctl that remembers which labels are loaded. */
function fakeLaunchctl(initiallyLoaded: string[] = []) {
  const loaded = new Set(initiallyLoaded);
  const calls: string[] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(args.join(" "));
    const [verb, target, path] = args;
    if (verb === "print") return { code: loaded.has(target!.split("/").at(-1)!) ? 0 : 113, stdout: "", stderr: "" };
    if (verb === "bootstrap") {
      const label = /<string>([^<]+)<\/string>/.exec(readFileSync(path!, "utf8").split("<key>Label</key>")[1] ?? "")?.[1];
      if (label) loaded.add(label);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (verb === "bootout") {
      loaded.delete(target!.split("/").at(-1)!);
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { launchctl, calls, loaded };
}

const healthy = async () => Response.json({ status: "ok" });
const deps = (launchctl: Launchctl, fetchImpl = healthy) => ({
  home, uid: 501, launchctl, fetchImpl, sleep: async () => {}, launchAgents: agents, healthTimeoutMs: 50,
});

test("an unmanaged proxy is left alone", async () => {
  writeBundle("v1");
  const { launchctl, calls } = fakeLaunchctl();
  expect(await syncService(deps(launchctl), bundle)).toEqual({ status: "off" });
  expect(calls).toEqual([]);
});

test("adopting stops the old agent, keeps its plist, and runs this app's binary with the same config", async () => {
  writeBundle("v1");
  writeFileSync(join(agents, "com.example.cliproxyapi.plist"), "<plist>old</plist>");
  const { launchctl, calls, loaded } = fakeLaunchctl(["com.example.cliproxyapi"]);
  const result = await adoptService(deps(launchctl), config, "com.example.cliproxyapi", bundle);
  expect(result).toMatchObject({ status: "running", binaryChanged: true, proxyVersion: "superpower-abc1234", baseUrl: "http://127.0.0.1:8317" });
  expect(calls).toContain("bootout gui/501/com.example.cliproxyapi");
  expect(existsSync(join(agents, "com.example.cliproxyapi.plist"))).toBe(false);
  expect(loaded.has(SERVICE_LABEL)).toBe(true);
  const paths = servicePaths(home, agents);
  expect(readFileSync(paths.binary, "utf8")).toBe("v1");
  expect(statSync(paths.binary).mode & 0o777).toBe(0o755);
  expect(readFileSync(paths.plist, "utf8")).toBe(launchAgentPlist(paths, config));
  const state = readServiceState(paths)!;
  expect(state).toMatchObject({ enabled: true, configPath: config, adoptedFrom: { label: "com.example.cliproxyapi" } });
  expect(readFileSync(state.adoptedFrom!.plistBackup, "utf8")).toBe("<plist>old</plist>");
});

test("a new bundled binary replaces the old one and restarts the agent; an unchanged one does nothing", async () => {
  writeBundle("v1");
  const { launchctl, calls } = fakeLaunchctl();
  await adoptService(deps(launchctl), config, null, bundle);
  calls.length = 0;
  expect(await syncService(deps(launchctl), bundle)).toMatchObject({ status: "running", binaryChanged: false });
  expect(calls.filter(call => !call.startsWith("print"))).toEqual([]);

  writeBundle("v2");
  expect(await syncService(deps(launchctl), bundle)).toMatchObject({ status: "running", binaryChanged: true });
  expect(calls).toContain(`kickstart -k gui/501/${SERVICE_LABEL}`);
  expect(readFileSync(servicePaths(home, agents).binary, "utf8")).toBe("v2");
  expect(readdirSync(join(home, "cliproxyapi", "bin"))).toEqual(["cli-proxy-api"]);
});

test("a proxy that does not come up is reported, and a failed adoption gives the old agent back", async () => {
  writeBundle("v1");
  writeFileSync(join(agents, "com.example.cliproxyapi.plist"), "<plist>old</plist>");
  const { launchctl, loaded } = fakeLaunchctl(["com.example.cliproxyapi"]);
  const down = async () => { throw new Error("ECONNREFUSED"); };
  await expect(adoptService(deps(launchctl, down), config, "com.example.cliproxyapi", bundle)).rejects.toThrow(/did not answer its health check/);
  expect(readFileSync(join(agents, "com.example.cliproxyapi.plist"), "utf8")).toBe("<plist>old</plist>");
  expect(existsSync(servicePaths(home, agents).plist)).toBe(false);
  expect(loaded.has(SERVICE_LABEL)).toBe(false);
  expect(readServiceState(servicePaths(home, agents))!.enabled).toBe(false);
});

test("release stops this app's agent and restores the adopted one", async () => {
  writeBundle("v1");
  writeFileSync(join(agents, "com.example.cliproxyapi.plist"), "<plist>old</plist>");
  const { launchctl, loaded } = fakeLaunchctl(["com.example.cliproxyapi"]);
  await adoptService(deps(launchctl), config, "com.example.cliproxyapi", bundle);
  expect(await releaseService(deps(launchctl))).toEqual({ released: true, restored: "com.example.cliproxyapi" });
  expect(loaded.has(SERVICE_LABEL)).toBe(false);
  expect(existsSync(join(agents, "com.example.cliproxyapi.plist"))).toBe(true);
  expect(await syncService(deps(launchctl), bundle)).toEqual({ status: "off" });
});

test("the health address comes from the bridge connection or the proxy's own config", () => {
  expect(serviceBaseUrl(home, config)).toBe("http://127.0.0.1:8317");
  writeFileSync(config, "port: 9001\n");
  expect(serviceBaseUrl(home, config)).toBe("http://127.0.0.1:9001");
  const plist = launchAgentPlist(servicePaths(home, agents), "/path with <odd> & chars/config.yaml");
  expect(plist).toContain("<string>/path with &lt;odd&gt; &amp; chars/config.yaml</string>");
  expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
});

test("a bundle whose binary does not match its manifest is refused", async () => {
  writeBundle("v1");
  writeFileSync(join(bundle, "cli-proxy-api"), "tampered");
  const { launchctl } = fakeLaunchctl();
  await expect(adoptService(deps(launchctl), config, null, bundle)).rejects.toThrow(/does not match its manifest/);
});
