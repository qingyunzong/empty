package q204

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
)

var errInjectedStore = errors.New("injected keystore failure")

type injectedKeyVersion struct {
	ref     KeyRef
	key     []byte
	revoked bool
}

type injectedStore struct {
	mu sync.Mutex

	current  KeyRef
	versions map[KeyRef]*injectedKeyVersion
	next     int

	currentCalls int
	loadCalls    int

	revokedBatches []string
	revokedRefs    []KeyRef
	revokeErr      error
}

func newInjectedStore(key []byte) *injectedStore {
	store := &injectedStore{versions: make(map[KeyRef]*injectedKeyVersion)}
	store.Rotate(key)
	return store
}

func (s *injectedStore) Rotate(key []byte) KeyRef {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	ref := KeyRef{ID: fmt.Sprintf("key-%d", s.next)}
	s.versions[ref] = &injectedKeyVersion{
		ref: ref,
		key: append([]byte(nil), key...),
	}
	s.current = ref
	return ref
}

func (s *injectedStore) Current(ctx context.Context) (KeyRef, error) {
	if err := ctx.Err(); err != nil {
		return KeyRef{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.currentCalls++
	return s.current, nil
}

func (s *injectedStore) Load(ctx context.Context, ref KeyRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.loadCalls++
	version, ok := s.versions[ref]
	if !ok {
		return nil, fmt.Errorf("unknown key reference")
	}
	if version.revoked {
		return nil, fmt.Errorf("key reference revoked")
	}
	return append([]byte(nil), version.key...), nil
}

func (s *injectedStore) RevokeBatch(ctx context.Context, batchID string, ref KeyRef) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revokedBatches = append(s.revokedBatches, batchID)
	s.revokedRefs = append(s.revokedRefs, ref)
	if version, ok := s.versions[ref]; ok {
		version.revoked = true
	}
	if s.revokeErr != nil {
		return s.revokeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

func (s *injectedStore) Counts() (currentCalls, loadCalls int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentCalls, s.loadCalls
}

func (s *injectedStore) Revocations() ([]string, []KeyRef) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.revokedBatches...), append([]KeyRef(nil), s.revokedRefs...)
}

func (s *injectedStore) SetRevokeError(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.revokeErr = err
}

func (s *injectedStore) CurrentRef() KeyRef {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

func (s *injectedStore) Key(ref KeyRef) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	version := s.versions[ref]
	if version == nil {
		return nil
	}
	return append([]byte(nil), version.key...)
}

func referenceHMAC(key []byte, value string) string {
	digest := hmac.New(sha256.New, key)
	_, _ = digest.Write([]byte(value))
	return hex.EncodeToString(digest.Sum(nil))
}
