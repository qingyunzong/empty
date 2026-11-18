package formal

import (
	"container/heap"
	"errors"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

var (
	// ErrClockBackwards is returned when a scheduler is advanced to an earlier
	// instant than the last processed instant.
	ErrClockBackwards = errors.New("scheduler clock moved backwards")
	// ErrEmptyID is returned when a message has no identifier.
	ErrEmptyID = errors.New("message ID must not be empty")
	// ErrDuplicateID is returned when a pending message already uses an ID.
	ErrDuplicateID = errors.New("message ID is already pending")
	// ErrRestoreNotEmpty is returned when restoring into a non-empty scheduler.
	ErrRestoreNotEmpty = errors.New("scheduler must be empty before restore")
	// ErrSnapshotVersion is returned for an unsupported snapshot version.
	ErrSnapshotVersion = errors.New("unsupported snapshot version")
)

// Config controls the hierarchical timing wheel. Tick is the resolution of
// the lowest wheel; WheelSize is the number of slots in every wheel. The
// effective span of level i is Tick*WheelSize^(i+1). Exact message deadlines
// are retained independently of Tick, so the wheel only controls placement and
// scan cost. Zero values select DefaultConfig values.
type Config struct {
	Tick      time.Duration
	WheelSize int
	MaxLevels int
}

// DefaultConfig returns a wheel with millisecond resolution and 64 slots per
// level. Up to eight levels are created as the scheduling horizon grows.
func DefaultConfig() Config {
	return Config{
		Tick:      time.Millisecond,
		WheelSize: 64,
		MaxLevels: 8,
	}
}

func (c Config) normalized() (Config, error) {
	defaults := DefaultConfig()
	if c.Tick == 0 {
		c.Tick = defaults.Tick
	}
	if c.WheelSize == 0 {
		c.WheelSize = defaults.WheelSize
	}
	if c.MaxLevels == 0 {
		c.MaxLevels = defaults.MaxLevels
	}
	if c.Tick < 0 {
		return Config{}, fmt.Errorf("tick must be positive: %s", c.Tick)
	}
	if c.WheelSize < 2 {
		return Config{}, fmt.Errorf("wheel size must be at least 2: %d", c.WheelSize)
	}
	if c.MaxLevels < 1 {
		return Config{}, fmt.Errorf("max levels must be positive: %d", c.MaxLevels)
	}
	return c, nil
}

// Message is a delayed message submitted to a Scheduler.
type Message struct {
	ID      string
	Due     time.Time
	Payload any
}

// Event is a message that became due. FiredAt is the instant supplied to
// Advance when the message was emitted; Due retains the exact deadline and is
// the ordering key.
type Event struct {
	ID      string
	Due     time.Time
	Payload any
	FiredAt time.Time
}

// Stats is a point-in-time diagnostic view of a Scheduler.
type Stats struct {
	Pending    int
	Buckets    int
	Levels     int
	Fired      uint64
	Cancelled  uint64
	Promotions uint64
}

// Scheduler stores delayed messages in a hierarchical timing wheel. It is safe
// for concurrent use.
type Scheduler struct {
	mu sync.Mutex

	clock     Clock
	tick      int64
	slots     int
	maxLevels int
	levels    []*wheelLevel
	buckets   bucketHeap
	messages  map[string]*entry
	sequence  uint64

	lastNowNs time.Time
	hasNow    bool

	fired      uint64
	cancelled  uint64
	promotions uint64
}

// New creates a scheduler using clock and cfg.
func New(clock Clock, cfg Config) (*Scheduler, error) {
	if clock == nil {
		return nil, errors.New("clock must not be nil")
	}
	cfg, err := cfg.normalized()
	if err != nil {
		return nil, err
	}
	s := &Scheduler{
		clock:     clock,
		tick:      int64(cfg.Tick),
		slots:     cfg.WheelSize,
		maxLevels: cfg.MaxLevels,
		messages:  make(map[string]*entry),
	}
	s.addLevelsLocked(1)
	return s, nil
}

// NewScheduler is an alias for New.
func NewScheduler(clock Clock, cfg Config) (*Scheduler, error) {
	return New(clock, cfg)
}

// NewWithClock creates a scheduler with DefaultConfig.
func NewWithClock(clock Clock) (*Scheduler, error) {
	return New(clock, DefaultConfig())
}

// ScheduleAt submits a message that is due at due. The caller may schedule a
// message in the past; it is emitted by the next Advance or Poll.
func (s *Scheduler) ScheduleAt(id string, due time.Time, payload any) error {
	if id == "" {
		return ErrEmptyID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.messages[id]; exists {
		return fmt.Errorf("%w: %q", ErrDuplicateID, id)
	}
	s.sequence++
	e := &entry{
		id:       id,
		due:      due,
		dueNs:    due.UnixNano(),
		payload:  payload,
		sequence: s.sequence,
		state:    statePending,
	}
	s.messages[id] = e
	s.placeLocked(e, s.clock.Now().UnixNano())
	return nil
}

// ScheduleAfter submits a message relative to the scheduler's clock.
func (s *Scheduler) ScheduleAfter(id string, delay time.Duration, payload any) error {
	return s.ScheduleAt(id, s.clock.Now().Add(delay), payload)
}

// Schedule submits a Message.
func (s *Scheduler) Schedule(msg Message) error {
	return s.ScheduleAt(msg.ID, msg.Due, msg.Payload)
}

// Add is an alias for Schedule.
func (s *Scheduler) Add(msg Message) error {
	return s.Schedule(msg)
}

// Cancel removes a pending message. Cancelled messages are detached from their
// wheel bucket immediately and therefore never occupy a firing slot. It returns
// false if the ID is unknown, already fired, or already cancelled.
func (s *Scheduler) Cancel(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.messages[id]
	if !ok || e.state != statePending {
		return false
	}
	s.removeEntryLocked(e)
	e.state = stateCancelled
	delete(s.messages, id)
	s.cancelled++
	return true
}

// Remove is an alias for Cancel.
func (s *Scheduler) Remove(id string) bool { return s.Cancel(id) }

// Advance emits every message with Due <= now, ordered by Due and then by
// submission order. Moving to an earlier instant returns ErrClockBackwards.
func (s *Scheduler) Advance(now time.Time) ([]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.advanceLocked(now)
}

// AdvanceTo is an alias for Advance.
func (s *Scheduler) AdvanceTo(now time.Time) ([]Event, error) {
	return s.Advance(now)
}

// Poll advances to the current clock time.
func (s *Scheduler) Poll() []Event {
	events, _ := s.Advance(s.clock.Now())
	return events
}

// Tick advances to the current clock time and returns the emitted messages.
// It is useful in an embedding broker's event loop.
func (s *Scheduler) Tick() []Event { return s.Poll() }

func (s *Scheduler) advanceLocked(now time.Time) ([]Event, error) {
	nowNs := now.UnixNano()
	if s.hasNow && nowNs < s.lastNowNs.UnixNano() {
		return nil, fmt.Errorf("%w: %s < %s", ErrClockBackwards, now, s.lastNowNs)
	}
	s.lastNowNs = now
	s.hasNow = true

	var due []*entry
	var future []*entry
	for len(s.buckets) > 0 && s.buckets[0].start <= nowNs {
		b := s.popBucketLocked()
		for _, e := range b.entries {
			e.bucket = nil
			e.position = -1
			if e.dueNs <= nowNs {
				due = append(due, e)
			} else {
				future = append(future, e)
			}
		}
		b.entries = nil
	}

	for _, e := range future {
		oldLevel := e.level
		s.placeLocked(e, nowNs)
		if e.level < oldLevel {
			s.promotions++
		}
	}

	if len(due) == 0 {
		return nil, nil
	}
	sort.SliceStable(due, func(i, j int) bool {
		if due[i].dueNs != due[j].dueNs {
			return due[i].dueNs < due[j].dueNs
		}
		return due[i].sequence < due[j].sequence
	})

	events := make([]Event, 0, len(due))
	for _, e := range due {
		if e.state != statePending {
			continue
		}
		e.state = stateFired
		delete(s.messages, e.id)
		s.fired++
		events = append(events, Event{
			ID:      e.id,
			Due:     e.due,
			Payload: e.payload,
			FiredAt: now,
		})
	}
	return events, nil
}

func (s *Scheduler) placeLocked(e *entry, nowNs int64) {
	level := s.levelForLocked(saturatingSub(e.dueNs, nowNs))
	start := floorTo(e.dueNs, level.resolution)
	b := s.levelBucketLocked(level, start)
	b.add(e)
}

func (s *Scheduler) levelForLocked(delay int64) *wheelLevel {
	for _, level := range s.levels {
		if delay <= level.span {
			return level
		}
	}
	for len(s.levels) < s.maxLevels {
		s.addLevelsLocked(1)
		level := s.levels[len(s.levels)-1]
		if delay <= level.span {
			return level
		}
	}
	return s.levels[len(s.levels)-1]
}

func (s *Scheduler) addLevelsLocked(count int) {
	for i := 0; i < count; i++ {
		index := len(s.levels)
		resolution := s.tick
		if index > 0 {
			resolution = saturatingMul(s.levels[index-1].resolution, int64(s.slots))
		}
		s.levels = append(s.levels, newLevel(index, resolution, s.slots))
	}
}

func (s *Scheduler) levelBucketLocked(level *wheelLevel, start int64) *bucket {
	if b, ok := level.buckets[start]; ok {
		return b
	}
	b := &bucket{
		level:     level.index,
		start:     start,
		heapIndex: -1,
	}
	level.buckets[start] = b
	heap.Push(&s.buckets, b)
	return b
}

func (s *Scheduler) popBucketLocked() *bucket {
	b := heap.Pop(&s.buckets).(*bucket)
	delete(s.levels[b.level].buckets, b.start)
	return b
}

func (s *Scheduler) removeEntryLocked(e *entry) {
	b := e.bucket
	if b == nil {
		return
	}
	b.remove(e)
	if len(b.entries) != 0 {
		return
	}
	delete(s.levels[b.level].buckets, b.start)
	if b.heapIndex >= 0 {
		heap.Remove(&s.buckets, b.heapIndex)
	}
}

func saturatingSub(a, b int64) int64 {
	if b > 0 && a < math.MinInt64+b {
		return math.MinInt64
	}
	if b < 0 && a > math.MaxInt64+b {
		return math.MaxInt64
	}
	return a - b
}

// Next returns the earliest pending deadline and whether one exists.
func (s *Scheduler) Next() (time.Time, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var selected *entry
	for _, e := range s.messages {
		if e.state != statePending {
			continue
		}
		if selected == nil || e.dueNs < selected.dueNs ||
			(e.dueNs == selected.dueNs && e.sequence < selected.sequence) {
			selected = e
		}
	}
	if selected == nil {
		return time.Time{}, false
	}
	return selected.due, true
}

// NextDue is an alias for Next.
func (s *Scheduler) NextDue() (time.Time, bool) { return s.Next() }

// Len returns the number of pending messages.
func (s *Scheduler) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.messages)
}

// Stats returns scheduler diagnostics.
func (s *Scheduler) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Stats{
		Pending:    len(s.messages),
		Buckets:    len(s.buckets),
		Levels:     len(s.levels),
		Fired:      s.fired,
		Cancelled:  s.cancelled,
		Promotions: s.promotions,
	}
}

// Clock returns the scheduler's clock.
func (s *Scheduler) Clock() Clock { return s.clock }
