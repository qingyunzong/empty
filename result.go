package formal

import "time"

// AttemptOutcome classifies one exchange with one forwarder.
type AttemptOutcome string

const (
	AttemptSuccess  AttemptOutcome = "success"
	AttemptNXDomain AttemptOutcome = "nxdomain"
	AttemptTimeout  AttemptOutcome = "timeout"
	AttemptFailure  AttemptOutcome = "failure"
)

// QueryStep is one candidate name examined by the resolver. CacheHit is true
// when the candidate was answered from the cache and therefore no forwarder was
// contacted for it.
type QueryStep struct {
	Name     string
	CacheHit bool
}

// Attempt records one actual exchange. Latency is the reply's reported latency;
// Waited is the virtual time charged to the attempt (the latency capped at the
// effective timeout).
type Attempt struct {
	Name       string
	Forwarder  string
	StubDomain string
	Outcome    AttemptOutcome
	Rcode      Rcode
	Latency    time.Duration
	Waited     time.Duration
	Err        string
}

// SourceKind identifies the source of the final result.
type SourceKind string

const (
	SourceCache   SourceKind = "cache"
	SourceStub    SourceKind = "stub"
	SourceDefault SourceKind = "default"
	SourceNone    SourceKind = "none"
)

// Source describes the final source. For SourceNone, Reason explains why no
// positive answer was found ("nxdomain", "timeout", "failure", ...).
type Source struct {
	Kind       SourceKind
	Name       string
	Forwarder  string
	StubDomain string
	Rcode      Rcode
	Reason     string
}

// Result is the complete, deterministic trace of one resolution.
type Result struct {
	RequestedName string
	Name          string
	Queries       []QueryStep
	Attempts      []Attempt
	Source        Source
	Entry         *CacheEntry
	StartedAt     time.Time
	FinishedAt    time.Time
	Elapsed       time.Duration
}
