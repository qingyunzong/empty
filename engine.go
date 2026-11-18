package formal

import (
	"sort"
	"sync"
	"time"
)

// Engine holds a set of active alerts and one current rule set. It is safe for
// concurrent use.
//
// All updates are applied to state first; notifications are always derived
// from one consistent snapshot. A successful UpdateRules is atomic: readers
// see either the old rule set or the new one, never a mixture.
type Engine struct {
	mu        sync.RWMutex
	config    Config
	compiled  compiledConfig
	alerts    map[string]Alert
	delivered map[string]struct{}
}

// NewEngine validates config and returns an empty engine.
func NewEngine(config Config) (*Engine, error) {
	compiled, err := compileConfig(config)
	if err != nil {
		return nil, err
	}
	return &Engine{
		config:    config.Clone(),
		compiled:  compiled,
		alerts:    make(map[string]Alert),
		delivered: make(map[string]struct{}),
	}, nil
}

// New is kept as a short alias for NewEngine.
func New(config Config) (*Engine, error) {
	return NewEngine(config)
}

// UpdateRules atomically replaces the rule set. Invalid rules are rejected and
// leave the previous configuration untouched. Alert state and the delivery
// ledger are preserved, so a no-op rule update cannot cause a duplicate
// notification.
func (e *Engine) UpdateRules(config Config) error {
	compiled, err := compileConfig(config)
	if err != nil {
		return err
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	e.config = config.Clone()
	e.compiled = compiled
	return nil
}

// SetRules is an alias for UpdateRules.
func (e *Engine) SetRules(config Config) error {
	return e.UpdateRules(config)
}

// Config returns an independent copy of the current configuration.
func (e *Engine) Config() Config {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.config.Clone()
}

// AddAlerts merges alerts into the active set and returns how many new unique
// fingerprints were added. Repeated arrivals of an existing fingerprint are
// idempotent; the earliest StartsAt is retained. Duplicates inside one batch
// are also collapsed.
func (e *Engine) AddAlerts(alerts ...Alert) int {
	e.mu.Lock()
	defer e.mu.Unlock()

	added := 0
	for _, alert := range alerts {
		fingerprint := alert.Fingerprint()
		existing, exists := e.alerts[fingerprint]
		if !exists {
			e.alerts[fingerprint] = alert.Clone()
			added++
			continue
		}
		e.alerts[fingerprint] = earlierAlert(existing, alert)
	}
	return added
}

// Add is an alias for AddAlerts.
func (e *Engine) Add(alerts ...Alert) int {
	return e.AddAlerts(alerts...)
}

// RemoveAlerts removes alerts by fingerprint and returns how many were
// present. Unknown fingerprints are ignored.
func (e *Engine) RemoveAlerts(fingerprints ...string) int {
	e.mu.Lock()
	defer e.mu.Unlock()

	removed := 0
	for _, fingerprint := range fingerprints {
		if _, exists := e.alerts[fingerprint]; !exists {
			continue
		}
		delete(e.alerts, fingerprint)
		removed++
	}
	return removed
}

// ResolveAlerts removes the given alerts by fingerprint.
func (e *Engine) ResolveAlerts(alerts ...Alert) int {
	fingerprints := make([]string, len(alerts))
	for i, alert := range alerts {
		fingerprints[i] = alert.Fingerprint()
	}
	return e.RemoveAlerts(fingerprints...)
}

// ClearAlerts removes all active alerts and returns how many were present.
func (e *Engine) ClearAlerts() int {
	e.mu.Lock()
	defer e.mu.Unlock()

	count := len(e.alerts)
	e.alerts = make(map[string]Alert)
	return count
}

// Alerts returns a sorted, independent copy of the active alerts.
func (e *Engine) Alerts() []Alert {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.copyAlertsLocked()
}

// Snapshot evaluates the complete notification set against the current alerts
// and rules. Each group and each alert within a group appears exactly once.
func (e *Engine) Snapshot(now time.Time) Report {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return evaluateCompiled(e.compiled, e.copyAlertsLocked(), now)
}

// Notifications returns only the complete notification set from Snapshot.
func (e *Engine) Notifications(now time.Time) []Notification {
	return e.Snapshot(now).Notifications
}

// Poll returns notifications that have not been returned by an earlier Poll.
//
// Notification identity is the group key plus the sorted set of alert
// fingerprints. Consequently:
//   - duplicate alert arrivals do not re-notify;
//   - a rule update that leaves a notification unchanged does not re-notify;
//   - an alert that moves to a genuinely different group does produce a new
//     group notification.
//
// Poll is at-most-once per notification ID. Use ResetDelivery only when a
// caller intentionally wants to start a new delivery epoch.
func (e *Engine) Poll(now time.Time) []Notification {
	e.mu.Lock()
	defer e.mu.Unlock()

	report := evaluateCompiled(e.compiled, e.copyAlertsLocked(), now)
	fresh := make([]Notification, 0, len(report.Notifications))
	for _, notification := range report.Notifications {
		id := notification.ID()
		if _, exists := e.delivered[id]; exists {
			continue
		}
		e.delivered[id] = struct{}{}
		fresh = append(fresh, notification)
	}
	return fresh
}

// ResetDelivery clears the Poll delivery ledger. The next Poll reports every
// currently visible notification again.
func (e *Engine) ResetDelivery() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.delivered = make(map[string]struct{})
}

func (e *Engine) copyAlertsLocked() []Alert {
	alerts := make([]Alert, 0, len(e.alerts))
	for _, alert := range e.alerts {
		alerts = append(alerts, alert.Clone())
	}
	sort.Slice(alerts, func(i, j int) bool {
		return alerts[i].Fingerprint() < alerts[j].Fingerprint()
	})
	return alerts
}
