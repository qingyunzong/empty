package robots

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	// ErrClaimRevoked is returned when a claim has been superseded, released
	// or closed and can no longer issue requests.
	ErrClaimRevoked = errors.New("robots: claim revoked")
	// ErrClaimReleased is the cause used when a caller releases a claim.
	ErrClaimReleased = errors.New("robots: claim released")
	// ErrDisallowed is returned when the bound policy denies a target.
	ErrDisallowed = errors.New("robots: target disallowed")
	// ErrRequestCanceled means the permit was canceled before it was sent.
	ErrRequestCanceled = errors.New("robots: request canceled")
	// ErrPermitClosed means the permit was explicitly closed.
	ErrPermitClosed = errors.New("robots: permit closed")
)

// DisallowedError carries the policy decision that denied a request.
type DisallowedError struct {
	Target   string
	Decision Decision
}

func (e *DisallowedError) Error() string {
	rule := "default"
	if e.Decision.Matched {
		rule = e.Decision.Rule.Pattern
	}
	return fmt.Sprintf("robots: target %q disallowed by %q", e.Target, rule)
}

// Unwrap exposes ErrDisallowed.
func (e *DisallowedError) Unwrap() error {
	return ErrDisallowed
}

type canceledPermit struct {
	target     string
	version    uint64
	generation uint64
}

// Claim binds a task to one immutable policy snapshot. It is safe for
// concurrent use. A claim is not valid forever: installing a newer policy for
// the same tenant and origin revokes it and cancels all permits that have not
// yet been marked sent. Call Release when the task no longer needs the claim;
// otherwise the manager retains it until supersession or Close.
type Claim struct {
	manager   *Manager
	tenant    string
	origin    Origin
	userAgent string
	snapshot  Snapshot

	mu       sync.Mutex
	revoked  bool
	released bool
	cause    error
	permits  map[*Permit]struct{}
}

// Lease is an alias for Claim.
type Lease = Claim

// CrawlLease is an alias for Claim.
type CrawlLease = Claim

// TaskLease is an alias for Claim.
type TaskLease = Claim

// Version returns the cache-wide policy version bound at claim time.
func (c *Claim) Version() uint64 {
	return c.snapshot.Version
}

// Generation returns the per-origin policy generation bound at claim time.
func (c *Claim) Generation() uint64 {
	return c.snapshot.Generation
}

// Snapshot returns the immutable policy bound to the claim.
func (c *Claim) Snapshot() Snapshot {
	return c.snapshot
}

// Tenant returns the claim's tenant.
func (c *Claim) Tenant() string {
	return c.tenant
}

// Origin returns the claim's origin.
func (c *Claim) Origin() Origin {
	return c.origin
}

// UserAgent returns the user agent used for group selection.
func (c *Claim) UserAgent() string {
	return c.userAgent
}

// Revoked returns nil while the claim can issue requests. Otherwise it returns
// the cancellation cause.
func (c *Claim) Revoked() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revoked || c.released {
		if c.cause != nil {
			return c.cause
		}
		return ErrClaimRevoked
	}
	return nil
}

// Decision evaluates target against the bound policy.
func (c *Claim) Decision(target string) Decision {
	return c.snapshot.Evaluate(c.userAgent, target)
}

// Allowed reports whether target is permitted by the bound policy.
func (c *Claim) Allowed(target string) bool {
	return c.Decision(target).Allowed
}

// CrawlDelay returns the bound policy's crawl delay for the claim's user agent.
func (c *Claim) CrawlDelay() time.Duration {
	return c.snapshot.CrawlDelay(c.userAgent)
}

