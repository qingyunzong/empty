package dataeng

import (
	"errors"
	"fmt"
)

var (
	// ErrInvalidEvent is returned for an unknown event type or an ERROR event
	// without an error.
	ErrInvalidEvent = errors.New("dataeng: invalid watch event")

	// ErrInvalidComparator is returned when the caller did not supply a
	// resource version comparator.
	ErrInvalidComparator = errors.New("dataeng: nil resource version comparator")

	// ErrExpired means that the watch resource version is no longer usable.
	// The caller must relist. The existing cache is deliberately preserved.
	ErrExpired = errors.New("dataeng: watch resource version expired; relist required")

	// ErrRelistRequired is an alias for ErrExpired.
	ErrRelistRequired = ErrExpired

	// ErrResourceVersionExpired is an alias for ErrExpired.
	ErrResourceVersionExpired = ErrExpired

	// ErrUnknownKey is reported when a DELETED event names a key that is not
	// present in the cache.
	ErrUnknownKey = errors.New("dataeng: delete of unknown key")

	// ErrStaleResourceVersion is reported when a full relist would move the
	// follower's resource version backwards.
	ErrStaleResourceVersion = errors.New("dataeng: resource version would move backwards")
)

// UnknownKeyError identifies the key whose deletion was unknown.
type UnknownKeyError struct {
	Key             string
	ResourceVersion string
}

func (e *UnknownKeyError) Error() string {
	if e.ResourceVersion == "" {
		return fmt.Sprintf("%s: %q", ErrUnknownKey, e.Key)
	}
	return fmt.Sprintf("%s: %q at resource version %q", ErrUnknownKey, e.Key, e.ResourceVersion)
}

// Is matches both ErrUnknownKey and any other *UnknownKeyError target.
func (e *UnknownKeyError) Is(target error) bool {
	_, ok := target.(*UnknownKeyError)
	return target == ErrUnknownKey || ok
}

// IsExpired reports whether err indicates that a relist is required.
func IsExpired(err error) bool {
	return errors.Is(err, ErrExpired)
}

// IsRelistRequired reports whether err indicates that a relist is required.
func IsRelistRequired(err error) bool {
	return IsExpired(err)
}

// IsUnknownKey reports whether err is an unknown-key deletion report.
func IsUnknownKey(err error) bool {
	return errors.Is(err, ErrUnknownKey)
}
