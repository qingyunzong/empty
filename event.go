package formal

import (
	"fmt"
	"strconv"
	"strings"
)

// EventType describes the kind of watch event that produced an Event.
type EventType string

const (
	EventAdd    EventType = "add"
	EventUpdate EventType = "update"
	EventDelete EventType = "delete"
)

// Short aliases for the event kinds.
const (
	Add    = EventAdd
	Update = EventUpdate
	Delete = EventDelete
)

// ObjectKey identifies an object in a cluster. Namespace is empty for
// cluster-scoped objects.
type ObjectKey struct {
	Namespace string
	Name      string
}

func (k ObjectKey) String() string {
	if k.Namespace == "" {
		return k.Name
	}
	return k.Namespace + "/" + k.Name
}

// Key returns the identity used by the queue to coalesce events.
func Key(namespace, name string) ObjectKey {
	return ObjectKey{Namespace: namespace, Name: name}
}

// ParseKey reverses ObjectKey.String.
func ParseKey(value string) ObjectKey {
	namespace, name, ok := strings.Cut(value, "/")
	if !ok {
		return ObjectKey{Name: value}
	}
	return ObjectKey{Namespace: namespace, Name: name}
}

// Event is the unit handled by a Queue.
//
// ResourceVersion orders successive observations of one object. Watches may
// deliver observations out of order; a Queue only accepts the highest version
// it has seen for an object. Version is an alias for ResourceVersion, retained
// for callers that use shorter field names. ResourceVersion wins when both are
// set.
//
// Object is opaque to the queue. It lets a reconciler carry the decoded
// Kubernetes object through the queue without a second cache lookup.
type Event struct {
	Type            EventType
	Namespace       string
	Name            string
	UID             string
	ResourceVersion uint64
	Version         uint64
	Object          any

	// lease is written by Get. Passing the returned Event back to Done or Fail
	// lets the queue reject stale completions from an earlier delivery.
	lease uint64
}

// NewEvent constructs an event. It is a convenience for callers that do not
// want to spell out every field.
func NewEvent(eventType EventType, namespace, name string, resourceVersion uint64, object any) Event {
	return Event{
		Type:            eventType,
		Namespace:       namespace,
		Name:            name,
		ResourceVersion: resourceVersion,
		Object:          object,
	}
}

// Key returns the object identity used for coalescing.
func (e Event) Key() ObjectKey {
	return ObjectKey{Namespace: e.Namespace, Name: e.Name}
}

// IsDelete reports whether the event is a deletion tombstone.
func (e Event) IsDelete() bool {
	return e.Type == EventDelete
}

func (e Event) resourceVersion() uint64 {
	if e.ResourceVersion != 0 {
		return e.ResourceVersion
	}
	return e.Version
}

func (e Event) String() string {
	return fmt.Sprintf("%s %s@%s", e.Type, e.Key(), strconv.FormatUint(e.resourceVersion(), 10))
}

func (e Event) normalized() Event {
	if e.Type == "" {
		e.Type = EventUpdate
	}
	if e.ResourceVersion == 0 {
		e.ResourceVersion = e.Version
	}
	return e
}
