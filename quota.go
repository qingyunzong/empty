package dataeng

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// QuotaScope selects the bucket updated by dynamic server quota headers.
type QuotaScope uint8

const (
	ScopeGlobal QuotaScope = iota
	ScopeTenant
	ScopeEndpoint
)

func (s QuotaScope) String() string {
	switch s {
	case ScopeGlobal:
		return "global"
	case ScopeTenant:
		return "tenant"
	case ScopeEndpoint:
		return "endpoint"
	default:
		return "unknown"
	}
}

// QuotaState is the subset of server quota information the scheduler can use.
// Nil fields were not present in the response.
type QuotaState struct {
	Limit      *float64
	Remaining  *float64
	ResetAt    *time.Time
	RetryAfter *time.Duration
}

// HeaderNames lists the response headers parsed by ParseQuotaHeaders. Nil or
// empty lists fall back to DefaultHeaderNames. Reset names accept an epoch
// time or a small relative number of seconds; ResetAfter names are relative
// seconds.
type HeaderNames struct {
	Limit      []string
	Remaining  []string
	Reset      []string
	ResetAfter []string
	RetryAfter []string
}

// DefaultHeaderNames supports the IETF RateLimit family, the widely used
// X-RateLimit family, Retry-After, and X-Quota aliases.
func DefaultHeaderNames() HeaderNames {
	return HeaderNames{
		Limit: []string{
			"RateLimit-Limit",
			"X-RateLimit-Limit",
			"X-Quota-Limit",
		},
		Remaining: []string{
			"RateLimit-Remaining",
			"X-RateLimit-Remaining",
			"X-Quota-Remaining",
		},
		Reset: []string{
			"X-RateLimit-Reset",
			"X-Quota-Reset",
		},
		ResetAfter: []string{
			"RateLimit-Reset",
			"X-RateLimit-Reset-After",
			"RateLimit-Reset-After",
			"X-Quota-Reset-After",
		},
		RetryAfter: []string{"Retry-After"},
	}
}

// ParseQuotaHeaders parses quota information with DefaultHeaderNames.
func ParseQuotaHeaders(header http.Header, observedAt time.Time) (QuotaState, error) {
	return ParseQuotaHeadersWith(header, observedAt, DefaultHeaderNames())
}

// ParseQuotaHeadersWith parses quota information using names. It returns the
// fields that were present and an error for the first malformed present field.
func ParseQuotaHeadersWith(header http.Header, observedAt time.Time, names HeaderNames) (QuotaState, error) {
	names = names.withDefaults()
	var state QuotaState

	if value, ok := firstHeaderValue(header, names.Limit); ok {
		limit, err := parseHeaderNumber(value)
		if err != nil {
			return state, fmt.Errorf("dataeng: quota limit header: %w", err)
		}
		state.Limit = &limit
	}
	if value, ok := firstHeaderValue(header, names.Remaining); ok {
		remaining, err := parseHeaderNumber(value)
		if err != nil {
			return state, fmt.Errorf("dataeng: quota remaining header: %w", err)
		}
		state.Remaining = &remaining
	}
	if value, ok := firstHeaderValue(header, names.Reset); ok {
		reset, err := parseEpochOrDate(value, observedAt)
		if err != nil {
			return state, fmt.Errorf("dataeng: quota reset header: %w", err)
		}
		state.ResetAt = &reset
	}
	if value, ok := firstHeaderValue(header, names.ResetAfter); ok {
		after, err := parseDeltaOrDate(value, observedAt)
		if err != nil {
			return state, fmt.Errorf("dataeng: quota reset-after header: %w", err)
		}
		reset := observedAt.Add(after)
		state.ResetAt = &reset
	}
	if value, ok := firstHeaderValue(header, names.RetryAfter); ok {
		after, err := parseDeltaOrDate(value, observedAt)
		if err != nil {
			return state, fmt.Errorf("dataeng: retry-after header: %w", err)
		}
		state.RetryAfter = &after
	}
	return state, nil
}

