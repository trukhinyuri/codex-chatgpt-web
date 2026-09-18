/**
 * Background proof that ChatGPT lists the Codex Native connector.
 *
 * After Full-harness setup the person still has to create the connector in ChatGPT, and ChatGPT
 * can take many minutes to list a new connector even after it has reached the tunnel. Instead of
 * asking them to press Verify until it works, the launcher re-checks by itself: every 15 seconds
 * for the first 5 minutes, every minute up to 30 minutes, then every 5 minutes, and stops once the
 * connector is listed. A check types "@codex" into the launcher-owned ChatGPT surface and clears
 * the composer again; it never sends a message. Checks run only while the launcher is idle and
 * never in Zero Risk, where every ChatGPT action belongs to the person.
 */

const FIRST_CHECK_DELAY_MS = 1_000;
const IDLE_RETRY_MAX_DELAY_MS = 15_000;
const CONNECTOR_CHECK_SCHEDULE = Object.freeze([
  Object.freeze({ untilMs: 5 * 60_000, everyMs: 15_000 }),
  Object.freeze({ untilMs: 30 * 60_000, everyMs: 60_000 }),
  Object.freeze({ untilMs: Number.POSITIVE_INFINITY, everyMs: 5 * 60_000 }),
]);
/** Non-urgent restarts (for example an unattended update) wait for pairing at most this long. */
const CONNECTOR_PAIRING_RESTART_DEFERRAL_MS = 30 * 60_000;

/** Each kind names what went wrong and has exactly one next step for the person or the launcher. */
const CONNECTOR_FAILURE_KINDS = Object.freeze([
  "tunnel_unavailable",
  "tunnel_missing",
  "tunnel_not_shared",
  "wrong_workspace",
  "never_contacted",
  "not_listed",
  "other_name",
  "menu_unavailable",
  "personalization_unavailable",
  "selection_failed",
]);
const CONNECTOR_FAILURE_CODE = /^connector_not_found(?::([a-z_]{1,40}))?$/;

function connectorCheckDelayMs(elapsedMs) {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  for (const step of CONNECTOR_CHECK_SCHEDULE) {
    if (elapsed < step.untilMs) return step.everyMs;
  }
  return CONNECTOR_CHECK_SCHEDULE.at(-1).everyMs;
}

function isConnectorFailureCode(code) {
  return typeof code === "string" && CONNECTOR_FAILURE_CODE.test(code);
}

/** The kind of a connector failure, from its structured code only; never from free text. */
function connectorFailureKind(errorOrCode) {
  const code = typeof errorOrCode === "string" ? errorOrCode : errorOrCode?.code;
  if (typeof code !== "string") return "unknown";
  const match = CONNECTOR_FAILURE_CODE.exec(code);
  if (!match) return "unknown";
  return match[1] && CONNECTOR_FAILURE_KINDS.includes(match[1]) ? match[1] : "unknown";
}

