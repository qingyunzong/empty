package boolcov

import "context"

// Reader resolves a variable by name. It may perform I/O and have side
// effects; the executor guarantees it is only called for variables that
// short-circuit evaluation actually reaches. A Reader may return an error
// or panic; either way, every node whose evaluation had already begun
// remains counted.
type Reader func(name string) (bool, error)

// Executor evaluates boolean ASTs against a coverage table. It is
// stateless beyond the table and safe for concurrent use; share one
// Executor (and its table) across goroutines, or give each goroutine a
// Shard executor and Merge afterwards.
type Executor struct {
	table *Table
}

// NewExecutor returns an executor recording into table. A nil table
// disables recording while keeping identical evaluation semantics.
func NewExecutor(table *Table) *Executor { return &Executor{table: table} }

// Table returns the table this executor records into.
func (e *Executor) Table() *Table { return e.table }

// Shard returns an executor recording into an independent table with the
// same frozen schema. Merge the shard's table back to aggregate.
func (e *Executor) Shard() *Executor {
	if e.table == nil {
		return &Executor{}
	}
	return &Executor{table: e.table.shard()}
}

// Eval evaluates n and returns its boolean value.
//
// Counting contract:
//   - a node is counted the moment its evaluation begins, before any
//     cancellation check, child evaluation, or variable read;
//   - && and || short-circuit: an unreached right operand is never
//     evaluated, never read, and never counted;
//   - errors and panics propagate to the caller, with every node started
//     so far already counted;
//   - if ctx is cancelled, evaluation stops at the next node boundary and
//     returns ctx.Err(); nodes already entered keep their count.
func (e *Executor) Eval(ctx context.Context, n *Node, read Reader) (bool, error) {
	// Count first: a started node is counted even if cancellation,
	// an error, or a panic ends evaluation immediately afterwards.
	if e.table != nil {
		e.table.add(n.ID)
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	switch n.Kind {
	case KindConst:
		return n.Value, nil
	case KindVar:
		return read(n.Name)
	case KindNot:
		v, err := e.Eval(ctx, n.Left, read)
		if err != nil {
			return false, err
		}
		return !v, nil
	case KindAnd:
		l, err := e.Eval(ctx, n.Left, read)
		if err != nil {
			return false, err
		}
		if !l {
			return false, nil // short-circuit: Right untouched
		}
		return e.Eval(ctx, n.Right, read)
	case KindOr:
		l, err := e.Eval(ctx, n.Left, read)
		if err != nil {
			return false, err
		}
		if l {
			return true, nil // short-circuit: Right untouched
		}
		return e.Eval(ctx, n.Right, read)
	default:
		panic("boolcov: unknown node kind")
	}
}
