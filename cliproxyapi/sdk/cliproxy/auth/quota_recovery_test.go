package auth

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	cliproxyexecutor "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/executor"
)

type quotaProbeExecutor struct {
	identifier string
	mu         sync.Mutex
	calls      []string
	results    map[string]QuotaProbeResult
	errs       map[string]error
}

func (e *quotaProbeExecutor) Identifier() string { return e.identifier }
func (e *quotaProbeExecutor) Execute(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}
func (e *quotaProbeExecutor) ExecuteStream(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return nil, nil
}
func (e *quotaProbeExecutor) Refresh(_ context.Context, auth *Auth) (*Auth, error) { return auth, nil }
func (e *quotaProbeExecutor) CountTokens(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}
func (e *quotaProbeExecutor) HttpRequest(context.Context, *Auth, *http.Request) (*http.Response, error) {
	return nil, nil
}
func (e *quotaProbeExecutor) ProbeQuota(_ context.Context, auth *Auth) (QuotaProbeResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, auth.ID)
	if err, ok := e.errs[auth.ID]; ok {
		return QuotaProbeResult{}, err
	}
	return e.results[auth.ID], nil
}
func (e *quotaProbeExecutor) callCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.calls)
}

type plainExecutor struct{ identifier string }

func (e *plainExecutor) Identifier() string { return e.identifier }
func (e *plainExecutor) Execute(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}
func (e *plainExecutor) ExecuteStream(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (*cliproxyexecutor.StreamResult, error) {
	return nil, nil
}
func (e *plainExecutor) Refresh(_ context.Context, auth *Auth) (*Auth, error) { return auth, nil }
func (e *plainExecutor) CountTokens(context.Context, *Auth, cliproxyexecutor.Request, cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	return cliproxyexecutor.Response{}, nil
}
func (e *plainExecutor) HttpRequest(context.Context, *Auth, *http.Request) (*http.Response, error) {
	return nil, nil
}

func newQuotaCooldownAuth(id, provider string, recoverAt time.Time) *Auth {
	return &Auth{
		ID:             id,
		Provider:       provider,
		Status:         StatusError,
		Unavailable:    true,
		NextRetryAfter: recoverAt,
		Quota: QuotaState{
			Exceeded:      true,
			Reason:        "credential_quota",
			NextRecoverAt: recoverAt,
		},
		ModelStates: map[string]*ModelState{
			"gpt-6-astra": {
				Unavailable:    true,
				Status:         StatusError,
				NextRetryAfter: recoverAt,
				Quota:          QuotaState{Exceeded: true, Reason: "quota", NextRecoverAt: recoverAt},
			},
			"gpt-5.6-luna": {
				Unavailable:    true,
				Status:         StatusError,
				NextRetryAfter: recoverAt,
				Quota:          QuotaState{Exceeded: true, Reason: "credential_quota", NextRecoverAt: recoverAt},
			},
		},
	}
}

func registerForQuotaTest(t *testing.T, manager *Manager, auth *Auth) {
	t.Helper()
	if _, err := manager.Register(context.Background(), auth); err != nil {
		t.Fatalf("register auth %s: %v", auth.ID, err)
	}
}

func TestRunQuotaRecovery_LiftsCooldownWhenUpstreamAvailable(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	recoverAt := time.Now().Add(48 * time.Hour)
	executor := &quotaProbeExecutor{
		identifier: "codex",
		results: map[string]QuotaProbeResult{
			"codex-a": {Available: true, Models: map[string]bool{"gpt-6-astra": true}},
		},
	}
	manager.RegisterExecutor(executor)
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-a", "codex", recoverAt))

	recovered := manager.RunQuotaRecovery(context.Background())
	if len(recovered) != 1 || recovered[0] != "codex-a" {
		t.Fatalf("expected codex-a to be recovered, got %v", recovered)
	}
	auth, ok := manager.GetByID("codex-a")
	if !ok {
		t.Fatalf("auth missing after recovery")
	}
	if auth.Unavailable || auth.Quota.Exceeded || !auth.NextRetryAfter.IsZero() || !auth.Quota.NextRecoverAt.IsZero() {
		t.Fatalf("expected credential cooldown to be cleared, got %#v", auth.Quota)
	}
	if auth.Status != StatusActive {
		t.Fatalf("expected status active, got %s", auth.Status)
	}
	for model, state := range auth.ModelStates {
		if state.Unavailable || state.Quota.Exceeded || !state.NextRetryAfter.IsZero() {
			t.Fatalf("expected model %s cooldown to be cleared, got %#v", model, state.Quota)
		}
	}
	if executor.callCount() != 1 {
		t.Fatalf("expected one probe call, got %d", executor.callCount())
	}
}

func TestRunQuotaRecovery_KeepsModelsReportedUnavailable(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	recoverAt := time.Now().Add(48 * time.Hour)
	executor := &quotaProbeExecutor{
		identifier: "codex",
		results: map[string]QuotaProbeResult{
			"codex-b": {Available: true, Models: map[string]bool{"gpt-6-astra": false, "gpt-5.6-luna": true}},
		},
	}
	manager.RegisterExecutor(executor)
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-b", "codex", recoverAt))

	if recovered := manager.RunQuotaRecovery(context.Background()); len(recovered) != 1 {
		t.Fatalf("expected recovery, got %v", recovered)
	}
	auth, _ := manager.GetByID("codex-b")
	if auth.Unavailable || auth.Quota.Reason == "credential_quota" {
		t.Fatalf("expected credential-scoped cooldown to be lifted, got unavailable=%v quota=%#v", auth.Unavailable, auth.Quota)
	}
	astra := auth.ModelStates["gpt-6-astra"]
	if astra == nil || !astra.Quota.Exceeded || !astra.Quota.NextRecoverAt.Equal(recoverAt) {
		t.Fatalf("expected gpt-6-astra cooldown to be retained, got %#v", astra)
	}
	luna := auth.ModelStates["gpt-5.6-luna"]
	if luna == nil || luna.Quota.Exceeded || luna.Unavailable {
		t.Fatalf("expected gpt-5.6-luna cooldown to be cleared, got %#v", luna)
	}
}

func TestRunQuotaRecovery_ShortensCooldownToUpstreamReset(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	recoverAt := time.Now().Add(48 * time.Hour)
	sooner := time.Now().Add(2 * time.Hour).Truncate(time.Second)
	later := time.Now().Add(96 * time.Hour)
	executor := &quotaProbeExecutor{
		identifier: "codex",
		results: map[string]QuotaProbeResult{
			"codex-c": {Available: false, ResetAt: sooner},
			"codex-d": {Available: false, ResetAt: later},
		},
	}
	manager.RegisterExecutor(executor)
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-c", "codex", recoverAt))
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-d", "codex", recoverAt))

	if recovered := manager.RunQuotaRecovery(context.Background()); len(recovered) != 0 {
		t.Fatalf("expected no recovery, got %v", recovered)
	}
	shortened, _ := manager.GetByID("codex-c")
	if !shortened.Quota.NextRecoverAt.Equal(sooner) || !shortened.NextRetryAfter.Equal(sooner) {
		t.Fatalf("expected cooldown shortened to %s, got quota=%s retry=%s", sooner, shortened.Quota.NextRecoverAt, shortened.NextRetryAfter)
	}
	for model, state := range shortened.ModelStates {
		if !state.Quota.NextRecoverAt.Equal(sooner) {
			t.Fatalf("expected model %s cooldown shortened, got %s", model, state.Quota.NextRecoverAt)
		}
	}
	untouched, _ := manager.GetByID("codex-d")
	if !untouched.Quota.NextRecoverAt.Equal(recoverAt) {
		t.Fatalf("expected later upstream reset to never extend cooldown, got %s", untouched.Quota.NextRecoverAt)
	}
}

func TestRunQuotaRecovery_SkipsIneligibleCredentials(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	recoverAt := time.Now().Add(48 * time.Hour)
	executor := &quotaProbeExecutor{
		identifier: "codex",
		results:    map[string]QuotaProbeResult{"codex-healthy": {Available: true}},
		errs: map[string]error{
			"codex-unsupported": ErrQuotaProbeUnsupported,
			"codex-failing":     errors.New("upstream 503"),
		},
	}
	manager.RegisterExecutor(executor)
	manager.RegisterExecutor(&plainExecutor{identifier: "claude"})

	healthy := &Auth{ID: "codex-healthy", Provider: "codex", Status: StatusActive}
	registerForQuotaTest(t, manager, healthy)
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-unsupported", "codex", recoverAt))
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-failing", "codex", recoverAt))
	disabled := newQuotaCooldownAuth("codex-disabled", "codex", recoverAt)
	disabled.Disabled = true
	disabled.Status = StatusDisabled
	registerForQuotaTest(t, manager, disabled)
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("claude-no-prober", "claude", recoverAt))

	if recovered := manager.RunQuotaRecovery(context.Background()); len(recovered) != 0 {
		t.Fatalf("expected no recovery, got %v", recovered)
	}
	if executor.callCount() != 2 {
		t.Fatalf("expected probes only for cooled-down codex credentials, got %d calls: %v", executor.callCount(), executor.calls)
	}
	for _, id := range []string{"codex-unsupported", "codex-failing", "claude-no-prober"} {
		auth, _ := manager.GetByID(id)
		if !auth.Quota.Exceeded || !auth.Quota.NextRecoverAt.Equal(recoverAt) {
			t.Fatalf("expected %s cooldown untouched, got %#v", id, auth.Quota)
		}
	}
}

