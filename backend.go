package formal

import "context"

// ApplyRequest describes one node application.
type ApplyRequest struct {
	PlanID     string
	Generation uint64
	Node       Node
}

// ApplyOutcome is reported by a Backend for exactly one Apply call.
//
// Effected must be true when the provider may have committed a change, even if
// Err is non-nil. Err with Effected=false means the operation failed before it
// took effect and therefore needs no compensation.
type ApplyOutcome struct {
	Effected bool
	Token    any
	Err      error
}

// RollbackRequest asks a Backend to undo an effect previously reported with
// Effected=true. Token is the value returned by that Apply call.
type RollbackRequest struct {
	PlanID     string
	Generation uint64
	Node       Node
	Token      any
}

// Backend is the cloud-provider adapter used by Executor.
//
// Apply must report exactly one outcome through done, either before returning
// or asynchronously afterwards. If Apply itself returns a non-nil error, the
// executor treats the apply as a submission failure with Effected=false and
// does not wait for done. Apply may run concurrently for different nodes and
// must be safe for concurrent use.
//
// Rollback is synchronous and is called only for nodes that reported
// Effected=true and are marked Reversible.
type Backend interface {
	Apply(ctx context.Context, req ApplyRequest, done func(ApplyOutcome)) error
	Rollback(ctx context.Context, req RollbackRequest) error
}
