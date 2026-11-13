package dataeng

import (
	"errors"
	"fmt"
)

// EventType is the type of a watch event. Its values match the event type
// strings used by Kubernetes watch responses.
type EventType string

const (
	EventAdded    EventType = "ADDED"
	EventModified EventType = "MODIFIED"
	EventDeleted  EventType = "DELETED"
	EventBookmark EventType = "BOOKMARK"
	EventError    EventType = "ERROR"

	// Short aliases for the event types.
	Added    = EventAdded
	Modified = EventModified
	Deleted  = EventDeleted
	Bookmark = EventBookmark
	Error    = EventError

	// Upper-case aliases make the wire values usable as Go identifiers too.
	ADDED    = EventAdded
	MODIFIED = EventModified
	DELETED  = EventDeleted
	BOOKMARK = EventBookmark
	ERROR    = EventError
)

// Valid reports whether t is one of the five watch event types.
func (t EventType) Valid() bool {
	switch t {
	case EventAdded, EventModified, EventDeleted, EventBookmark, EventError:
		return true
	default:
		return false
	}
}

// String returns the wire representation of the event type.
func (t EventType) String() string {
	return string(t)
}

// Event is one item from a watch event stream.
//
// Key identifies the cached object. Object carries the object for ADDED and
// MODIFIED events and may carry the deleted object for DELETED events. For
// DELETED events with a nil Object, the object currently in the cache is used.
// ResourceVersion is the opaque version assigned by the server.
//
// Err is the error carried by an ERROR event. Expired may be set by callers
// that cannot attach a sentinel error; it has the same effect as an Err that
// wraps ErrExpired.
type Event struct {
	Type            EventType
	Key             string
	Object          any
	ResourceVersion string
	Err             error
	Expired         bool
}

// Change is produced for every accepted ADDED, MODIFIED or DELETED event.
// BOOKMARK and ERROR events never produce a Change.
type Change struct {
	Type            EventType
	Key             string
	Object          any
	Previous        any
	ResourceVersion string
}

// CompareFunc is the caller-supplied resource version comparator. It must
// return a negative number when a is older than b, zero when they are equal,
// and a positive number when a is newer than b.
type CompareFunc func(a, b string) int

// AddEvent returns an ADDED event.
func AddEvent(key string, object any, resourceVersion string) Event {
	return Event{Type: EventAdded, Key: key, Object: object, ResourceVersion: resourceVersion}
}

// ModifyEvent returns a MODIFIED event.
func ModifyEvent(key string, object any, resourceVersion string) Event {
	return Event{Type: EventModified, Key: key, Object: object, ResourceVersion: resourceVersion}
}

// DeleteEvent returns a DELETED event.
func DeleteEvent(key string, object any, resourceVersion string) Event {
	return Event{Type: EventDeleted, Key: key, Object: object, ResourceVersion: resourceVersion}
}

// BookmarkEvent returns a BOOKMARK event.
func BookmarkEvent(resourceVersion string) Event {
	return Event{Type: EventBookmark, ResourceVersion: resourceVersion}
}

// ErrorEvent returns an ERROR event carrying err.
func ErrorEvent(err error) Event {
	return Event{Type: EventError, Err: err}
}

// ExpiredEvent returns an ERROR event that requires a relist.
func ExpiredEvent() Event {
	return Event{Type: EventError, Err: ErrExpired, Expired: true}
}

func (e Event) validate() error {
	if !e.Type.Valid() {
		return fmt.Errorf("%w: unknown event type %q", ErrInvalidEvent, e.Type)
	}
	if e.Type == EventError && e.Err == nil && !e.Expired {
		if err, ok := e.Object.(error); ok {
			e.Err = err
			return nil
		}
		return fmt.Errorf("%w: ERROR event has no error", ErrInvalidEvent)
	}
	return nil
}

func (e Event) error() error {
	if e.Err != nil {
		return e.Err
	}
	if err, ok := e.Object.(error); ok {
		return err
	}
	return nil
}

func (e Event) isExpired() bool {
	if e.Expired {
		return true
	}
	err := e.error()
	return err != nil && errors.Is(err, ErrExpired)
}
