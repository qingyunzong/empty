// Package dataeng decodes the shared-string table from the payloads of a BIFF
// SST record and its CONTINUE records. Payload fragments are read as a stream
// with explicit continuation-width markers; they are never concatenated.
package dataeng
