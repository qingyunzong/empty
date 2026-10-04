// Package authlib implements a quota authorization library backed by a
// write-ahead log. One token grants k integer actions. A quota deduction
// and its business effect commit are written as a single log record, so
// they share one log transaction: a failure never deducts without the
// effect, and a duplicate request ID never deducts twice. Revocation and
// commits are serialized by a single mutex, so their observable order is
// exactly the in-lock order.
package authlib

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"sync"
)

var (
	ErrExhausted = errors.New("authlib: token quota exhausted")
	ErrRevoked   = errors.New("authlib: token revoked")
	ErrUnknown   = errors.New("authlib: unknown token")
	ErrExists    = errors.New("authlib: token already granted")
	ErrCrashed   = errors.New("authlib: simulated crash, store is unusable")
)

// Record types in the write-ahead log.
const (
	recGrant  byte = 1
	recCommit byte = 2
	recRevoke byte = 3
)

// Crash fault-injection stages, set via SetFailpoint.
const (
	FailBeforeWrite = "beforeWrite" // crash before the record hits the file
	FailDuringWrite = "duringWrite" // crash after a torn partial write
	FailAfterWrite  = "afterWrite"  // crash after write, before fsync
	FailAfterSync   = "afterSync"   // crash after fsync, before in-memory apply
)

const maxPayload = 1 << 20

type tokenState struct {
	remaining int
	effects   int
	revoked   bool
	seen      map[string]struct{}
}

// Store is a WAL-backed quota store. All public methods are safe for
// concurrent use; the mutex defines the total order of commits/revokes.
type Store struct {
	mu      sync.Mutex
	file    *os.File
	tokens  map[string]*tokenState
	crashed bool

	failStage string
	failLeft  int
}

