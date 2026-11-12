package mergejoin

import (
	"context"
	"fmt"
	"io"
	"sync/atomic"
)

// Result summarizes a completed join run.
type Result struct {
	// Pairs is the number of emitted and acknowledged result pairs.
	Pairs int
	// MatchedGroups is the number of keys present on both sides.
	MatchedGroups int
}

// Joiner performs one merge join run over two sorted streams. A Joiner is
// single-use: create a fresh instance for every run.
type Joiner[L, R any] struct {
	left       Stream[L]
	right      Stream[R]
	emit       EmitFunc[L, R]
	newStaging NewStagingFunc[L, R]
	gate       *Gate

	leftCfg  sideConfig[L]
	rightCfg sideConfig[R]

	started atomic.Bool
}

// New builds a Joiner. newStaging supplies the replayable spill storage used
// whenever a key group exceeds the configured memory budget.
func New[L, R any](
	left Stream[L],
	right Stream[R],
	cfg Config[L, R],
	emit EmitFunc[L, R],
	newStaging NewStagingFunc[L, R],
) (*Joiner[L, R], error) {
	if left == nil || right == nil {
		return nil, fmt.Errorf("%w: both input streams are required", ErrInvalidConfig)
	}
	if emit == nil {
		return nil, fmt.Errorf("%w: emit callback is required", ErrInvalidConfig)
	}
	if newStaging == nil {
		return nil, fmt.Errorf("%w: staging factory is required", ErrInvalidConfig)
	}
	if cfg.MaxGroupRows < 0 || cfg.MaxGroupBytes < 0 {
		return nil, fmt.Errorf("%w: memory budgets must be non-negative", ErrInvalidConfig)
	}
	if cfg.MaxGroupBytes > 0 && (cfg.LeftSizer == nil || cfg.RightSizer == nil) {
		return nil, fmt.Errorf("%w: byte budget requires both sizers", ErrInvalidConfig)
	}

	return &Joiner[L, R]{
		left:       left,
		right:      right,
		emit:       emit,
		newStaging: newStaging,
		gate:       NewGate(),
		leftCfg: sideConfig[L]{
			maxRows:  cfg.MaxGroupRows,
			maxBytes: cfg.MaxGroupBytes,
			sizer:    cfg.LeftSizer,
		},
		rightCfg: sideConfig[R]{
			maxRows:  cfg.MaxGroupRows,
			maxBytes: cfg.MaxGroupBytes,
			sizer:    cfg.RightSizer,
		},
	}, nil
}

// WithGate installs an externally controlled pause/resume gate. Passing nil
// restores an internal gate. Call before Run.
func (j *Joiner[L, R]) WithGate(gate *Gate) *Joiner[L, R] {
	if gate == nil {
		gate = NewGate()
	}
	j.gate = gate
	return j
}

// Gate returns the flow-control gate used by the run.
func (j *Joiner[L, R]) Gate() *Gate {
	return j.gate
}

// Run executes the join. On return, including cancellation or error, both
// input streams and the staging handle are closed.
func (j *Joiner[L, R]) Run(ctx context.Context) (Result, error) {
	if err := j.markStarted(); err != nil {
		return Result{}, err
	}

	staging, err := j.newStaging()
	if err != nil {
		return Result{}, err
	}

	// Cancellation must not leak inputs or the staging handle.
	defer func() { _ = staging.Close() }()
	defer func() { _ = j.left.Close() }()
	defer func() { _ = j.right.Close() }()

	leftCursor := newCursor(j.left, Left)
	rightCursor := newCursor(j.right, Right)

	var result Result
	for {
		if err := ctx.Err(); err != nil {
			return result, err
		}

		leftHead, err := leftCursor.peek(ctx)
		if err == io.EOF {
			return result, nil
		}
		if err != nil {
			return result, err
		}
		rightHead, err := rightCursor.peek(ctx)
		if err == io.EOF {
			return result, nil
		}
		if err != nil {
			return result, err
		}

		switch {
		case leftHead.Key < rightHead.Key:
			if err := leftCursor.skipGroup(ctx, leftHead.Key); err != nil {
				return result, err
			}
		case leftHead.Key > rightHead.Key:
			if err := rightCursor.skipGroup(ctx, rightHead.Key); err != nil {
				return result, err
			}
		default:
			pairs, err := j.joinGroup(ctx, leftHead.Key, leftCursor, rightCursor, staging)
			if err != nil {
				return result, err
			}
			result.Pairs += pairs
			result.MatchedGroups++
		}
	}
}

