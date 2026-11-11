package q159

import (
	"context"
	"errors"
)

// ErrNoPath is returned when no sequence of edges connects a record's
// source schema to the transformer's current target schema.
var ErrNoPath = errors.New("q159: no transformation path to target schema")

// ErrCycle is returned when updating the graph would introduce a directed
// cycle. The update is rejected atomically and the previous graph is kept.
var ErrCycle = errors.New("q159: cycle detected in transformation graph")

// ErrDuplicateEdge is returned when two edges share the same ID.
var ErrDuplicateEdge = errors.New("q159: duplicate edge ID")

// ErrInvalidEdge is returned when an edge is missing a required field or
// has a non-positive cost.
var ErrInvalidEdge = errors.New("q159: invalid edge")

// SchemaID identifies a field schema. Schemas are the vertices of the
// directed transformation graph.
type SchemaID string

// EdgeID identifies a transformation edge. Edge ID sequences are compared
// lexicographically when two paths have the same total cost.
type EdgeID string

// TransformFn is a caller-supplied pure transformation between two schemas.
// It must not mutate its input; the returned value becomes the record
// payload for the next edge in the path.
type TransformFn func(ctx context.Context, in any) (out any, err error)

// Edge is a directed, schema-to-schema transformation with a positive cost.
type Edge struct {
	ID    EdgeID
	From  SchemaID
	To    SchemaID
	Cost  uint64
	Apply TransformFn
}

// Record carries a payload together with the schema describing it.
type Record struct {
	Schema  SchemaID
	Payload any
}
