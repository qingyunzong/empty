// Package formal implements deterministic weighted Dominant Resource
// Fairness (DRF) for multi-resource queues.
//
// Tasks are gang-atomic: a task reserves Demand for all GangSize members at
// once or stays waiting. Queues and tasks may be weighted. Resource shares
// are kept as reduced rational numbers, so admission and preemption
// comparisons never depend on floating-point rounding.
//
// The scheduler also performs resource-conserving preemption. Victims are
// selected in a stable order: largest exact task dominant share first, then
// largest queue share, then submission order. A preempted gang is returned to
// the waiting set as a whole.
package formal