// Begin creates a request permit if the target is allowed. The returned permit
// starts in the "not sent" state. Call MarkSent immediately before dispatching
// the network request; a policy update between Begin and MarkSent cancels the
// permit.
func (c *Claim) Begin(ctx context.Context, target string) (*Permit, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if target == "" {
		target = "/"
	}
	if c.manager == nil {
		return nil, ErrClaimRevoked
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	c.mu.Lock()
	if c.released || c.revoked {
		cause := c.cause
		c.mu.Unlock()
		if cause == nil {
			cause = ErrClaimRevoked
		}
		return nil, fmt.Errorf("%w: %w", ErrClaimRevoked, cause)
	}

	if c.manager != nil {
		scope := Scope{Tenant: c.tenant, Origin: c.origin}
		if last := c.manager.cache.LastVersion(scope); last > c.snapshot.Version {
			canceled := c.revokeLocked(ErrPolicySuperseded)
			c.mu.Unlock()
			c.manager.auditCanceled(c, ErrPolicySuperseded, canceled)
			c.manager.record(AuditEvent{
				Kind:       AuditClaimRevoked,
				Tenant:     c.tenant,
				Origin:     c.origin,
				Version:    c.snapshot.Version,
				Generation: c.snapshot.Generation,
				Message:    fmt.Sprintf("superseded by policy version %d", last),
				Err:        ErrPolicySuperseded,
			})
			c.manager.releaseClaim(c)
			return nil, fmt.Errorf("%w: %w", ErrClaimRevoked, ErrPolicySuperseded)
		}
	}

	decision := c.snapshot.Evaluate(c.userAgent, target)
	if !decision.Allowed {
		c.mu.Unlock()
		c.manager.record(AuditEvent{
			Kind:       AuditRequestDenied,
			Tenant:     c.tenant,
			Origin:     c.origin,
			Version:    c.snapshot.Version,
			Generation: c.snapshot.Generation,
			Target:     target,
			Message:    fmt.Sprintf("matched %q", decision.Rule.Pattern),
			Err:        ErrDisallowed,
		})
		return nil, &DisallowedError{Target: target, Decision: decision}
	}

	permitContext, cancel := context.WithCancelCause(ctx)
	permit := &Permit{
		claim:       c,
		ctx:         permitContext,
		cancel:      cancel,
		target:      target,
		requestedAt: c.manager.clock(),
	}
	c.permits[permit] = struct{}{}
	c.mu.Unlock()
	return permit, nil
}

// RecordEvidence appends completed evidence under the claim's bound policy
// version. It remains callable after revocation so a request that was already
// sent can still finish; the append-only store prevents rewriting an existing
// record.
func (c *Claim) RecordEvidence(evidence Evidence) (Evidence, error) {
	return c.recordEvidence(evidence)
}

// CompleteEvidence is an alias for RecordEvidence.
func (c *Claim) CompleteEvidence(evidence Evidence) (Evidence, error) {
	return c.recordEvidence(evidence)
}

// Complete is an alias for RecordEvidence.
func (c *Claim) Complete(evidence Evidence) (Evidence, error) {
	return c.recordEvidence(evidence)
}

func (c *Claim) recordEvidence(evidence Evidence) (Evidence, error) {
	if c.manager == nil {
		return evidence, ErrClaimRevoked
	}
	if evidence.ID == "" {
		return evidence, ErrEvidenceIDRequired
	}
	if evidence.Tenant != "" && evidence.Tenant != c.tenant {
		return evidence, ErrEvidenceScope
	}
	if !evidence.Origin.IsZero() && evidence.Origin != c.origin {
		return evidence, ErrEvidenceScope
	}
	if evidence.PolicyVersion != 0 && evidence.PolicyVersion != c.snapshot.Version {
		return evidence, ErrEvidenceVersion
	}
	if evidence.PolicyGeneration != 0 && evidence.PolicyGeneration != c.snapshot.Generation {
		return evidence, ErrEvidenceVersion
	}

	evidence.Tenant = c.tenant
	evidence.Origin = c.origin
	if evidence.UserAgent == "" {
		evidence.UserAgent = c.userAgent
	}
	evidence.PolicyVersion = c.snapshot.Version
	evidence.PolicyGeneration = c.snapshot.Generation
	if evidence.CompletedAt.IsZero() {
		evidence.CompletedAt = c.manager.clock()
	}

	if err := c.manager.evidence.Append(evidence); err != nil {
		c.manager.record(AuditEvent{
			Kind:       AuditEvidenceRejected,
			Tenant:     c.tenant,
			Origin:     c.origin,
			Version:    c.snapshot.Version,
			Generation: c.snapshot.Generation,
			Target:     evidence.Target,
			EvidenceID: evidence.ID,
			Message:    err.Error(),
			Err:        err,
		})
		return evidence, err
	}

	c.manager.record(AuditEvent{
		Kind:       AuditEvidenceRecorded,
		Tenant:     c.tenant,
		Origin:     c.origin,
		Version:    c.snapshot.Version,
		Generation: c.snapshot.Generation,
		Target:     evidence.Target,
		EvidenceID: evidence.ID,
	})
	return evidence.Clone(), nil
}

// Release unregisters the claim and cancels permits that have not been sent.
// Evidence from already-sent requests may still be recorded.
func (c *Claim) Release() {
	c.mu.Lock()
	if c.released {
		c.mu.Unlock()
		return
	}
	c.released = true
	canceled := c.revokeLocked(ErrClaimReleased)
	c.mu.Unlock()

	if c.manager != nil {
		c.manager.releaseClaim(c)
		c.manager.auditCanceled(c, ErrClaimReleased, canceled)
		c.manager.record(AuditEvent{
			Kind:       AuditClaimRevoked,
			Tenant:     c.tenant,
			Origin:     c.origin,
			Version:    c.snapshot.Version,
			Generation: c.snapshot.Generation,
			Message:    "claim released",
			Err:        ErrClaimReleased,
		})
	}
}

// Close is an alias for Release.
func (c *Claim) Close() {
	c.Release()
}

func (c *Claim) revoke(cause error) []canceledPermit {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revokeLocked(cause)
}

func (c *Claim) revokeLocked(cause error) []canceledPermit {
	if c.revoked {
		return nil
	}
	c.revoked = true
	c.cause = cause

	var canceled []canceledPermit
	for permit := range c.permits {
		if permit.cancelIfPending(cause) {
			canceled = append(canceled, canceledPermit{
				target:     permit.target,
				version:    c.snapshot.Version,
				generation: c.snapshot.Generation,
			})
		}
	}
	c.permits = nil
	return canceled
}

func (c *Claim) removePermit(permit *Permit) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.permits, permit)
}

