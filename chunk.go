package dataeng

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
)

// DigestSize is the expected length of every SHA256 digest in this package.
const DigestSize = sha256.Size

// Sentinel errors returned by the collector. Callers should use errors.Is.
var (
	// ErrInvalidManifest means the supplied manifest is internally inconsistent.
	ErrInvalidManifest = errors.New("invalid manifest")
	// ErrChunkIndexOutOfRange means a chunk index is negative or >= TotalChunks.
	ErrChunkIndexOutOfRange = errors.New("chunk index out of range")
	// ErrLengthMismatch means a chunk does not have the length declared in the manifest.
	ErrLengthMismatch = errors.New("chunk length mismatch")
	// ErrDigestMismatch means a chunk does not match its per-chunk SHA256.
	ErrDigestMismatch = errors.New("chunk digest mismatch")
	// ErrConflict means a re-delivered index holds different bytes than the stored ones.
	ErrConflict = errors.New("chunk content conflict")
	// ErrIncomplete means Complete was called while some chunks are still missing.
	ErrIncomplete = errors.New("file is incomplete")
	// ErrFileDigestMismatch means the assembled file does not match the whole-file SHA256.
	ErrFileDigestMismatch = errors.New("whole file digest mismatch")
	// ErrCommitAmbiguous means a transaction outcome could not be confirmed either way.
	ErrCommitAmbiguous = errors.New("transaction commit outcome ambiguous")
	// ErrStopped means the collector stopped itself after an unreadable confirmed state.
	ErrStopped = errors.New("collector stopped")
	// ErrClosed means the collector was cancelled and no longer accepts operations.
	ErrClosed = errors.New("collector closed")
)

// ChunkSpec describes one expected chunk: its non-negative length and SHA256.
type ChunkSpec struct {
	Length int
	SHA256 []byte
}

// Manifest describes the expected layout of the whole file.
type Manifest struct {
	// TotalChunks must be a positive integer.
	TotalChunks int
	// FileSHA256 must be a 32-byte SHA256 digest of the concatenated chunks.
	FileSHA256 []byte
	// Chunks must have exactly TotalChunks entries, indexed from zero.
	Chunks []ChunkSpec
}

func (m *Manifest) validate() error {
	if m == nil {
		return fmt.Errorf("%w: manifest is nil", ErrInvalidManifest)
	}
	if m.TotalChunks <= 0 {
		return fmt.Errorf("%w: TotalChunks must be positive", ErrInvalidManifest)
	}
	if len(m.Chunks) != m.TotalChunks {
		return fmt.Errorf("%w: got %d chunk specs for %d chunks",
			ErrInvalidManifest, len(m.Chunks), m.TotalChunks)
	}
	if len(m.FileSHA256) != DigestSize {
		return fmt.Errorf("%w: file digest must be %d bytes", ErrInvalidManifest, DigestSize)
	}
	for i, spec := range m.Chunks {
		if spec.Length < 0 {
			return fmt.Errorf("%w: chunk %d has negative length", ErrInvalidManifest, i)
		}
		if len(spec.SHA256) != DigestSize {
			return fmt.Errorf("%w: chunk %d digest must be %d bytes",
				ErrInvalidManifest, i, DigestSize)
		}
	}
	return nil
}

// Txn is one transaction against the landing point. Staging transactions persist
// chunk bytes and the received marker together; publish transactions install the
// assembled file atomically.
type Txn interface {
	// PutChunk stores chunk bytes inside a staging transaction.
	PutChunk(ctx context.Context, index int, data []byte) error
	// MarkReceived records that the index has been accepted, inside the same transaction.
	MarkReceived(ctx context.Context, index int) error
	// RemoveChunk deletes chunk bytes and its received marker inside a transaction.
	RemoveChunk(ctx context.Context, index int) error
	// PublishFile stages the assembled file inside a publish transaction.
	PublishFile(ctx context.Context, data []byte) error
	// Commit applies the transaction. It may return ErrCommitAmbiguous when the
	// outcome is unknown; a hard error means nothing was applied.
	Commit(ctx context.Context) error
	// Rollback discards an uncommitted transaction.
	Rollback(ctx context.Context) error
}

