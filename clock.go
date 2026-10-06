package circuitbreaker

import "time"

// Clock abstracts time so tests can drive state transitions deterministically.
type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }
