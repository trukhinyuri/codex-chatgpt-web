const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");
const {
  CONNECTOR_TUNNEL_RECOVERY_INTERVAL_MS,
  TUNNEL_CONTACT_OBSERVATION_FRESH_MS,
  RuntimeSupervisor,
  parseTunnelContactMetrics,
  tunnelContactStatus,
  tunnelRuntimeIdentity,
  validateConfig,
} = require("../electron/runtime-supervisor.cjs");

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";
const OTHER_TUNNEL_ID = "tunnel_fedcba9876543210fedcba9876543210";
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

/**
 * The turn broker listens on a Unix socket everywhere except Windows, where it is a named pipe
 * (the product's defaultBrokerEndpoint in src/config.ts). A fixture config that carries a Unix
 * socket path on Windows is rejected by validateConfig ("invalid Windows broker pipe"), so every
 * supervisor start reports needs-setup instead of ready.
 */
function brokerEndpoint(root, platform = process.platform) {
  return platform === "win32"
    ? "\\\\.\\pipe\\codex-chatgpt-web-tunnel-connector-test"
    : path.join(root, "turn-broker.sock");
}

function fullConfig(root, descriptorPath, overrides = {}, platform = process.platform) {
  return {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "full",
    host: "127.0.0.1",
    port: 1,
    contextWindow: 256_000,
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: brokerEndpoint(root, platform),
    headed: true,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "tunnel-connector-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    tunnel: {
      binaryPath: path.join(root, "bin", "tunnel-client"),
      tunnelId: TUNNEL_ID,
      runtimeKeyFile: path.join(root, "secrets", "tunnel-runtime-automatic.key"),
      profileDir: path.join(root, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
    ...overrides,
  };
}

function writeTunnelClient(root, version = "0.0.12", digest = "a".repeat(64)) {
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin", "tunnel-client"), "fake tunnel-client");
  fs.writeFileSync(path.join(root, "secrets", "tunnel-runtime-automatic.key"), "fake key", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "bin", "tunnel-client-manifest.json"), JSON.stringify({
    version: 1,
    tunnelClientVersion: version,
    binarySha256: digest,
  }));
}

const METRICS_FIXTURE = [
  "# HELP command_end_to_end_latency_milliseconds Latency in milliseconds from control-plane enqueue to final response delivery.",
  "# TYPE command_end_to_end_latency_milliseconds histogram",
  'command_end_to_end_latency_milliseconds_count{channel="main",latency_type="poll_to_response",otel_scope_name="dispatcher",request_kind="call",request_method="initialize",tunnel_id="tunnel_x",tunnel_service_status="200"} 4',
  'command_end_to_end_latency_milliseconds_count{channel="main",latency_type="poll_to_response",request_kind="notification",request_method="notifications/initialized",tunnel_id="tunnel_x",tunnel_service_status="200"} 4',
  'command_end_to_end_latency_milliseconds_count{channel="main",latency_type="poll_to_response",request_kind="call",request_method="tools/list",tunnel_id="tunnel_x",tunnel_service_status="200"} 2',
  'command_end_to_end_latency_milliseconds_count{channel="main",latency_type="poll_to_response",request_kind="call",request_method="tools/call",tunnel_id="tunnel_x",tunnel_service_status="200"} 40',
  'command_end_to_end_latency_milliseconds_count{channel="main",latency_type="poll_to_response",request_kind="call",request_method="tools/call",tunnel_id="tunnel_x",tunnel_service_status="502"} 3',
  'command_end_to_end_latency_milliseconds_count{channel="harpoon",latency_type="poll_to_response",request_kind="call",request_method="initialize",tunnel_id="tunnel_x",tunnel_service_status="200"} 9',
  'command_end_to_end_latency_milliseconds_sum{channel="main",request_method="tools/call",tunnel_service_status="200"} 1234',
  "process_start_time_seconds 1.78975e+09",
  'go_goroutines 42',
].join("\n");