// Permit is a single request authorisation. It is pending until MarkSent is
// called. Policy supersession cancels pending permits but leaves sent permits
// alone so their completed evidence can be recorded under the bound version.
type Permit struct {
	claim       *Claim
	ctx         context.Context
	cancel      context.CancelCauseFunc
	target      string
	requestedAt time.Time

	mu     sync.Mutex
	sent   bool
	closed bool
	cause  error
}

// Context returns the permit context. It is canceled when the permit is
// revoked before sending, when its parent is canceled, or when Close is called.
func (p *Permit) Context() context.Context {
	return p.ctx
}

// Done is a convenience wrapper around Context().Done().
func (p *Permit) Done() <-chan struct{} {
	return p.ctx.Done()
}

// Target returns the target path or URL supplied to Begin.
func (p *Permit) Target() string {
	return p.target
}

// Version returns the policy version bound by the parent claim.
func (p *Permit) Version() uint64 {
	return p.claim.snapshot.Version
}

// Generation returns the policy generation bound by the parent claim.
func (p *Permit) Generation() uint64 {
	return p.claim.snapshot.Generation
}

// MarkSent moves the permit from pending to sent. It must be called
// immediately before dispatching the request. If the claim was revoked first,
// MarkSent returns the cancellation cause and the request must not be sent.
// Calling MarkSent more than once is idempotent.
func (p *Permit) MarkSent() error {
	p.mu.Lock()
	if p.sent {
		p.mu.Unlock()
		return nil
	}
	if p.closed {
		err := p.cause
		p.mu.Unlock()
		if err != nil {
			return err
		}
		return ErrRequestCanceled
	}
	if cause := context.Cause(p.ctx); cause != nil {
		p.closed = true
		p.cause = cause
		p.mu.Unlock()
		return cause
	}
	if p.claim != nil && p.claim.manager != nil {
		manager := p.claim.manager
		scope := Scope{Tenant: p.claim.tenant, Origin: p.claim.origin}
		manager.mu.Lock()
		if manager.closed {
			manager.mu.Unlock()
			p.closed = true
			p.cause = ErrManagerClosed
			p.cancel(ErrManagerClosed)
			p.mu.Unlock()
			manager.record(AuditEvent{
				Kind:       AuditRequestCanceled,
				Tenant:     p.claim.tenant,
				Origin:     p.claim.origin,
				Version:    p.claim.snapshot.Version,
				Generation: p.claim.snapshot.Generation,
				Target:     p.target,
				Message:    "manager closed before request was sent",
				Err:        ErrManagerClosed,
			})
			return ErrManagerClosed
		}
		last := manager.cache.LastVersion(scope)
		if last > p.claim.snapshot.Version {
			manager.mu.Unlock()
			p.closed = true
			p.cause = ErrPolicySuperseded
			p.cancel(ErrPolicySuperseded)
			p.mu.Unlock()
			manager.record(AuditEvent{
				Kind:       AuditRequestCanceled,
				Tenant:     p.claim.tenant,
				Origin:     p.claim.origin,
				Version:    p.claim.snapshot.Version,
				Generation: p.claim.snapshot.Generation,
				Target:     p.target,
				Message:    fmt.Sprintf("policy version %d superseded %d before request was sent", last, p.claim.snapshot.Version),
				Err:        ErrPolicySuperseded,
			})
			return ErrPolicySuperseded
		}
		p.sent = true
		manager.mu.Unlock()
		p.mu.Unlock()
		return nil
	}
	p.sent = true
	p.mu.Unlock()
	return nil
}

// Complete records completed evidence. It is valid only after MarkSent
// succeeded and remains valid after policy supersession or claim release.
func (p *Permit) Complete(evidence Evidence) (Evidence, error) {
	p.mu.Lock()
	sent := p.sent
	p.mu.Unlock()
	if !sent {
		return evidence, ErrRequestNotSent
	}

	if evidence.Target == "" {
		evidence.Target = p.target
	}
	if evidence.RequestedAt.IsZero() {
		evidence.RequestedAt = p.requestedAt
	}
	return p.claim.RecordEvidence(evidence)
}

// Cause returns the context cancellation cause, if any.
func (p *Permit) Cause() error {
	return context.Cause(p.ctx)
}

// Err is an alias for Cause.
func (p *Permit) Err() error {
	return p.Cause()
}

// Sent reports whether MarkSent succeeded.
func (p *Permit) Sent() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sent
}

// Close releases the permit's context and unregisters it. Sent permits may
// still complete evidence before or after Close.
func (p *Permit) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.cause = ErrPermitClosed
	p.cancel(ErrPermitClosed)
	p.mu.Unlock()
	p.claim.removePermit(p)
}

func (p *Permit) cancelIfPending(cause error) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.sent || p.closed {
		return false
	}
	p.closed = true
	p.cause = cause
	p.cancel(cause)
	return true
}
