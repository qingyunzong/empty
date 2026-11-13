// Package dataeng implements the client-side state machine for one OPC UA
// subscription's publish sequence.
//
// It detects gaps, queues Republish requests, distinguishes transient errors
// from a server-confirmed permanent loss, ignores responses from a session
// that no longer owns the subscription after Transfer, and only acknowledges
// notifications that have been durably persisted.
package dataeng
