// Package dataeng reads LDIF-style directory change records without
// connecting to a directory.
//
// Parsing unfolds continuation lines that start with one space or tab and
// decodes double-colon attribute values from base64. Change records may only
// be add, modify, or delete. A malformed record is reported in place and does
// not prevent the following records from being read.
//
// ReadChanges and Process additionally apply records in order to an in-memory
// Directory. Modify operations are applied in sequence, distinguished names
// are compared with the caller's normalization function, and a failing record
// is not committed.
package dataeng
