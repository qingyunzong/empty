package fieldsync

import "context"

// Store persists batches under string keys. Reading a missing key returns an
// empty Batch and a zero Receipt with a nil error.
type Store interface {
	Read(ctx context.Context, key string) (Batch, Receipt, error)
	Write(ctx context.Context, key string, b Batch) (Receipt, error)
}
