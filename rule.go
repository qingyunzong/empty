package dataeng

import (
	"strings"
	"time"
)

// Rule defines multiline event boundaries.
//
// Start is checked first. When it matches, any open event is completed with
// ReasonNewStart and the line begins a new event. Otherwise, if an event is
// open and Continue matches, the line is appended to it. A line that matches
// neither predicate also completes the open event and begins a new one, so
// input is never dropped just because it did not match a rule.
//
// Timeout receives the time elapsed since the event last accepted a line. It
// is evaluated before every input line and on every scheduled flush. A nil
// predicate disables timeout-based completion.
//
// Predicates run while the aggregator's internal lock is held. They must be
// side-effect free and must not call Aggregator methods.
type Rule struct {
	Start    func(line string) bool
	Continue func(line string) bool
	Timeout  func(idle time.Duration) bool
}

// HasPrefix returns a predicate that matches lines starting with any of the
// supplied prefixes. It is a convenient Start or Continue rule.
func HasPrefix(prefixes ...string) func(string) bool {
	expected := append([]string(nil), prefixes...)
	return func(line string) bool {
		for _, prefix := range expected {
			if strings.HasPrefix(line, prefix) {
				return true
			}
		}
		return false
	}
}

// IdleTimeout returns a timeout predicate that matches once an event has been
// idle for at least d.
func IdleTimeout(d time.Duration) func(time.Duration) bool {
	return func(idle time.Duration) bool {
		return idle >= d
	}
}
