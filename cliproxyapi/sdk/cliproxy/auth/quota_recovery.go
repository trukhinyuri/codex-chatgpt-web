package auth

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	log "github.com/sirupsen/logrus"
)

const (
	// defaultQuotaRecoveryInterval is how often credentials held in a quota
	// cooldown are probed upstream when no interval is configured.
	defaultQuotaRecoveryInterval = 5 * time.Minute
	// minQuotaRecoveryInterval bounds how aggressively upstream usage endpoints
	// may be polled, regardless of configuration.
	minQuotaRecoveryInterval = 30 * time.Second
	// quotaRecoveryProbeTimeout bounds one upstream probe call.
	quotaRecoveryProbeTimeout = 20 * time.Second
	// quotaRecoveryMaxConcurrency bounds how many probes run at once.
	quotaRecoveryMaxConcurrency = 4
)

// ErrQuotaProbeUnsupported is returned by QuotaProber implementations when the
// supplied credential cannot be probed (for example API-key credentials or a
// custom upstream without a usage endpoint). Such credentials are skipped
// silently by the recovery loop.
var ErrQuotaProbeUnsupported = errors.New("quota probe unsupported for credential")

// QuotaProbeResult describes the upstream quota state observed for one credential.
type QuotaProbeResult struct {
	// Available reports whether the upstream currently accepts requests for
	// the credential. When true, any quota cooldown held for the credential is
	// lifted before its scheduled expiry.
	Available bool
	// ResetAt is the earliest upstream reset time reported while the
	// credential is still limited. A zero value means the reset time is unknown.
	// The recovery loop only ever shortens an existing cooldown to this value;
	// it never extends one.
	ResetAt time.Time
	// Models optionally carries per-model availability reported upstream, keyed
	// by the upstream model name. Models marked unavailable keep their
	// model-level cooldown even when the credential as a whole is available.
	Models map[string]bool
}

// QuotaProber is an optional interface a ProviderExecutor may implement to
// report whether a credential's upstream quota is available again. The manager
// uses it to lift quota cooldowns early, for example after the user purchased a
// limit reset or when the upstream reset window differs from the value parsed
// out of the original rate-limit error.
type QuotaProber interface {
	ProbeQuota(ctx context.Context, auth *Auth) (QuotaProbeResult, error)
}

// StartQuotaRecovery launches a background loop that periodically probes
// credentials held in a quota cooldown and lifts the cooldown once the
// upstream reports the credential as available. Only one loop is kept alive;
// starting a new one cancels the previous run. A non-positive interval selects
// the default interval.
func (m *Manager) StartQuotaRecovery(parent context.Context, interval time.Duration) {
	if m == nil {
		return
	}
	interval = normalizeQuotaRecoveryInterval(interval)

	m.mu.Lock()
	cancelPrev := m.quotaRecoveryCancel
	m.quotaRecoveryCancel = nil
	m.mu.Unlock()
	if cancelPrev != nil {
		cancelPrev()
	}

	ctx, cancelCtx := context.WithCancel(parent)
	m.mu.Lock()
	m.quotaRecoveryCancel = cancelCtx
	m.mu.Unlock()

	go m.quotaRecoveryLoop(ctx, interval)
}

// StopQuotaRecovery cancels the background quota recovery loop, if running.
func (m *Manager) StopQuotaRecovery() {
	if m == nil {
		return
	}
	m.mu.Lock()
	cancel := m.quotaRecoveryCancel
	m.quotaRecoveryCancel = nil
	m.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func normalizeQuotaRecoveryInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return defaultQuotaRecoveryInterval
	}
	if interval < minQuotaRecoveryInterval {
		return minQuotaRecoveryInterval
	}
	return interval
}

func (m *Manager) quotaRecoveryLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.RunQuotaRecovery(ctx)
		}
	}
}

