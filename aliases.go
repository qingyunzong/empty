package dataeng

import "context"

// Compatibility aliases for callers that use the terminology of a watch
// stream rather than a follower.

type Watcher = Follower
type Tracker = Follower
type WatchEvent = Event
type WatchEventType = EventType
type Update = Change
type Item = Entry

// New returns a Follower using compare.
func New(compare func(a, b string) int) *Follower {
	return NewFollower(compare)
}

// NewWatcher returns a Follower using compare.
func NewWatcher(compare func(a, b string) int) *Follower {
	return NewFollower(compare)
}

// NewTracker returns a Follower using compare.
func NewTracker(compare func(a, b string) int) *Follower {
	return NewFollower(compare)
}

// Follow creates a Follower and consumes events until it stops.
func Follow(ctx context.Context, compare func(a, b string) int, events <-chan Event, sinks ...func(Change) error) error {
	return NewFollower(compare).Follow(ctx, events, sinks...)
}
