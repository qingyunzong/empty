package dataeng

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"sync"
	"time"

	"example.org/dataeng13/q0426/polite"
)

// ErrDomainNotRegistered is returned by Add when the URL's domain has
// no politeness interval and therefore refuses new sends.
var ErrDomainNotRegistered = errors.New("dataeng: domain has no politeness interval")

// FetchResult is the outcome of a single fetch.
type FetchResult struct {
	URL        string
	StatusCode int
	Body       []byte
	// RedirectTo, when non-empty, is the URL the fetch was redirected
	// to. The scheduler re-queues it under the target domain, which
	// decides by its own interval when it may be sent; the original
	// domain's interval is not extended.
	RedirectTo string
}

// Fetcher performs a single fetch.
type Fetcher interface {
	Fetch(ctx context.Context, rawURL string) (FetchResult, error)
}

// FetcherFunc adapts a function to the Fetcher interface.
type FetcherFunc func(ctx context.Context, rawURL string) (FetchResult, error)

// Fetch implements Fetcher.
func (f FetcherFunc) Fetch(ctx context.Context, rawURL string) (FetchResult, error) {
	return f(ctx, rawURL)
}

// FetchError pairs a failed URL with its error.
type FetchError struct {
	URL string
	Err error
}

// SentRecord logs one dispatched fetch: the address and the moment it
// was sent.
type SentRecord struct {
	URL string
	At  time.Time
}

// Scheduler dispatches queued URLs while honouring each registered
// domain's politeness interval. The zero value is not usable; build
// one with NewScheduler.
type Scheduler struct {
	fetcher Fetcher
	limiter *polite.Limiter
	now     func() time.Time

	mu       sync.Mutex
	queues   map[string][]string // domain -> queued URLs, sorted ascending
	inFlight int
	sent     []SentRecord
	results  []FetchResult
	errs     []FetchError
	wake     chan struct{}
}

// Option customises a Scheduler.
type Option func(*Scheduler)

// WithClock overrides the time source, mainly for tests.
func WithClock(now func() time.Time) Option {
	return func(s *Scheduler) { s.now = now }
}

// NewScheduler returns a Scheduler that fetches through f.
func NewScheduler(f Fetcher, opts ...Option) *Scheduler {
	s := &Scheduler{
		fetcher: f,
		limiter: polite.New(),
		now:     time.Now,
		queues:  make(map[string][]string),
		wake:    make(chan struct{}, 1),
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// RegisterDomain sets the politeness interval for domain. Calling it
// again replaces the interval used for future sends; in-flight
// requests are never cancelled.
func (s *Scheduler) RegisterDomain(domain string, interval time.Duration) {
	s.limiter.Register(domain, interval)
	s.signal()
}

// UnregisterDomain removes the interval for domain. The domain refuses
// new sends from then on; requests already in flight run to completion.
func (s *Scheduler) UnregisterDomain(domain string) {
	s.limiter.Unregister(domain)
}

// ReadyAt reports the earliest moment domain may send its next request.
func (s *Scheduler) ReadyAt(domain string) (time.Time, bool) {
	return s.limiter.ReadyAt(domain)
}

// Add queues rawURL for fetching. It fails when the URL's domain has
// no politeness interval.
func (s *Scheduler) Add(rawURL string) error {
	domain, err := hostOf(rawURL)
	if err != nil {
		return err
	}
	if !s.limiter.Registered(domain) {
		return fmt.Errorf("%w: %s", ErrDomainNotRegistered, domain)
	}
	s.mu.Lock()
	s.enqueueLocked(domain, rawURL)
	s.mu.Unlock()
	s.signal()
	return nil
}

// Results returns the successful fetch results collected so far.
func (s *Scheduler) Results() []FetchResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]FetchResult(nil), s.results...)
}

// Errors returns the fetch errors collected so far.
func (s *Scheduler) Errors() []FetchError {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]FetchError(nil), s.errs...)
}

// Sent returns the dispatch log, in send order.
func (s *Scheduler) Sent() []SentRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]SentRecord(nil), s.sent...)
}

// Pending reports how many URLs are still queued across all domains.
func (s *Scheduler) Pending() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pendingLocked()
}

// Run dispatches queued URLs until every queue is empty and every
// in-flight request has finished, or until ctx is cancelled. When
// several addresses are due at the same moment, the lexicographically
// smallest address is sent first.
func (s *Scheduler) Run(ctx context.Context) error {
	for {
		s.mu.Lock()
		if s.inFlight == 0 && s.pendingLocked() == 0 {
			s.mu.Unlock()
			return nil
		}
		now := s.now()
		rawURL, wait, hasWait, ok := s.nextLocked(now)
		if ok {
			domain, _ := hostOf(rawURL)
			s.queues[domain] = s.queues[domain][1:]
			s.limiter.MarkSent(domain, now)
			s.sent = append(s.sent, SentRecord{URL: rawURL, At: now})
			s.inFlight++
			s.mu.Unlock()
			go s.fetch(ctx, rawURL)
			continue
		}
		s.mu.Unlock()

		if !hasWait {
			// Nothing is dispatchable and no timer can help (e.g. only
			// unregistered domains remain queued); wait for a change.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-s.wake:
			}
			continue
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-s.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// fetch runs one request to completion. A redirect target is queued
// under its own registered domain; the original domain's limiter state
// is left untouched.
func (s *Scheduler) fetch(ctx context.Context, rawURL string) {
	res, err := s.fetcher.Fetch(ctx, rawURL)
	s.mu.Lock()
	s.inFlight--
	if err != nil {
		s.errs = append(s.errs, FetchError{URL: rawURL, Err: err})
	} else {
		s.results = append(s.results, res)
		if res.RedirectTo != "" {
			if domain, derr := hostOf(res.RedirectTo); derr == nil && s.limiter.Registered(domain) {
				s.enqueueLocked(domain, res.RedirectTo)
			}
		}
	}
	s.mu.Unlock()
	s.signal()
}

// nextLocked picks the next URL to send. Among domains whose next
// allowed send time has arrived, the lexicographically smallest queued
// address wins. When nothing is due yet, it reports how long to wait
// for the earliest domain to become ready.
func (s *Scheduler) nextLocked(now time.Time) (rawURL string, wait time.Duration, hasWait, ok bool) {
	best := ""
	found := false
	for domain, queue := range s.queues {
		if len(queue) == 0 {
			continue
		}
		ready, registered := s.limiter.ReadyAt(domain)
		if !registered {
			continue
		}
		if !ready.After(now) {
			if !found || queue[0] < best {
				best = queue[0]
				found = true
			}
			continue
		}
		if d := ready.Sub(now); !hasWait || d < wait {
			wait = d
			hasWait = true
		}
	}
	if !found {
		return "", wait, hasWait, false
	}
	return best, 0, hasWait, true
}

// enqueueLocked inserts rawURL keeping the domain queue sorted.
func (s *Scheduler) enqueueLocked(domain, rawURL string) {
	queue := s.queues[domain]
	i := sort.SearchStrings(queue, rawURL)
	queue = append(queue, "")
	copy(queue[i+1:], queue[i:])
	queue[i] = rawURL
	s.queues[domain] = queue
}

func (s *Scheduler) pendingLocked() int {
	n := 0
	for _, queue := range s.queues {
		n += len(queue)
	}
	return n
}

func (s *Scheduler) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func hostOf(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("dataeng: parse URL: %w", err)
	}
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("dataeng: URL %q has no host", rawURL)
	}
	return host, nil
}
