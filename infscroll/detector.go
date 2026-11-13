// Package infscroll provides a termination detector for infinite-scroll
// crawlers. It consumes per-round observations (DOM key set, network
// delta, scroll extent, sentinel state) and decides whether scrolling
// should continue, stop, or be aborted as indeterminate.
//
// Termination requires a configurable number of consecutive rounds in
// which every invariant holds (no new DOM keys, stable scroll extent,
// quiet network, no in-flight requests, idle sentinel). Content
// recycling (previously observed keys disappearing) or key reuse (a
// retired key reappearing, or duplicates within one round) makes the
// observation stream untrustworthy and yields an indeterminate verdict.
//
// Every verdict carries the evidence that produced it.
package infscroll

import (
	"fmt"
	"sort"
	"strings"
)

// Decision is the outcome of evaluating one observation round.
type Decision int

const (
	// DecisionContinue means scrolling should continue; termination
	// invariants have not held for enough consecutive rounds yet.
	DecisionContinue Decision = iota
	// DecisionStop means the termination invariants held for the
	// required number of consecutive rounds with no in-flight requests.
	DecisionStop
	// DecisionIndeterminate means content recycling or key reuse was
	// detected, so no trustworthy conclusion can be drawn.
	DecisionIndeterminate
)

func (d Decision) String() string {
	switch d {
	case DecisionContinue:
		return "continue"
	case DecisionStop:
		return "stop"
	case DecisionIndeterminate:
		return "indeterminate"
	default:
		return "unknown"
	}
}

// Observation is one scroll round as reported by the orchestrator.
type Observation struct {
	// Keys is the set of stable DOM keys visible after this round.
	Keys []string
	// NetworkDelta is the number of new network requests fired during
	// this round.
	NetworkDelta int
	// InFlight is the number of requests still in flight at observation
	// time.
	InFlight int
	// ScrollExtent is the current scrollable extent (e.g. scrollHeight).
	ScrollExtent float64
	// SentinelVisible reports whether the sentinel element is intersecting
	// the viewport, i.e. the page may still load more content.
	SentinelVisible bool
}

// Condition records whether a single invariant held during a round,
// together with the measured values that explain the outcome.
type Condition struct {
	Name   string
	Passed bool
	Detail string
}

// Evidence explains why a verdict was reached for a given round.
type Evidence struct {
	Round        int
	Decision     Decision
	Conditions   []Condition
	StableStreak int
	Reason       string
}

// Verdict is the detector output for one observation round.
type Verdict struct {
	Decision Decision
	Evidence Evidence
}

// Terminal reports whether the verdict ends the scroll session.
func (v Verdict) Terminal() bool {
	return v.Decision != DecisionContinue
}

// Config tunes the detector. The zero value is the default, strict
// configuration (3 stable rounds, exact extent match, sentinel must be
// idle, recycling and key reuse are fatal).
type Config struct {
	// StableRounds is the number of consecutive rounds that must satisfy
	// every invariant before stopping. Defaults to 3.
	StableRounds int
	// ExtentEpsilon is the tolerance when comparing scroll extents.
	// Defaults to 0 (exact match).
	ExtentEpsilon float64
	// AllowSentinelVisible lets rounds count toward termination even
	// while the sentinel is still visible. Defaults to false.
	AllowSentinelVisible bool
	// IgnoreRecycle disables the indeterminate verdict for disappearing
	// keys (content recycling). Defaults to false.
	IgnoreRecycle bool
	// IgnoreReuse disables the indeterminate verdict for reappearing
	// retired keys and duplicate keys within one round. Defaults to
	// false.
	IgnoreReuse bool
}

// DefaultConfig returns the default configuration.
func DefaultConfig() Config {
	return Config{
		StableRounds:  3,
		ExtentEpsilon: 0,
	}
}

func (c Config) withDefaults() Config {
	if c.StableRounds <= 0 {
		c.StableRounds = DefaultConfig().StableRounds
	}
	return c
}

// Detector is a stateful infinite-scroll termination judge. Create one
// per scroll session with New and feed it one Observation per round.
// It is not safe for concurrent use.
type Detector struct {
	cfg Config

	round    int
	streak   int
	seen     map[string]struct{}
	retired  map[string]struct{}
	prevKeys map[string]struct{}
	prevExt  float64
	hasPrev  bool
	terminal *Verdict
}

// New returns a Detector using cfg merged over DefaultConfig.
func New(cfg Config) *Detector {
	return &Detector{
		cfg:     cfg.withDefaults(),
		seen:    make(map[string]struct{}),
		retired: make(map[string]struct{}),
	}
}

// Config returns the effective configuration.
func (d *Detector) Config() Config { return d.cfg }

