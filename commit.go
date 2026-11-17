package formal

import (
	"context"
	"errors"
	"fmt"
)

var (
	// ErrShardConflict reports a retry that tried to replace an immutable
	// shard with different content. The caller must use a new generation.
	ErrShardConflict = errors.New("formal: shard conflicts with immutable object")
	// ErrShardMismatch reports a shard whose header belongs to a different
	// step, generation, or rank than the key it was stored under.
	ErrShardMismatch = errors.New("formal: shard metadata does not match commit")
	// ErrMissingShard reports a shard that never became visible at its exact
	// step/generation/rank key.
	ErrMissingShard = errors.New("formal: shard missing or not visible")
	// ErrStepCommitted reports that another manifest already owns the step.
	ErrStepCommitted = errors.New("formal: step already committed with a different manifest")
)

// StepCommittedError carries the manifest that won the publish race.
type StepCommittedError struct {
	Step     uint64
	Manifest Manifest
}

func (e *StepCommittedError) Error() string {
	return fmt.Sprintf("formal: step %d already committed with generation %d (%d shards)",
		e.Step, e.Manifest.Generation, e.Manifest.RankCount)
}

// Unwrap lets errors.Is(err, ErrStepCommitted) succeed.
func (e *StepCommittedError) Unwrap() error { return ErrStepCommitted }

// Uploader writes one rank's shard. Upload is idempotent for identical
// content: a create-once conflict is resolved by reading the existing object
// back and comparing its header. Different content under the same
// step/generation/rank is rejected as ErrShardConflict.
type Uploader struct {
	Store      Store
	Step       uint64
	Generation uint64
	Rank       int
	Retry      RetryPolicy
}

// Upload writes the immutable shard and returns the reference a manifest
// should record.
func (u *Uploader) Upload(ctx context.Context, payload []byte) (ShardRef, error) {
	if u.Store == nil {
		return ShardRef{}, errors.New("formal: nil store")
	}
	if u.Rank < 0 {
		return ShardRef{}, fmt.Errorf("formal: negative rank %d", u.Rank)
	}

	blob, header, err := EncodeShard(u.Step, u.Generation, u.Rank, payload)
	if err != nil {
		return ShardRef{}, err
	}
	key := ShardKey(u.Step, u.Generation, u.Rank)
	_, err = u.Store.Put(ctx, key, blob, Condition{IfNoneMatch: true})
	switch {
	case err == nil:
		// Stored by this attempt.
	case errors.Is(err, ErrAlreadyExists) || errors.Is(err, ErrPreconditionFailed):
		existing, readErr := getWithRetry(ctx, u.Store, key, u.Retry)
		if readErr != nil {
			return ShardRef{}, fmt.Errorf("formal: read back existing shard %s: %w", key, readErr)
		}
		existingHeader, _, decodeErr := DecodeShard(existing.Data)
		if decodeErr != nil {
			return ShardRef{}, fmt.Errorf("formal: existing shard %s: %w", key, decodeErr)
		}
		if existingHeader.Step != header.Step ||
			existingHeader.Generation != header.Generation ||
			existingHeader.Rank != header.Rank ||
			existingHeader.Digest != header.Digest ||
			existingHeader.Size != header.Size {
			return ShardRef{}, fmt.Errorf("%w: key %s existing digest %s size %d, new digest %s size %d",
				ErrShardConflict, key, existingHeader.Digest, existingHeader.Size, header.Digest, header.Size)
		}
		// Identical retry: fall through to the successful return.
	default:
		return ShardRef{}, fmt.Errorf("formal: put shard %s: %w", key, err)
	}

	return ShardRef{
		Rank:   header.Rank,
		Key:    key,
		Digest: header.Digest,
		Size:   header.Size,
	}, nil
}

// CommitResult reports the manifest that owns the step. Created is true only
// when this call performed the atomic publish.
type CommitResult struct {
	Manifest Manifest
	Created  bool
}

// Coordinator publishes the manifest for a step after every rank's shard has
// been verified. It requires ranks [0, Ranks) and a positive rank count.
type Coordinator struct {
	Store      Store
	Step       uint64
	Generation uint64
	Ranks      int
	Retry      RetryPolicy
}

