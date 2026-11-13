package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Config holds coordinator defaults. Per-plan values take precedence.
type Config struct {
	MaxRetries      int
	AttemptTimeout  time.Duration
	RestartRegister *uint16
	Clock           func() time.Time
}

// Option configures a Coordinator.
type Option func(*Config)

// WithMaxRetries sets the default number of additional attempts per range.
func WithMaxRetries(retries int) Option {
	return func(config *Config) {
		config.MaxRetries = retries
	}
}

// WithAttemptTimeout bounds each individual range attempt.
func WithAttemptTimeout(timeout time.Duration) Option {
	return func(config *Config) {
		config.AttemptTimeout = timeout
	}
}

// WithRestartRegister sets the default device restart-counter register.
func WithRestartRegister(address uint16) Option {
	return func(config *Config) {
		addr := address
		config.RestartRegister = &addr
	}
}

// WithRestartCountRegister is an alias for WithRestartRegister.
func WithRestartCountRegister(address uint16) Option {
	return WithRestartRegister(address)
}

// WithClock overrides the clock used for snapshot timestamps.
func WithClock(clock func() time.Time) Option {
	return func(config *Config) {
		if clock != nil {
			config.Clock = clock
		}
	}
}

// WithConfig applies a complete configuration.
func WithConfig(config Config) Option {
	return func(target *Config) {
		if config.MaxRetries != 0 {
			target.MaxRetries = config.MaxRetries
		}
		if config.AttemptTimeout != 0 {
			target.AttemptTimeout = config.AttemptTimeout
		}
		if config.RestartRegister != nil {
			addr := *config.RestartRegister
			target.RestartRegister = &addr
		}
		if config.Clock != nil {
			target.Clock = config.Clock
		}
	}
}

// Coordinator serialises complete device rounds. It never copies values from
// the previous round into a new snapshot.
type Coordinator struct {
	mu sync.Mutex

	reader any
	config Config

	generation   uint64
	sequence     uint64
	hasRestart   bool
	lastRestart  uint16
	lastSnapshot *Snapshot
}

// Aliases for coordinator-oriented call sites.
type (
	SnapshotCoordinator = Coordinator
	RegisterCoordinator = Coordinator
	Collector           = Coordinator
)

// NewCoordinator creates a coordinator around a collector.
//
// Options may be Option, Config, *Config, func(*Config), int (default retries)
// or time.Duration (default attempt timeout). The flexible option form keeps
// existing Modbus collectors easy to wire in without an adapter allocation.
func NewCoordinator(reader any, options ...any) *Coordinator {
	config := Config{
		MaxRetries: 1,
		Clock:      time.Now,
	}
	coordinator := &Coordinator{reader: reader, config: config}
	for _, option := range options {
		coordinator.applyOption(option)
	}
	if coordinator.config.Clock == nil {
		coordinator.config.Clock = time.Now
	}
	return coordinator
}

// NewSnapshotCoordinator is an alias for NewCoordinator.
func NewSnapshotCoordinator(reader any, options ...any) *Coordinator {
	return NewCoordinator(reader, options...)
}

// NewRegisterCoordinator is an alias for NewCoordinator.
func NewRegisterCoordinator(reader any, options ...any) *Coordinator {
	return NewCoordinator(reader, options...)
}

// NewRegisterSnapshotCoordinator is an alias for NewCoordinator.
func NewRegisterSnapshotCoordinator(reader any, options ...any) *Coordinator {
	return NewCoordinator(reader, options...)
}

// New is an alias for NewCoordinator.
func New(reader any, options ...any) *Coordinator {
	return NewCoordinator(reader, options...)
}

func (c *Coordinator) applyOption(option any) {
	switch value := option.(type) {
	case nil:
		return
	case Option:
		value(&c.config)
	case func(*Config):
		value(&c.config)
	case Config:
		WithConfig(value)(&c.config)
	case *Config:
		if value != nil {
			WithConfig(*value)(&c.config)
		}
	case int:
		c.config.MaxRetries = value
	case time.Duration:
		c.config.AttemptTimeout = value
	}
}

