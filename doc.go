// Package dataeng provides a multipart upload coordinator for the object
// collector. It binds collection sessions, part numbers, ETags and SHA-256
// checksums to the final object generation, detects conflicting re-uploads
// of the same part number, guarantees a single terminal state when complete
// and abort race, and reconciles the local manifest with the remote part
// list of the session's own upload ID during recovery.
package dataeng
