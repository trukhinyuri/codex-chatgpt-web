const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONNECTOR_PAIRING_RESTART_DEFERRAL_MS,
  FIRST_CHECK_DELAY_MS,
  connectorCheckDelayMs,
  connectorFailureKind,
  createConnectorReadinessMonitor,
  createConnectorTunnelService,
  isConnectorFailureCode,
} = require("../electron/connector-readiness.cjs");

function fakeClock(start = Date.parse("2026-09-18T08:22:28.000Z")) {
  let current = start;
  const timers = new Map();
  let nextId = 1;
  const delays = [];
  return {
    now: () => current,
    setTimer(callback, delay) {
      const id = nextId++;
      delays.push(delay);
      timers.set(id, { at: current + delay, callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    delays,
    /** Move time forward, firing due timers in order and letting their async work settle. */
    async advance(milliseconds, monitor) {
      const target = current + milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        current = timer.at;
        timer.callback();
        for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve));
        await monitor?.settled();
      }
      current = target;
    },
  };
}

function notListed() {
  const error = new Error("ChatGPT connector menu opened but exposed no row named \"Codex Native2\"");
  error.code = "connector_not_found:not_listed";
  return error;
}

function monitorFixture({ enabled = true, verified = false, idle = () => true, verifyResults = [] } = {}) {
  const clock = fakeClock();
  const state = { enabled, verified, verifyCalls: 0, verifiedEvents: [], changes: [] };
  const monitor = createConnectorReadinessMonitor({
    logger: { info() {}, warn() {} },
    isEnabled: () => state.enabled,
    isVerified: () => state.verified,
    isIdle: async () => idle(),
    verify: async () => {
      state.verifyCalls += 1;
      const result = verifyResults.shift();
      if (result instanceof Error) throw result;
    },
    observe: async () => ({ tunnelReady: true, contact: { status: "observed", at: "2026-09-18T08:27:03.000Z" } }),
    onVerified: (snapshot) => {
      state.verified = true;
      state.verifiedEvents.push(snapshot);
    },
    onChange: (snapshot) => state.changes.push(snapshot),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, monitor, state };
}

test("the check cadence is 15 s for 5 minutes, then 60 s up to 30 minutes, then 5 minutes", () => {
  assert.equal(connectorCheckDelayMs(0), 15_000);
  assert.equal(connectorCheckDelayMs(5 * 60_000 - 1), 15_000);
  assert.equal(connectorCheckDelayMs(5 * 60_000), 60_000);
  assert.equal(connectorCheckDelayMs(30 * 60_000 - 1), 60_000);
  assert.equal(connectorCheckDelayMs(30 * 60_000), 300_000);
  assert.equal(connectorCheckDelayMs(10 * 60 * 60_000), 300_000);
  assert.equal(connectorCheckDelayMs(Number.NaN), 15_000);
});

test("connector failure kinds come only from the structured code", () => {
  assert.equal(connectorFailureKind(notListed()), "not_listed");
  assert.equal(connectorFailureKind("connector_not_found:never_contacted"), "never_contacted");
  assert.equal(connectorFailureKind("connector_not_found"), "unknown");
  assert.equal(connectorFailureKind("connector_not_found:made_up"), "unknown");
  assert.equal(connectorFailureKind(new Error("connector_not_found:not_listed")), "unknown");
  assert.equal(connectorFailureKind({ code: "rate_limit_exceeded" }), "unknown");
  assert.equal(isConnectorFailureCode("connector_not_found:tunnel_unavailable"), true);
  assert.equal(isConnectorFailureCode("connector_not_found"), true);
  assert.equal(isConnectorFailureCode("rate_limit_exceeded"), false);
  assert.equal(isConnectorFailureCode(undefined), false);
});

test("a connector that appears on the third poll is verified with no IPC or button press", async () => {
  const { clock, monitor, state } = monitorFixture({ verifyResults: [notListed(), notListed()] });
  monitor.start("setup-mcp");
  assert.equal(monitor.snapshot().status, "waiting");

  await clock.advance(FIRST_CHECK_DELAY_MS, monitor);
  assert.equal(state.verifyCalls, 1);
  assert.equal(monitor.snapshot().lastFailureKind, "not_listed");
  assert.equal(monitor.snapshot().connectorListed, false);
  assert.equal(monitor.snapshot().status, "waiting");

  await clock.advance(15_000, monitor);
  assert.equal(state.verifyCalls, 2);
  assert.equal(state.verified, false);

  await clock.advance(15_000, monitor);
  assert.equal(state.verifyCalls, 3);
  assert.equal(state.verified, true);
  assert.equal(state.verifiedEvents.length, 1);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.status, "verified");
  assert.equal(snapshot.connectorListed, true);
  assert.equal(snapshot.tunnelReady, true);
  assert.deepEqual(snapshot.contact, { status: "observed", at: "2026-09-18T08:27:03.000Z" });
  assert.equal(snapshot.lastFailureKind, null);
  assert.equal(clock.pending(), 0, "the monitor stops once the connector is verified");

  await clock.advance(60 * 60_000, monitor);
  assert.equal(state.verifyCalls, 3);
});

