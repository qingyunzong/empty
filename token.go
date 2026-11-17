package formal

import "sync"

// Fencer is a small helper for the resource side of fencing.
//
// Before applying a mutation guarded by a lock, the resource calls Allow with
// the handle's token. Allow accepts only tokens strictly greater than every
// token accepted before. Because the coordination service never reuses tokens,
// a holder whose lease was lost can never become valid again.
//
// A Fencer is safe for concurrent use. The zero value rejects token zero.
// Use one Fencer per protected resource and persist Last across process
// restarts; otherwise a restarted resource forgets which tokens it has seen.
type Fencer struct {
	mu   sync.Mutex
	last Token
}

// Allow reports whether token is newer than the last accepted token. An
// accepted token is remembered atomically with the decision.
func (f *Fencer) Allow(token Token) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if token == 0 || token <= f.last {
		return false
	}
	f.last = token
	return true
}

// Last returns the greatest token accepted so far.
func (f *Fencer) Last() Token {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.last
}
