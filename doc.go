// Package formal provides a concurrency-safe idempotency store.
//
// A Store executes at most one request function per key at a time. Concurrent
// callers with the same key wait for that execution and receive its published
// value and error. Published results are reused until their TTL expires, and
// Reap removes only expired entries that have no request in flight.
package formal