func TestQuotaRecoveryLoop_RunsPasses(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	recoverAt := time.Now().Add(48 * time.Hour)
	executor := &quotaProbeExecutor{
		identifier: "codex",
		results:    map[string]QuotaProbeResult{"codex-loop": {Available: true}},
	}
	manager.RegisterExecutor(executor)
	registerForQuotaTest(t, manager, newQuotaCooldownAuth("codex-loop", "codex", recoverAt))

	if got := normalizeQuotaRecoveryInterval(0); got != defaultQuotaRecoveryInterval {
		t.Fatalf("expected default interval, got %s", got)
	}
	if got := normalizeQuotaRecoveryInterval(time.Second); got != minQuotaRecoveryInterval {
		t.Fatalf("expected interval floor, got %s", got)
	}

	passes := make(chan []string, 4)
	manager.quotaRecoveryPassHook = func(recovered []string) {
		select {
		case passes <- recovered:
		default:
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Drive the loop directly with a short interval; StartQuotaRecovery enforces
	// the production floor, which is too slow for a unit test.
	go manager.quotaRecoveryLoop(ctx, 5*time.Millisecond)

	select {
	case recovered := <-passes:
		if len(recovered) != 1 || recovered[0] != "codex-loop" {
			t.Fatalf("expected first pass to recover codex-loop, got %v", recovered)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("expected the loop to run a recovery pass")
	}
	cancel()
	if auth, ok := manager.GetByID("codex-loop"); !ok || auth.Quota.Exceeded {
		t.Fatalf("expected loop to lift the cooldown")
	}
}

func TestStartQuotaRecovery_StopCancelsLoop(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	manager.StartQuotaRecovery(context.Background(), time.Minute)
	manager.mu.RLock()
	cancel := manager.quotaRecoveryCancel
	manager.mu.RUnlock()
	if cancel == nil {
		t.Fatalf("expected loop cancel to be registered")
	}
	manager.StopQuotaRecovery()
	manager.mu.RLock()
	cancel = manager.quotaRecoveryCancel
	manager.mu.RUnlock()
	if cancel != nil {
		t.Fatalf("expected loop cancel to be cleared after stop")
	}
}
