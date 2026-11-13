package dataeng

import (
	"sort"
	"time"
)

// Register is one holding-register value returned by a device.
type Register struct {
	Address uint16
	Value   uint16
}

// Address returns a pointer to a register address. It is useful for
// PollPlan.RestartRegister and Config literals.
func Address(address uint16) *uint16 {
	return &address
}

// ReadRange is a half-open Modbus read interval: [Start, Start+Count).
//
// Address, Quantity and Length are accepted as aliases for Start and Count so
// callers that model the request as an address/quantity pair can use the same
// plan.
type ReadRange struct {
	Start    uint16
	Count    uint16
	Address  uint16
	Quantity uint16
	Length   uint16
}

// RangeStart returns the normalised start address.
func (r ReadRange) RangeStart() uint16 {
	if r.Start != 0 {
		return r.Start
	}
	return r.Address
}

// RangeCount returns the normalised register count.
func (r ReadRange) RangeCount() uint16 {
	switch {
	case r.Count != 0:
		return r.Count
	case r.Quantity != 0:
		return r.Quantity
	default:
		return r.Length
	}
}

// End returns the exclusive end address of the range.
func (r ReadRange) End() uint32 {
	return uint32(r.RangeStart()) + uint32(r.RangeCount())
}

// Contains reports whether addr belongs to the range.
func (r ReadRange) Contains(addr uint16) bool {
	start := uint32(r.RangeStart())
	return uint32(addr) >= start && uint32(addr) < start+uint32(r.RangeCount())
}

func (r ReadRange) normalise() (ReadRange, error) {
	start := r.RangeStart()
	count := r.RangeCount()

	if count == 0 {
		return ReadRange{}, invalidRangeError(r, "count must be greater than zero")
	}
	if r.Start != 0 && r.Address != 0 && r.Start != r.Address {
		return ReadRange{}, invalidRangeError(r, "Start and Address disagree")
	}
	if r.Count != 0 && r.Quantity != 0 && r.Count != r.Quantity {
		return ReadRange{}, invalidRangeError(r, "Count and Quantity disagree")
	}
	if r.Count != 0 && r.Length != 0 && r.Count != r.Length {
		return ReadRange{}, invalidRangeError(r, "Count and Length disagree")
	}
	if r.Quantity != 0 && r.Length != 0 && r.Quantity != r.Length {
		return ReadRange{}, invalidRangeError(r, "Quantity and Length disagree")
	}
	if uint32(start)+uint32(count) > 1<<16 {
		return ReadRange{}, invalidRangeError(r, "range exceeds the 16-bit address space")
	}

	return ReadRange{Start: start, Count: count}, nil
}

// RangeReading is a completed read of one interval.
//
// RestartCount is optional. When a reader supplies it for every interval, the
// coordinator uses it as an additional consistency check across the round.
type RangeReading struct {
	Range           ReadRange
	Registers       []Register
	RestartCount    uint16
	HasRestartCount bool
}

// Aliases for RangeReading.
type (
	RangeObservation = RangeReading
	RegisterReading  = RangeReading
	ReadResult       = RangeReading
)

// PollPlan describes one consistent device round.
//
// The round budget is the first non-zero value among Cycle, Period,
// DeviceCycle, Budget and Timeout. All range attempts and retries share that
// budget; a retry never extends it.
type PollPlan struct {
	UnitID uint8

	Cycle       time.Duration
	Period      time.Duration
	DeviceCycle time.Duration
	Budget      time.Duration
	Timeout     time.Duration

	Ranges []ReadRange

	// RestartRegister identifies the device's reboot/power-cycle counter.
	// RestartCountRegister and RestartCounter are accepted aliases.
	RestartRegister      *uint16
	RestartCountRegister *uint16
	RestartCounter       *uint16

	// MaxRetries is the number of additional attempts allowed per range.
	// Retries is an alias. A negative value disables retries; zero uses the
	// coordinator default.
	MaxRetries int
	Retries    int

	// RangeTimeout/ReadTimeout bound a single range attempt. They must not
	// exceed the round budget.
	RangeTimeout time.Duration
	ReadTimeout  time.Duration

	// VerifyRestartStable re-reads the restart counter at the end of the
	// round. A change invalidates the complete round.
	VerifyRestartStable bool
}

// Snapshot is one complete, internally consistent device observation.
//
// A Snapshot never contains values borrowed from a previous successful round.
type Snapshot struct {
	Generation uint64
	Sequence   uint64
	Round      uint64

	Values    map[uint16]uint16
	Registers []Register
	Ranges    []ReadRange

	RestartCount    uint16
	RestartCounter  uint16
	HasRestartCount bool

	StartedAt   time.Time
	CompletedAt time.Time
}

// Value returns the register value at addr.
func (s *Snapshot) Value(addr uint16) (uint16, bool) {
	if s == nil {
		return 0, false
	}
	value, ok := s.Values[addr]
	return value, ok
}

// Clone returns a deep copy of the snapshot.
func (s *Snapshot) Clone() *Snapshot {
	if s == nil {
		return nil
	}
	clone := *s
	clone.Values = make(map[uint16]uint16, len(s.Values))
	for addr, value := range s.Values {
		clone.Values[addr] = value
	}
	clone.Registers = append([]Register(nil), s.Registers...)
	clone.Ranges = append([]ReadRange(nil), s.Ranges...)
	return &clone
}

func (p PollPlan) roundBudget() time.Duration {
	for _, budget := range []time.Duration{
		p.Cycle,
		p.Period,
		p.DeviceCycle,
		p.Budget,
		p.Timeout,
	} {
		if budget != 0 {
			return budget
		}
	}
	return 0
}

func (p PollPlan) restartAddress() *uint16 {
	for _, addr := range []*uint16{
		p.RestartRegister,
		p.RestartCountRegister,
		p.RestartCounter,
	} {
		if addr != nil {
			return addr
		}
	}
	return nil
}

func (p PollPlan) retryCount(defaultRetries int) int {
	retries := defaultRetries
	if p.MaxRetries != 0 {
		retries = p.MaxRetries
	}
	if p.Retries != 0 {
		retries = p.Retries
	}
	if retries < 0 {
		return 0
	}
	return retries
}

func (p PollPlan) attemptTimeout(defaultTimeout time.Duration) time.Duration {
	if p.RangeTimeout != 0 {
		return p.RangeTimeout
	}
	if p.ReadTimeout != 0 {
		return p.ReadTimeout
	}
	return defaultTimeout
}

func copyRegisters(values map[uint16]uint16) []Register {
	registers := make([]Register, 0, len(values))
	for addr, value := range values {
		registers = append(registers, Register{Address: addr, Value: value})
	}
	sort.Slice(registers, func(i, j int) bool {
		return registers[i].Address < registers[j].Address
	})
	return registers
}

// Range and related aliases make the interval vocabulary convenient at call
// sites without changing the wire-level type.
type (
	Range         = ReadRange
	RegisterRange = ReadRange
	ReadInterval  = ReadRange
)

// Plan aliases keep the coordinator usable from collectors that call a plan a
// poll, snapshot or round request.
type (
	Plan            = PollPlan
	SnapshotPlan    = PollPlan
	SnapshotRequest = PollPlan
	PollRequest     = PollPlan
)

// Snapshot aliases.
type (
	RegisterSnapshot = Snapshot
	SnapshotResult   = Snapshot
)