// Commit verifies all shards and then attempts an if-none-match create of the
// step manifest. If a manifest already exists, it is verified and adopted
// rather than overwritten; a manifest from a different generation is reported
// as *StepCommittedError.
func (c *Coordinator) Commit(ctx context.Context) (CommitResult, error) {
	if c.Store == nil {
		return CommitResult{}, errors.New("formal: nil store")
	}
	if c.Ranks <= 0 {
		return CommitResult{}, fmt.Errorf("formal: coordinator rank count must be positive, got %d", c.Ranks)
	}

	manifestKey := ManifestKey(c.Step)

	// Fast path: a previous attempt may already have published this step. The
	// read can be stale, in which case the conditional write below resolves
	// the race.
	if obj, err := c.Store.Get(ctx, manifestKey); err == nil {
		return c.adopt(ctx, obj.Data)
	} else if !errors.Is(err, ErrNotFound) {
		return CommitResult{}, fmt.Errorf("formal: read manifest %s: %w", manifestKey, err)
	}

	refs := make([]ShardRef, c.Ranks)
	for rank := 0; rank < c.Ranks; rank++ {
		ref, err := c.readShard(ctx, rank)
		if err != nil {
			return CommitResult{}, fmt.Errorf("formal: step %d generation %d: %w", c.Step, c.Generation, err)
		}
		refs[rank] = ref
	}

	manifest := Manifest{
		Format:     ManifestFormat,
		Step:       c.Step,
		Generation: c.Generation,
		RankCount:  c.Ranks,
		Shards:     refs,
	}
	data, err := manifest.Marshal()
	if err != nil {
		return CommitResult{}, err
	}

	_, err = c.Store.Put(ctx, manifestKey, data, Condition{IfNoneMatch: true})
	if err == nil {
		return CommitResult{Manifest: manifest, Created: true}, nil
	}
	if !errors.Is(err, ErrAlreadyExists) && !errors.Is(err, ErrPreconditionFailed) {
		return CommitResult{}, fmt.Errorf("formal: publish manifest %s: %w", manifestKey, err)
	}

	// Lost the publish race: another manifest became visible first. Adopt and
	// verify it instead of overwriting.
	obj, err := getWithRetry(ctx, c.Store, manifestKey, c.Retry)
	if err != nil {
		return CommitResult{}, fmt.Errorf("formal: load manifest after publish race: %w", err)
	}
	return c.adopt(ctx, obj.Data)
}

func (c *Coordinator) readShard(ctx context.Context, rank int) (ShardRef, error) {
	key := ShardKey(c.Step, c.Generation, rank)
	obj, err := getWithRetry(ctx, c.Store, key, c.Retry)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return ShardRef{}, fmt.Errorf("%w: rank %d key %s: %w", ErrMissingShard, rank, key, err)
		}
		return ShardRef{}, fmt.Errorf("formal: read shard rank %d key %s: %w", rank, key, err)
	}
	header, _, err := DecodeShard(obj.Data)
	if err != nil {
		return ShardRef{}, fmt.Errorf("rank %d key %s: %w", rank, key, err)
	}
	if header.Step != c.Step || header.Generation != c.Generation || header.Rank != rank {
		return ShardRef{}, fmt.Errorf("%w: rank %d key %s contains step=%d generation=%d rank=%d, want step=%d generation=%d rank=%d",
			ErrShardMismatch, rank, key, header.Step, header.Generation, header.Rank, c.Step, c.Generation, rank)
	}
	return ShardRef{
		Rank:   rank,
		Key:    key,
		Digest: header.Digest,
		Size:   header.Size,
	}, nil
}

func (c *Coordinator) adopt(ctx context.Context, data []byte) (CommitResult, error) {
	manifest, err := DecodeManifest(data)
	if err != nil {
		return CommitResult{}, fmt.Errorf("formal: published manifest for step %d: %w", c.Step, err)
	}
	if manifest.Step != c.Step {
		return CommitResult{}, fmt.Errorf("%w: manifest for step %d found while committing step %d", ErrManifestInvalid, manifest.Step, c.Step)
	}
	if err := Verify(ctx, c.Store, manifest, VerifyOptions{Retry: c.Retry}); err != nil {
		return CommitResult{}, fmt.Errorf("formal: published manifest for step %d is invalid: %w", c.Step, err)
	}
	result := CommitResult{Manifest: manifest, Created: false}
	if manifest.Generation == c.Generation && manifest.RankCount == c.Ranks {
		return result, nil
	}
	return result, &StepCommittedError{Step: c.Step, Manifest: manifest}
}
