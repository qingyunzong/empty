package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// ErrUnknownRule is returned when events are applied to an unregistered rule.
var ErrUnknownRule = errors.New("dataeng: unknown rule")

// Rule defines how raw keys become comparable occupancies. Keys are only ever
// compared inside one rule and one normalization generation: different rules,
// and different NormVersions of the same rule, never see each other's state.
type Rule struct {
	ID          string
	NormVersion int
	// Normalize maps a raw key to its canonical form; two raw keys with the
	// same normalized form collide.
	Normalize func(string) string
	Window    WindowSpec
	// AllowedLateness is how far behind the generation's watermark an event
	// may lag and still revise state; older events are rejected.
	AllowedLateness time.Duration
}

// Conflict is a normalized key claimed by more than one entity inside one
// window of the current generation.
type Conflict struct {
	Generation    int
	WindowStart   time.Time
	WindowEnd     time.Time
	NormalizedKey string
	Owner         string
	Members       []string
}

type claim struct {
	entityID    string
	key         string
	windowStart time.Time
	eventTime   time.Time
	seq         uint64
}

// less orders claims by occupancy precedence: earliest event time wins, with
// sequence and entity ID as deterministic tie-breakers.
func (c *claim) less(o *claim) bool {
	if !c.eventTime.Equal(o.eventTime) {
		return c.eventTime.Before(o.eventTime)
	}
	if c.seq != o.seq {
		return c.seq < o.seq
	}
	return c.entityID < o.entityID
}

type keyBucket struct {
	claims map[string]*claim // entityID -> claim
}

// ranked returns claims sorted by occupancy precedence.
func (b *keyBucket) ranked() []*claim {
	out := make([]*claim, 0, len(b.claims))
	for _, c := range b.claims {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].less(out[j]) })
	return out
}

type windowState struct {
	start   time.Time
	buckets map[string]*keyBucket // normalized key -> claims
}

// generation is the isolated state produced by one normalization version of
// a rule. A version bump opens a new generation; generations are never
// compared with each other.
type generation struct {
	number       int
	rule         Rule
	watermark    time.Time
	hasWatermark bool
	windows      map[int64]*windowState // window start (unix nano) -> state
	entities     map[string]*claim      // entityID -> current claim
}

func (g *generation) window(start time.Time) *windowState {
	key := start.UnixNano()
	ws, ok := g.windows[key]
	if !ok {
		ws = &windowState{start: start, buckets: make(map[string]*keyBucket)}
		g.windows[key] = ws
	}
	return ws
}

// revoke removes the entity's current claim in this generation, returning
// the removed claim and the bucket it left behind (nil if none).
func (g *generation) revoke(entityID string) (*claim, *keyBucket) {
	old, ok := g.entities[entityID]
	if !ok {
		return nil, nil
	}
	delete(g.entities, entityID)
	ws, ok := g.windows[old.windowStart.UnixNano()]
	if !ok {
		return old, nil
	}
	bucket, ok := ws.buckets[old.key]
	if !ok {
		return old, nil
	}
	delete(bucket.claims, entityID)
	if len(bucket.claims) == 0 {
		delete(ws.buckets, old.key)
	}
	return old, bucket
}

type ruleState struct {
	rule Rule
	gen  *generation
}

// Store is the unique-key state library the streaming quality gate plugs
// into. It is safe for concurrent use.
type Store struct {
	mu    sync.Mutex
	rules map[string]*ruleState
	seq   uint64
}

func NewStore() *Store {
	return &Store{rules: make(map[string]*ruleState)}
}

