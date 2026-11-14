package dataeng

import (
	"context"
	"fmt"
	"io"
)

// Upload stores data as a content-addressed immutable object and returns its
// File descriptor without staging it for a commit.
func (w *Writer) Upload(ctx context.Context, path string, data []byte) (File, error) {
	if !validLogicalPath(path) {
		return File{}, fmt.Errorf("%w: invalid logical path %q", ErrInvalidManifest, path)
	}
	digest := Digest(data)
	relative, err := DataObjectKey(digest)
	if err != nil {
		return File{}, err
	}
	key := withPrefix(w.prefix, relative)
	if err := putImmutable(ctx, w.store, key, data); err != nil {
		return File{}, err
	}
	file := File{
		Path:   path,
		Object: relative,
		Digest: digest,
		Size:   int64(len(data)),
	}
	if w.verifyData {
		if _, err := readDataFile(ctx, w.store, w.prefix, file); err != nil {
			return File{}, err
		}
	}
	return file, nil
}

// UploadReader reads r and uploads it as one immutable data object.
func (w *Writer) UploadReader(ctx context.Context, path string, r io.Reader) (File, error) {
	if r == nil {
		return File{}, fmt.Errorf("dataeng: nil reader")
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return File{}, err
	}
	return w.Upload(ctx, path, data)
}

func readDataFile(ctx context.Context, store Store, prefix string, file File) ([]byte, error) {
	if err := validateFile(&file); err != nil {
		return nil, err
	}
	key := withPrefix(prefix, file.Object)
	data, err := store.Get(ctx, key)
	if err != nil {
		if IsNotFound(err) {
			return nil, fmt.Errorf("%w: data object %s", ErrObjectNotFound, key)
		}
		return nil, err
	}
	actual := Digest(data)
	if actual != file.Digest {
		return nil, fmt.Errorf("%w: data object %s has digest %s, expected %s",
			ErrDigestMismatch, key, actual, file.Digest)
	}
	if int64(len(data)) != file.Size {
		return nil, fmt.Errorf("%w: data object %s has size %d, expected %d",
			ErrCorrupt, key, len(data), file.Size)
	}
	return data, nil
}
