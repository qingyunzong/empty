// Package compaction exposes the root planner under a conventional package
// name. All types and functions are aliases or thin wrappers around
// example.org/dlks/formal/q10175.
package compaction

import (
	formal "example.org/dlks/formal/q10175"
)

type (
	Key         = formal.Key
	File        = formal.File
	Level       = formal.Level
	RunningTask = formal.RunningTask
	State       = formal.State
	Config      = formal.Config
	Plan        = formal.Plan
	Planner     = formal.Planner
)

var (
	ErrInvalidState = formal.ErrInvalidState
	ErrNoPlan       = formal.ErrNoPlan
)

// NewPlanner creates a planner. At most one Config is used.
func NewPlanner(configs ...Config) *Planner {
	return formal.NewPlanner(configs...)
}

// BuildPlan runs a planner with the zero-value configuration.
func BuildPlan(state State) (Plan, error) {
	return formal.BuildPlan(state)
}

// ValidatePlan checks a plan before it is handed to an executor.
func ValidatePlan(state State, cfg Config, plan Plan) error {
	return formal.ValidatePlan(state, cfg, plan)
}