test("tunnel metrics count only ChatGPT's successful MCP commands on the main channel", () => {
  const parsed = parseTunnelContactMetrics(METRICS_FIXTURE);
  assert.equal(parsed.exposition, true);
  assert.equal(parsed.contacts, 4 + 2 + 40);
  assert.equal(parsed.processStartSeconds, 1.78975e9);

  const idle = parseTunnelContactMetrics("# HELP go_goroutines x\ngo_goroutines 12\nprocess_start_time_seconds 1789750000\n");
  assert.deepEqual(idle, { contacts: 0, commandSeries: 0, processStartSeconds: 1789750000, exposition: true });

  assert.equal(parseTunnelContactMetrics("<html>not metrics</html>").exposition, false);
  assert.equal(parseTunnelContactMetrics(undefined).exposition, false);
  const harpoonOnly = parseTunnelContactMetrics(
    'command_end_to_end_latency_milliseconds_count{channel="harpoon",request_method="tools/list",tunnel_service_status="200"} 5',
  );
  assert.equal(harpoonOnly.contacts, 0);
});

test("contact status never treats missing or unverified metrics as proof of no contact", () => {
  const now = Date.parse("2026-09-18T08:30:00.000Z");
  const fresh = new Date(now - 5_000).toISOString();
  const base = { metricsReadable: true, metricsVerified: true, observedAt: fresh, processStartSeconds: 1789720000 };
  assert.deepEqual(tunnelContactStatus({ ...base, lastContactAt: "2026-09-18T08:27:03.000Z" }, now), {
    status: "observed",
    at: "2026-09-18T08:27:03.000Z",
  });
  assert.deepEqual(tunnelContactStatus(base, now), {
    status: "not-observed",
    at: new Date(1789720000 * 1000).toISOString(),
  });
  assert.equal(tunnelContactStatus({ ...base, metricsVerified: false }, now).status, "unknown");
  assert.equal(tunnelContactStatus({ ...base, metricsReadable: false }, now).status, "unknown");
  assert.equal(tunnelContactStatus({
    ...base,
    observedAt: new Date(now - TUNNEL_CONTACT_OBSERVATION_FRESH_MS - 1).toISOString(),
  }, now).status, "unknown");
  assert.equal(tunnelContactStatus(null, now).status, "unknown");
});

test("ChatGPT's last contact survives tunnel restarts that reset tunnel-client counters", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-contact-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  try {
    writeTunnelClient(root);
    const config = fullConfig(root, descriptorPath);
    const readings = [
      { readable: true, contacts: 0, processStartSeconds: 100 },
      { readable: true, contacts: 5, processStartSeconds: 100 },
      { readable: true, contacts: 5, processStartSeconds: 100 },
      { readable: true, contacts: 0, processStartSeconds: 200 },
      { readable: false, contacts: 0, processStartSeconds: null },
    ];
    const make = () => {
      const supervisor = new RuntimeSupervisor({
        app: { getVersion: () => "0.2.0" },
        logger: quietLogger,
        sourceRoot: root,
        coreHome: root,
        browserDescriptorPath: descriptorPath,
      });
      supervisor.probeTunnelChatGptContact = async () => readings.shift();
      return supervisor;
    };
    const supervisor = make();
    assert.equal((await supervisor.observeChatGptContact(config)).status, "not-observed");
    const first = await supervisor.observeChatGptContact(config);
    assert.equal(first.status, "observed");
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(await supervisor.observeChatGptContact(config), first, "the same count is not a new contact");
    assert.deepEqual(await supervisor.observeChatGptContact(config), first, "a restarted tunnel keeps the time");
    const afterLauncherRestart = make();
    assert.deepEqual(await afterLauncherRestart.observeChatGptContact(config), first);
    assert.deepEqual(afterLauncherRestart.tunnelContact(config), first);
    const record = JSON.parse(fs.readFileSync(path.join(root, "runtime", "tunnel-contact.json"), "utf8"));
    assert.equal(JSON.stringify(record).includes(TUNNEL_ID), false, "the record stores a fingerprint, not the id");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(root, "runtime", "tunnel-contact.json")).mode & 0o077, 0);
    }
    assert.deepEqual(
      afterLauncherRestart.tunnelContact(fullConfig(root, descriptorPath, {
        tunnel: { ...config.tunnel, tunnelId: OTHER_TUNNEL_ID },
      })),
      { status: "unknown", at: null },
      "contact with another tunnel is not evidence for this one",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unverified tunnel-client version cannot report that ChatGPT never connected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-contact-version-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  try {
    writeTunnelClient(root, "0.0.99");
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0" },
      logger: quietLogger,
      sourceRoot: root,
      coreHome: root,
      browserDescriptorPath: descriptorPath,
    });
    supervisor.probeTunnelChatGptContact = async () => ({ readable: true, contacts: 0, processStartSeconds: 100 });
    assert.deepEqual(await supervisor.observeChatGptContact(fullConfig(root, descriptorPath)), {
      status: "unknown",
      at: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the live /metrics probe reads the tunnel's loopback health endpoint", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/metrics") response.end(METRICS_FIXTURE);
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0" },
      logger: quietLogger,
      sourceRoot: os.tmpdir(),
      coreHome: os.tmpdir(),
      browserDescriptorPath: path.join(os.tmpdir(), "launcher-browser.json"),
    });
    assert.equal((await supervisor.probeTunnelChatGptContact()).readable, false);
    supervisor.tunnelHealthBaseUrl = `http://127.0.0.1:${server.address().port}`;
    const probe = await supervisor.probeTunnelChatGptContact();
    assert.equal(probe.readable, true);
    assert.equal(probe.contacts, 46);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