// RegisterRule makes a rule known to the store and returns its current
// generation number. Re-registering with the same NormVersion is a no-op;
// registering with a new NormVersion opens a new generation whose state is
// disjoint from every previous one.
func (s *Store) RegisterRule(rule Rule) (int, error) {
	if rule.ID == "" {
		return 0, errors.New("dataeng: rule ID is required")
	}
	if rule.Normalize == nil {
		return 0, fmt.Errorf("dataeng: rule %q requires a Normalize func", rule.ID)
	}
	if rule.Window.Size <= 0 {
		return 0, fmt.Errorf("dataeng: rule %q window size must be positive", rule.ID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if rs, ok := s.rules[rule.ID]; ok {
		if rs.rule.NormVersion == rule.NormVersion {
			return rs.gen.number, nil
		}
		rs.rule = rule
		rs.gen = &generation{
			number:   rs.gen.number + 1,
			rule:     rule,
			windows:  make(map[int64]*windowState),
			entities: make(map[string]*claim),
		}
		return rs.gen.number, nil
	}
	gen := &generation{
		number:   0,
		rule:     rule,
		windows:  make(map[int64]*windowState),
		entities: make(map[string]*claim),
	}
	s.rules[rule.ID] = &ruleState{rule: rule, gen: gen}
	return gen.number, nil
}

// CurrentGeneration reports the rule's active generation number.
func (s *Store) CurrentGeneration(ruleID string) (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rs, ok := s.rules[ruleID]
	if !ok {
		return 0, false
	}
	return rs.gen.number, true
}

// Apply evaluates one event against the rule's current generation.
func (s *Store) Apply(ruleID string, ev Event) (Outcome, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rs, ok := s.rules[ruleID]
	if !ok {
		return Outcome{}, fmt.Errorf("%w: %q", ErrUnknownRule, ruleID)
	}
	g := rs.gen
	out := Outcome{RuleID: ruleID, Generation: g.number}

	// Late events beyond the allowed lateness are dropped without touching
	// any state; events inside it still revise their window's conflict group.
	if g.hasWatermark && ev.EventTime.Before(g.watermark.Add(-g.rule.AllowedLateness)) {
		out.Status = StatusRejectedLate
		return out, nil
	}
	if !g.hasWatermark || ev.EventTime.After(g.watermark) {
		g.watermark, g.hasWatermark = ev.EventTime, true
	}

	s.seq++
	seq := s.seq

	// Updates and deletes undo the entity's previous key first.
	old, oldBucket := g.revoke(ev.EntityID)
	if old != nil {
		out.RevokedKey = old.key
		out.RevokedWindow = old.windowStart
	}

	if ev.Op == OpDelete {
		out.Status = StatusAccepted
		fillGroup(&out, oldBucket)
		return out, nil
	}

	norm := g.rule.Normalize(ev.Key)
	start := g.rule.Window.Start(ev.EventTime)
	ws := g.window(start)
	bucket, ok := ws.buckets[norm]
	if !ok {
		bucket = &keyBucket{claims: make(map[string]*claim)}
		ws.buckets[norm] = bucket
	}
	c := &claim{
		entityID:    ev.EntityID,
		key:         norm,
		windowStart: start,
		eventTime:   ev.EventTime,
		seq:         seq,
	}
	bucket.claims[ev.EntityID] = c
	g.entities[ev.EntityID] = c

	out.NormalizedKey = norm
	out.WindowStart = start
	out.WindowEnd = g.rule.Window.End(start)
	if len(bucket.claims) > 1 {
		out.Status = StatusDuplicate
	} else {
		out.Status = StatusAccepted
	}
	fillGroup(&out, bucket)
	return out, nil
}

// fillGroup populates owner and conflict-group fields from a bucket.
func fillGroup(out *Outcome, bucket *keyBucket) {
	if bucket == nil || len(bucket.claims) == 0 {
		return
	}
	ranked := bucket.ranked()
	out.Owner = ranked[0].entityID
	if len(ranked) > 1 {
		members := make([]string, len(ranked))
		for i, c := range ranked {
			members[i] = c.entityID
		}
		out.ConflictGroup = members
	}
}

// Conflicts lists the unresolved conflict groups in the rule's current
// generation, ordered by window, key.
func (s *Store) Conflicts(ruleID string) ([]Conflict, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rs, ok := s.rules[ruleID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownRule, ruleID)
	}
	g := rs.gen
	var out []Conflict
	for _, ws := range g.windows {
		for key, bucket := range ws.buckets {
			if len(bucket.claims) < 2 {
				continue
			}
			ranked := bucket.ranked()
			members := make([]string, len(ranked))
			for i, c := range ranked {
				members[i] = c.entityID
			}
			out = append(out, Conflict{
				Generation:    g.number,
				WindowStart:   ws.start,
				WindowEnd:     g.rule.Window.End(ws.start),
				NormalizedKey: key,
				Owner:         ranked[0].entityID,
				Members:       members,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].WindowStart.Equal(out[j].WindowStart) {
			return out[i].WindowStart.Before(out[j].WindowStart)
		}
		return out[i].NormalizedKey < out[j].NormalizedKey
	})
	return out, nil
}
