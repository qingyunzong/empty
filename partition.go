package formal

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
)

// Config controls a planning run.
type Config struct {
	// Partitions is the requested number of physical partitions. It must be at
	// least one.
	Partitions int

	// HotKeyFactor is the load multiple of the ideal partition load at which a
	// key is considered skewed. Values <= 0 select the default of 1.25.
	HotKeyFactor float64

	// MinHotLoad is the smallest key load that may be salted. Values <= 0
	// select the default of 2: a single occurrence can never be split.
	MinHotLoad int64

	// MaxSaltBuckets limits the number of salted sub-partitions created for one
	// key. Values <= 0 select min(Partitions, 32). A value of one disables
	// salting.
	MaxSaltBuckets int

	// Previous makes planning migration-aware. The returned plan reports the
	// observed load that changed partition relative to this plan, and the
	// planner uses it as a deterministic tie-breaker.
	Previous *Plan
}

// DefaultConfig returns a configuration suitable for most callers.
func DefaultConfig(partitions int) Config {
	return Config{
		Partitions:     partitions,
		HotKeyFactor:   1.25,
		MinHotLoad:     2,
		MaxSaltBuckets: minInt(partitions, 32),
	}
}

func (c Config) normalized() (Config, error) {
	if c.Partitions < 1 {
		return Config{}, fmt.Errorf("%w: partitions must be at least 1", ErrInvalidConfig)
	}
	if math.IsNaN(c.HotKeyFactor) || math.IsInf(c.HotKeyFactor, 0) {
		return Config{}, fmt.Errorf("%w: hot key factor must be finite", ErrInvalidConfig)
	}
	if c.HotKeyFactor <= 0 {
		c.HotKeyFactor = 1.25
	}
	if c.MinHotLoad <= 0 {
		c.MinHotLoad = 2
	}
	if c.MaxSaltBuckets <= 0 {
		c.MaxSaltBuckets = minInt(c.Partitions, 32)
	}
	if c.MaxSaltBuckets > c.Partitions {
		c.MaxSaltBuckets = c.Partitions
	}
	return c, nil
}

// ErrInvalidConfig is returned for a configuration that cannot produce a plan.
var ErrInvalidConfig = errors.New("formal: invalid partitioning configuration")

// Event is a unit of observed load. A non-empty ID makes ingestion idempotent:
// observing the same ID more than once adds the event exactly once.
type Event struct {
	ID     string
	Key    string
	Weight int64
}

// Partitioner accumulates key load and turns it into immutable plans. It is
// safe for concurrent use.
type Partitioner struct {
	mu       sync.Mutex
	cfg      Config
	counts   map[string]int64
	seen     map[string]struct{}
	total    int64
	revision uint64
	events   int
}

// Planner is an alias for Partitioner.
type Planner = Partitioner

// NewPartitioner creates a load accumulator with a validated configuration.
func NewPartitioner(cfg Config) (*Partitioner, error) {
	cfg, err := cfg.normalized()
	if err != nil {
		return nil, err
	}
	return &Partitioner{
		cfg:    cfg,
		counts: make(map[string]int64),
		seen:   make(map[string]struct{}),
	}, nil
}

// New is an alias for NewPartitioner.
func New(cfg Config) (*Partitioner, error) {
	return NewPartitioner(cfg)
}

// NewPlanner is an alias for NewPartitioner.
func NewPlanner(cfg Config) (*Partitioner, error) {
	return NewPartitioner(cfg)
}

// Observe records weight units for key. With no weight it records one unit.
// Non-positive weights are ignored.
func (p *Partitioner) Observe(key string, weight ...int64) {
	n := int64(1)
	if len(weight) > 0 {
		n = weight[0]
	}
	_ = p.ObserveN(key, n)
}

// ObserveN records n units for key. It rejects negative n.
func (p *Partitioner) ObserveN(key string, n int64) error {
	if n < 0 {
		return fmt.Errorf("formal: negative observation weight %d", n)
	}
	if n == 0 {
		return nil
	}
	p.mu.Lock()
	p.counts[key] += n
	p.total += n
	p.revision++
	p.events++
	p.mu.Unlock()
	return nil
}

// AddEvent records an event exactly once when its ID is non-empty. It returns
// true when load was added.
func (p *Partitioner) AddEvent(e Event) bool {
	if e.Weight <= 0 {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if e.ID != "" {
		if _, ok := p.seen[e.ID]; ok {
			return false
		}
		p.seen[e.ID] = struct{}{}
	}
	p.counts[e.Key] += e.Weight
	p.total += e.Weight
	p.revision++
	p.events++
	return true
}

// Add is a convenience wrapper around AddEvent.
func (p *Partitioner) Add(id, key string, weight int64) bool {
	return p.AddEvent(Event{ID: id, Key: key, Weight: weight})
}

// ObserveMap atomically adds all positive entries of freq.
func (p *Partitioner) ObserveMap(freq map[string]int64) error {
	for key, n := range freq {
		if n < 0 {
			return fmt.Errorf("formal: negative observation weight %d for key %q", n, key)
		}
	}
	p.mu.Lock()
	for key, n := range freq {
		if n == 0 {
			continue
		}
		p.counts[key] += n
		p.total += n
		p.events++
	}
	p.revision++
	p.mu.Unlock()
	return nil
}

// Snapshot is a point-in-time copy of observed load.
type Snapshot struct {
	Counts   map[string]int64
	Total    int64
	Revision uint64
	Events   int
}

// Snapshot returns a copy that the caller may modify freely.
func (p *Partitioner) Snapshot() Snapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	counts := make(map[string]int64, len(p.counts))
	for key, n := range p.counts {
		counts[key] = n
	}
	return Snapshot{
		Counts:   counts,
		Total:    p.total,
		Revision: p.revision,
		Events:   p.events,
	}
}

// Reset clears observations and event IDs. It keeps the configuration.
func (p *Partitioner) Reset() {
	p.mu.Lock()
	p.counts = make(map[string]int64)
	p.seen = make(map[string]struct{})
	p.total = 0
	p.revision++
	p.events = 0
	p.mu.Unlock()
}

// SetPrevious changes the migration baseline used by subsequent plans.
func (p *Partitioner) SetPrevious(previous *Plan) {
	p.mu.Lock()
	p.cfg.Previous = previous
	p.mu.Unlock()
}

// Config returns a copy of the effective configuration.
func (p *Partitioner) Config() Config {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cfg
}

// Plan builds a plan from the observations visible at one instant. Events
// arriving while the plan is computed are not included in that plan and are
// not double counted by a later plan.
func (p *Partitioner) Plan() (*Plan, error) {
	p.mu.Lock()
	counts := make(map[string]int64, len(p.counts))
	for key, n := range p.counts {
		counts[key] = n
	}
	cfg := p.cfg
	revision := p.revision
	p.mu.Unlock()
	return buildPlan(counts, cfg, revision)
}

// BuildPlan builds a plan directly from a frequency table. Zero and negative
// counts are ignored; they do not represent observed load.
func BuildPlan(freq map[string]int64, cfg Config) (*Plan, error) {
	cfg, err := cfg.normalized()
	if err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(freq))
	for key, n := range freq {
		if n > 0 {
			counts[key] = n
		}
	}
	return buildPlan(counts, cfg, 1)
}

// Balance is an alias for BuildPlan.
func Balance(freq map[string]int64, cfg Config) (*Plan, error) {
	return BuildPlan(freq, cfg)
}

func sortedKeys(counts map[string]int64) []string {
	keys := make([]string, 0, len(counts))
	for key, n := range counts {
		if n > 0 {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