// RunQuotaRecovery performs one pass over credentials held in a quota
// cooldown, probes each one whose executor implements QuotaProber and lifts or
// shortens cooldowns according to the upstream answer. It returns the IDs of
// credentials whose cooldown was lifted. The pass never holds the manager lock
// while talking to an upstream.
func (m *Manager) RunQuotaRecovery(ctx context.Context) []string {
	if m == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	now := time.Now()

	type candidate struct {
		auth   *Auth
		prober QuotaProber
	}
	candidates := make([]candidate, 0)

	m.mu.RLock()
	for _, auth := range m.auths {
		if auth == nil || auth.Disabled || auth.Status == StatusDisabled {
			continue
		}
		if !authHeldInQuotaCooldown(auth, now) {
			continue
		}
		executor := m.executors[executorKeyFromAuth(auth)]
		prober, ok := executor.(QuotaProber)
		if !ok || prober == nil {
			continue
		}
		candidates = append(candidates, candidate{auth: auth.Clone(), prober: prober})
	}
	m.mu.RUnlock()

	if len(candidates) == 0 {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].auth.ID < candidates[j].auth.ID })

	type outcome struct {
		authID string
		result QuotaProbeResult
		err    error
	}
	outcomes := make([]outcome, len(candidates))

	var wg sync.WaitGroup
	sem := make(chan struct{}, quotaRecoveryMaxConcurrency)
	for i := range candidates {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			probeCtx, cancel := context.WithTimeout(ctx, quotaRecoveryProbeTimeout)
			defer cancel()
			result, err := candidates[i].prober.ProbeQuota(probeCtx, candidates[i].auth)
			outcomes[i] = outcome{authID: candidates[i].auth.ID, result: result, err: err}
		}(i)
	}
	wg.Wait()

	recovered := make([]string, 0)
	snapshots := make([]*Auth, 0)
	cooldownStateChanged := false

	for _, o := range outcomes {
		if o.authID == "" {
			continue
		}
		if o.err != nil {
			if errors.Is(o.err, ErrQuotaProbeUnsupported) || errors.Is(o.err, context.Canceled) {
				continue
			}
			log.Debugf("quota recovery: probe failed for auth %s: %v", o.authID, o.err)
			continue
		}
		applied := time.Now()
		m.mu.Lock()
		auth := m.auths[o.authID]
		if auth == nil || auth.Disabled || auth.Status == StatusDisabled || !authHeldInQuotaCooldown(auth, applied) {
			m.mu.Unlock()
			continue
		}
		changed := false
		if o.result.Available {
			changed = liftQuotaCooldownForAuth(auth, o.result.Models, applied)
			if changed {
				recovered = append(recovered, auth.ID)
			}
		} else if !o.result.ResetAt.IsZero() {
			changed = shortenQuotaCooldownForAuth(auth, o.result.ResetAt, applied)
		}
		if changed {
			auth.UpdatedAt = applied
			snapshots = append(snapshots, auth.Clone())
			cooldownStateChanged = true
		}
		m.mu.Unlock()

		if changed {
			if o.result.Available {
				log.Infof("quota recovery: upstream reports credential %s available again, cooldown lifted", describeAuthForQuotaRecovery(auth))
			} else {
				log.Infof("quota recovery: upstream reports reset at %s for credential %s, cooldown shortened", o.result.ResetAt.Format(time.RFC3339), describeAuthForQuotaRecovery(auth))
			}
		}
	}

	if m.scheduler != nil {
		for _, snapshot := range snapshots {
			m.scheduler.upsertAuth(snapshot)
		}
	}
	if cooldownStateChanged {
		m.persistCooldownStates(context.Background())
	}
	if hook := m.quotaRecoveryPassHook; hook != nil {
		hook(recovered)
	}
	return recovered
}