// Sink is the injectable transactional landing point.
type Sink interface {
	// BeginTxn starts a transaction. publish=true opens a publish transaction,
	// otherwise a staging transaction is opened.
	BeginTxn(ctx context.Context, publish bool) (Txn, error)
	// ReadChunk returns the stored chunk bytes. ok=false means nothing is stored.
	ReadChunk(ctx context.Context, index int) (data []byte, ok bool, err error)
	// IsMarkedReceived reports whether the index carries a confirmed marker.
	IsMarkedReceived(ctx context.Context, index int) (bool, error)
	// Published reports whether the assembled file has already been published.
	Published(ctx context.Context) (bool, error)
	// Release releases the underlying handle. Persisted chunks must survive it.
	Release()
}

// Collector reassembles and verifies a file delivered as unordered chunks.
type Collector struct {
	mu       sync.Mutex
	manifest *Manifest
	sink     Sink
	received []bool
	closed   bool
	stopped  bool
	stopErr  error
}

// NewCollector validates the manifest and rebuilds the in-memory received set
// from the durable markers kept by the sink.
func NewCollector(manifest *Manifest, sink Sink) (*Collector, error) {
	if err := manifest.validate(); err != nil {
		return nil, err
	}
	if sink == nil {
		return nil, fmt.Errorf("%w: sink is nil", ErrInvalidManifest)
	}
	c := &Collector{
		manifest: manifest,
		sink:     sink,
		received: make([]bool, manifest.TotalChunks),
	}
	ctx := context.Background()
	for i := range manifest.Chunks {
		marked, err := sink.IsMarkedReceived(ctx, i)
		if err != nil {
			return nil, fmt.Errorf("read marker for chunk %d: %w", i, err)
		}
		c.received[i] = marked
	}
	return c, nil
}

// checkLive returns the terminal state of the collector, if any.
func (c *Collector) checkLive() error {
	if c.closed {
		return ErrClosed
	}
	if c.stopped {
		return c.stopErr
	}
	return nil
}

// stop marks the collector stopped and returns the wrapped error. It is used
// when a confirmed marker/content pair cannot be read back.
func (c *Collector) stop(err error) error {
	c.stopped = true
	c.stopErr = fmt.Errorf("%w: %w", ErrStopped, err)
	return c.stopErr
}

// AddChunk accepts a chunk carrying a zero-based index. Chunks may arrive out of
// order or more than once. Invalid chunks are rejected before anything is
// written. A re-delivered index is compared byte-for-byte against the stored
// chunk; differing content reports ErrConflict.
func (c *Collector) AddChunk(ctx context.Context, index int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.checkLive(); err != nil {
		return err
	}
	if index < 0 || index >= c.manifest.TotalChunks {
		return fmt.Errorf("%w: index %d", ErrChunkIndexOutOfRange, index)
	}
	spec := c.manifest.Chunks[index]
	if len(data) != spec.Length {
		return fmt.Errorf("%w: chunk %d expects %d bytes, got %d",
			ErrLengthMismatch, index, spec.Length, len(data))
	}
	digest := sha256.Sum256(data)
	if !bytes.Equal(digest[:], spec.SHA256) {
		return fmt.Errorf("%w: chunk %d", ErrDigestMismatch, index)
	}

	if c.received[index] {
		return c.checkDuplicate(ctx, index, data)
	}
	return c.stageChunk(ctx, index, data)
}