// Snapshot reads one complete round. On any failure it returns a nil snapshot
// and leaves the last successful snapshot and generation untouched.
func (c *Coordinator) Snapshot(ctx context.Context, plan PollPlan) (*Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if plan.roundBudget() < 0 {
		return nil, fmt.Errorf("%w: round budget must not be negative", ErrInvalidPlan)
	}
	if plan.attemptTimeout(c.config.AttemptTimeout) < 0 {
		return nil, fmt.Errorf("%w: range timeout must not be negative", ErrInvalidPlan)
	}

	roundCtx, cancel := c.roundContext(ctx, plan)
	defer cancel()

	restartAddress := plan.restartAddress()
	if restartAddress == nil {
		restartAddress = c.config.RestartRegister
	}
	if restartAddress != nil {
		addr := *restartAddress
		restartAddress = &addr
	}

	ranges, err := effectiveRanges(plan.Ranges, restartAddress)
	if err != nil {
		return nil, err
	}

	startedAt := c.config.Clock()
	values := make(map[uint16]uint16)

	var observedRestart uint16
	hasObservedRestart := false

	for _, readRange := range ranges {
		reading, readErr := c.readRange(roundCtx, plan, readRange)
		if readErr != nil {
			return nil, readErr
		}
		if mergeErr := mergeRegisters(values, reading.registers); mergeErr != nil {
			return nil, mergeErr
		}
		if reading.hasRestartCount {
			if hasObservedRestart && reading.restartCount != observedRestart {
				return nil, fmt.Errorf("%w: interval %+v reported restart count %d, previous intervals reported %d",
					ErrGenerationChanged, readRange, reading.restartCount, observedRestart)
			}
			observedRestart = reading.restartCount
			hasObservedRestart = true
		}
	}

	if err := roundBudgetError(roundCtx); err != nil {
		return nil, err
	}

	restartValue := observedRestart
	hasRestart := hasObservedRestart
	if restartAddress != nil {
		value, ok := values[*restartAddress]
		if !ok {
			return nil, fmt.Errorf("%w: restart register %d was not observed", ErrIncomplete, *restartAddress)
		}
		if hasObservedRestart && value != observedRestart {
			return nil, fmt.Errorf("%w: restart register %d is %d but an interval reported %d",
				ErrGenerationChanged, *restartAddress, value, observedRestart)
		}
		restartValue = value
		hasRestart = true
	}

	if restartAddress != nil && plan.VerifyRestartStable {
		verificationRange := ReadRange{Start: *restartAddress, Count: 1}
		reading, readErr := c.readRange(roundCtx, plan, verificationRange)
		if readErr != nil {
			return nil, readErr
		}
		if len(reading.registers) != 1 {
			return nil, fmt.Errorf("%w: restart verification returned %d registers", ErrIncomplete, len(reading.registers))
		}
		if reading.registers[0].Value != restartValue {
			return nil, fmt.Errorf("%w: restart register moved from %d to %d during the round",
				ErrGenerationChanged, restartValue, reading.registers[0].Value)
		}
		if reading.hasRestartCount && reading.restartCount != restartValue {
			return nil, fmt.Errorf("%w: restart verification reported %d, expected %d",
				ErrGenerationChanged, reading.restartCount, restartValue)
		}
	}

	if err := roundBudgetError(roundCtx); err != nil {
		return nil, err
	}

	generation := c.generation
	if generation == 0 {
		generation = 1
	}
	if hasRestart && c.hasRestart && restartValue != c.lastRestart {
		generation++
	}

	sequence := c.sequence + 1
	completedAt := c.config.Clock()
	snapshot := &Snapshot{
		Generation:  generation,
		Sequence:    sequence,
		Round:       sequence,
		Values:      values,
		Registers:   copyRegisters(values),
		Ranges:      append([]ReadRange(nil), ranges...),
		StartedAt:   startedAt,
		CompletedAt: completedAt,
	}
	if hasRestart {
		snapshot.RestartCount = restartValue
		snapshot.RestartCounter = restartValue
		snapshot.HasRestartCount = true
	}

	c.generation = generation
	c.sequence = sequence
	c.hasRestart = hasRestart
	if hasRestart {
		c.lastRestart = restartValue
	}
	c.lastSnapshot = snapshot.Clone()
	return snapshot, nil
}

