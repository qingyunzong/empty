// Package schedgen generates deterministic transaction schedules for testing
// online index builds.
//
// A schedule deliberately includes transactions that begin before the snapshot
// is opened and commit after it, transactions that update or delete keys seen
// by the snapshot, aborted transactions, and repeated catch-up calls. Optional
// cancellation is scheduled after the snapshot but before sealing.
package schedgen

import (
	"fmt"
	"math/rand"
)

// Kind identifies a scheduled operation.
type Kind uint8

const (
	Begin Kind = iota + 1
	Put
	Delete
	Commit
	Rollback
	Scan
	CatchUp
	Seal
	Publish
	Cancel
)

func (k Kind) String() string {
	switch k {
	case Begin:
		return "begin"
	case Put:
		return "put"
	case Delete:
		return "delete"
	case Commit:
		return "commit"
	case Rollback:
		return "rollback"
	case Scan:
		return "scan"
	case CatchUp:
		return "catchup"
	case Seal:
		return "seal"
	case Publish:
		return "publish"
	case Cancel:
		return "cancel"
	default:
		return fmt.Sprintf("kind(%d)", uint8(k))
	}
}

// Op is one operation in a schedule. Txn is an index into the schedule's
// transaction table, not a database transaction ID.
type Op struct {
	Kind  Kind
	Txn   int
	Key   string
	Value string
}

func (o Op) String() string {
	switch o.Kind {
	case Put:
		return fmt.Sprintf("put(txn=%d,%s=%s)", o.Txn, o.Key, o.Value)
	case Delete:
		return fmt.Sprintf("delete(txn=%d,%s)", o.Txn, o.Key)
	case Begin, Commit, Rollback:
		return fmt.Sprintf("%s(txn=%d)", o.Kind, o.Txn)
	default:
		return o.Kind.String()
	}
}

// Options controls schedule shape. Zero values are replaced with defaults.
type Options struct {
	Keys     int
	Pre      int
	Crossing int
	Post     int

	// Cancel inserts a cancellation after the build has seen at least one
	// commit, instead of sealing and publishing.
	Cancel bool
}

// Schedule is a deterministic sequence of operations.
type Schedule struct {
	Seed    int64
	Options Options
	Ops     []Op
}

// String returns a compact description suitable for a test name.
func (s Schedule) String() string {
	return fmt.Sprintf("seed=%d/pre=%d/cross=%d/post=%d/cancel=%t",
		s.Seed, s.Options.Pre, s.Options.Crossing, s.Options.Post, s.Options.Cancel)
}

// Generate builds a schedule. The same seed and options always produce the
// same schedule.
func Generate(seed int64, opts Options) Schedule {
	if opts.Keys <= 0 {
		opts.Keys = 8
	}
	if opts.Pre <= 0 {
		opts.Pre = 4
	}
	if opts.Crossing <= 0 {
		opts.Crossing = 3
	}
	if opts.Post <= 0 {
		opts.Post = 3
	}

	rng := rand.New(rand.NewSource(seed))
	var ops []Op
	nextTxn := 0

	key := func() string {
		return fmt.Sprintf("k%03d", rng.Intn(opts.Keys))
	}
	value := func(txn int) string {
		return fmt.Sprintf("v%d_%d", txn, rng.Intn(1_000_000))
	}
	body := func(txn int) {
		n := 1 + rng.Intn(3)
		for i := 0; i < n; i++ {
			k := key()
			if rng.Intn(3) == 0 {
				ops = append(ops, Op{Kind: Delete, Txn: txn, Key: k})
			} else {
				ops = append(ops, Op{Kind: Put, Txn: txn, Key: k, Value: value(txn)})
			}
		}
	}

	for i := 0; i < opts.Pre; i++ {
		txn := nextTxn
		nextTxn++
		ops = append(ops, Op{Kind: Begin, Txn: txn})
		body(txn)
		ops = append(ops, Op{Kind: Commit, Txn: txn})
	}

	crossing := make([]int, 0, opts.Crossing)
	for i := 0; i < opts.Crossing; i++ {
		txn := nextTxn
		nextTxn++
		ops = append(ops, Op{Kind: Begin, Txn: txn})
		body(txn)
		crossing = append(crossing, txn)
	}

	ops = append(ops, Op{Kind: Scan})

	type action struct {
		commitCrossing bool
		txn            int
		rollback       bool
	}
	actions := make([]action, 0, len(crossing)+opts.Post)
	for _, txn := range crossing {
		actions = append(actions, action{
			commitCrossing: true,
			txn:            txn,
			rollback:       rng.Intn(6) == 0,
		})
	}
	for i := 0; i < opts.Post; i++ {
		actions = append(actions, action{txn: -1})
	}
	rng.Shuffle(len(actions), func(i, j int) {
		actions[i], actions[j] = actions[j], actions[i]
	})

	catchUps := 0
	for i, act := range actions {
		if act.commitCrossing {
			if act.rollback {
				ops = append(ops, Op{Kind: Rollback, Txn: act.txn})
			} else {
				ops = append(ops, Op{Kind: Commit, Txn: act.txn})
			}
		} else {
			txn := nextTxn
			nextTxn++
			ops = append(ops, Op{Kind: Begin, Txn: txn})
			body(txn)
			if rng.Intn(5) == 0 {
				ops = append(ops, Op{Kind: Rollback, Txn: txn})
			} else {
				ops = append(ops, Op{Kind: Commit, Txn: txn})
			}
		}

		if i == len(actions)/2 && len(actions) > 1 {
			ops = append(ops, Op{Kind: CatchUp})
			catchUps++
		}
	}
	if catchUps == 0 || len(actions) == 0 {
		ops = append(ops, Op{Kind: CatchUp})
	}

	if opts.Cancel {
		// Cancel after at least one post-snapshot commit has been applied, so
		// the test exercises interruption of an online build.
		ops = append(ops, Op{Kind: Cancel})
		return Schedule{Seed: seed, Options: opts, Ops: ops}
	}

	ops = append(ops, Op{Kind: Seal}, Op{Kind: Publish})
	return Schedule{Seed: seed, Options: opts, Ops: ops}
}