test("background checks follow the bounded schedule while the connector stays missing", async () => {
  const failures = Array.from({ length: 200 }, () => notListed());
  const { clock, monitor, state } = monitorFixture({ verifyResults: failures });
  monitor.start("setup-mcp");
  await clock.advance(40 * 60_000, monitor);
  const delays = clock.delays;
  assert.equal(delays[0], FIRST_CHECK_DELAY_MS);
  // 1 s, then 15 s steps until 5 minutes have passed since arming, then 60 s steps to 30 minutes.
  const fast = delays.slice(1).filter(delay => delay === 15_000).length;
  const medium = delays.filter(delay => delay === 60_000).length;
  const slow = delays.filter(delay => delay === 300_000).length;
  assert.equal(fast, 20);
  assert.equal(medium, 25);
  assert.ok(slow >= 2, `expected slow checks after 30 minutes, saw ${slow}`);
  assert.equal(delays.some(delay => ![FIRST_CHECK_DELAY_MS, 15_000, 60_000, 300_000].includes(delay)), false);
  assert.equal(state.verifyCalls, delays.length - 1);
});

test("background checks never overlap a busy launcher and resume when it is idle", async () => {
  let idle = false;
  const { clock, monitor, state } = monitorFixture({ idle: () => idle, verifyResults: [] });
  monitor.start("launcher-start");
  await clock.advance(FIRST_CHECK_DELAY_MS, monitor);
  assert.equal(state.verifyCalls, 0);
  assert.equal(monitor.snapshot().status, "paused");
  await clock.advance(15_000, monitor);
  assert.equal(state.verifyCalls, 0);
  idle = true;
  await clock.advance(15_000, monitor);
  assert.equal(state.verifyCalls, 1);
  assert.equal(state.verified, true);
});

test("Zero Risk and other disabled modes never schedule a check", async () => {
  const { clock, monitor, state } = monitorFixture({ enabled: false });
  assert.equal(monitor.start("setup-mcp").status, "disabled");
  assert.equal(clock.pending(), 0);
  await clock.advance(60 * 60_000, monitor);
  assert.equal(state.verifyCalls, 0);
  assert.equal(monitor.noteTunnelRestarted(), true);
  assert.equal(monitor.snapshot().status, "disabled");
  assert.equal(clock.pending(), 0);
});

test("a monitor switched to Zero Risk while armed stops at its next check", async () => {
  const { clock, monitor, state } = monitorFixture({ verifyResults: [notListed()] });
  monitor.start("setup-mcp");
  await clock.advance(FIRST_CHECK_DELAY_MS, monitor);
  assert.equal(state.verifyCalls, 1);
  state.enabled = false;
  await clock.advance(15_000, monitor);
  assert.equal(state.verifyCalls, 1);
  assert.equal(monitor.snapshot().status, "disabled");
  assert.equal(clock.pending(), 0);
});

test("a tunnel restart re-arms the fast cadence for an unverified connector", async () => {
  const failures = Array.from({ length: 100 }, () => notListed());
  const { clock, monitor } = monitorFixture({ verifyResults: failures });
  monitor.start("setup-mcp");
  await clock.advance(10 * 60_000, monitor);
  assert.equal(clock.delays.at(-1), 60_000);
  assert.equal(monitor.noteTunnelRestarted(), true);
  assert.equal(clock.delays.at(-1), FIRST_CHECK_DELAY_MS);
  await clock.advance(FIRST_CHECK_DELAY_MS, monitor);
  assert.equal(clock.delays.at(-1), 15_000);
});