// Read is an alias for Snapshot.
func (c *Coordinator) Read(ctx context.Context, plan PollPlan) (*Snapshot, error) {
	return c.Snapshot(ctx, plan)
}

// ReadSnapshot is an alias for Snapshot.
func (c *Coordinator) ReadSnapshot(ctx context.Context, plan PollPlan) (*Snapshot, error) {
	return c.Snapshot(ctx, plan)
}

// Collect is an alias for Snapshot.
func (c *Coordinator) Collect(ctx context.Context, plan PollPlan) (*Snapshot, error) {
	return c.Snapshot(ctx, plan)
}

// NextSnapshot is an alias for Snapshot.
func (c *Coordinator) NextSnapshot(ctx context.Context, plan PollPlan) (*Snapshot, error) {
	return c.Snapshot(ctx, plan)
}

// Poll is an alias for Snapshot.
func (c *Coordinator) Poll(ctx context.Context, plan PollPlan) (*Snapshot, error) {
	return c.Snapshot(ctx, plan)
}

// LastSnapshot returns a defensive copy of the last successful snapshot.
func (c *Coordinator) LastSnapshot() *Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastSnapshot.Clone()
}

// Last is an alias for LastSnapshot.
func (c *Coordinator) Last() *Snapshot {
	return c.LastSnapshot()
}

// Generation returns the current published device generation.
func (c *Coordinator) Generation() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.generation
}

// Reset clears generation and snapshot state.
func (c *Coordinator) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.generation = 0
	c.sequence = 0
	c.hasRestart = false
	c.lastRestart = 0
	c.lastSnapshot = nil
}

func (c *Coordinator) roundContext(parent context.Context, plan PollPlan) (context.Context, context.CancelFunc) {
	budget := plan.roundBudget()
	if budget > 0 {
		return context.WithTimeout(parent, budget)
	}
	return parent, func() {}
}

func (c *Coordinator) readRange(roundCtx context.Context, plan PollPlan, readRange ReadRange) (readingResult, error) {
	retries := plan.retryCount(c.config.MaxRetries)
	attemptTimeout := plan.attemptTimeout(c.config.AttemptTimeout)
	attempts := 0
	var lastErr error

	for attempt := 0; attempt <= retries; attempt++ {
		if err := roundCtx.Err(); err != nil {
			if lastErr == nil {
				lastErr = err
			}
			return readingResult{}, &RangeError{
				Range:    readRange,
				Attempts: attempts,
				Err:      roundBudgetError(roundCtx),
			}
		}

		attempts++
		attemptCtx := roundCtx
		cancel := func() {}
		if attemptTimeout > 0 {
			attemptCtx, cancel = context.WithTimeout(roundCtx, attemptTimeout)
		}

		reading, err := c.readOnce(attemptCtx, readRange)
		cancel()
		lastErr = err

		if err == nil {
			if validationErr := validateRegisters(reading.registers, readRange); validationErr != nil {
				lastErr = validationErr
			} else {
				return reading, nil
			}
		}

		if roundCtx.Err() != nil {
			return readingResult{}, &RangeError{
				Range:    readRange,
				Attempts: attempts,
				Err:      roundBudgetError(roundCtx),
			}
		}
		if errors.Is(lastErr, ErrReaderUnsupported) || errors.Is(lastErr, ErrInvalidRange) {
			break
		}
	}

	return readingResult{}, &RangeError{
		Range:    readRange,
		Attempts: attempts,
		Err:      lastErr,
	}
}

func effectiveRanges(requested []ReadRange, restartAddress *uint16) ([]ReadRange, error) {
	ranges := make([]ReadRange, 0, len(requested)+1)
	restartCovered := false

	for _, requestedRange := range requested {
		normalised, err := requestedRange.normalise()
		if err != nil {
			return nil, err
		}
		ranges = append(ranges, normalised)
		if restartAddress != nil && normalised.Contains(*restartAddress) {
			restartCovered = true
		}
	}

	if restartAddress != nil && !restartCovered {
		ranges = append(ranges, ReadRange{Start: *restartAddress, Count: 1})
	}
	if len(ranges) == 0 {
		return nil, fmt.Errorf("%w: no read ranges", ErrInvalidPlan)
	}
	return ranges, nil
}