function isoOrNull(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function normalizeContact(value) {
  const status = value?.status === "observed" || value?.status === "not-observed" ? value.status : "unknown";
  const at = typeof value?.at === "string" && Number.isFinite(Date.parse(value.at)) ? value.at : null;
  return { status, at };
}

function createConnectorReadinessMonitor({
  logger,
  isEnabled,
  isVerified,
  isIdle,
  verify,
  observe = async () => ({ tunnelReady: null, contact: { status: "unknown", at: null }, workspaceMatch: "unknown" }),
  onVerified,
  onChange,
  now = Date.now,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = timer => clearTimeout(timer),
}) {
  if (typeof isEnabled !== "function" || typeof isVerified !== "function"
    || typeof isIdle !== "function" || typeof verify !== "function") {
    throw new Error("Connector readiness monitor requires isEnabled, isVerified, isIdle and verify");
  }
  let timer = null;
  let generation = 0;
  let inFlight = null;
  const state = {
    status: "idle",
    reason: null,
    armedAt: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    verifiedAt: null,
    lastFailureKind: null,
    checks: 0,
    tunnelReady: null,
    contact: { status: "unknown", at: null },
    connectorListed: null,
    workspaceMatch: "unknown",
    resendHint: false,
    waitingTurn: null,
  };

  const snapshot = () => ({
    status: state.status,
    reason: state.reason,
    armedAt: isoOrNull(state.armedAt),
    lastCheckedAt: isoOrNull(state.lastCheckedAt),
    nextCheckAt: isoOrNull(state.nextCheckAt),
    verifiedAt: isoOrNull(state.verifiedAt),
    lastFailureKind: state.lastFailureKind,
    checks: state.checks,
    tunnelReady: state.tunnelReady,
    contact: { ...state.contact },
    connectorListed: state.connectorListed,
    workspaceMatch: state.workspaceMatch,
    resendHint: state.resendHint,
    waitingTurn: state.waitingTurn && state.waitingTurn.until > now()
      ? { step: state.waitingTurn.step, total: state.waitingTurn.total }
      : null,
  });
  const publish = () => {
    try {
      onChange?.(snapshot());
    } catch (error) {
      logger?.warn?.("connector.readiness_publish_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const clear = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    state.nextCheckAt = null;
  };
  const schedule = (delayMs) => {
    clear();
    const scheduledGeneration = generation;
    const delay = Math.max(0, Math.round(delayMs));
    state.nextCheckAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      if (scheduledGeneration !== generation) return;
      void tick(scheduledGeneration);
    }, delay);
    timer?.unref?.();
  };
  const markVerified = (source) => {
    generation += 1;
    clear();
    state.status = "verified";
    state.verifiedAt = now();
    state.connectorListed = true;
    state.lastFailureKind = null;
    logger?.info?.("connector.readiness_verified", { source, checks: state.checks });
    try {
      onVerified?.(snapshot());
    } catch (error) {
      logger?.warn?.("connector.readiness_persist_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    publish();
  };
  const disable = () => {
    generation += 1;
    clear();
    state.status = "disabled";
    publish();
  };

  async function tick(tickGeneration) {
    if (tickGeneration !== generation) return;
    if (!isEnabled()) {
      disable();
      return;
    }
    if (isVerified()) {
      markVerified("state");
      return;
    }
    if (inFlight) {
      // A check from before the last re-arm is still finishing; its result is ignored. Try again
      // shortly instead of dropping this generation's schedule.
      schedule(FIRST_CHECK_DELAY_MS);
      return;
    }
    let idle = false;
    try {
      idle = await isIdle();
    } catch {
      idle = false;
    }
    if (tickGeneration !== generation) return;
    const elapsed = now() - state.armedAt;
    if (!idle) {
      state.status = "paused";
      schedule(Math.min(connectorCheckDelayMs(elapsed), IDLE_RETRY_MAX_DELAY_MS));
      publish();
      return;
    }
    state.status = "checking";
    state.nextCheckAt = null;
    publish();
    const run = (async () => {
      try {
        const observed = await observe();
        state.tunnelReady = typeof observed?.tunnelReady === "boolean" ? observed.tunnelReady : null;
        state.contact = normalizeContact(observed?.contact);
        state.workspaceMatch = observed?.workspaceMatch === "match" || observed?.workspaceMatch === "mismatch"
          ? observed.workspaceMatch
          : "unknown";
      } catch {
        state.tunnelReady = null;
        state.contact = { status: "unknown", at: null };
        state.workspaceMatch = "unknown";
      }
      if (tickGeneration !== generation) return;
      state.checks += 1;
      state.lastCheckedAt = now();
      try {
        await verify();
      } catch (error) {
        if (tickGeneration !== generation) return;
        state.lastFailureKind = connectorFailureKind(error);
        state.connectorListed = false;
        state.status = "waiting";
        logger?.info?.("connector.readiness_pending", {
          reason: state.reason,
          check: state.checks,
          kind: state.lastFailureKind,
          tunnelReady: state.tunnelReady,
          contact: state.contact.status,
        });
        schedule(connectorCheckDelayMs(now() - state.armedAt));
        publish();
        return;
      }
      if (tickGeneration !== generation) return;
      markVerified("background");
    })();
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  return {
    /**
     * (Re)arm the monitor. The schedule restarts from its fast cadence, so a new tunnel or a failed
     * turn is re-checked quickly. A verified connector is left alone unless `force` says the caller
     * has just learned that it stopped working.
     */
    start(reason = "start", { force = false, resendHint = false } = {}) {
      generation += 1;
      clear();
      state.reason = reason;
      if (!isEnabled()) {
        state.status = "disabled";
        publish();
        return snapshot();
      }
      if (!force && isVerified()) {
        state.status = "verified";
        state.connectorListed = true;
        publish();
        return snapshot();
      }
      state.status = "waiting";
      state.armedAt = now();
      state.connectorListed = force ? false : state.connectorListed;
      if (resendHint) state.resendHint = true;
      logger?.info?.("connector.readiness_armed", { reason });
      schedule(FIRST_CHECK_DELAY_MS);
      publish();
      return snapshot();
    },
    stop(reason = "stop") {
      generation += 1;
      clear();
      if (state.status !== "verified") {
        state.status = "idle";
        state.stoppedReason = reason;
      }
      publish();
      return snapshot();
    },
    /** Continue after a stop without restarting the schedule or the pairing window. */
    resume(reason = "resume") {
      if (state.status !== "idle" || !Number.isFinite(state.armedAt) || !isEnabled() || isVerified()) {
        return this.start(reason);
      }
      generation += 1;
      state.status = "waiting";
      schedule(connectorCheckDelayMs(now() - state.armedAt));
      publish();
      return snapshot();
    },
    /** A Codex turn failed because the connector was unavailable: re-check without any action. */
    noteTurnFailure(code) {
      if (!isConnectorFailureCode(code)) return false;
      state.lastFailureKind = connectorFailureKind(code);
      this.start("turn-failure", { force: true, resendHint: true });
      return true;
    },
    /** A new tunnel process may have changed what ChatGPT can see; re-check quickly if not verified. */
    noteTunnelRestarted() {
      if (state.status === "verified" || isVerified()) return false;
      this.start("tunnel-restart");
      return true;
    },
    /** The person pressed Verify: its result updates the same checklist. */
    noteManualResult(ok, error) {
      state.checks += 1;
      state.lastCheckedAt = now();
      if (ok) {
        markVerified("manual");
        return;
      }
      state.lastFailureKind = connectorFailureKind(error);
      state.connectorListed = false;
      publish();
    },
    /** Update the tunnel and contact rows without a browser check. */
    noteObservation(observed) {
      state.tunnelReady = typeof observed?.tunnelReady === "boolean" ? observed.tunnelReady : state.tunnelReady;
      if (observed?.contact) state.contact = normalizeContact(observed.contact);
      publish();
    },
    clearResendHint() {
      if (!state.resendHint) return;
      state.resendHint = false;
      publish();
    },
    /** A Codex turn is waiting for ChatGPT to list the connector: show its progress. */
    noteWaitingTurn({ step, total, waitMs }) {
      if (!Number.isInteger(step) || step < 1) return;
      state.waitingTurn = {
        step,
        total: Number.isInteger(total) && total >= step ? total : step,
        until: now() + (Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0) + 30_000,
      };
      publish();
    },
    noteTurnEnded() {
      if (!state.waitingTurn) return;
      state.waitingTurn = null;
      publish();
    },
    /** While a new connector is being paired, restarts that can wait (unattended updates) do wait. */
    restartDeferralActive() {
      return ["waiting", "checking", "paused"].includes(state.status)
        && Number.isFinite(state.armedAt)
        && state.reason !== "turn-failure"
        && now() - state.armedAt < CONNECTOR_PAIRING_RESTART_DEFERRAL_MS;
    },
    snapshot,
    /** Tests and the manual path can await the check that is currently running. */
    async settled() {
      await inFlight;
    },
  };
}

/**
 * What a Codex turn that waits for the connector may learn and ask: whether the tunnel answers
 * /readyz, whether ChatGPT has ever reached it, and one restart. The restart is granted only when
 * /readyz does not answer and no turn has an MCP tool call in flight, because restarting the
 * tunnel ends its MCP child and with it every call in progress.
 */
/**
 * Does the ChatGPT workspace in use reach this tunnel? Two ChatGPT accounts can be signed in at
 * once and ChatGPT Web switches between them (upstream feature request #563); on 19.09.2026 the
 * connector and the tunnel belonged to one account while every turn went to the other, and nothing
 * said so. A mismatch is claimed only when both ids are known: an unreadable selector or a tunnel
 * whose workspaces are unknown proves nothing.
 */
function chatGptWorkspaceMatch(registry, activeWorkspaceId) {
  if (registry?.status !== "ok") return "unknown";
  const workspaces = Array.isArray(registry.workspaceIds) ? registry.workspaceIds : [];
  if (workspaces.length === 0 || typeof activeWorkspaceId !== "string" || !activeWorkspaceId) return "unknown";
  return workspaces.includes(activeWorkspaceId) ? "match" : "mismatch";
}

/** What may leave this process about the registry: verdicts and a name, never a workspace id. */
function publishedRegistry(registry, workspaceMatch) {
  return {
    status: registry?.status === "ok" || registry?.status === "missing" || registry?.status === "unauthorized"
      ? registry.status
      : "unproven",
    sharing: registry?.sharing === "shared" || registry?.sharing === "not-shared" ? registry.sharing : "unknown",
    tunnelName: typeof registry?.tunnelName === "string" && registry.tunnelName ? registry.tunnelName : null,
    workspaceMatch,
  };
}

function createConnectorTunnelService({ supervisor, monitor, logger, activeWorkspaceId }) {
  return async function connectorTunnel({ restart = false, waitStep, waitTotal, waitMs } = {}) {
    let config = null;
    try {
      config = supervisor.readConfig();
    } catch {
      config = null;
    }
    if (!config || config.mode !== "full" || !config.tunnel) {
      return {
        tunnelReady: null,
        readyz: null,
        contact: { status: "unknown", at: null },
        registry: { status: "unproven", sharing: "unknown", tunnelName: null, workspaceMatch: "unknown" },
        restart: "not-configured",
      };
    }
    if (!supervisor.tunnelHealthBaseUrl) {
      try {
        await supervisor.discoverTunnelHealthBaseUrl(config);
      } catch {
        // A tunnel in the middle of a restart has no health URL yet; readiness stays unknown.
      }
    }
    let readyz = null;
    if (supervisor.tunnelHealthBaseUrl) {
      const probe = await supervisor.probeTunnelEndpoint("/readyz");
      readyz = probe.observed === true && probe.ok === true;
    }
    // OpenAI's own answer about the tunnel, cached by the supervisor: a tunnel that was deleted or
    // shared with no workspace cannot be healed by waiting, and the turn must say so at once.
    let registry;
    try {
      registry = await supervisor.probeTunnelRegistry(config);
    } catch {
      registry = null;
    }
    let active = null;
    try {
      active = await activeWorkspaceId?.();
    } catch {
      active = null;
    }
    const published = publishedRegistry(registry, chatGptWorkspaceMatch(registry, active));
    if (published.workspaceMatch === "mismatch") {
      logger?.warn?.("connector.chatgpt_workspace_mismatch", {});
    }
    let contact;
    try {
      contact = await supervisor.observeChatGptContact(config);
    } catch {
      contact = supervisor.tunnelContact(config);
    }
    let restartResult = "not-requested";
    if (restart === true) {
      if (readyz !== false) {
        restartResult = readyz === true ? "not-needed" : "health-unknown";
      } else {
        const health = await supervisor.proxyHealthPayload(config);
        const inFlight = Number.isInteger(health?.active_tool_calls) ? health.active_tool_calls : null;
        if (inFlight !== 0) {
          restartResult = "tool-calls-in-flight";
        } else {
          const requested = supervisor.requestConnectorTunnelRecovery(
            "the tunnel did not answer /readyz while a Codex turn waited for the connector",
          );
          restartResult = requested.requested ? "requested" : requested.reason;
        }
      }
      logger?.info?.("connector.tunnel_restart_decision", { readyz, result: restartResult });
    }
    monitor?.noteObservation({ tunnelReady: readyz, contact });
    if (Number.isInteger(waitStep) && waitStep > 0) monitor?.noteWaitingTurn({ step: waitStep, total: waitTotal, waitMs });
    return { tunnelReady: readyz, readyz, contact, registry: published, restart: restartResult };
  };
}

module.exports = {
  CONNECTOR_CHECK_SCHEDULE,
  CONNECTOR_FAILURE_KINDS,
  CONNECTOR_PAIRING_RESTART_DEFERRAL_MS,
  FIRST_CHECK_DELAY_MS,
  IDLE_RETRY_MAX_DELAY_MS,
  connectorCheckDelayMs,
  connectorFailureKind,
  createConnectorReadinessMonitor,
  chatGptWorkspaceMatch,
  createConnectorTunnelService,
  isConnectorFailureCode,
};