test("a tunnel restart leaves a verified connector alone", async () => {
  const { clock, monitor, state } = monitorFixture({ verified: true });
  assert.equal(monitor.start("launcher-start").status, "verified");
  assert.equal(monitor.noteTunnelRestarted(), false);
  assert.equal(clock.pending(), 0);
  assert.equal(state.verifyCalls, 0);
});

test("a connector_not_found turn failure re-arms the monitor without any action and asks to resend", async () => {
  const { clock, monitor, state } = monitorFixture({ verified: true, verifyResults: [notListed()] });
  monitor.start("launcher-start");
  assert.equal(monitor.noteTurnFailure("rate_limit_exceeded"), false);
  assert.equal(clock.pending(), 0);

  state.verified = false;
  assert.equal(monitor.noteTurnFailure("connector_not_found:not_listed"), true);
  assert.equal(monitor.snapshot().resendHint, true);
  assert.equal(monitor.snapshot().connectorListed, false);
  await clock.advance(FIRST_CHECK_DELAY_MS, monitor);
  assert.equal(state.verifyCalls, 1);
  assert.equal(state.verified, false);
  await clock.advance(15_000, monitor);
  assert.equal(state.verifyCalls, 2);
  assert.equal(state.verified, true);
  assert.equal(monitor.snapshot().resendHint, true, "the person learns to resend the failed task");
  monitor.clearResendHint();
  assert.equal(monitor.snapshot().resendHint, false);
});

test("a manual Verify result updates the same checklist and stops the schedule on success", async () => {
  const { clock, monitor, state } = monitorFixture({ verifyResults: [notListed()] });
  monitor.start("setup-mcp");
  monitor.noteManualResult(false, { code: "connector_not_found:never_contacted" });
  assert.equal(monitor.snapshot().lastFailureKind, "never_contacted");
  monitor.noteManualResult(true);
  assert.equal(state.verified, true);
  assert.equal(monitor.snapshot().status, "verified");
  assert.equal(clock.pending(), 0);
});

test("non-urgent restarts wait only while a new connector is being paired, and at most 30 minutes", async () => {
  const failures = Array.from({ length: 100 }, () => notListed());
  const { clock, monitor, state } = monitorFixture({ verifyResults: failures });
  assert.equal(monitor.restartDeferralActive(), false);
  monitor.start("setup-mcp");
  assert.equal(monitor.restartDeferralActive(), true);
  await clock.advance(CONNECTOR_PAIRING_RESTART_DEFERRAL_MS - 1_000, monitor);
  assert.equal(monitor.restartDeferralActive(), true);
  await clock.advance(2_000, monitor);
  assert.equal(monitor.restartDeferralActive(), false);

  state.verified = false;
  monitor.noteTurnFailure("connector_not_found:not_listed");
  assert.equal(monitor.restartDeferralActive(), false, "a working setup is not paired again");
  monitor.start("setup-mcp");
  monitor.noteManualResult(true);
  assert.equal(monitor.restartDeferralActive(), false);
});

function tunnelSupervisor({ mode = "full", baseUrl = "http://127.0.0.1:43210", readyz = true, health = { active_tool_calls: 0 }, contact = { status: "observed", at: "2026-09-18T08:27:03.000Z" } } = {}) {
  const calls = { recovery: [], discover: 0 };
  return {
    calls,
    tunnelHealthBaseUrl: baseUrl,
    readConfig: () => ({ mode, tunnel: mode === "full" ? { tunnelId: "tunnel_x" } : undefined }),
    discoverTunnelHealthBaseUrl: async () => { calls.discover += 1; throw new Error("alias is restarting"); },
    probeTunnelEndpoint: async (pathname) => {
      assert.equal(pathname, "/readyz");
      return readyz ? { observed: true, ok: true } : { observed: false, ok: false };
    },
    observeChatGptContact: async () => contact,
    tunnelContact: () => contact,
    proxyHealthPayload: async () => health,
    requestConnectorTunnelRecovery: (reason) => {
      calls.recovery.push(reason);
      return { requested: true };
    },
  };
}

