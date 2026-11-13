// Package polite tracks per-domain politeness intervals for crawlers.
//
// Each registered domain remembers the earliest moment the next request
// to it may be sent. After a fetch is sent, that moment becomes the send
// time plus the domain's interval. A domain without an interval refuses
// new sends, while requests already in flight are left to finish.
package polite

import (
	"sync"
	"time"
)

// Limiter records, per registered domain, the next allowed send time.
// It is safe for concurrent use.
type Limiter struct {
	mu        sync.Mutex
	intervals map[string]time.Duration
	next      map[string]time.Time
}

// New returns an empty Limiter.
func New() *Limiter {
	return &Limiter{
		intervals: make(map[string]time.Duration),
		next:      make(map[string]time.Time),
	}
}

// Register sets the politeness interval for domain. Re-registering
// replaces the interval used for future sends; it does not move the
// currently recorded next-send time and never cancels in-flight
// requests.
func (l *Limiter) Register(domain string, interval time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.intervals[domain] = interval
}

// Unregister removes the interval for domain. The domain then refuses
// new sends; requests already sent keep running to completion.
func (l *Limiter) Unregister(domain string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.intervals, domain)
	delete(l.next, domain)
}

// Registered reports whether domain currently has an interval.
func (l *Limiter) Registered(domain string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.intervals[domain]
	return ok
}

// ReadyAt returns the earliest moment a new request to domain may be
// sent. ok is false when domain has no interval. A registered domain
// that has never sent anything is ready immediately (zero time).
func (l *Limiter) ReadyAt(domain string) (ready time.Time, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.intervals[domain]; !ok {
		return time.Time{}, false
	}
	return l.next[domain], true
}

// MarkSent records that a request to domain was sent at sentAt and
// moves the next allowed send time to sentAt+interval. It returns
// false when domain has no interval, meaning the send is refused.
func (l *Limiter) MarkSent(domain string, sentAt time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	interval, ok := l.intervals[domain]
	if !ok {
		return false
	}
	l.next[domain] = sentAt.Add(interval)
	return true
}
