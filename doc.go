// Package dataeng provides a streaming Server-Sent Events (SSE) parser for
// ingestion gateways.
//
// The parser is byte oriented, so a UTF-8 sequence split across two reads is
// preserved. Events are emitted only when a complete empty line terminates the
// current event; a connection that ends in the middle of an event emits no
// partial event.
//
// Last-Event-ID has explicit confirmation semantics. LastEventID reports only
// IDs of events passed to Commit (or Ack); parsing an id field does not move
// the resumable cursor until the caller confirms that the event was output.
package dataeng
