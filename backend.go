package dataeng

import "context"

// RemotePart is a part as listed by the remote backend for a specific
// upload ID.
type RemotePart struct {
	Number int
	ETag   string
	Size   int64
}

// PartRef references a part by number and ETag in a complete request.
type PartRef struct {
	Number int
	ETag   string
}

// ObjectInfo describes a committed object generation.
type ObjectInfo struct {
	Key        string
	Generation int64
	ETag       string
	Size       int64
}

// Backend abstracts the remote object store. Implementations must scope
// every operation to the given upload ID: ListParts and CompleteUpload must
// never expose or accept parts belonging to a different upload ID, even for
// the same object key.
type Backend interface {
	// InitiateUpload starts a multipart upload for key and returns its
	// remote upload ID.
	InitiateUpload(ctx context.Context, key string) (uploadID string, err error)
	// UploadPart stores one part and returns its ETag.
	UploadPart(ctx context.Context, key, uploadID string, number int, body []byte) (etag string, err error)
	// ListParts returns the parts currently stored under uploadID, and only
	// those parts.
	ListParts(ctx context.Context, key, uploadID string) ([]RemotePart, error)
	// CompleteUpload assembles the referenced parts into a new object
	// generation. Parts must be ascending by number.
	CompleteUpload(ctx context.Context, key, uploadID string, parts []PartRef) (ObjectInfo, error)
	// AbortUpload discards the upload and all of its parts.
	AbortUpload(ctx context.Context, key, uploadID string) error
}
