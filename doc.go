// Package dataeng builds leakage-safe, time-ordered train/validation/test
// splits for model-training data.
//
// Records are first collapsed into indivisible blocks using connected
// components of entity and group identifiers. The optimizer then assigns whole
// blocks to splits, enforces that every test timestamp is strictly later than
// every train timestamp, and minimizes the weighted class-proportion deviation
// from a target matrix. Small instances are solved exactly by branch and bound;
// when a node or time budget stops the search, the result contains the best
// incumbent, the best remaining lower bound, and an explicit open-frontier
// proof. Ties are resolved deterministically by the stable block key order.
package dataeng
