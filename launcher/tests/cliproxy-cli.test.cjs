const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createCliProxyPanel, runCliProxy } = require("../electron/cliproxy-cli.cjs");

/** A child process that prints the given stdout lines, then exits with `code`. */
function fakeSpawn({ stdout = [], stderr = "", code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let input = "";
    child.stdin.on("data", chunk => { input += chunk.toString(); });
    child.kill = () => {};
    calls.push({ executable, args, options, input: () => input });
    setImmediate(() => {
      for (const line of stdout) child.stdout.write(`${line}\n`);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", code));
    });
    return child;
  };
  return { spawnImpl, calls };
}

const invocation = { executable: "/runtime/bin/codex-chatgpt-web", args: [], cwd: "/runtime" };

test("pretty JSON, JSON lines and CLI errors are read as the CLI prints them", async () => {
  const pretty = fakeSpawn({ stdout: ["{", '  "enabled": true,', '  "proxyModels": 3', "}"] });
  assert.deepEqual(await runCliProxy(invocation, { spawnImpl: pretty.spawnImpl }), { enabled: true, proxyModels: 3 });

  const seen = [];
  const lines = fakeSpawn({ stdout: ['{"provider":"claude","url":"https://claude.ai/x","waiting":true}', '{"provider":"claude","signedIn":true}'] });
  const result = await runCliProxy(invocation, { spawnImpl: lines.spawnImpl, onLine: line => seen.push(line) });
  assert.equal(result.length, 2);
  assert.deepEqual(seen.map(line => Object.keys(line).sort().join(",")), ["provider,url,waiting", "provider,signedIn"]);

  const failed = fakeSpawn({ stderr: "codex-chatgpt-web: CLIProxyAPI rejected the management key\n", code: 1 });
  await assert.rejects(runCliProxy(invocation, { spawnImpl: failed.spawnImpl }), { message: "CLIProxyAPI rejected the management key" });
});

test("keys go on standard input only, and bad input never reaches the CLI", async () => {
  const fake = fakeSpawn({ stdout: ['{"connected":true,"proxyModels":2}'] });
  const panel = createCliProxyPanel({
    invocationFor: args => ({ ...invocation, args }),
    env: { CODEX_CHATGPT_WEB_HOME: "/home/.codex-chatgpt-web" },
    openExternal: async () => {},
  });
  // Swap the real spawn for the fake by driving runCliProxy through the same invocation shape.
  const connectArgs = ["cliproxy", "connect", "--base-url", "http://127.0.0.1:8317", "--api-key-stdin"];
  await runCliProxy({ ...invocation, args: connectArgs }, { spawnImpl: fake.spawnImpl, input: "sk-key\n" });
  assert.deepEqual(fake.calls[0].args, connectArgs);
  assert.equal(fake.calls[0].input(), "sk-key\n");
  assert.ok(!fake.calls[0].args.some(arg => arg.includes("sk-key")));

  assert.throws(() => panel.connect({ apiKey: "" }), /Enter the CLIProxyAPI API key/);
  assert.throws(() => panel.connect({ apiKey: "two words" }), /Enter the CLIProxyAPI API key/);
  assert.throws(() => panel.setManagementKey(undefined), /management key/);
  assert.throws(() => panel.login("gemini"), /Unknown CLIProxyAPI provider/);
  assert.throws(() => panel.remove(""), /Choose an account/);
});

test("login opens only an https sign-in page and returns the final line", async () => {
  const opened = [];
  const fake = fakeSpawn({ stdout: ['{"provider":"codex","url":"https://auth.openai.com/oauth","waiting":true}', '{"provider":"codex","signedIn":true}'] });
  const moduleUnderTest = require("../electron/cliproxy-cli.cjs");
  const panel = {
    login: provider => moduleUnderTest.runCliProxy({ ...invocation, args: ["cliproxy", "login", provider, "--no-open"] }, {
      spawnImpl: fake.spawnImpl,
      onLine: line => { if (typeof line?.url === "string" && /^https:\/\//.test(line.url)) opened.push(line.url); },
    }).then(result => (Array.isArray(result) ? result.at(-1) : result)),
  };
  assert.deepEqual(await panel.login("codex"), { provider: "codex", signedIn: true });
  assert.deepEqual(opened, ["https://auth.openai.com/oauth"]);

  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "cliproxy-cli.cjs"), "utf8");
  assert.match(source, /if \(typeof line\?\.url === "string" && \/\^https:\\\/\\\/\/\.test\(line\.url\)\) void openExternal\(line\.url\);/);
  assert.match(source, /run\(\["login", provider, "--no-open"\]/);
});

test("the launcher exposes the panel through one IPC channel and the runtime's own home", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
  assert.match(main, /env: \{ \.\.\.process\.env, CODEX_CHATGPT_WEB_HOME: CORE_HOME \}/);
  assert.match(main, /handle\("launcher:cliproxy", \(_event, action, payload\) => \{/);
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8");
  assert.match(preload, /cliproxy: \(action, payload\) => ipcRenderer\.invoke\("launcher:cliproxy", action, payload\)/);
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /setApiKey\(""\);\n\s*await api!\.cliproxy\("connect"/, "the key field is cleared before the call");
  assert.match(app, /setManagementKey\(""\);\n\s*await api!\.cliproxy\("management-key"/);
});
