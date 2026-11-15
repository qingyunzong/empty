package robots

import (
	"fmt"
	"strings"
	"time"
)

// Source describes how a policy snapshot was obtained.
type Source string

// PolicyVersion is a cache-wide policy revision.
type PolicyVersion = uint64

// PolicyGeneration is a per-origin installation counter.
type PolicyGeneration = uint64

// TenantID identifies a policy tenant.
type TenantID = string

const (
	// SourceFetched means a complete robots.txt document was parsed.
	SourceFetched Source = "fetched"
	// SourceAbsent means the origin answered 404/410 (or equivalent).
	SourceAbsent Source = "absent"
	// SourceAccessDenied means the origin answered 401/403.
	SourceAccessDenied Source = "access_denied"
	// SourceFallback means the network or parser failed and a configured
	// fail-open or fail-closed policy was installed.
	SourceFallback Source = "fallback"
	// SourceOperator means rules were published directly through
	// Manager.InstallPolicy or Manager.Publish.
	SourceOperator Source = "operator"
)

// FailureMode selects the policy used when robots.txt cannot be obtained.
type FailureMode uint8

const (
	// FailClosed denies every fetch. It is the zero value and the safe default.
	FailClosed FailureMode = iota
	// FailOpen permits every fetch.
	FailOpen
)

// Aliases kept for callers that prefer explicit mode names.
const (
	FailClosedMode = FailClosed
	FailOpenMode   = FailOpen
)

func (m FailureMode) String() string {
	switch m {
	case FailOpen:
		return "fail-open"
	default:
		return "fail-closed"
	}
}

// MarshalText implements encoding.TextMarshaler.
func (m FailureMode) MarshalText() ([]byte, error) {
	return []byte(m.String()), nil
}

// UnmarshalText implements encoding.TextUnmarshaler.
func (m *FailureMode) UnmarshalText(text []byte) error {
	parsed, err := ParseFailureMode(string(text))
	if err != nil {
		return err
	}
	*m = parsed
	return nil
}

// ParseFailureMode parses "fail-open" or "fail-closed" (case-insensitive).
func ParseFailureMode(value string) (FailureMode, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "fail-open", "failopen", "open":
		return FailOpen, nil
	case "fail-closed", "failclosed", "closed":
		return FailClosed, nil
	default:
		return FailClosed, fmt.Errorf("robots: unknown failure mode %q", value)
	}
}

// Snapshot is an immutable parsed policy bound to one tenant and origin.
//
// Version is a cache-wide, monotonically increasing revision. Generation is
// the per-origin installation count. A task claim binds both, and conditional
// cache writes compare Version so a slow fetch from an older generation can
// never replace a newer policy.
type Snapshot struct {
	Tenant      string
	Origin      Origin
	Rules       *Rules
	Version     uint64
	Generation  uint64
	FetchedAt   time.Time
	ExpiresAt   time.Time
	Source      Source
	Degraded    bool
	FailureMode FailureMode
	Problem     string
}

// Fresh reports whether the snapshot is still within its TTL at now. A zero
// ExpiresAt means the snapshot never expires.
func (s Snapshot) Fresh(now time.Time) bool {
	return s.ExpiresAt.IsZero() || now.Before(s.ExpiresAt)
}

// Expired is the inverse of Fresh.
func (s Snapshot) Expired(now time.Time) bool {
	return !s.Fresh(now)
}

// Evaluate resolves target using the snapshot's rules.
func (s Snapshot) Evaluate(userAgent, target string) Decision {
	if s.Rules == nil {
		return Decision{Allowed: true, UserAgent: strings.ToLower(userAgent)}
	}
	return s.Rules.Evaluate(userAgent, target)
}

// Allowed reports whether target is permitted by the snapshot.
func (s Snapshot) Allowed(userAgent, target string) bool {
	return s.Evaluate(userAgent, target).Allowed
}

// CrawlDelay returns the crawl delay configured for userAgent.
func (s Snapshot) CrawlDelay(userAgent string) time.Duration {
	if s.Rules == nil {
		return 0
	}
	return s.Rules.CrawlDelayFor(userAgent)
}

// Clone returns a deep copy of the snapshot and its rules.
func (s Snapshot) Clone() Snapshot {
	s.Rules = s.Rules.Clone()
	return s
}

// PolicySnapshot is an explicit name for Snapshot.
type PolicySnapshot = Snapshot

// Policy is an alias for Snapshot.
type Policy = Snapshot
