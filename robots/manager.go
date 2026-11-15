package robots

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

var (
	// ErrStaleGeneration means a fetch completed after its origin had already
	// advanced to a newer policy generation.
	ErrStaleGeneration = errors.New("robots: stale policy generation")
	// ErrManagerClosed is returned after Manager.Close.
	ErrManagerClosed = errors.New("robots: manager closed")
	// ErrNilRules is returned when publishing a policy without rules.
	ErrNilRules = errors.New("robots: nil rules")
	// ErrPolicySuperseded is the cancellation cause for claims and permits
	// that were displaced by a newer policy version.
	ErrPolicySuperseded = errors.New("robots: policy superseded")
)

// Config configures a Manager.
type Config struct {
	Cache     *Cache
	Fetcher   Fetcher
	Auditor   Auditor
	Evidence  EvidenceStore
	UserAgent string

	// TTL is the lifetime of a successfully fetched policy. Zero uses the
	// default (24h); a negative value means never expire.
	TTL time.Duration
	// FailureTTL is the lifetime of a fail-open/fail-closed fallback. Zero
	// uses the default (5m); a negative value means never expire.
	FailureTTL time.Duration
	// FailureMode is used for transport errors, 5xx responses, oversized
	// bodies and parse failures. The zero value is FailClosed.
	FailureMode FailureMode
	// MaxBodyBytes bounds the robots.txt body. Zero uses 512 KiB.
	MaxBodyBytes int64
	Clock        Clock
}

// DefaultConfig returns production-oriented defaults.
func DefaultConfig() Config {
	return Config{
		UserAgent:    "q0216-robots/1.0",
		TTL:          24 * time.Hour,
		FailureTTL:   5 * time.Minute,
		FailureMode:  FailClosed,
		MaxBodyBytes: 512 << 10,
		Clock:        time.Now,
	}
}

type flight struct {
	done     chan struct{}
	snapshot Snapshot
	err      error
}

type fetchOutcome struct {
	rules       *Rules
	ttl         time.Duration
	source      Source
	degraded    bool
	failureMode FailureMode
	kind        AuditKind
	message     string
	problem     string
	err         error
}

// Manager coordinates fetching, caching, policy revisions, claims and audit
// events for any number of tenants.
type Manager struct {
	cfg      Config
	cache    *Cache
	fetcher  Fetcher
	auditor  Auditor
	evidence EvidenceStore
	clock    Clock

	mu       sync.Mutex
	inflight map[Scope]*flight
	claims   map[Scope]map[*Claim]struct{}
	closed   bool
}

// NewManager creates a manager, applying defaults for zero config fields.
func NewManager(cfg Config) (*Manager, error) {
	cfg, err := normaliseConfig(cfg)
	if err != nil {
		return nil, err
	}

	cache := cfg.Cache
	if cache == nil {
		cache = NewCache(WithCacheClock(cfg.Clock))
	}
	fetcher := cfg.Fetcher
	if fetcher == nil {
		fetcher = NewHTTPFetcher(HTTPFetcherConfig{MaxBodyBytes: cfg.MaxBodyBytes})
	}
	evidence := cfg.Evidence
	if evidence == nil {
		evidence = NewMemoryEvidenceStore()
	}

	return &Manager{
		cfg:      cfg,
		cache:    cache,
		fetcher:  fetcher,
		auditor:  cfg.Auditor,
		evidence: evidence,
		clock:    cfg.Clock,
		inflight: make(map[Scope]*flight),
		claims:   make(map[Scope]map[*Claim]struct{}),
	}, nil
}

func normaliseConfig(cfg Config) (Config, error) {
	defaults := DefaultConfig()
	if cfg.UserAgent == "" {
		cfg.UserAgent = defaults.UserAgent
	}
	if cfg.TTL == 0 {
		cfg.TTL = defaults.TTL
	}
	if cfg.FailureTTL == 0 {
		cfg.FailureTTL = defaults.FailureTTL
	}
	if cfg.MaxBodyBytes == 0 {
		cfg.MaxBodyBytes = defaults.MaxBodyBytes
	}
	if cfg.MaxBodyBytes < 0 {
		return cfg, fmt.Errorf("robots: MaxBodyBytes must not be negative")
	}
	if cfg.Clock == nil {
		cfg.Clock = defaults.Clock
	}
	if cfg.FailureMode != FailClosed && cfg.FailureMode != FailOpen {
		return cfg, fmt.Errorf("robots: invalid failure mode %d", cfg.FailureMode)
	}
	return cfg, nil
}