// checkDuplicate compares a re-delivered chunk against the durable bytes.
func (c *Collector) checkDuplicate(ctx context.Context, index int, data []byte) error {
	stored, ok, err := c.sink.ReadChunk(ctx, index)
	if err != nil {
		return c.stop(fmt.Errorf("read stored chunk %d: %w", index, err))
	}
	if !ok {
		return c.stop(fmt.Errorf("marker for chunk %d exists without content", index))
	}
	if !bytes.Equal(stored, data) {
		return fmt.Errorf("%w: chunk %d", ErrConflict, index)
	}
	return nil
}

// stageChunk persists chunk bytes and the received marker in one transaction.
func (c *Collector) stageChunk(ctx context.Context, index int, data []byte) error {
	txn, err := c.sink.BeginTxn(ctx, false)
	if err != nil {
		return fmt.Errorf("begin staging txn for chunk %d: %w", index, err)
	}
	if err := txn.PutChunk(ctx, index, data); err != nil {
		_ = txn.Rollback(ctx)
		return fmt.Errorf("write chunk %d: %w", index, err)
	}
	if err := txn.MarkReceived(ctx, index); err != nil {
		_ = txn.Rollback(ctx)
		return fmt.Errorf("mark chunk %d: %w", index, err)
	}

	switch err := txn.Commit(ctx); {
	case err == nil:
		c.received[index] = true
		return nil
	case errors.Is(err, ErrCommitAmbiguous):
		return c.confirmStaged(ctx, index, data)
	default:
		_ = txn.Rollback(ctx)
		return fmt.Errorf("commit chunk %d: %w", index, err)
	}
}

// confirmStaged resolves an ambiguous staging commit by reading the marker and
// the content back. Any read failure stops the collector because the confirmed
// state can no longer be trusted.
func (c *Collector) confirmStaged(ctx context.Context, index int, data []byte) error {
	marked, err := c.sink.IsMarkedReceived(ctx, index)
	if err != nil {
		return c.stop(fmt.Errorf("confirm marker for chunk %d: %w", index, err))
	}
	if !marked {
		return fmt.Errorf("%w: chunk %d not marked after commit", ErrCommitAmbiguous, index)
	}
	stored, ok, err := c.sink.ReadChunk(ctx, index)
	if err != nil {
		return c.stop(fmt.Errorf("confirm content for chunk %d: %w", index, err))
	}
	if !ok {
		return c.stop(fmt.Errorf("marker for chunk %d exists without content", index))
	}
	if !bytes.Equal(stored, data) {
		return c.stop(fmt.Errorf("confirmed content for chunk %d differs from delivery", index))
	}
	c.received[index] = true
	return nil
}

// Recover revalidates every staged chunk against the manifest. Corrupt chunks
// have their marker and bytes cleared and are returned as indices that must be
// requested again. A read failure against a marked chunk stops the collector.
func (c *Collector) Recover(ctx context.Context) ([]int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.checkLive(); err != nil {
		return nil, err
	}

	missing := make([]int, 0)
	for index, spec := range c.manifest.Chunks {
		marked, err := c.sink.IsMarkedReceived(ctx, index)
		if err != nil {
			return nil, c.stop(fmt.Errorf("read marker for chunk %d: %w", index, err))
		}
		if !marked {
			c.received[index] = false
			missing = append(missing, index)
			continue
		}

		data, ok, err := c.sink.ReadChunk(ctx, index)
		if err != nil {
			return nil, c.stop(fmt.Errorf("read chunk %d: %w", index, err))
		}
		digest := sha256.Sum256(data)
		switch {
		case !ok, len(data) != spec.Length, !bytes.Equal(digest[:], spec.SHA256):
			if err := c.clearChunk(ctx, index); err != nil {
				return nil, err
			}
			missing = append(missing, index)
		default:
			c.received[index] = true
		}
	}
	return missing, nil
}

