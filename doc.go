// Package dataeng re-exports the robots policy component at the module root.
//
// The implementation lives in example.org/dataeng/q0216/robots. Both import
// paths expose the same types, so applications can import whichever path fits
// their layering.
package dataeng

import (
	"io"
	"net/url"

	"example.org/dataeng/q0216/robots"
)

// Core policy types.
type (
	Origin              = robots.Origin
	Rule                = robots.Rule
	Group               = robots.Group
	Rules               = robots.Rules
	RuleSet             = robots.Rules
	RobotsRules         = robots.Rules
	AgentRules          = robots.AgentRules
	Decision            = robots.Decision
	Scope               = robots.Scope
	Snapshot            = robots.Snapshot
	Policy              = robots.Snapshot
	PolicySnapshot      = robots.Snapshot
	PolicyVersion       = robots.PolicyVersion
	PolicyGeneration    = robots.PolicyGeneration
	TenantID            = robots.TenantID
	Source              = robots.Source
	FailureMode         = robots.FailureMode
	Cache               = robots.Cache
	PolicyCache         = robots.Cache
	PolicyStore         = robots.Cache
	CacheConfig         = robots.CacheConfig
	CacheOption         = robots.CacheOption
	Clock               = robots.Clock
	Config              = robots.Config
	Manager             = robots.Manager
	Task                = robots.Task
	Claim               = robots.Claim
	Lease               = robots.Claim
	CrawlLease          = robots.Claim
	TaskLease           = robots.Claim
	Permit              = robots.Permit
	DisallowedError     = robots.DisallowedError
	Evidence            = robots.Evidence
	EvidenceStore       = robots.EvidenceStore
	MemoryEvidenceStore = robots.MemoryEvidenceStore
	Auditor             = robots.Auditor
	AuditSink           = robots.Auditor
	AuditFunc           = robots.AuditFunc
	AuditEvent          = robots.AuditEvent
	AuditKind           = robots.AuditKind
	AuditLog            = robots.AuditLog
	Fetcher             = robots.Fetcher
	FetchFunc           = robots.FetchFunc
	FetchError          = robots.FetchError
	HTTPFetcher         = robots.HTTPFetcher
	HTTPFetcherConfig   = robots.HTTPFetcherConfig
)

// Failure modes.
const (
	FailClosed     = robots.FailClosed
	FailOpen       = robots.FailOpen
	FailClosedMode = robots.FailClosed
	FailOpenMode   = robots.FailOpen
)

// Policy sources.
const (
	SourceFetched      = robots.SourceFetched
	SourceAbsent       = robots.SourceAbsent
	SourceAccessDenied = robots.SourceAccessDenied
	SourceFallback     = robots.SourceFallback
	SourceOperator     = robots.SourceOperator
)

// Audit kinds.
const (
	AuditPolicyFetched      = robots.AuditPolicyFetched
	AuditPolicyAbsent       = robots.AuditPolicyAbsent
	AuditPolicyAccessDenied = robots.AuditPolicyAccessDenied
	AuditFetchFailed        = robots.AuditFetchFailed
	AuditFallback           = robots.AuditFallback
	AuditPolicyInstalled    = robots.AuditPolicyInstalled
	AuditPolicyStale        = robots.AuditPolicyStale
	AuditClaimBound         = robots.AuditClaimBound
	AuditClaimRevoked       = robots.AuditClaimRevoked
	AuditRequestDenied      = robots.AuditRequestDenied
	AuditRequestCanceled    = robots.AuditRequestCanceled
	AuditEvidenceRecorded   = robots.AuditEvidenceRecorded
	AuditEvidenceRejected   = robots.AuditEvidenceRejected
	AuditManagerClosed      = robots.AuditManagerClosed
)

