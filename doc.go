// Package formal implements a deterministic control component for progressive
// delivery. It compares control and treatment SLIs with sequential tests,
// supports several metrics with a shared false-alarm budget, enforces minimum
// sample sizes, and keeps an executed rollback irreversible when delayed data
// is backfilled.
//
// Evaluate recomputes every statistic from the full retained sample set and
// returns a recommendation. Execute records the action the orchestrator
// actually performed. Once Execute(Rollback) has been called, later backfills
// may update the reported statistics but can never produce ScaleUp again.
package formal
