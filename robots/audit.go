package robots

import (
	"sync"
	"time"
)

// AuditKind classifies an audit event.
type AuditKind string

const (
	AuditPolicyFetched      AuditKind = "policy.fetched"
	AuditPolicyAbsent       AuditKind = "policy.absent"
	AuditPolicyAccessDenied AuditKind = "policy.access_denied"
	AuditFetchFailed        AuditKind = "policy.fetch_failed"
	AuditFallback           AuditKind = "policy.fallback"
	AuditPolicyInstalled    AuditKind = "policy.installed"
	AuditPolicyStale        AuditKind = "policy.stale_generation"
	AuditClaimBound         AuditKind = "claim.bound"
	AuditClaimRevoked       AuditKind = "claim.revoked"
	AuditRequestDenied      AuditKind = "request.denied"
	AuditRequestCanceled    AuditKind = "request.canceled"
	AuditEvidenceRecorded   AuditKind = "evidence.recorded"
	AuditEvidenceRejected   AuditKind = "evidence.rejected"
	AuditManagerClosed      AuditKind = "manager.closed"
)

// AuditEvent is a structured, append-only record of a policy or request
// transition.
type AuditEvent struct {
	Time        time.Time
	Kind        AuditKind
	Tenant      string
	Origin      Origin
	Version     uint64
	Generation  uint64
	FailureMode FailureMode
	Degraded    bool
	Target      string
	EvidenceID  string
	Message     string
	Err         error
}

// Auditor receives audit events. Implementations should be fast and must be
// safe for concurrent use. The Manager deliberately calls the auditor without
// holding its internal locks.
type Auditor interface {
	Record(AuditEvent)
}

// AuditFunc adapts a function to Auditor.
type AuditFunc func(AuditEvent)

// Record calls f.
func (f AuditFunc) Record(event AuditEvent) {
	if f != nil {
		f(event)
	}
}

// AuditSink is an alias for Auditor.
type AuditSink = Auditor

// AuditLog is an in-memory, bounded audit sink. A non-positive capacity means
// unbounded.
type AuditLog struct {
	mu     sync.Mutex
	events []AuditEvent
	limit  int
}

// NewAuditLog creates an in-memory audit log.
func NewAuditLog(limit int) *AuditLog {
	return &AuditLog{limit: limit}
}

// Record appends an event.
func (l *AuditLog) Record(event AuditEvent) {
	if l == nil {
		return
	}
	if event.Time.IsZero() {
		event.Time = time.Now()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
	if l.limit > 0 && len(l.events) > l.limit {
		excess := len(l.events) - l.limit
		copy(l.events, l.events[excess:])
		l.events = l.events[:l.limit]
	}
}

// Events returns a copy of the recorded events.
func (l *AuditLog) Events() []AuditEvent {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]AuditEvent(nil), l.events...)
}

// Len returns the number of retained events.
func (l *AuditLog) Len() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.events)
}