// Open opens (or creates) the log at path and replays it. A torn or
// corrupt tail left by a crash is truncated, so recovered state always
// reflects whole records only.
func Open(path string) (*Store, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	s := &Store{file: f, tokens: make(map[string]*tokenState)}
	if err := s.replay(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

// SetFailpoint arms a one-shot (or count-shot) simulated crash at the
// given stage. For testing only.
func (s *Store) SetFailpoint(stage string, times int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failStage = stage
	s.failLeft = times
}

// Close closes the underlying log file.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.file.Close()
}

// Grant issues a token allowing k actions. It is itself a logged record
// so grants survive recovery.
func (s *Store) Grant(token string, k int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkUsable(); err != nil {
		return err
	}
	if _, ok := s.tokens[token]; ok {
		return ErrExists
	}
	payload := putString(nil, token)
	var kb [8]byte
	binary.BigEndian.PutUint64(kb[:], uint64(k))
	payload = append(payload, kb[:]...)
	if err := s.appendLocked(recGrant, payload); err != nil {
		return err
	}
	s.tokens[token] = &tokenState{remaining: k, seen: make(map[string]struct{})}
	return nil
}

// Commit performs one authorized action for token, identified by reqID.
// The quota deduction and the business effect commit are appended as one
// log record inside the same critical section, so they are atomic with
// respect to crashes. It reports applied=true only when this call
// performed a new deduction; a duplicate reqID is an idempotent no-op
// returning (false, nil).
func (s *Store) Commit(token, reqID string) (applied bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkUsable(); err != nil {
		return false, err
	}
	st, ok := s.tokens[token]
	if !ok {
		return false, ErrUnknown
	}
	if _, dup := st.seen[reqID]; dup {
		return false, nil // already committed: no second deduction
	}
	if st.revoked {
		return false, ErrRevoked
	}
	if st.remaining <= 0 {
		return false, ErrExhausted
	}
	payload := putString(nil, token)
	payload = putString(payload, reqID)
	if err := s.appendLocked(recCommit, payload); err != nil {
		return false, err
	}
	st.remaining--
	st.effects++
	st.seen[reqID] = struct{}{}
	return true, nil
}

// Revoke revokes the token. It takes the same mutex as Commit, so a
// revoke and a concurrent commit are ordered by lock acquisition: the
// commit either lands entirely before the revoke or is rejected after it.
func (s *Store) Revoke(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkUsable(); err != nil {
		return err
	}
	st, ok := s.tokens[token]
	if !ok {
		return ErrUnknown
	}
	if st.revoked {
		return nil
	}
	if err := s.appendLocked(recRevoke, putString(nil, token)); err != nil {
		return err
	}
	st.revoked = true
	return nil
}

// Remaining reports the token's remaining quota.
func (s *Store) Remaining(token string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.tokens[token]
	if !ok {
		return 0, ErrUnknown
	}
	return st.remaining, nil
}

// Effects reports how many business effects have been committed for the
// token. Invariant: Effects + Remaining == granted k.
func (s *Store) Effects(token string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.tokens[token]
	if !ok {
		return 0, ErrUnknown
	}
	return st.effects, nil
}

// Revoked reports whether the token is revoked.
func (s *Store) Revoked(token string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.tokens[token]
	if !ok {
		return false, ErrUnknown
	}
	return st.revoked, nil
}

func (s *Store) checkUsable() error {
	if s.crashed {
		return ErrCrashed
	}
	return nil
}

// appendLocked encodes and appends one record, honouring fault injection.
// A record is the unit of atomicity: deduction and effect commit travel
// in the same record, hence the same log transaction.
func (s *Store) appendLocked(typ byte, payload []byte) error {
	rec := encodeRecord(typ, payload)
	if s.fail(FailBeforeWrite) {
		return s.crash()
	}
	if s.fail(FailDuringWrite) {
		s.file.Write(rec[:len(rec)/2]) // torn partial write, no sync
		return s.crash()
	}
	if _, err := s.file.Write(rec); err != nil {
		return err
	}
	if s.fail(FailAfterWrite) {
		return s.crash()
	}
	if err := s.file.Sync(); err != nil {
		return err
	}
	if s.fail(FailAfterSync) {
		return s.crash()
	}
	return nil
}

func (s *Store) fail(stage string) bool {
	if s.failStage == stage && s.failLeft > 0 {
		s.failLeft--
		return true
	}
	return false
}

func (s *Store) crash() error {
	s.crashed = true
	return ErrCrashed
}

// replay scans the log, applies whole records, and truncates any torn or
// corrupt tail so future appends start at the last good offset.
func (s *Store) replay() error {
	if _, err := s.file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var good int64
	for {
		header := make([]byte, 5)
		if _, err := io.ReadFull(s.file, header); err != nil {
			break // clean EOF or torn header
		}
		n := binary.BigEndian.Uint32(header[1:])
		if n > maxPayload {
			break // corrupt length
		}
		rest := make([]byte, n+4)
		if _, err := io.ReadFull(s.file, rest); err != nil {
			break // torn payload/checksum
		}
		if crc32.ChecksumIEEE(append(header, rest[:n]...)) != binary.BigEndian.Uint32(rest[n:]) {
			break // corrupt record
		}
		if err := s.applyRecord(header[0], rest[:n]); err != nil {
			return err
		}
		good += int64(5 + n + 4)
	}
	if err := s.file.Truncate(good); err != nil {
		return err
	}
	_, err := s.file.Seek(good, io.SeekStart)
	return err
}

func (s *Store) applyRecord(typ byte, p []byte) error {
	switch typ {
	case recGrant:
		token, rest := getString(p)
		k := binary.BigEndian.Uint64(rest)
		s.tokens[token] = &tokenState{remaining: int(k), seen: make(map[string]struct{})}
	case recCommit:
		token, rest := getString(p)
		reqID, _ := getString(rest)
		st := s.tokens[token]
		if _, dup := st.seen[reqID]; !dup {
			st.remaining--
			st.effects++
			st.seen[reqID] = struct{}{}
		}
	case recRevoke:
		token, _ := getString(p)
		s.tokens[token].revoked = true
	}
	return nil
}

func encodeRecord(typ byte, payload []byte) []byte {
	buf := make([]byte, 0, 5+len(payload)+4)
	buf = append(buf, typ)
	var lb [4]byte
	binary.BigEndian.PutUint32(lb[:], uint32(len(payload)))
	buf = append(buf, lb[:]...)
	buf = append(buf, payload...)
	var cb [4]byte
	binary.BigEndian.PutUint32(cb[:], crc32.ChecksumIEEE(buf))
	return append(buf, cb[:]...)
}

func putString(dst []byte, v string) []byte {
	var lb [2]byte
	binary.BigEndian.PutUint16(lb[:], uint16(len(v)))
	dst = append(dst, lb[:]...)
	return append(dst, v...)
}

func getString(p []byte) (string, []byte) {
	n := binary.BigEndian.Uint16(p)
	return string(p[2 : 2+n]), p[2+n:]
}
