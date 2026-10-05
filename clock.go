package clocksim

// Clock is a simulated node clock that advances in virtual ticks.
// Each tick shifts the uncertainty interval forward by a fixed step.
// A clock whose step is not positive makes no progress, which lets
// waiters detect a stalled clock and report the read as pending.
type Clock struct {
	node string
	now  Interval
	step int64
}

// NewClock returns a clock for node starting at interval start and
// advancing step ticks per Tick. A non-positive step models a stalled
// clock whose interval never progresses.
func NewClock(node string, start Interval, step int64) *Clock {
	return &Clock{node: node, now: start, step: step}
}

// Node returns the clock's node name.
func (c *Clock) Node() string { return c.node }

// Now returns the current uncertainty interval without advancing time.
func (c *Clock) Now() Interval { return c.now }

// Tick advances the clock by one virtual tick and returns the new
// interval together with whether the interval made progress, i.e.
// whether Earliest strictly increased.
func (c *Clock) Tick() (Interval, bool) {
	next := c.now.Shift(c.step)
	progressed := next.Earliest > c.now.Earliest
	c.now = next
	return c.now, progressed
}
