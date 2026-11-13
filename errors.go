package dataeng

import "errors"

var (
	// ErrMalformedPacket is returned when a packet cannot be parsed.
	ErrMalformedPacket = errors.New("dataeng: malformed packet")
	// ErrUnsupportedVersion is returned for a packet that is neither NetFlow
	// v9 nor IPFIX.
	ErrUnsupportedVersion = errors.New("dataeng: unsupported flow protocol version")
	// ErrNoTemplate is returned by explicit decode operations when no active
	// template exists. Packet processing never guesses a template.
	ErrNoTemplate = errors.New("dataeng: no active template")
	// ErrInvalidTemplate is returned when a template cannot be registered.
	ErrInvalidTemplate = errors.New("dataeng: invalid template")
	// ErrPendingFull can be wrapped in diagnostics when a bounded pending
	// queue rejects a data set. Receive reports the event through Stats and
	// normally continues processing the packet.
	ErrPendingFull = errors.New("dataeng: pending queue full")
)