func (j *Joiner[L, R]) markStarted() error {
	if !j.started.CompareAndSwap(false, true) {
		return ErrRunReused
	}
	return nil
}

// joinGroup drains one matching key from both cursors and emits its full
// Cartesian product, spilling to staging when either side crosses budget.
func (j *Joiner[L, R]) joinGroup(
	ctx context.Context,
	key int64,
	leftCursor *cursor[L],
	rightCursor *cursor[R],
	staging Staging[L, R],
) (int, error) {
	leftGroup := newGroupSide(j.leftCfg, key, staging.NewLeftWriter)
	rightGroup := newGroupSide(j.rightCfg, key, staging.NewRightWriter)

	if err := leftCursor.drainGroup(ctx, key, leftGroup.add); err != nil {
		return 0, err
	}
	if err := rightCursor.drainGroup(ctx, key, rightGroup.add); err != nil {
		return 0, err
	}
	if err := leftGroup.closeWriter(); err != nil {
		return 0, err
	}
	if err := rightGroup.closeWriter(); err != nil {
		return 0, err
	}

	leftSource, err := j.openLeftSource(ctx, key, leftGroup, staging)
	if err != nil {
		return 0, err
	}
	rightSource, err := j.openRightSource(ctx, key, rightGroup, staging)
	if err != nil {
		_ = leftSource.close(ctx)
		return 0, err
	}
	defer func() {
		_ = rightSource.close(ctx)
		_ = leftSource.close(ctx)
	}()

	emitted, err := j.emitProduct(ctx, key, leftGroup, rightGroup, leftSource, rightSource)
	if err != nil {
		return emitted, err
	}

	expected := leftGroup.count * rightGroup.count
	if emitted != expected {
		return emitted, fmt.Errorf("%w: key=%d expected=%d emitted=%d",
			ErrTruncated, key, expected, emitted)
	}
	return emitted, nil
}

func (j *Joiner[L, R]) openLeftSource(
	ctx context.Context,
	key int64,
	group *groupSide[L],
	staging Staging[L, R],
) (rowSource[L], error) {
	if !group.spilled {
		return buildMemSource(group), nil
	}
	reader, err := staging.NewLeftReader(ctx, key)
	if err != nil {
		return nil, err
	}
	return buildStageSource(group, reader), nil
}

func (j *Joiner[L, R]) openRightSource(
	ctx context.Context,
	key int64,
	group *groupSide[R],
	staging Staging[L, R],
) (rowSource[R], error) {
	if !group.spilled {
		return buildMemSource(group), nil
	}
	reader, err := staging.NewRightReader(ctx, key)
	if err != nil {
		return nil, err
	}
	return buildStageSource(group, reader), nil
}

// emitProduct runs the nested loop: left rows in arrival order, each paired
// with every right row, rewinding the right source for every left row.
func (j *Joiner[L, R]) emitProduct(
	ctx context.Context,
	key int64,
	leftGroup *groupSide[L],
	rightGroup *groupSide[R],
	leftSource rowSource[L],
	rightSource rowSource[R],
) (int, error) {
	emitted := 0
	for {
		if err := ctx.Err(); err != nil {
			return emitted, err
		}
		leftRow, err := leftSource.next(ctx)
		if err == io.EOF {
			return emitted, nil
		}
		if err != nil {
			return emitted, err
		}

		if err := rightSource.rewind(); err != nil {
			return emitted, err
		}
		for {
			if err := ctx.Err(); err != nil {
				return emitted, err
			}
			// Honor an externally armed pause before producing the pair.
			j.gate.Wait(ctx.Done())
			if err := ctx.Err(); err != nil {
				return emitted, err
			}
			rightRow, err := rightSource.next(ctx)
			if err == io.EOF {
				break
			}
			if err != nil {
				return emitted, err
			}

			decision, err := j.emit(ctx, Pair[L, R]{
				Key:   key,
				Left:  leftRow,
				Right: rightRow,
			})
			if err != nil {
				return emitted, err
			}
			emitted++

			if decision == Pause {
				// The pair above is already acknowledged. A Pause decision
				// arms the gate so Wait blocks until the consumer resumes;
				// an externally armed gate is already paused.
				j.gate.Pause()
				j.gate.Wait(ctx.Done()) // returns on Resume or cancellation
				if err := ctx.Err(); err != nil {
					return emitted, err
				}
			}
		}
	}
}
