package synclib

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned by Store.Read when the ID has no visible record.
var ErrNotFound = errors.New("synclib: record not found")

// Receipt is the acknowledgement of a write, kept on verification failure.
type Receipt struct {
	ID        string
	Version   uint64
	WrittenAt time.Time
}

// Store is the minimal storage contract the Syncer relies on.
type Store interface {
	// Write persists the record and returns its receipt.
	Write(ctx context.Context, rec Record) (Receipt, error)
	// Read returns the currently visible record and the receipt of the
	// write that produced it, or ErrNotFound.
	Read(ctx context.Context, id string) (Record, Receipt, error)
}
