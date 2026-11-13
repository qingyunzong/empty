package dataeng

import (
	"context"
	"sort"
	"sync"
)

// Follower applies watch events to an in-memory object cache. It never
// creates a watch; events and relists are supplied by the caller.
//
// Compare must be set before the Follower is used. A Follower is safe for
// concurrent calls to its cache and version accessors, but the caller must not
// modify Compare concurrently with an event.
type Follower struct {
	Compare CompareFunc

	mu             sync.Mutex
	objects        map[string]any
	lastVersion    string
	hasLastVersion bool
}

// NewFollower returns a Follower whose resource version ordering is defined
// by compare. Compare must return a negative number when its first argument is
// older, zero when the versions are equal, and a positive number when the
// first argument is newer.
func NewFollower(compare func(a, b string) int) *Follower {
	f := &Follower{objects: make(map[string]any)}
	if compare != nil {
		f.Compare = CompareFunc(compare)
	}
	return f
}

// Apply processes one watch event and returns the changes it produced.
//
// A stale event (one whose resource version is older than the last accepted
// version) is ignored and produces neither a change nor an error. An equal
// bookmark is ignored. An equal object event is still delivered.
//
// ErrExpired is returned for an expired ERROR event. It is a request to
// relist, not a cache invalidation: the existing cache and version are left
// untouched. Any other ERROR is returned unchanged, which stops the follower.
//
// Deleting an unknown key returns an *UnknownKeyError and does not change the
// cache or the resource version.
func (f *Follower) Apply(event Event) ([]Change, error) {
	if err := event.validate(); err != nil {
		return nil, err
	}
	if f == nil {
		return nil, ErrInvalidComparator
	}
	if f.Compare == nil {
		return nil, ErrInvalidComparator
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	if f.objects == nil {
		f.objects = make(map[string]any)
	}

	if event.Type == EventError {
		if event.isExpired() {
			return nil, ErrExpired
		}
		return nil, event.error()
	}

	status := f.versionStatus(event.ResourceVersion)
	if status == versionStale {
		return nil, nil
	}

	if event.Type == EventBookmark {
		if status != versionEqual {
			f.setVersion(event.ResourceVersion)
		}
		return nil, nil
	}

	change, err := f.applyObject(event)
	if err != nil {
		return nil, err
	}
	f.setVersion(event.ResourceVersion)
	return []Change{change}, nil
}

// Handle is an alias for Apply.
func (f *Follower) Handle(event Event) ([]Change, error) {
	return f.Apply(event)
}

// Process is an alias for Apply.
func (f *Follower) Process(event Event) ([]Change, error) {
	return f.Apply(event)
}

// Follow consumes events until the channel is closed, the context is cancelled,
// or an event returns an error. An expiration error returns ErrExpired with the
// cache intact; all other errors stop immediately. The optional sink receives
// each produced Change in order.
func (f *Follower) Follow(ctx context.Context, events <-chan Event, sinks ...func(Change) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	var sink func(Change) error
	if len(sinks) > 0 {
		sink = sinks[0]
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event, ok := <-events:
			if !ok {
				return nil
			}
			changes, err := f.Apply(event)
			if err != nil {
				return err
			}
			if sink == nil {
				continue
			}
			for _, change := range changes {
				if err := sink(change); err != nil {
					return err
				}
			}
		}
	}
}

// Run is an alias for Follow.
func (f *Follower) Run(ctx context.Context, events <-chan Event, sinks ...func(Change) error) error {
	return f.Follow(ctx, events, sinks...)
}

// ResourceVersion returns the last accepted resource version. The empty string
// is returned before any version has been accepted.
func (f *Follower) ResourceVersion() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastVersion
}

// Len returns the number of objects in the cache.
func (f *Follower) Len() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.objects)
}

// Lookup returns the cached object for key.
func (f *Follower) Lookup(key string) (any, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	object, ok := f.objects[key]
	return object, ok
}

// Has reports whether key is present in the cache.
func (f *Follower) Has(key string) bool {
	_, ok := f.Lookup(key)
	return ok
}

