package dataeng

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Cache stores verified compressed shard payloads. Entries are keyed by the
// compressed digest, so the same payload is reused even if it appears at a
// different sequence number.
//
// Implementations must make Store atomic: a reader must never observe a
// partially written entry. The consumer treats caches as best-effort: a failed
// Open or Store falls back to downloading, and a cached entry is re-verified
// before use. Open and Store may be called concurrently by different shard
// workers.
type Cache interface {
	Open(ctx context.Context, shard Shard) (r io.ReadCloser, ok bool, err error)
	Store(ctx context.Context, shard Shard, r io.Reader) error
}

// DirCache is a filesystem-backed Cache. Entries are named by digest and
// written with a temporary file followed by an atomic rename.
type DirCache struct {
	Dir string
}

// NewDirCache returns a filesystem cache rooted at dir.
func NewDirCache(dir string) *DirCache {
	return &DirCache{Dir: dir}
}

func (c *DirCache) path(digest string) (string, error) {
	if strings.TrimSpace(c.Dir) == "" {
		return "", errors.New("dataeng: cache directory is empty")
	}
	normalized, err := NormalizeDigest(digest)
	if err != nil {
		return "", err
	}
	name := strings.TrimPrefix(normalized, digestPrefix) + ".shard"
	return filepath.Join(c.Dir, name), nil
}

// Path returns the filesystem path used for a shard digest.
func (c *DirCache) Path(digest string) (string, error) {
	return c.path(digest)
}

// Open implements Cache.
func (c *DirCache) Open(ctx context.Context, shard Shard) (io.ReadCloser, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	path, err := c.path(shard.Digest)
	if err != nil {
		return nil, false, err
	}
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return f, true, nil
}

// Store implements Cache.
func (c *DirCache) Store(ctx context.Context, shard Shard, r io.Reader) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(c.Dir, 0o755); err != nil {
		return err
	}
	path, err := c.path(shard.Digest)
	if err != nil {
		return err
	}

	tmp, err := os.CreateTemp(c.Dir, ".shard-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := io.Copy(tmp, &contextReader{ctx: ctx, r: r}); err != nil {
		return fmt.Errorf("dataeng: write cache entry: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("dataeng: sync cache entry: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		return fmt.Errorf("dataeng: chmod cache entry: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("dataeng: close cache entry: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("dataeng: publish cache entry: %w", err)
	}
	committed = true
	return nil
}