/**
 * A fake tunnel-client manager: one alias whose runtime can be connected and stopped, and a fake
 * daemon process that answers the bridge's health and lifecycle endpoints.
 */
async function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-tunnel-keep-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const serverPath = path.join(root, "fake-runtime.cjs");
  const port = await freePort();
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  writeTunnelClient(root);
  const writeConfig = (overrides = {}) => fs.writeFileSync(
    configPath,
    `${JSON.stringify(fullConfig(root, descriptorPath, { port, ...overrides }))}\n`,
  );
  writeConfig();
  fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const http = require("node:http");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let draining = false;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "close");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({ status: "ok", service: "codex-chatgpt-web", mode: config.mode,
      version: config.releaseVersion, pid: process.pid, accepting_turns: !draining }));
    return;
  }
  if (request.headers.authorization !== "Bearer " + config.controlToken) {
    response.statusCode = 401; response.end("{}"); return;
  }
  if (request.method === "POST" && request.url === "/admin/drain") draining = true;
  else if (request.method === "POST" && request.url === "/admin/resume") draining = false;
  else if (request.method === "POST" && request.url === "/admin/shutdown" && draining) {
    response.end(JSON.stringify({ status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    server.close(() => process.exit(0));
    return;
  } else { response.statusCode = 404; response.end("{}"); return; }
  response.end(JSON.stringify({ status: "ok", accepting_turns: !draining, active_http_turns: 0, active_browser_turns: 0 }));
});
server.listen(config.port, config.host);
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`);
  const tunnel = { running: false, pid: null, nextPid: 900_001, commands: [] };
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: quietLogger,
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    runtimeInvocationFactory: ({ args }) => ({
      executable: process.execPath,
      args: args[0] === "serve" ? [serverPath, configPath] : [serverPath, ...args],
      cwd: root,
    }),
  });
  supervisor.runTunnelCommand = async (_config, args) => {
    const command = args.slice(0, 2).join(" ");
    tunnel.commands.push(command);
    if (command === "runtimes cleanup") {
      const entries = tunnel.running
        ? [{ alias: "codex-chatgpt-web", runtime_state: "ready", live_runtime: { found: true, system: { pid: tunnel.pid } } }]
        : [];
      return { code: 0, stdout: JSON.stringify({ entries }), stderr: "", output: JSON.stringify({ entries }) };
    }
    if (command.startsWith("runtimes stop")) {
      tunnel.running = false;
      tunnel.pid = null;
      return { code: 0, stdout: "{}", stderr: "", output: "{}" };
    }
    if (command === "runtimes connect") {
      tunnel.running = true;
      tunnel.pid = tunnel.nextPid++;
      return { code: 0, stdout: "{}", stderr: "", output: "{}" };
    }
    throw new Error(`unexpected tunnel command ${command}`);
  };
  supervisor.waitForTunnelMcpTransport = async () => ({ observed: true, ok: true });
  supervisor.probeTunnelChatGptContact = async () => ({ readable: false, contacts: 0, processStartSeconds: null });
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "user-data"), getVersion: () => "0.2.0" },
    logger: quietLogger,
    sourceRoot: root,
    browserDescriptorPath: descriptorPath,
    coreHome: root,
    codexHome: path.join(root, "codex"),
    supervisor,
  });
  const cleanup = async () => {
    supervisor.stopTunnelMonitor();
    await supervisor.stopForSetup().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, configPath, supervisor, host, tunnel, writeConfig, cleanup };
}

test("the bridge answers /healthz before tunnel-client starts", async () => {
  const fixture = await runtimeFixture();
  const events = [];
  const startDaemon = fixture.supervisor.startDaemon.bind(fixture.supervisor);
  fixture.supervisor.startDaemon = async (config) => {
    events.push("daemon-start");
    await startDaemon(config);
    events.push("daemon-healthy");
  };
  const runTunnelCommand = fixture.supervisor.runTunnelCommand;
  fixture.supervisor.runTunnelCommand = async (config, args) => {
    if (args[1] === "connect") events.push("tunnel-connect");
    return await runTunnelCommand(config, args);
  };
  try {
    const started = await fixture.supervisor.startIfConfigured();
    assert.equal(started.status, "ready");
    assert.deepEqual(events, ["daemon-start", "daemon-healthy", "tunnel-connect"]);
  } finally {
    await fixture.cleanup();
  }
});

test("a tunnel recovery waits for a bridge that is still coming up (503, then 200)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-tunnel-after-bridge-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  try {
    writeTunnelClient(root);
    const config = fullConfig(root, descriptorPath);
    const supervisor = new RuntimeSupervisor({
      app: { getVersion: () => "0.2.0" },
      logger: quietLogger,
      sourceRoot: root,
      coreHome: root,
      browserDescriptorPath: descriptorPath,
    });
    const events = [];
    let probes = 0;
    supervisor.daemon = { pid: 4242 };
    supervisor.proxyHealth = async (_config, _timeout, pid) => {
      probes += 1;
      assert.equal(pid, 4242);
      const healthy = probes >= 3;
      events.push(healthy ? "bridge-200" : "bridge-503");
      return healthy;
    };
    assert.equal(await supervisor.waitForBridgeBeforeTunnel(config, 5_000), true);
    events.push("tunnel-connect");
    assert.deepEqual(events, ["bridge-503", "bridge-503", "bridge-200", "tunnel-connect"]);

    supervisor.daemon = null;
    assert.equal(await supervisor.waitForBridgeBeforeTunnel(config, 5_000), true, "no owned bridge: nothing to wait for");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("toggling Bigger Context with an unchanged tunnel configuration keeps the tunnel pid", async () => {
  const fixture = await runtimeFixture();
  try {
    const started = await fixture.supervisor.startIfConfigured();
    assert.equal(started.status, "ready");
    const tunnelPid = fixture.supervisor.tunnel.pid;
    const daemonPid = fixture.supervisor.daemon.pid;
    assert.equal(tunnelPid, 900_001);
    fixture.tunnel.commands.length = 0;
    fixture.host.run = async (_name, args) => {
      if (!args.includes("--preflight-only")) {
        // Real setup rewrites the config: the context flag and a new lifecycle token.
        fixture.writeConfig({
          experimentalBiggerContext: true,
          controlToken: "tunnel-connector-rotated-token-0123456789abcdef",
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await fixture.host.setBiggerContext(true);
    assert.equal(result.enabled, true);
    assert.equal(fixture.supervisor.tunnel.pid, tunnelPid, "the tunnel process is the same one");
    assert.notEqual(fixture.supervisor.daemon.pid, daemonPid, "only the bridge daemon restarted");
    assert.equal(fixture.tunnel.commands.some(command => command.startsWith("runtimes stop")), false);
    assert.equal(fixture.tunnel.commands.includes("runtimes connect"), false);
    const state = JSON.parse(fs.readFileSync(path.join(fixture.root, "runtime", "launcher-supervisor.json"), "utf8"));
    assert.equal(state.status, "ready");
    assert.equal(state.tunnelPid, tunnelPid);
  } finally {
    await fixture.cleanup();
  }
});

test("a setup that changes the tunnel configuration still restarts the tunnel", async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.supervisor.startIfConfigured();
    const tunnelPid = fixture.supervisor.tunnel.pid;
    fixture.tunnel.commands.length = 0;
    fixture.host.run = async (_name, args) => {
      if (!args.includes("--preflight-only")) {
        const current = JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
        fixture.writeConfig({ tunnel: { ...current.tunnel, tunnelId: OTHER_TUNNEL_ID } });
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await fixture.host.runSetup("core-setup", ["setup", "--full"], { preserveTunnel: true });
    assert.notEqual(fixture.supervisor.tunnel.pid, tunnelPid);
    assert.equal(fixture.tunnel.commands.filter(command => command.startsWith("runtimes stop")).length >= 1, true);
    assert.equal(fixture.tunnel.commands.includes("runtimes connect"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("an upgraded tunnel-client binary is a different tunnel even with the same configuration", () => {
  const config = fullConfig("/root", "/root/runtime/launcher-browser.json");
  assert.notEqual(tunnelRuntimeIdentity(config, "a".repeat(64)), tunnelRuntimeIdentity(config, "b".repeat(64)));
  assert.equal(
    tunnelRuntimeIdentity({ ...config, experimentalBiggerContext: true, controlToken: "x".repeat(40) }, "a".repeat(64)),
    tunnelRuntimeIdentity(config, "a".repeat(64)),
  );
  assert.equal(tunnelRuntimeIdentity({ ...config, mode: "browser-only" }), null);
});

test("the fixture configuration stays valid on Windows named pipes and Unix sockets", () => {
  // verify(windows-latest) once failed every supervisor-start test with needs-setup because this
  // fixture wrote a Unix socket path that validateConfig rejects on win32. Validating the fixture
  // for platform "win32" makes that regression visible on macOS and Linux too.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwg-tunnel-platform-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  try {
    for (const platform of ["win32", process.platform]) {
      const config = fullConfig(root, descriptorPath, {}, platform);
      assert.equal(config.brokerSocketPath, brokerEndpoint(root, platform));
      assert.doesNotThrow(() => validateConfig(config, descriptorPath, platform));
    }
    assert.throws(
      () => validateConfig(
        {
          ...fullConfig(root, descriptorPath, {}, "win32"),
          brokerSocketPath: path.join(root, "turn-broker.sock"),
        },
        descriptorPath,
        "win32",
      ),
      /invalid Windows broker pipe/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed setup stop keeps supervising the tunnel that is still running", async () => {
  const fixture = await runtimeFixture();
  try {
    await fixture.supervisor.startIfConfigured();
    fixture.supervisor.acquireDrain = async () => {
      throw new Error("daemon has 1 active HTTP turn(s)");
    };
    await assert.rejects(fixture.supervisor.stopForSetup({ preserveTunnel: true }), /active HTTP turn/);
    assert.notEqual(fixture.supervisor.tunnelMonitorTimer, null, "the tunnel monitor runs again");
    assert.equal(fixture.supervisor.preservedTunnel, null);
    await assert.rejects(fixture.supervisor.stopForSetup(), /active HTTP turn/);
    assert.notEqual(fixture.supervisor.tunnelMonitorTimer, null);
  } finally {
    delete fixture.supervisor.acquireDrain;
    await fixture.cleanup();
  }
});

test("a waiting connector turn can request one tunnel restart, never a loop", () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0" },
    logger: quietLogger,
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher-browser.json"),
  });
  const scheduled = [];
  supervisor.tryWriteState = () => true;
  supervisor.scheduleRecovery = (name) => scheduled.push(name);
  supervisor.tunnel = { pid: 1 };
  assert.deepEqual(supervisor.requestConnectorTunnelRecovery("readyz unavailable"), { requested: true });
  assert.deepEqual(scheduled, ["tunnel"]);
  assert.equal(supervisor.tunnel, null);
  assert.deepEqual(supervisor.requestConnectorTunnelRecovery("readyz unavailable"), {
    requested: false,
    reason: "recently-restarted",
  });
  supervisor.lastConnectorTunnelRecoveryAt = Date.now() - CONNECTOR_TUNNEL_RECOVERY_INTERVAL_MS - 1;
  supervisor.restartTimers.tunnel = setTimeout(() => {}, 1);
  assert.deepEqual(supervisor.requestConnectorTunnelRecovery("readyz unavailable"), { requested: false, reason: "busy" });
  clearTimeout(supervisor.restartTimers.tunnel);
  supervisor.restartTimers.tunnel = null;
  supervisor.stopping = true;
  assert.deepEqual(supervisor.requestConnectorTunnelRecovery("readyz unavailable"), { requested: false, reason: "busy" });
  assert.deepEqual(scheduled, ["tunnel"]);
});
