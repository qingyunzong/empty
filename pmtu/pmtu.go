// Package pmtu implements a path MTU discovery cache for the IP stack
// send path.
//
// The cache tracks one entry per destination. The confirmed MTU only
// ever decreases on trusted fragmentation-needed errors; it rises again
// only through acknowledged probes after the entry ages. While probing,
// the MTU reported to the send path stays at the confirmed value, so no
// data packet larger than the confirmed MTU is ever emitted.
package pmtu

import "time"

// Config tunes a Cache.
type Config struct {
	// MinMTU is the lower clamp applied to error-reported MTUs.
	MinMTU int
	// MaxMTU is the first-hop (link) MTU and the probe ceiling.
	MaxMTU int
	// ProbeStep is the increment between successive probe sizes.
	ProbeStep int
	// AgeTimeout is how long after the last confirmed decrease the
	// entry waits before probing upward again.
	AgeTimeout time.Duration
	// MaxProbeFails is how many consecutive probe failures (lost or
	// rejected) are tolerated before probing pauses for another aging
	// interval.
	MaxProbeFails int
}

// DefaultConfig returns a Config with RFC-4821-flavoured defaults.
func DefaultConfig() Config {
	return Config{
		MinMTU:        576,
		MaxMTU:        1500,
		ProbeStep:     200,
		AgeTimeout:    10 * time.Minute,
		MaxProbeFails: 3,
	}
}

func (c Config) normalize() Config {
	if c.MinMTU <= 0 {
		c.MinMTU = 576
	}
	if c.MaxMTU <= 0 {
		c.MaxMTU = 1500
	}
	if c.MinMTU > c.MaxMTU {
		c.MinMTU = c.MaxMTU
	}
	if c.ProbeStep <= 0 {
		c.ProbeStep = 200
	}
	if c.AgeTimeout <= 0 {
		c.AgeTimeout = 10 * time.Minute
	}
	if c.MaxProbeFails <= 0 {
		c.MaxProbeFails = 3
	}
	return c
}

type entry struct {
	confirmed     int       // largest MTU known to work; caps data packets
	probing       bool      // upward probing in progress
	probeSize     int       // current probe target (> confirmed)
	probeInFlight bool      // a probe of probeSize is outstanding
	fails         int       // consecutive probe failures
	lastDecrease  time.Time // last time confirmed decreased (or probing gave up)
}

// Cache is a per-destination PMTU table. It is not safe for concurrent
// use; serialize callers at the send path.
type Cache struct {
	cfg     Config
	entries map[string]*entry
}

// New returns an empty Cache using cfg.
func New(cfg Config) *Cache {
	return &Cache{cfg: cfg.normalize(), entries: make(map[string]*entry)}
}

// get returns the entry for dst, creating it at MaxMTU if absent.
func (c *Cache) get(dst string, now time.Time) *entry {
	e, ok := c.entries[dst]
	if !ok {
		e = &entry{confirmed: c.cfg.MaxMTU, lastDecrease: now}
		c.entries[dst] = e
	}
	return e
}

// age moves a steady entry into the probing state once its aging
// interval has elapsed. Aging never changes the confirmed MTU itself.
func (c *Cache) age(e *entry, now time.Time) {
	if e.probing || now.Sub(e.lastDecrease) < c.cfg.AgeTimeout {
		return
	}
	if e.confirmed >= c.cfg.MaxMTU {
		// Already at the ceiling; nothing to probe. Restart the
		// aging interval so we do not re-check every call.
		e.lastDecrease = now
		return
	}
	e.probing = true
	e.probeSize = min(e.confirmed+c.cfg.ProbeStep, c.cfg.MaxMTU)
	e.probeInFlight = false
	e.fails = 0
}

// MTU returns the largest data packet size currently allowed for dst.
// It never exceeds the confirmed MTU, even while probing.
func (c *Cache) MTU(dst string, now time.Time) int {
	e := c.get(dst, now)
	c.age(e, now)
	return e.confirmed
}

// NextProbe reports the probe packet size the send path should emit for
// dst, if any. The probe is marked in flight until ProbeAck, ProbeLost,
// or a trusted error resolves it. Probe packets are the only packets
// allowed above the confirmed MTU.
func (c *Cache) NextProbe(dst string, now time.Time) (int, bool) {
	e := c.get(dst, now)
	c.age(e, now)
	if !e.probing || e.probeInFlight || e.probeSize <= e.confirmed {
		return 0, false
	}
	e.probeInFlight = true
	return e.probeSize, true
}

// ProbeAck records that a probe of the given size reached the peer,
// raising the confirmed MTU. Stale or unexpected acks are ignored.
func (c *Cache) ProbeAck(dst string, size int, now time.Time) {
	e, ok := c.entries[dst]
	if !ok || !e.probing || !e.probeInFlight || size != e.probeSize {
		return
	}
	e.confirmed = size
	e.probeInFlight = false
	e.fails = 0
	if e.confirmed >= c.cfg.MaxMTU {
		e.probing = false
		e.lastDecrease = now
		return
	}
	e.probeSize = min(e.confirmed+c.cfg.ProbeStep, c.cfg.MaxMTU)
}

// probeFailed handles a lost or rejected probe.
func (c *Cache) probeFailed(e *entry, now time.Time) {
	e.probeInFlight = false
	e.fails++
	if e.fails >= c.cfg.MaxProbeFails {
		// Black hole: stop probing and wait a full aging interval
		// before trying again, so a silent path cannot make the
		// probe state flap.
		e.probing = false
		e.fails = 0
		e.lastDecrease = now
	}
}

// ProbeLost records that an outstanding probe for dst vanished without
// any error (a black hole). After MaxProbeFails consecutive losses the
// cache pauses probing for another aging interval.
func (c *Cache) ProbeLost(dst string, now time.Time) {
	e, ok := c.entries[dst]
	if !ok || !e.probing || !e.probeInFlight {
		return
	}
	c.probeFailed(e, now)
}

// Update feeds a fragmentation-needed error for dst into the cache.
// Only trusted errors may lower the confirmed MTU; errors never raise
// it. A trusted error at or above the confirmed MTU is stale, except
// that it also fails an outstanding probe (the probe was rejected).
func (c *Cache) Update(dst string, errMTU int, trusted bool, now time.Time) {
	if !trusted {
		return
	}
	e := c.get(dst, now)
	m := errMTU
	if m < c.cfg.MinMTU {
		m = c.cfg.MinMTU
	}
	if m > c.cfg.MaxMTU {
		m = c.cfg.MaxMTU
	}
	if m < e.confirmed {
		e.confirmed = m
		e.probing = false
		e.probeInFlight = false
		e.fails = 0
		e.lastDecrease = now
		return
	}
	if e.probing && e.probeInFlight {
		c.probeFailed(e, now)
	}
}