// Observe evaluates one round and returns the verdict with its evidence.
// After a terminal verdict, subsequent calls return the same verdict.
func (d *Detector) Observe(obs Observation) Verdict {
	if d.terminal != nil {
		return *d.terminal
	}
	d.round++

	current, dupes := keySet(obs.Keys)

	if !d.cfg.IgnoreReuse && len(dupes) > 0 {
		return d.fail("key reuse within round: duplicate keys " + strings.Join(dupes, ", "))
	}

	if !d.cfg.IgnoreRecycle && d.hasPrev {
		if missing := diffKeys(d.prevKeys, current); len(missing) > 0 {
			return d.fail("content recycling: keys disappeared: " + strings.Join(missing, ", "))
		}
	}

	if !d.cfg.IgnoreReuse {
		if reused := intersectKeys(current, d.retired); len(reused) > 0 {
			return d.fail("key reuse: retired keys reappeared: " + strings.Join(reused, ", "))
		}
	}

	conditions := d.evalConditions(obs, current)
	stable := true
	for _, c := range conditions {
		if !c.Passed {
			stable = false
			break
		}
	}
	if stable {
		d.streak++
	} else {
		d.streak = 0
	}

	d.retire(current)
	d.prevKeys = current
	d.prevExt = obs.ScrollExtent
	d.hasPrev = true

	ev := Evidence{
		Round:        d.round,
		Conditions:   conditions,
		StableStreak: d.streak,
	}

	if d.streak >= d.cfg.StableRounds {
		ev.Decision = DecisionStop
		ev.Reason = fmt.Sprintf("invariants held for %d consecutive rounds (required %d) with no in-flight requests",
			d.streak, d.cfg.StableRounds)
		v := Verdict{Decision: DecisionStop, Evidence: ev}
		d.terminal = &v
		return v
	}

	ev.Decision = DecisionContinue
	if stable {
		ev.Reason = fmt.Sprintf("invariants held but streak %d/%d too short", d.streak, d.cfg.StableRounds)
	} else {
		ev.Reason = "invariants violated: " + strings.Join(failedNames(conditions), ", ")
	}
	return Verdict{Decision: DecisionContinue, Evidence: ev}
}

func (d *Detector) fail(reason string) Verdict {
	ev := Evidence{
		Round:        d.round,
		Decision:     DecisionIndeterminate,
		StableStreak: d.streak,
		Reason:       reason,
	}
	v := Verdict{Decision: DecisionIndeterminate, Evidence: ev}
	d.terminal = &v
	return v
}

func (d *Detector) evalConditions(obs Observation, current map[string]struct{}) []Condition {
	newKeys := make([]string, 0)
	for k := range current {
		if _, ok := d.seen[k]; !ok {
			newKeys = append(newKeys, k)
		}
	}
	sort.Strings(newKeys)

	conds := []Condition{
		{
			Name:   "no_new_keys",
			Passed: d.hasPrev && len(newKeys) == 0,
			Detail: detailf(d.hasPrev, "%d new keys: %s", len(newKeys), strings.Join(newKeys, ", ")),
		},
		{
			Name:   "extent_stable",
			Passed: d.hasPrev && abs(obs.ScrollExtent-d.prevExt) <= d.cfg.ExtentEpsilon,
			Detail: detailf(d.hasPrev, "extent %.2f -> %.2f (epsilon %.2f)", d.prevExt, obs.ScrollExtent, d.cfg.ExtentEpsilon),
		},
		{
			Name:   "network_quiet",
			Passed: obs.NetworkDelta == 0,
			Detail: fmt.Sprintf("%d new requests this round", obs.NetworkDelta),
		},
		{
			Name:   "no_in_flight",
			Passed: obs.InFlight == 0,
			Detail: fmt.Sprintf("%d requests in flight", obs.InFlight),
		},
	}
	if !d.cfg.AllowSentinelVisible {
		conds = append(conds, Condition{
			Name:   "sentinel_idle",
			Passed: !obs.SentinelVisible,
			Detail: fmt.Sprintf("sentinel visible=%t", obs.SentinelVisible),
		})
	}
	return conds
}

// retire moves keys that vanished between the previous round and the
// current one into the retired set so their reappearance can be flagged,
// and records all current keys as seen.
func (d *Detector) retire(current map[string]struct{}) {
	for k := range d.prevKeys {
		if _, ok := current[k]; !ok {
			d.retired[k] = struct{}{}
		}
	}
	for k := range current {
		d.seen[k] = struct{}{}
	}
}

func keySet(keys []string) (set map[string]struct{}, dupes []string) {
	set = make(map[string]struct{}, len(keys))
	for _, k := range keys {
		if _, ok := set[k]; ok {
			dupes = append(dupes, k)
			continue
		}
		set[k] = struct{}{}
	}
	sort.Strings(dupes)
	return set, dupes
}

func diffKeys(a, b map[string]struct{}) []string {
	out := make([]string, 0)
	for k := range a {
		if _, ok := b[k]; !ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func intersectKeys(a, b map[string]struct{}) []string {
	out := make([]string, 0)
	for k := range a {
		if _, ok := b[k]; ok {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func failedNames(conds []Condition) []string {
	out := make([]string, 0)
	for _, c := range conds {
		if !c.Passed {
			out = append(out, c.Name)
		}
	}
	return out
}

func detailf(hasBaseline bool, format string, args ...interface{}) string {
	if !hasBaseline {
		return "no baseline (first round)"
	}
	return fmt.Sprintf(format, args...)
}

func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}
