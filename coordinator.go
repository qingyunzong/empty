package dataeng

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"time"
)

const (
	minPartNumber = 1
	maxPartNumber = 10000
)

// Coordinator drives multipart upload sessions against a Backend while
// keeping a durable manifest in a SessionStore. It guarantees:
//
//   - re-uploading a part number with different content fails with
//     ErrPartConflict instead of silently replacing data;
//   - complete and abort racing on the same session produce exactly one
//     terminal state;
//   - recovery reconciles the local manifest with the remote part list of
//     the session's own upload ID, so parts from other uploads are never
//     spliced into the completed object.
type Coordinator struct {
	backend Backend
	store   SessionStore
}

// NewCoordinator returns a Coordinator using the given backend and store.
func NewCoordinator(b Backend, s SessionStore) *Coordinator {
	return &Coordinator{backend: b, store: s}
}

// Begin starts a new collection session for key: it initiates the remote
// upload and records the session manifest bound to the returned upload ID.
func (c *Coordinator) Begin(ctx context.Context, key string) (*Session, error) {
	uploadID, err := c.backend.InitiateUpload(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("dataeng: initiate upload: %w", err)
	}
	now := time.Now().UTC()
	s := &Session{
		ID:        newSessionID(),
		ObjectKey: key,
		UploadID:  uploadID,
		State:     StateActive,
		Parts:     make(map[int]*Part),
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := c.store.Create(ctx, s); err != nil {
		return nil, err
	}
	return s.Clone(), nil
}

// Get returns the current manifest for a session.
func (c *Coordinator) Get(ctx context.Context, sessionID string) (*Session, error) {
	return c.store.Get(ctx, sessionID)
}

// UploadPart uploads one part. If the part number was already recorded with
// identical content, the recorded part is returned without re-uploading
// (idempotent retry). If it was recorded with different content,
// ErrPartConflict is returned.
func (c *Coordinator) UploadPart(ctx context.Context, sessionID string, number int, r io.Reader) (*Part, error) {
	if number < minPartNumber || number > maxPartNumber {
		return nil, ErrInvalidPartNumber
	}
	body, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("dataeng: read part body: %w", err)
	}
	sum := sha256.Sum256(body)
	checksum := hex.EncodeToString(sum[:])

	s, err := c.store.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if s.State != StateActive {
		return nil, fmt.Errorf("%w: state is %s", ErrSessionNotActive, s.State)
	}
	if existing, ok := s.Parts[number]; ok {
		if existing.ChecksumSHA256 != checksum {
			return nil, fmt.Errorf("%w: part %d already uploaded with different content", ErrPartConflict, number)
		}
		return existing, nil
	}

	etag, err := c.backend.UploadPart(ctx, s.ObjectKey, s.UploadID, number, body)
	if err != nil {
		return nil, fmt.Errorf("dataeng: upload part %d: %w", number, err)
	}

	part := &Part{
		Number:         number,
		ETag:           etag,
		Size:           int64(len(body)),
		ChecksumSHA256: checksum,
		UploadedAt:     time.Now().UTC(),
	}
	var recorded *Part
	err = c.store.Update(ctx, sessionID, func(cur *Session) error {
		if cur.State != StateActive {
			return fmt.Errorf("%w: state is %s", ErrSessionNotActive, cur.State)
		}
		if existing, ok := cur.Parts[number]; ok {
			if existing.ChecksumSHA256 != checksum {
				return fmt.Errorf("%w: part %d already uploaded with different content", ErrPartConflict, number)
			}
			recorded = existing
			return nil
		}
		cur.Parts[number] = part
		recorded = part
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := *recorded
	return &out, nil
}

// Complete finalizes the upload: it verifies the recorded parts against the
// remote part list of the session's own upload ID, then asks the backend to
// assemble exactly those parts into a new object generation. Completing an
// already completed session returns the recorded result; completing after an
// abort fails with ErrSessionTerminal.
func (c *Coordinator) Complete(ctx context.Context, sessionID string) (*CompleteResult, error) {
	s, err := c.store.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	switch s.State {
	case StateCompleted:
		r := *s.Result
		return &r, nil
	case StateActive:
		// proceed below
	case StateCompleting, StateAborting:
		return nil, ErrOperationInFlight
	default:
		return nil, fmt.Errorf("%w: state is %s", ErrSessionTerminal, s.State)
	}
	if len(s.Parts) == 0 {
		return nil, ErrNoParts
	}
	if err := c.transition(ctx, sessionID, StateActive, StateCompleting, nil); err != nil {
		return nil, err
	}

	result, err := c.completeRemote(ctx, s)
	if err != nil {
		if err == ErrUploadNotFound {
			// The remote upload is gone (aborted or expired out of band):
			// the only consistent terminal state left is aborted.
			_ = c.transition(ctx, sessionID, StateCompleting, StateAborted, func(cur *Session) {
				cur.AbortReason = "remote upload disappeared before complete"
			})
			return nil, err
		}
		// Transient failure: roll back to active so the caller can retry.
		_ = c.transition(ctx, sessionID, StateCompleting, StateActive, nil)
		return nil, err
	}

	final := &CompleteResult{
		Generation:  result.Generation,
		ETag:        result.ETag,
		Size:        result.Size,
		CompletedAt: time.Now().UTC(),
	}
	if err := c.transition(ctx, sessionID, StateCompleting, StateCompleted, func(cur *Session) {
		cur.Result = final
	}); err != nil {
		return nil, err
	}
	out := *final
	return &out, nil
}

// completeRemote verifies the manifest against the remote part list and
// completes the upload with exactly the recorded parts.
func (c *Coordinator) completeRemote(ctx context.Context, s *Session) (ObjectInfo, error) {
	remote, err := c.backend.ListParts(ctx, s.ObjectKey, s.UploadID)
	if err != nil {
		return ObjectInfo{}, err
	}
	byNumber := make(map[int]string, len(remote))
	for _, rp := range remote {
		byNumber[rp.Number] = rp.ETag
	}
	refs := make([]PartRef, 0, len(s.Parts))
	for _, p := range s.sortedParts() {
		etag, ok := byNumber[p.Number]
		if !ok {
			return ObjectInfo{}, fmt.Errorf("%w: part %d missing remotely", ErrPartConflict, p.Number)
		}
		if etag != p.ETag {
			return ObjectInfo{}, fmt.Errorf("%w: part %d remote ETag changed", ErrPartConflict, p.Number)
		}
		refs = append(refs, PartRef{Number: p.Number, ETag: p.ETag})
	}
	return c.backend.CompleteUpload(ctx, s.ObjectKey, s.UploadID, refs)
}

// Abort discards the upload. Aborting an already aborted session is a
// no-op; aborting after a successful complete fails with ErrSessionTerminal.
func (c *Coordinator) Abort(ctx context.Context, sessionID string) error {
	s, err := c.store.Get(ctx, sessionID)
	if err != nil {
		return err
	}
	switch s.State {
	case StateAborted:
		return nil
	case StateActive:
		// proceed below
	case StateCompleting, StateAborting:
		return ErrOperationInFlight
	default:
		return fmt.Errorf("%w: state is %s", ErrSessionTerminal, s.State)
	}
	if err := c.transition(ctx, sessionID, StateActive, StateAborting, nil); err != nil {
		return err
	}
	if err := c.backend.AbortUpload(ctx, s.ObjectKey, s.UploadID); err != nil && err != ErrUploadNotFound {
		_ = c.transition(ctx, sessionID, StateAborting, StateActive, nil)
		return fmt.Errorf("dataeng: abort upload: %w", err)
	}
	return c.transition(ctx, sessionID, StateAborting, StateAborted, nil)
}

// Resume reconciles a session with the remote state after a restart. It
// lists parts for the session's own upload ID only, drops recorded parts
// that are missing remotely (so they can be re-uploaded), and fails on any
// disagreement: a remote ETag that differs from the manifest
// (ErrPartConflict) or a remote part that was never recorded
// (ErrOrphanPart). Terminal sessions are returned unchanged.
func (c *Coordinator) Resume(ctx context.Context, sessionID string) (*Session, error) {
	s, err := c.store.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if s.State.Terminal() {
		return s, nil
	}
	if s.State != StateActive {
		return nil, ErrOperationInFlight
	}

	remote, err := c.backend.ListParts(ctx, s.ObjectKey, s.UploadID)
	if err != nil {
		if err == ErrUploadNotFound {
			_ = c.transition(ctx, sessionID, StateActive, StateAborted, func(cur *Session) {
				cur.AbortReason = "remote upload missing at resume"
			})
		}
		return nil, err
	}
	byNumber := make(map[int]string, len(remote))
	for _, rp := range remote {
		byNumber[rp.Number] = rp.ETag
	}
	for n, p := range s.Parts {
		etag, ok := byNumber[n]
		if !ok {
			continue // missing remotely; will be pruned below
		}
		if etag != p.ETag {
			return nil, fmt.Errorf("%w: part %d remote ETag changed", ErrPartConflict, n)
		}
	}
	for n := range byNumber {
		if _, ok := s.Parts[n]; !ok {
			return nil, fmt.Errorf("%w: remote part %d not in manifest", ErrOrphanPart, n)
		}
	}
	if err := c.store.Update(ctx, sessionID, func(cur *Session) error {
		if cur.State != StateActive {
			return fmt.Errorf("%w: state is %s", ErrSessionNotActive, cur.State)
		}
		for n := range cur.Parts {
			if _, ok := byNumber[n]; !ok {
				delete(cur.Parts, n)
			}
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return c.store.Get(ctx, sessionID)
}

// transition atomically moves the session from one state to another,
// applying mutate on success. It fails with ErrSessionTerminal or
// ErrOperationInFlight when the current state no longer matches, which is
// what guarantees a single terminal state under races.
func (c *Coordinator) transition(ctx context.Context, sessionID string, from, to State, mutate func(*Session)) error {
	return c.store.Update(ctx, sessionID, func(cur *Session) error {
		if cur.State != from {
			if cur.State.Terminal() {
				return fmt.Errorf("%w: state is %s", ErrSessionTerminal, cur.State)
			}
			return fmt.Errorf("%w: state is %s", ErrOperationInFlight, cur.State)
		}
		cur.State = to
		if mutate != nil {
			mutate(cur)
		}
		return nil
	})
}

func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