func validateRegisters(registers []Register, readRange ReadRange) error {
	start := uint32(readRange.RangeStart())
	count := uint32(readRange.RangeCount())
	if uint32(len(registers)) != count {
		return fmt.Errorf("%w: range %+v expected %d registers, got %d",
			ErrIncomplete, readRange, count, len(registers))
	}

	seen := make(map[uint16]struct{}, len(registers))
	for _, register := range registers {
		address := uint32(register.Address)
		if address < start || address >= start+count {
			return fmt.Errorf("%w: range %+v returned address %d",
				ErrIncomplete, readRange, register.Address)
		}
		if _, duplicate := seen[register.Address]; duplicate {
			return fmt.Errorf("%w: range %+v returned address %d more than once",
				ErrIncomplete, readRange, register.Address)
		}
		seen[register.Address] = struct{}{}
	}
	return nil
}

func mergeRegisters(values map[uint16]uint16, registers []Register) error {
	for _, register := range registers {
		existing, ok := values[register.Address]
		if ok && existing != register.Value {
			return &ConflictError{
				Address:  register.Address,
				Existing: existing,
				Incoming: register.Value,
				First:    existing,
				Second:   register.Value,
			}
		}
		values[register.Address] = register.Value
	}
	return nil
}

func roundBudgetError(ctx context.Context) error {
	err := ctx.Err()
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: round budget exhausted", ErrTimeout)
	}
	return err
}

// ReadSnapshot is a one-shot helper around a fresh Coordinator.
func ReadSnapshot(ctx context.Context, reader any, plan PollPlan, options ...any) (*Snapshot, error) {
	return NewCoordinator(reader, options...).Snapshot(ctx, plan)
}

// CollectSnapshot is an alias for ReadSnapshot.
func CollectSnapshot(ctx context.Context, reader any, plan PollPlan, options ...any) (*Snapshot, error) {
	return ReadSnapshot(ctx, reader, plan, options...)
}

// CombineReadings validates and merges already-completed interval reads. This
// is useful when a collector performs its own transport calls but still wants
// the coordinator's conflict and completeness rules.
func CombineReadings(readings []RangeReading) (*Snapshot, error) {
	values := make(map[uint16]uint16)
	ranges := make([]ReadRange, 0, len(readings))
	var observedRestart uint16
	hasObservedRestart := false

	for _, reading := range readings {
		normalised, err := reading.Range.normalise()
		if err != nil {
			return nil, err
		}
		if err := validateRegisters(reading.Registers, normalised); err != nil {
			return nil, err
		}
		if err := mergeRegisters(values, reading.Registers); err != nil {
			return nil, err
		}
		ranges = append(ranges, normalised)

		if reading.HasRestartCount {
			if hasObservedRestart && reading.RestartCount != observedRestart {
				return nil, fmt.Errorf("%w: interval %+v reported restart count %d, previous intervals reported %d",
					ErrGenerationChanged, normalised, reading.RestartCount, observedRestart)
			}
			observedRestart = reading.RestartCount
			hasObservedRestart = true
		}
	}

	if len(readings) == 0 {
		return nil, fmt.Errorf("%w: no readings", ErrInvalidPlan)
	}

	now := time.Now()
	snapshot := &Snapshot{
		Generation:  1,
		Sequence:    1,
		Round:       1,
		Values:      values,
		Registers:   copyRegisters(values),
		Ranges:      ranges,
		StartedAt:   now,
		CompletedAt: now,
	}
	if hasObservedRestart {
		snapshot.RestartCount = observedRestart
		snapshot.RestartCounter = observedRestart
		snapshot.HasRestartCount = true
	}
	return snapshot, nil
}

// Combine is an alias for CombineReadings.
func Combine(readings []RangeReading) (*Snapshot, error) {
	return CombineReadings(readings)
}