// MustNewManager is NewManager with a panic on invalid configuration.
func MustNewManager(cfg Config) *Manager {
	manager, err := NewManager(cfg)
	if err != nil {
		panic(err)
	}
	return manager
}

// New is an alias for NewManager.
func New(cfg Config) (*Manager, error) {
	return NewManager(cfg)
}

// Resolve returns a fresh policy snapshot, fetching robots.txt when necessary.
// A network or parse failure is converted to the configured fallback policy
// and still returns a usable snapshot; the fallback is marked Degraded and is
// recorded through the Auditor.
func (m *Manager) Resolve(ctx context.Context, tenant string, origin Origin) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	canonical, err := origin.Canonical()
	if err != nil {
		return Snapshot{}, err
	}
	origin = canonical
	if err := m.checkOpen(); err != nil {
		return Snapshot{}, err
	}

	scope := Scope{Tenant: tenant, Origin: origin}
	if snapshot, ok := m.cache.Get(scope); ok {
		return snapshot, nil
	}
	return m.refresh(ctx, scope, false)
}

// Refresh forces a network refresh even when the cached entry is fresh.
func (m *Manager) Refresh(ctx context.Context, tenant string, origin Origin) (Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	canonical, err := origin.Canonical()
	if err != nil {
		return Snapshot{}, err
	}
	origin = canonical
	if err := m.checkOpen(); err != nil {
		return Snapshot{}, err
	}
	return m.refresh(ctx, Scope{Tenant: tenant, Origin: origin}, true)
}

func (m *Manager) refresh(ctx context.Context, scope Scope, force bool) (Snapshot, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Snapshot{}, ErrManagerClosed
	}
	if current := m.inflight[scope]; current != nil {
		m.mu.Unlock()
		select {
		case <-current.done:
			return current.snapshot, current.err
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		}
	}
	if !force {
		// A concurrent flight may have completed between Resolve's cache miss
		// and this lock. Rechecking closes the check-then-start window without
		// weakening the single-flight guarantee.
		if snapshot, ok := m.cache.Get(scope); ok {
			m.mu.Unlock()
			return snapshot, nil
		}
	}
	current := &flight{done: make(chan struct{})}
	m.inflight[scope] = current
	m.mu.Unlock()

	snapshot, err := m.fetchAndInstall(ctx, scope)

	m.mu.Lock()
	current.snapshot = snapshot
	current.err = err
	delete(m.inflight, scope)
	close(current.done)
	m.mu.Unlock()
	return snapshot, err
}

func (m *Manager) fetchAndInstall(ctx context.Context, scope Scope) (Snapshot, error) {
	baseVersion := m.cache.LastVersion(scope)
	body, fetchErr := m.fetcher.Fetch(ctx, scope.Origin, m.cfg.UserAgent)
	if ctx.Err() != nil {
		return Snapshot{}, ctx.Err()
	}

	outcome := m.classify(body, fetchErr)
	snapshot := Snapshot{
		Tenant:      scope.Tenant,
		Origin:      scope.Origin,
		Rules:       outcome.rules,
		Source:      outcome.source,
		Degraded:    outcome.degraded,
		FailureMode: outcome.failureMode,
		Problem:     outcome.problem,
	}
	stored, ok := m.putIfVersion(scope, baseVersion, snapshot, outcome.ttl)
	if !ok {
		m.record(AuditEvent{
			Kind:       AuditPolicyStale,
			Tenant:     scope.Tenant,
			Origin:     scope.Origin,
			Version:    baseVersion,
			Generation: stored.Generation,
			Degraded:   stored.Degraded,
			Message:    fmt.Sprintf("discarded fetch for version %d; current version is %d", baseVersion, stored.Version),
			Err:        ErrStaleGeneration,
		})
		if stored.Version == 0 || !stored.Fresh(m.cache.Now()) {
			return stored, ErrStaleGeneration
		}
		return stored, nil
	}

	m.auditOutcome(scope, stored, outcome)
	m.record(AuditEvent{
		Kind:        AuditPolicyInstalled,
		Tenant:      scope.Tenant,
		Origin:      scope.Origin,
		Version:     stored.Version,
		Generation:  stored.Generation,
		FailureMode: stored.FailureMode,
		Degraded:    stored.Degraded,
		Message:     string(stored.Source),
	})
	m.notifyInstalled(stored)
	return stored, nil
}

