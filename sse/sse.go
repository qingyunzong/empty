// Package sse exposes the Server-Sent Events parser under a package name that
// matches the protocol.
//
// It is a thin alias of the root dataeng package; both packages expose the
// same types and behavior.
package sse

import (
	"io"
	"time"

	"example.org/dataeng/q0079"
)

// Event is one dispatched SSE event.
type Event = dataeng.Event

// Parser reads and parses an SSE stream incrementally.
type Parser = dataeng.Parser

// Decoder is an alias for Parser.
type Decoder = dataeng.Decoder

var (
	// ErrNoPendingEvent is returned by Commit when there is no event to confirm.
	ErrNoPendingEvent = dataeng.ErrNoPendingEvent
	// ErrOutOfOrderCommit is returned when an older event is committed.
	ErrOutOfOrderCommit = dataeng.ErrOutOfOrderCommit
)

// NewParser creates a parser. A supplied reader is consumed by Next; without a
// reader, chunks can be supplied with Feed.
func NewParser(readers ...io.Reader) *Parser {
	return dataeng.NewParser(readers...)
}

// New is shorthand for NewParser.
func New(readers ...io.Reader) *Parser {
	return dataeng.New(readers...)
}

// NewDecoder is an alias for NewParser.
func NewDecoder(readers ...io.Reader) *Parser {
	return dataeng.NewDecoder(readers...)
}

// RetryMilliseconds converts a retry duration to whole milliseconds.
func RetryMilliseconds(retry time.Duration) int {
	if retry <= 0 {
		return 0
	}
	return int(retry / time.Millisecond)
}
