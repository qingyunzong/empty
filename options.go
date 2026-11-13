package dataeng

import (
	"errors"
	"time"
)

// Options configures a Processor.
type Options struct {
	// WindowSize is the width of each tumbling window. It must be positive.
	WindowSize time.Duration

	// AllowedLateness is how long after a window's End the window remains
	// open to corrections. It must be non-negative.
	AllowedLateness time.Duration

	// Origin aligns window boundaries. The zero value means Unix epoch.
	Origin time.Time

	// Clock stamps emitted records with processing time. The zero value
	// means time.Now.
	Clock Clock
}

// Config is an alias for Options.
type Config = Options

func (o Options) normalized() (Options, error) {
	if o.WindowSize <= 0 {
		return Options{}, errors.New("dataeng: window size must be positive")
	}
	if o.AllowedLateness < 0 {
		return Options{}, errors.New("dataeng: allowed lateness must not be negative")
	}
	if o.Origin.IsZero() {
		o.Origin = time.Unix(0, 0).UTC()
	}
	if o.Clock == nil {
		o.Clock = ClockFunc(time.Now)
	}
	return o, nil
}