func (m *Manager) classify(body []byte, fetchErr error) fetchOutcome {
	switch {
	case fetchErr == nil:
		rules, err := ParseBytes(body)
		if err != nil {
			return m.fallback(err)
		}
		return fetchOutcome{
			rules:   rules,
			ttl:     m.cfg.TTL,
			source:  SourceFetched,
			kind:    AuditPolicyFetched,
			message: fmt.Sprintf("parsed %d bytes", len(body)),
		}
	case errors.Is(fetchErr, ErrRobotsNotFound):
		return fetchOutcome{
			rules:   AllowAllRules(),
			ttl:     m.cfg.TTL,
			source:  SourceAbsent,
			kind:    AuditPolicyAbsent,
			message: fetchErr.Error(),
		}
	case errors.Is(fetchErr, ErrRobotsAccessDenied):
		return fetchOutcome{
			rules:   DisallowAllRules(),
			ttl:     m.cfg.TTL,
			source:  SourceAccessDenied,
			kind:    AuditPolicyAccessDenied,
			message: fetchErr.Error(),
		}
	default:
		return m.fallback(fetchErr)
	}
}

func (m *Manager) fallback(cause error) fetchOutcome {
	rules := DisallowAllRules()
	if m.cfg.FailureMode == FailOpen {
		rules = AllowAllRules()
	}
	message := "robots.txt unavailable"
	if cause != nil {
		message = cause.Error()
	}
	return fetchOutcome{
		rules:       rules,
		ttl:         m.cfg.FailureTTL,
		source:      SourceFallback,
		degraded:    true,
		failureMode: m.cfg.FailureMode,
		kind:        AuditFetchFailed,
		message:     message,
		problem:     message,
		err:         cause,
	}
}

func (m *Manager) auditOutcome(scope Scope, snapshot Snapshot, outcome fetchOutcome) {
	common := AuditEvent{
		Tenant:      scope.Tenant,
		Origin:      scope.Origin,
		Version:     snapshot.Version,
		Generation:  snapshot.Generation,
		FailureMode: outcome.failureMode,
		Degraded:    outcome.degraded,
		Message:     outcome.message,
		Err:         outcome.err,
	}
	first := common
	first.Kind = outcome.kind
	m.record(first)

	if outcome.degraded {
		second := common
		second.Kind = AuditFallback
		second.Message = fmt.Sprintf("installed %s fallback policy", outcome.failureMode)
		m.record(second)
	}
}

func (m *Manager) notifyInstalled(snapshot Snapshot) {
	scope := Scope{Tenant: snapshot.Tenant, Origin: snapshot.Origin}
	m.mu.Lock()
	set := m.claims[scope]
	var revoked []*Claim
	for claim := range set {
		if claim.snapshot.Version < snapshot.Version {
			delete(set, claim)
			revoked = append(revoked, claim)
		}
	}
	if len(set) == 0 {
		delete(m.claims, scope)
	}
	m.mu.Unlock()

	for _, claim := range revoked {
		canceled := claim.revoke(ErrPolicySuperseded)
		m.record(AuditEvent{
			Kind:       AuditClaimRevoked,
			Tenant:     claim.tenant,
			Origin:     claim.origin,
			Version:    claim.snapshot.Version,
			Generation: claim.snapshot.Generation,
			Message:    fmt.Sprintf("superseded by policy version %d", snapshot.Version),
			Err:        ErrPolicySuperseded,
		})
		m.auditCanceled(claim, ErrPolicySuperseded, canceled)
	}
}

func (m *Manager) auditCanceled(claim *Claim, cause error, canceled []canceledPermit) {
	for _, permit := range canceled {
		m.record(AuditEvent{
			Kind:       AuditRequestCanceled,
			Tenant:     claim.tenant,
			Origin:     claim.origin,
			Version:    permit.version,
			Generation: permit.generation,
			Target:     permit.target,
			Message:    "request had not been sent",
			Err:        cause,
		})
	}
}

// Task describes a unit of work whose policy must be bound before fetching.
type Task struct {
	Tenant    string
	URL       string
	UserAgent string
	Origin    Origin
}

// Claim binds a task to the currently fresh policy version for its origin.
// The returned lease remains valid until a newer policy for the same origin is
// installed, the claim is released, or the manager is closed.
func (m *Manager) Claim(ctx context.Context, task Task) (*Claim, error) {
	origin := task.Origin
	if origin.IsZero() {
		if strings.TrimSpace(task.URL) == "" {
			return nil, fmt.Errorf("%w: task URL or origin is required", ErrInvalidOrigin)
		}
		parsed, err := ParseOrigin(task.URL)
		if err != nil {
			return nil, err
		}
		origin = parsed
	}
	return m.ClaimFor(ctx, task.Tenant, origin, task.UserAgent)
}

// Lease is an alias for Claim.
func (m *Manager) Lease(ctx context.Context, task Task) (*Claim, error) {
	return m.Claim(ctx, task)
}

// ClaimTask is an alias for Claim.
func (m *Manager) ClaimTask(ctx context.Context, task Task) (*Claim, error) {
	return m.Claim(ctx, task)
}

// ClaimFor binds an explicitly supplied tenant, origin and user agent.
func (m *Manager) ClaimFor(ctx context.Context, tenant string, origin Origin, userAgent string) (*Claim, error) {
	if userAgent == "" {
		userAgent = m.cfg.UserAgent
	}
	canonical, err := origin.Canonical()
	if err != nil {
		return nil, err
	}
	origin = canonical
	scope := Scope{Tenant: tenant, Origin: origin}

	for attempt := 0; attempt < 2; attempt++ {
		snapshot, err := m.Resolve(ctx, tenant, origin)
		if err != nil {
			return nil, err
		}
		claim := &Claim{
			manager:   m,
			tenant:    tenant,
			origin:    origin,
			userAgent: userAgent,
			snapshot:  snapshot,
			permits:   make(map[*Permit]struct{}),
		}

		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return nil, ErrManagerClosed
		}
		if last := m.cache.LastVersion(scope); last > snapshot.Version {
			m.mu.Unlock()
			continue
		}
		set := m.claims[scope]
		if set == nil {
			set = make(map[*Claim]struct{})
			m.claims[scope] = set
		}
		set[claim] = struct{}{}
		m.mu.Unlock()

		m.record(AuditEvent{
			Kind:       AuditClaimBound,
			Tenant:     tenant,
			Origin:     origin,
			Version:    snapshot.Version,
			Generation: snapshot.Generation,
			Degraded:   snapshot.Degraded,
			Message:    string(snapshot.Source),
		})
		return claim, nil
	}
	return nil, ErrPolicySuperseded
}

// InstallPolicy publishes rules without a network fetch. It is useful for
// operators and tests that need to simulate a new policy generation.
func (m *Manager) InstallPolicy(tenant string, origin Origin, rules *Rules, ttl time.Duration) (Snapshot, error) {
	if rules == nil {
		return Snapshot{}, ErrNilRules
	}
	canonical, err := origin.Canonical()
	if err != nil {
		return Snapshot{}, err
	}
	origin = canonical
	if ttl == 0 {
		ttl = m.cfg.TTL
	}
	if err := m.checkOpen(); err != nil {
		return Snapshot{}, err
	}

	scope := Scope{Tenant: tenant, Origin: origin}
	snapshot := m.putPolicy(scope, Snapshot{
		Rules:  rules,
		Source: SourceOperator,
	}, ttl)
	m.record(AuditEvent{
		Kind:       AuditPolicyInstalled,
		Tenant:     tenant,
		Origin:     origin,
		Version:    snapshot.Version,
		Generation: snapshot.Generation,
		Message:    "installed by operator",
	})
	m.notifyInstalled(snapshot)
	return snapshot, nil
}