// Sentinel errors.
var (
	ErrInvalidOrigin       = robots.ErrInvalidOrigin
	ErrParse               = robots.ErrParse
	ErrRobotsNotFound      = robots.ErrRobotsNotFound
	ErrRobotsAccessDenied  = robots.ErrRobotsAccessDenied
	ErrRobotsUnavailable   = robots.ErrRobotsUnavailable
	ErrRobotsTooLarge      = robots.ErrRobotsTooLarge
	ErrCrossOriginRedirect = robots.ErrCrossOriginRedirect
	ErrEvidenceExists      = robots.ErrEvidenceExists
	ErrEvidenceIDRequired  = robots.ErrEvidenceIDRequired
	ErrEvidenceVersion     = robots.ErrEvidenceVersion
	ErrEvidenceScope       = robots.ErrEvidenceScope
	ErrRequestNotSent      = robots.ErrRequestNotSent
	ErrStaleGeneration     = robots.ErrStaleGeneration
	ErrManagerClosed       = robots.ErrManagerClosed
	ErrNilRules            = robots.ErrNilRules
	ErrPolicySuperseded    = robots.ErrPolicySuperseded
	ErrClaimRevoked        = robots.ErrClaimRevoked
	ErrClaimReleased       = robots.ErrClaimReleased
	ErrDisallowed          = robots.ErrDisallowed
	ErrRequestCanceled     = robots.ErrRequestCanceled
	ErrPermitClosed        = robots.ErrPermitClosed
)

// NewOrigin canonicalises and validates an origin.
func NewOrigin(scheme, host, port string) (Origin, error) {
	return robots.NewOrigin(scheme, host, port)
}

// ParseOrigin parses an origin from a URL.
func ParseOrigin(raw string) (Origin, error) {
	return robots.ParseOrigin(raw)
}

// OriginFromURL derives an origin from a parsed URL.
func OriginFromURL(u *url.URL) (Origin, error) {
	return robots.OriginFromURL(u)
}

// NewScope creates a tenant/origin cache key.
func NewScope(tenant string, origin Origin) Scope {
	return robots.NewScope(tenant, origin)
}

// Parse reads a robots.txt document.
func Parse(reader io.Reader) (*Rules, error) {
	return robots.Parse(reader)
}

// ParseBytes parses a robots.txt document from bytes.
func ParseBytes(data []byte) (*Rules, error) {
	return robots.ParseBytes(data)
}

// AllowAllRules returns a policy permitting every target.
func AllowAllRules() *Rules {
	return robots.AllowAllRules()
}

// DisallowAllRules returns a policy denying every target.
func DisallowAllRules() *Rules {
	return robots.DisallowAllRules()
}

// RequestPath normalises a request target for matching.
func RequestPath(target string) string {
	return robots.RequestPath(target)
}

// ParseFailureMode parses a fail-open/fail-closed string.
func ParseFailureMode(value string) (FailureMode, error) {
	return robots.ParseFailureMode(value)
}

// NewCache creates a policy cache.
func NewCache(options ...CacheOption) *Cache {
	return robots.NewCache(options...)
}

// NewCacheWithConfig creates a policy cache from a config value.
func NewCacheWithConfig(cfg CacheConfig) *Cache {
	return robots.NewCacheWithConfig(cfg)
}

// WithMaxEntries sets the cache LRU capacity.
func WithMaxEntries(entries int) CacheOption {
	return robots.WithMaxEntries(entries)
}

// WithCacheCapacity is an alias for WithMaxEntries.
func WithCacheCapacity(entries int) CacheOption {
	return robots.WithCacheCapacity(entries)
}

// WithCacheClock injects a cache clock.
func WithCacheClock(clock Clock) CacheOption {
	return robots.WithCacheClock(clock)
}

// DefaultConfig returns production-oriented manager defaults.
func DefaultConfig() Config {
	return robots.DefaultConfig()
}

// NewManager creates a policy manager.
func NewManager(cfg Config) (*Manager, error) {
	return robots.NewManager(cfg)
}

// MustNewManager is NewManager with a panic on invalid configuration.
func MustNewManager(cfg Config) *Manager {
	return robots.MustNewManager(cfg)
}

// New is an alias for NewManager.
func New(cfg Config) (*Manager, error) {
	return robots.New(cfg)
}

// NewHTTPFetcher creates the default HTTP robots fetcher.
func NewHTTPFetcher(cfg HTTPFetcherConfig) *HTTPFetcher {
	return robots.NewHTTPFetcher(cfg)
}

// NewMemoryEvidenceStore creates an append-only in-memory evidence store.
func NewMemoryEvidenceStore() *MemoryEvidenceStore {
	return robots.NewMemoryEvidenceStore()
}

// NewAuditLog creates an in-memory audit sink.
func NewAuditLog(limit int) *AuditLog {
	return robots.NewAuditLog(limit)
}