// Snapshot returns a shallow copy of the cache. Objects themselves are not
// copied.
func (f *Follower) Snapshot() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	snapshot := make(map[string]any, len(f.objects))
	for key, object := range f.objects {
		snapshot[key] = object
	}
	return snapshot
}

// Entry is one object in a full relist.
type Entry struct {
	Key    string
	Object any
}

// Relist replaces the cache with a complete list of objects, normally after
// ErrExpired has been returned. It does not clear the cache before the relist
// data has been accepted: a relist whose resource version would move backwards
// is rejected and leaves the existing cache and version intact.
//
// The returned changes are ordered by key. Keys that disappeared are reported
// as DELETED, new keys as ADDED, and keys present in both as MODIFIED. The
// relist resource version is applied to every change.
func (f *Follower) Relist(entries []Entry, resourceVersion string) ([]Change, error) {
	if f == nil || f.Compare == nil {
		return nil, ErrInvalidComparator
	}

	f.mu.Lock()
	defer f.mu.Unlock()

	status := f.versionStatus(resourceVersion)
	if status == versionStale {
		return nil, ErrStaleResourceVersion
	}

	next := make(map[string]any, len(entries))
	for _, entry := range entries {
		if _, exists := next[entry.Key]; exists {
			return nil, &DuplicateKeyError{Key: entry.Key}
		}
		next[entry.Key] = entry.Object
	}

	changes := make([]Change, 0, len(next)+len(f.objects))
	for key, oldObject := range f.objects {
		if _, ok := next[key]; !ok {
			changes = append(changes, Change{
				Type:            EventDeleted,
				Key:             key,
				Object:          oldObject,
				Previous:        oldObject,
				ResourceVersion: resourceVersion,
			})
		}
	}
	for key, object := range next {
		if oldObject, ok := f.objects[key]; ok {
			changes = append(changes, Change{
				Type:            EventModified,
				Key:             key,
				Object:          object,
				Previous:        oldObject,
				ResourceVersion: resourceVersion,
			})
		} else {
			changes = append(changes, Change{
				Type:            EventAdded,
				Key:             key,
				Object:          object,
				ResourceVersion: resourceVersion,
			})
		}
	}
	sort.Slice(changes, func(i, j int) bool {
		return changes[i].Key < changes[j].Key
	})

	f.objects = next
	f.setVersion(resourceVersion)
	return changes, nil
}

// Replace is an alias for Relist.
func (f *Follower) Replace(entries []Entry, resourceVersion string) ([]Change, error) {
	return f.Relist(entries, resourceVersion)
}

// DuplicateKeyError reports a duplicate key in a relist.
type DuplicateKeyError struct {
	Key string
}

func (e *DuplicateKeyError) Error() string {
	return "dataeng: duplicate key in relist: " + e.Key
}

type versionStatus int

const (
	versionStale versionStatus = iota - 1
	versionEqual
	versionNewer
	versionInitial
)

func (f *Follower) versionStatus(resourceVersion string) versionStatus {
	if !f.hasLastVersion {
		return versionInitial
	}
	switch result := f.Compare(resourceVersion, f.lastVersion); {
	case result < 0:
		return versionStale
	case result > 0:
		return versionNewer
	default:
		return versionEqual
	}
}

func (f *Follower) setVersion(resourceVersion string) {
	f.lastVersion = resourceVersion
	f.hasLastVersion = true
}

func (f *Follower) applyObject(event Event) (Change, error) {
	previous, exists := f.objects[event.Key]
	change := Change{
		Type:            event.Type,
		Key:             event.Key,
		Object:          event.Object,
		ResourceVersion: event.ResourceVersion,
	}

	switch event.Type {
	case EventAdded, EventModified:
		if exists {
			change.Previous = previous
		}
		f.objects[event.Key] = event.Object
	case EventDeleted:
		if !exists {
			return Change{}, &UnknownKeyError{
				Key:             event.Key,
				ResourceVersion: event.ResourceVersion,
			}
		}
		if change.Object == nil {
			change.Object = previous
		}
		change.Previous = previous
		delete(f.objects, event.Key)
	}
	return change, nil
}