// Publish is a lower-level variant of InstallPolicy that stores a supplied
// snapshot.
func (m *Manager) Publish(tenant string, origin Origin, snapshot Snapshot, ttl time.Duration) (Snapshot, error) {
	if snapshot.Rules == nil {
		return Snapshot{}, ErrNilRules
	}
	canonical, err := origin.Canonical()
	if err != nil {
		return Snapshot{}, err
	}
	origin = canonical
	if ttl == 0 {
		ttl = m.cfg.TTL
	}
	if err := m.checkOpen(); err != nil {
		return Snapshot{}, err
	}

	scope := Scope{Tenant: tenant, Origin: origin}
	if snapshot.Source == "" {
		snapshot.Source = SourceOperator
	}
	stored := m.putPolicy(scope, snapshot, ttl)
	m.record(AuditEvent{
		Kind:        AuditPolicyInstalled,
		Tenant:      tenant,
		Origin:      origin,
		Version:     stored.Version,
		Generation:  stored.Generation,
		FailureMode: stored.FailureMode,
		Degraded:    stored.Degraded,
		Message:     string(stored.Source),
	})
	m.notifyInstalled(stored)
	return stored, nil
}

func (m *Manager) releaseClaim(claim *Claim) {
	scope := Scope{Tenant: claim.tenant, Origin: claim.origin}
	m.mu.Lock()
	defer m.mu.Unlock()
	set := m.claims[scope]
	delete(set, claim)
	if len(set) == 0 {
		delete(m.claims, scope)
	}
}

// putPolicy serialises policy publication with Permit.MarkSent. Holding the
// manager lock across the cache write gives the "new rules cancel unsent
// requests" guarantee a precise linearisation point.
func (m *Manager) putPolicy(scope Scope, snapshot Snapshot, ttl time.Duration) Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cache.Put(scope, snapshot, ttl)
}

func (m *Manager) putIfVersion(scope Scope, expected uint64, snapshot Snapshot, ttl time.Duration) (Snapshot, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cache.PutIfVersion(scope, expected, snapshot, ttl)
}

// Close revokes every active claim. It does not close the underlying cache or
// evidence store.
func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	var claims []*Claim
	for _, set := range m.claims {
		for claim := range set {
			claims = append(claims, claim)
		}
	}
	m.claims = nil
	m.mu.Unlock()

	for _, claim := range claims {
		canceled := claim.revoke(ErrManagerClosed)
		m.record(AuditEvent{
			Kind:       AuditClaimRevoked,
			Tenant:     claim.tenant,
			Origin:     claim.origin,
			Version:    claim.snapshot.Version,
			Generation: claim.snapshot.Generation,
			Message:    "manager closed",
			Err:        ErrManagerClosed,
		})
		m.auditCanceled(claim, ErrManagerClosed, canceled)
	}
	m.record(AuditEvent{Kind: AuditManagerClosed})
}

func (m *Manager) checkOpen() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrManagerClosed
	}
	return nil
}

func (m *Manager) record(event AuditEvent) {
	if event.Time.IsZero() {
		event.Time = m.clock()
	}
	if m.auditor != nil {
		m.auditor.Record(event)
	}
}

// Cache exposes the manager's policy cache for inspection and sweeps.
func (m *Manager) Cache() *Cache {
	return m.cache
}

// PolicyCache is an alias for Cache.
func (m *Manager) PolicyCache() *Cache {
	return m.cache
}

// EvidenceStore exposes the append-only evidence store.
func (m *Manager) EvidenceStore() EvidenceStore {
	return m.evidence
}

// Evidence is an alias for EvidenceStore.
func (m *Manager) Evidence() EvidenceStore {
	return m.evidence
}

// Auditor returns the configured audit sink, if any.
func (m *Manager) Auditor() Auditor {
	return m.auditor
}

// FailureMode returns the configured failure mode.
func (m *Manager) FailureMode() FailureMode {
	return m.cfg.FailureMode
}