// authHeldInQuotaCooldown reports whether the credential or any of its model
// states is currently held back by an unexpired quota cooldown.
func authHeldInQuotaCooldown(auth *Auth, now time.Time) bool {
	if auth == nil {
		return false
	}
	if auth.Quota.Exceeded && auth.Quota.NextRecoverAt.After(now) {
		return true
	}
	for _, state := range auth.ModelStates {
		if state != nil && state.Quota.Exceeded && state.Quota.NextRecoverAt.After(now) {
			return true
		}
	}
	return false
}

// liftQuotaCooldownForAuth treats an upstream "available" answer like a
// successful request: the credential-level cooldown is cleared and every
// model state is reset, except models the upstream explicitly reports as
// unavailable, which keep their own cooldown. The credential-level quota is
// then re-aggregated from the remaining model states, exactly as after a
// successful request. It returns true when any state changed.
func liftQuotaCooldownForAuth(auth *Auth, models map[string]bool, now time.Time) bool {
	if auth == nil {
		return false
	}
	keep := make(map[string]struct{})
	for model, available := range models {
		if !available {
			keep[canonicalModelKey(model)] = struct{}{}
		}
	}

	changed := false
	if auth.Unavailable || !auth.NextRetryAfter.IsZero() || auth.Quota.Exceeded || !auth.Quota.NextRecoverAt.IsZero() {
		auth.Unavailable = false
		auth.NextRetryAfter = time.Time{}
		applyCooldownFields(&auth.Quota, QuotaState{})
		changed = true
	}
	for key, state := range auth.ModelStates {
		if state == nil {
			continue
		}
		if _, held := keep[canonicalModelKey(key)]; held {
			continue
		}
		if state.Unavailable || state.Status == StatusError || state.LastError != nil || !state.NextRetryAfter.IsZero() || state.Quota.Exceeded || !state.Quota.NextRecoverAt.IsZero() {
			resetModelState(state, now)
			changed = true
		}
	}
	if len(auth.ModelStates) > 0 {
		updateAggregatedAvailability(auth, now)
	}
	if !auth.Disabled && auth.Status != StatusDisabled && !hasModelError(auth, now) {
		auth.LastError = nil
		auth.StatusMessage = ""
		auth.Status = StatusActive
	}
	return changed
}

// shortenQuotaCooldownForAuth moves an unexpired quota cooldown deadline
// earlier when the upstream reports a sooner reset. Deadlines are never
// extended. It returns true when any deadline moved.
func shortenQuotaCooldownForAuth(auth *Auth, resetAt time.Time, now time.Time) bool {
	if auth == nil || resetAt.IsZero() || !resetAt.After(now) {
		return false
	}
	changed := false
	if auth.Quota.Exceeded && auth.Quota.NextRecoverAt.After(resetAt) {
		auth.Quota.NextRecoverAt = resetAt
		changed = true
	}
	if !auth.NextRetryAfter.IsZero() && auth.NextRetryAfter.After(resetAt) {
		auth.NextRetryAfter = resetAt
		changed = true
	}
	for _, state := range auth.ModelStates {
		if state == nil {
			continue
		}
		if state.Quota.Exceeded && state.Quota.NextRecoverAt.After(resetAt) {
			state.Quota.NextRecoverAt = resetAt
			state.UpdatedAt = now
			changed = true
		}
		if !state.NextRetryAfter.IsZero() && state.NextRetryAfter.After(resetAt) {
			state.NextRetryAfter = resetAt
			state.UpdatedAt = now
			changed = true
		}
	}
	return changed
}

func describeAuthForQuotaRecovery(auth *Auth) string {
	if auth == nil {
		return ""
	}
	parts := make([]string, 0, 3)
	if auth.Provider != "" {
		parts = append(parts, "provider="+auth.Provider)
	}
	if auth.FileName != "" {
		parts = append(parts, "auth_file="+auth.FileName)
	} else if auth.ID != "" {
		parts = append(parts, "id="+auth.ID)
	}
	return strings.Join(parts, " ")
}
