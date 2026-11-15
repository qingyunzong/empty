// Package dataeng coordinates browser download completion events with files
// being materialized on disk.
//
// A download is registered with its browser download ID, suggested filename
// and temporary path. The completion event may arrive before the browser has
// finished writing the file, so Wait observes the temporary file until its
// length has stopped changing. The file is then hashed, optionally checked
// against an expected SHA-256 digest, and atomically renamed into the
// destination directory. Only after both the digest check and the rename
// succeed does the Coordinator publish an Artifact.
package dataeng