// clearChunk removes a corrupt chunk and its marker inside one transaction.
func (c *Collector) clearChunk(ctx context.Context, index int) error {
	txn, err := c.sink.BeginTxn(ctx, false)
	if err != nil {
		return fmt.Errorf("begin cleanup txn for chunk %d: %w", index, err)
	}
	if err := txn.RemoveChunk(ctx, index); err != nil {
		_ = txn.Rollback(ctx)
		return fmt.Errorf("remove chunk %d: %w", index, err)
	}
	switch err := txn.Commit(ctx); {
	case err == nil:
		c.received[index] = false
		return nil
	case errors.Is(err, ErrCommitAmbiguous):
		return c.confirmCleared(ctx, index)
	default:
		_ = txn.Rollback(ctx)
		return fmt.Errorf("commit cleanup for chunk %d: %w", index, err)
	}
}

// confirmCleared resolves an ambiguous cleanup commit by re-reading the marker.
func (c *Collector) confirmCleared(ctx context.Context, index int) error {
	marked, err := c.sink.IsMarkedReceived(ctx, index)
	if err != nil {
		return c.stop(fmt.Errorf("confirm removal marker for chunk %d: %w", index, err))
	}
	if !marked {
		c.received[index] = false
		return nil
	}
	if _, ok, err := c.sink.ReadChunk(ctx, index); err != nil {
		return c.stop(fmt.Errorf("confirm removal content for chunk %d: %w", index, err))
	} else if ok {
		return fmt.Errorf("%w: chunk %d still present after cleanup", ErrCommitAmbiguous, index)
	}
	return fmt.Errorf("%w: chunk %d still marked after cleanup", ErrCommitAmbiguous, index)
}

// Complete assembles all chunks in index order, verifies the whole-file digest,
// and publishes the file atomically through a publish transaction. Nothing is
// published while the file is incomplete or its digest is wrong.
func (c *Collector) Complete(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.checkLive(); err != nil {
		return err
	}

	missing := make([]int, 0)
	for index, marked := range c.received {
		if !marked {
			missing = append(missing, index)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%w: missing chunks %v", ErrIncomplete, missing)
	}

	var assembled bytes.Buffer
	hasher := sha256.New()
	for index, spec := range c.manifest.Chunks {
		data, ok, err := c.sink.ReadChunk(ctx, index)
		if err != nil {
			return c.stop(fmt.Errorf("read chunk %d for assembly: %w", index, err))
		}
		if !ok {
			return c.stop(fmt.Errorf("marker for chunk %d exists without content", index))
		}
		digest := sha256.Sum256(data)
		if len(data) != spec.Length || !bytes.Equal(digest[:], spec.SHA256) {
			return fmt.Errorf("%w: chunk %d failed final revalidation", ErrDigestMismatch, index)
		}
		assembled.Write(data)
		_, _ = hasher.Write(data)
	}
	if !bytes.Equal(hasher.Sum(nil), c.manifest.FileSHA256) {
		return ErrFileDigestMismatch
	}
	return c.publish(ctx, assembled.Bytes())
}

// publish installs the assembled file in one publish transaction and resolves
// ambiguous commits against the durable published flag.
func (c *Collector) publish(ctx context.Context, data []byte) error {
	txn, err := c.sink.BeginTxn(ctx, true)
	if err != nil {
		return fmt.Errorf("begin publish txn: %w", err)
	}
	if err := txn.PublishFile(ctx, data); err != nil {
		_ = txn.Rollback(ctx)
		return fmt.Errorf("stage published file: %w", err)
	}
	switch err := txn.Commit(ctx); {
	case err == nil:
		return nil
	case errors.Is(err, ErrCommitAmbiguous):
		published, readErr := c.sink.Published(ctx)
		if readErr != nil {
			return c.stop(fmt.Errorf("confirm publish: %w", readErr))
		}
		if published {
			return nil
		}
		return fmt.Errorf("%w: file not visible after commit", ErrCommitAmbiguous)
	default:
		_ = txn.Rollback(ctx)
		return fmt.Errorf("commit publish: %w", err)
	}
}

// Cancel releases the sink handle but keeps every confirmed chunk and its
// marker on durable storage. The collector rejects further operations.
func (c *Collector) Cancel() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	c.sink.Release()
}
