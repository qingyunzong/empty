// Package formal provides an exact, deterministic compaction planner for an
// LSM storage engine.
//
// A Plan selects a contiguous key range from one source level and the full
// overlap closure in the next level. The planner respects level size pressure,
// byte and file budgets, tombstone safety, and running-task occupancy. Among
// feasible plans it minimizes estimated bytes written, then applies fixed
// tie-break rules documented on Planner.Plan.
//
// State and Config are immutable inputs. Plans can be checked independently
// with ValidatePlan before an executor starts work.
package formal