func (n HeaderNames) withDefaults() HeaderNames {
	defaults := DefaultHeaderNames()
	if len(n.Limit) == 0 {
		n.Limit = defaults.Limit
	}
	if len(n.Remaining) == 0 {
		n.Remaining = defaults.Remaining
	}
	if len(n.Reset) == 0 {
		n.Reset = defaults.Reset
	}
	if len(n.ResetAfter) == 0 {
		n.ResetAfter = defaults.ResetAfter
	}
	if len(n.RetryAfter) == 0 {
		n.RetryAfter = defaults.RetryAfter
	}
	return n
}

func firstHeaderValue(header http.Header, names []string) (string, bool) {
	for _, name := range names {
		value := strings.TrimSpace(header.Get(name))
		if value != "" {
			return value, true
		}
	}
	return "", false
}

func parseHeaderNumber(value string) (float64, error) {
	value = strings.TrimSpace(value)
	if index := strings.IndexAny(value, ",;"); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	value = strings.TrimPrefix(value, "@")
	number, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("parse %q: %w", value, err)
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return 0, fmt.Errorf("invalid non-negative number %q", value)
	}
	return number, nil
}

func parseEpochOrDate(value string, observedAt time.Time) (time.Time, error) {
	value = strings.TrimSpace(value)
	if seconds, err := parseHeaderNumber(value); err == nil {
		if seconds > 1e12 {
			return time.UnixMilli(int64(seconds)), nil
		}
		if seconds < 1e9 {
			return observedAt.Add(time.Duration(seconds * float64(time.Second))), nil
		}
		whole := int64(seconds)
		fraction := seconds - float64(whole)
		return time.Unix(whole, int64(fraction*float64(time.Second))), nil
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse %q: %w", value, err)
	}
	return parsed, nil
}

func parseDeltaOrDate(value string, observedAt time.Time) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if seconds, err := parseHeaderNumber(value); err == nil {
		if seconds > float64(math.MaxInt64)/float64(time.Second) {
			return 0, fmt.Errorf("duration %q is too large", value)
		}
		return time.Duration(seconds * float64(time.Second)), nil
	}
	parsed, err := http.ParseTime(value)
	if err != nil {
		return 0, fmt.Errorf("parse %q: %w", value, err)
	}
	delta := parsed.Sub(observedAt)
	if delta < 0 {
		return 0, nil
	}
	return delta, nil
}

// ApplyQuota applies a server observation to the selected bucket. While
// reservations are in flight, Remaining may lower local availability but does
// not raise it, so a stale response cannot overbook the server. Once all
// in-flight requests settle, Remaining becomes authoritative. A ResetAt in the
// future establishes a temporary refill rate that reaches Limit at reset.
func (s *Scheduler) ApplyQuota(scope QuotaScope, id string, state QuotaState) error {
	if state.Limit != nil {
		if math.IsNaN(*state.Limit) || math.IsInf(*state.Limit, 0) || *state.Limit < 0 {
			return fmt.Errorf("%w: quota limit must be finite and non-negative", ErrInvalidRequest)
		}
	}
	if state.Remaining != nil {
		if math.IsNaN(*state.Remaining) || math.IsInf(*state.Remaining, 0) || *state.Remaining < 0 {
			return fmt.Errorf("%w: quota remaining must be finite and non-negative", ErrInvalidRequest)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrSchedulerClosed
	}
	now := s.clock.Now()
	var target *limitState
	switch scope {
	case ScopeGlobal:
		target = &s.global
	case ScopeTenant:
		target = &s.tenantLocked(id, now).limit
	case ScopeEndpoint:
		target = &s.endpointLocked(id, now).limit
	default:
		return fmt.Errorf("%w: unknown quota scope %d", ErrInvalidRequest, scope)
	}
	target.applyQuota(state, now)
	s.dispatchLocked(now)
	s.armLocked(now)
	return nil
}