test("a paused monitor resumes its schedule without reopening the pairing window", async () => {
  const failures = Array.from({ length: 100 }, () => notListed());
  const { clock, monitor, state } = monitorFixture({ verifyResults: failures });
  monitor.start("setup-mcp");
  const armedAt = monitor.snapshot().armedAt;
  await clock.advance(10 * 60_000, monitor);
  monitor.stop("quit");
  assert.equal(clock.pending(), 0);
  const calls = state.verifyCalls;
  monitor.resume("quit-cancelled");
  assert.equal(monitor.snapshot().armedAt, armedAt, "a cancelled quit does not extend the update deferral");
  assert.equal(clock.delays.at(-1), 60_000, "the schedule continues where it was");
  await clock.advance(60_000, monitor);
  assert.equal(state.verifyCalls, calls + 1);
  await clock.advance(21 * 60_000, monitor);
  assert.equal(monitor.restartDeferralActive(), false);
});

test("the tunnel answers /readyz: a turn's restart request is not needed", async () => {
  const supervisor = tunnelSupervisor();
  const service = createConnectorTunnelService({ supervisor });
  assert.deepEqual(await service({ restart: true }), {
    tunnelReady: true,
    readyz: true,
    contact: { status: "observed", at: "2026-09-18T08:27:03.000Z" },
    restart: "not-needed",
  });
  assert.deepEqual(supervisor.calls.recovery, []);
});

test("a tunnel that does not answer /readyz restarts only when no tool call is in flight", async () => {
  const idle = tunnelSupervisor({ readyz: false });
  assert.equal((await createConnectorTunnelService({ supervisor: idle })({ restart: true })).restart, "requested");
  assert.equal(idle.calls.recovery.length, 1);

  const busy = tunnelSupervisor({ readyz: false, health: { active_tool_calls: 2 } });
  assert.equal((await createConnectorTunnelService({ supervisor: busy })({ restart: true })).restart, "tool-calls-in-flight");
  assert.deepEqual(busy.calls.recovery, []);

  const oldBridge = tunnelSupervisor({ readyz: false, health: { status: "ok" } });
  assert.equal((await createConnectorTunnelService({ supervisor: oldBridge })({ restart: true })).restart, "tool-calls-in-flight");
  assert.deepEqual(oldBridge.calls.recovery, [], "unknown in-flight calls are never cut");

  const unreachable = tunnelSupervisor({ readyz: false, health: null });
  assert.equal((await createConnectorTunnelService({ supervisor: unreachable })({ restart: true })).restart, "tool-calls-in-flight");
  assert.deepEqual(unreachable.calls.recovery, []);

  const unasked = tunnelSupervisor({ readyz: false });
  assert.equal((await createConnectorTunnelService({ supervisor: unasked })({})).restart, "not-requested");
  assert.deepEqual(unasked.calls.recovery, []);
});

test("an unknown tunnel health URL is unknown readiness, never a reason to restart", async () => {
  const supervisor = tunnelSupervisor({ baseUrl: null });
  const status = await createConnectorTunnelService({ supervisor })({ restart: true });
  assert.equal(status.readyz, null);
  assert.equal(status.restart, "health-unknown");
  assert.equal(supervisor.calls.discover, 1);
  assert.deepEqual(supervisor.calls.recovery, []);

  const browserOnly = await createConnectorTunnelService({ supervisor: tunnelSupervisor({ mode: "browser-only" }) })({ restart: true });
  assert.deepEqual(browserOnly, { tunnelReady: null, readyz: null, contact: { status: "unknown", at: null }, restart: "not-configured" });
});

test("a waiting turn's progress and tunnel observations reach the launcher checklist", async () => {
  const { monitor } = monitorFixture();
  const service = createConnectorTunnelService({ supervisor: tunnelSupervisor(), monitor });
  await service({ waitStep: 2, waitTotal: 5, waitMs: 30_000 });
  const snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.waitingTurn, { step: 2, total: 5 });
  assert.equal(snapshot.tunnelReady, true);
  assert.deepEqual(snapshot.contact, { status: "observed", at: "2026-09-18T08:27:03.000Z" });
  monitor.noteTurnEnded();
  assert.equal(monitor.snapshot().waitingTurn, null);
});
