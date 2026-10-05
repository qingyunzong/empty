package tokenbucket

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// Record kinds stored in the log.
const (
	kindDecision = "decision"
	kindSnapshot = "snapshot"
)

// decision is one durable log record. Decision records carry the full
// post-decision bucket state, so replaying records in order rebuilds
// the exact state without ever re-charging a request. A snapshot
// record (written by truncation) captures the bucket state by itself
// and carries no request ID.
type decision struct {
	Kind      string `json:"kind"`
	RequestID string `json:"request_id"`
	Allowed   bool   `json:"allowed"`
	Cost      int64  `json:"cost"`
	Time      int64  `json:"time"`      // effective (monotonic-clamped) logical time
	Tokens    int64  `json:"tokens"`    // bucket tokens after the decision
	Remainder int64  `json:"remainder"` // bucket remainder after the decision
}

// Store persists a Bucket as an append-only JSON-lines log. Every
// Allow call with a fresh request ID appends one record (fsync'd before
// returning). Repeating a request ID returns the recorded decision
// without consuming tokens, including after a restart.
//
// Truncate rewrites the log keeping only the most recent records; those
// retained request IDs form the idempotency window. Duplicates older
// than the window are treated as new requests.
type Store struct {
	mu        sync.Mutex
	bucket    *Bucket
	file      *os.File
	enc       *json.Encoder
	path      string
	decisions map[string]decision // idempotency window
	log       []decision          // in-memory mirror of the log file

	maxRecords int // auto-truncate threshold; 0 disables
	window     int // records kept by auto-truncation
}

// Option configures a Store.
type Option func(*Store)

// WithAutoTruncate makes the store compact its log once it exceeds
// maxRecords records, keeping the most recent window records as the
// idempotency window. window must be >= 1 and <= maxRecords.
func WithAutoTruncate(maxRecords, window int) Option {
	return func(s *Store) {
		s.maxRecords = maxRecords
		s.window = window
	}
}

// Open opens or creates the log at path and replays it to rebuild state.
// An empty or missing log starts a full bucket at logical time 0.
func Open(path string, cfg Config, opts ...Option) (*Store, error) {
	b, err := NewBucket(cfg)
	if err != nil {
		return nil, err
	}
	s := &Store{
		bucket:    b,
		path:      path,
		decisions: make(map[string]decision),
	}
	for _, o := range opts {
		o(s)
	}
	if s.maxRecords < 0 || s.window < 0 || s.window > s.maxRecords {
		return nil, errors.New("tokenbucket: invalid truncation parameters")
	}
	if err := s.replay(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	s.file = f
	s.enc = json.NewEncoder(f)
	return s, nil
}

func (s *Store) replay() error {
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	dec := json.NewDecoder(bufio.NewReader(f))
	for {
		var d decision
		err := dec.Decode(&d)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("tokenbucket: replay %s: %w", s.path, err)
		}
		if err := s.bucket.restore(d.Tokens, d.Remainder, d.Time); err != nil {
			return err
		}
		if d.Kind == kindSnapshot {
			continue
		}
		s.decisions[d.RequestID] = d
		s.log = append(s.log, d)
	}
}

// Allow consumes cost tokens for requestID at logical time now. A
// repeated requestID returns the original recorded decision and never
// charges again. The decision is durable before Allow returns.
func (s *Store) Allow(now int64, requestID string, cost int64) (bool, error) {
	if requestID == "" {
		return false, errors.New("tokenbucket: request ID must not be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.decisions[requestID]; ok {
		return d.Allowed, nil
	}
	allowed, err := s.bucket.Allow(now, cost)
	if err != nil {
		return false, err
	}
	tokens, rem, last := s.bucket.State()
	d := decision{
		Kind:      kindDecision,
		RequestID: requestID,
		Allowed:   allowed,
		Cost:      cost,
		Time:      last,
		Tokens:    tokens,
		Remainder: rem,
	}
	if err := s.enc.Encode(&d); err != nil {
		return false, err
	}
	if err := s.file.Sync(); err != nil {
		return false, err
	}
	s.decisions[requestID] = d
	s.log = append(s.log, d)
	if s.maxRecords > 0 && len(s.log) > s.maxRecords {
		if err := s.truncateLocked(s.window); err != nil {
			return false, err
		}
	}
	return allowed, nil
}

// State returns the current bucket state.
func (s *Store) State() (tokens, remainder, lastTime int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bucket.State()
}

// LogLen returns the number of decision records currently in the log.
func (s *Store) LogLen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.log)
}

// Truncate compacts the log, keeping only the most recent keep records.
// Those records' request IDs remain idempotent; older IDs are forgotten
// and will be treated as new requests. The kept records carry the full
// bucket state, so replay after truncation yields identical state.
func (s *Store) Truncate(keep int) error {
	if keep < 0 {
		return errors.New("tokenbucket: keep must be >= 0")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.truncateLocked(keep)
}

func (s *Store) truncateLocked(keep int) error {
	if keep > len(s.log) {
		keep = len(s.log)
	}
	kept := append([]decision(nil), s.log[len(s.log)-keep:]...)

	tmp := s.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	// A snapshot preserves the exact bucket state even when the kept
	// window is empty, so a later restart cannot rewind the clock or
	// refill the bucket.
	tokens, rem, last := s.bucket.State()
	snap := decision{Kind: kindSnapshot, Time: last, Tokens: tokens, Remainder: rem}
	if err := enc.Encode(&snap); err != nil {
		f.Close()
		return err
	}
	for i := range kept {
		if err := enc.Encode(&kept[i]); err != nil {
			f.Close()
			return err
		}
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := s.file.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	// Best-effort directory sync so the rename itself is durable.
	if dir, err := os.Open(filepath.Dir(s.path)); err == nil {
		dir.Sync()
		dir.Close()
	}
	nf, err := os.OpenFile(s.path, os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	s.file = nf
	s.enc = json.NewEncoder(nf)
	s.log = kept
	s.decisions = make(map[string]decision, len(kept))
	for _, d := range kept {
		s.decisions[d.RequestID] = d
	}
	return nil
}

// Close flushes and closes the log file.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}
