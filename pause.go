package dataeng

import (
	"errors"
	"math"
	"sync"
	"time"
)

var (
	// ErrInvalidVersion is returned when a response carries a non-positive
	// version number.
	ErrInvalidVersion = errors.New("dataeng: version must be a positive integer")
	// ErrInconsistentVersion is returned when two responses for the same
	// source and version carry different Retry-After content.
	ErrInconsistentVersion = errors.New("dataeng: same version carries different content")
)

// RetryAfter is the caller-parsed Retry-After value of a response: either a
// non-negative number of seconds or an absolute UTC second.
type RetryAfter struct {
	deltaSeconds *uint64
	absolute     *time.Time
}

// AfterSeconds builds a Retry-After of a non-negative number of seconds.
func AfterSeconds(seconds uint64) RetryAfter {
	return RetryAfter{deltaSeconds: &seconds}
}

// AtAbsolute builds a Retry-After of an absolute instant, truncated to the
// caller-parsed UTC second.
func AtAbsolute(absolute time.Time) RetryAfter {
	abs := absolute.UTC().Truncate(time.Second)
	return RetryAfter{absolute: &abs}
}

// retryAfterKey is a comparable fingerprint of the Retry-After content.
type retryAfterKey struct {
	kind    uint8
	seconds uint64
	unix    int64
}

func (r RetryAfter) key() retryAfterKey {
	switch {
	case r.deltaSeconds != nil:
		return retryAfterKey{kind: 1, seconds: *r.deltaSeconds}
	case r.absolute != nil:
		return retryAfterKey{kind: 2, unix: r.absolute.Unix()}
	default:
		return retryAfterKey{}
	}
}

// Response is a per-source fetch response carrying its positive version, the
// receive wall-clock and monotonic readings, the optional server Date, and
// the Retry-After directive.
type Response struct {
	Source     string
	Version    uint64
	Received   time.Time
	Mono       time.Duration
	Date       *time.Time
	RetryAfter RetryAfter
}

// wait resolves the Retry-After to a non-negative wait. An absolute date is
// estimated against the server Date when a valid one is present, otherwise
// against the receive UTC instant; negative waits clamp to zero.
func (r Response) wait() time.Duration {
	switch ra := r.RetryAfter; {
	case ra.deltaSeconds != nil:
		return secondsDuration(*ra.deltaSeconds)
	case ra.absolute != nil:
		ref := r.Received.UTC()
		if r.Date != nil && !r.Date.IsZero() {
			ref = r.Date.UTC()
		}
		// time.Time.Sub saturates, so the subtraction cannot overflow.
		if w := ra.absolute.Sub(ref); w > 0 {
			return w
		}
		return 0
	default:
		return 0
	}
}

// secondsDuration converts seconds to a Duration, saturating instead of
// overflowing.
func secondsDuration(s uint64) time.Duration {
	const maxSeconds = uint64(math.MaxInt64) / uint64(time.Second)
	if s > maxSeconds {
		return time.Duration(math.MaxInt64)
	}
	return time.Duration(s) * time.Second
}

// addSaturating adds delta to base, saturating at the Duration limits.
func addSaturating(base, delta time.Duration) time.Duration {
	if delta > 0 && base > math.MaxInt64-delta {
		return time.Duration(math.MaxInt64)
	}
	if delta < 0 && base < math.MinInt64-delta {
		return time.Duration(math.MinInt64)
	}
	return base + delta
}

type sourceState struct {
	pauses   map[uint64]time.Duration // version -> monotonic deadline
	contents map[uint64]retryAfterKey // version -> Retry-After fingerprint
	barrier  uint64                   // highest version cleared by success
}

// Tracker records per-source pause windows. It is safe for concurrent use.
type Tracker struct {
	clock   Clock
	mu      sync.Mutex
	sources map[string]*sourceState
}

// NewTracker returns a Tracker using the real clock.
func NewTracker() *Tracker {
	return NewTrackerWithClock(realClock{start: time.Now()})
}

// NewTrackerWithClock returns a Tracker using the given clock for queries.
func NewTrackerWithClock(clock Clock) *Tracker {
	return &Tracker{clock: clock, sources: make(map[string]*sourceState)}
}

func (t *Tracker) state(source string) *sourceState {
	st, ok := t.sources[source]
	if !ok {
		st = &sourceState{
			pauses:   make(map[uint64]time.Duration),
			contents: make(map[uint64]retryAfterKey),
		}
		t.sources[source] = st
	}
	return st
}

// RecordFailure records a pause from a failed response. Responses arriving
// out of order keep the maximum of the existing and the new deadline. A
// failure whose version was already cleared by a success is rejected by the
// barrier and cannot resurrect the cleared pause.
func (t *Tracker) RecordFailure(resp Response) error {
	if resp.Version == 0 {
		return ErrInvalidVersion
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.state(resp.Source)
	if resp.Version <= st.barrier {
		return nil
	}
	key := resp.RetryAfter.key()
	if prev, ok := st.contents[resp.Version]; ok && prev != key {
		return ErrInconsistentVersion
	}
	st.contents[resp.Version] = key
	deadline := addSaturating(resp.Mono, resp.wait())
	if cur, ok := st.pauses[resp.Version]; !ok || deadline > cur {
		st.pauses[resp.Version] = deadline
	}
	return nil
}

// RecordSuccess records an explicit success at the given version: it clears
// every pause with version not greater than it and raises the barrier that
// rejects older failures.
func (t *Tracker) RecordSuccess(source string, version uint64) error {
	if version == 0 {
		return ErrInvalidVersion
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	st := t.state(source)
	if version > st.barrier {
		st.barrier = version
	}
	for v := range st.pauses {
		if v <= version {
			delete(st.pauses, v)
		}
	}
	for v := range st.contents {
		if v <= version {
			delete(st.contents, v)
		}
	}
	return nil
}

// Paused reports whether the source currently has an unexpired pause.
func (t *Tracker) Paused(source string) bool {
	_, ok := t.Deadline(source)
	return ok
}

// Deadline returns the latest unexpired monotonic pause deadline for the
// source, or false if the source is not paused.
func (t *Tracker) Deadline(source string) (time.Duration, bool) {
	now := t.clock.Monotonic()
	t.mu.Lock()
	defer t.mu.Unlock()
	st, ok := t.sources[source]
	if !ok {
		return 0, false
	}
	var latest time.Duration
	found := false
	for _, d := range st.pauses {
		if d > now && (!found || d > latest) {
			latest, found = d, true
		}
	}
	return latest, found
}
