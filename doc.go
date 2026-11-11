// Package q204 implements deterministic de-identification of structured
// telemetry events.
//
// A caller submits a batch of JSON-like events together with a rule tree.
// Rules select values by paths made of literal segments and "*" wildcards.
// Matching rules apply one of three actions: delete, fixed-string replacement,
// or HMAC-SHA256 replacement over the UTF-8 bytes of a string.
//
// Batches resolve one key version when they start. Rotation therefore affects
// only new batches, while retries of an existing batch reuse the original key
// snapshot and reproduce the same output bytes. Revocation clears the local
// key reference and material before notifying the key store, and a revoked
// batch can never be processed again, even if the store's revocation hook
// fails.
//
// The package does not log. Errors may contain field paths and batch identifiers
// but never raw event values.
package q204
