package dataeng

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"sync"
)

// Downloader fetches the compressed payload of one shard.
type Downloader interface {
	Download(ctx context.Context, shard Shard) (io.ReadCloser, error)
}

// DownloaderFunc adapts a function to Downloader.
type DownloaderFunc func(ctx context.Context, shard Shard) (io.ReadCloser, error)

// Download implements Downloader.
func (f DownloaderFunc) Download(ctx context.Context, shard Shard) (io.ReadCloser, error) {
	return f(ctx, shard)
}

// Decompressor opens a streaming decompressor. The returned ReadCloser must
// not close the underlying reader.
type Decompressor func(io.Reader) (io.ReadCloser, error)

// GzipDecompressor is the default Decompressor.
func GzipDecompressor(r io.Reader) (io.ReadCloser, error) {
	return gzip.NewReader(r)
}

// Consumer downloads, verifies, and streams sharded NDJSON exports.
//
// A Consumer is safe for concurrent use after configuration; each Open call
// creates an independent Reader.
type Consumer struct {
	Downloader Downloader
	Cache      Cache

	// Concurrency is the maximum number of shards downloaded and verified at
	// once. It defaults to 4.
	Concurrency int
	// Prefetch bounds how many shards may be prepared ahead of the current
	// sequence. It defaults to twice Concurrency and is never less than
	// Concurrency.
	Prefetch int
	// MaxLineBytes is the largest allowed uncompressed line, excluding its
	// trailing newline. It defaults to 16 MiB.
	MaxLineBytes int
	// Decompress defaults to GzipDecompressor.
	Decompress Decompressor
	// TempDir stores verified compressed shards until they are consumed. It
	// defaults to os.TempDir().
	TempDir string
	// OnCacheError observes non-fatal cache failures. Cache errors never fail
	// consumption because the downloader remains authoritative. It may be
	// called concurrently from shard workers.
	OnCacheError func(error)
}

// Record is one decompressed NDJSON line.
//
// Line is zero-based within the shard. Data excludes the trailing LF (and a
// trailing CR when the source used CRLF).
type Record struct {
	Sequence      int64
	Line          int64
	SchemaVersion string
	Data          []byte
}

// Reader streams records in shard sequence order.
type Reader struct {
	pf     *prefetcher
	shards []Shard
	cur    *shardCursor
	next   int

	schema  string
	decomp  Decompressor
	maxLine int
	wm      *Watermark

	closed    bool
	closeOnce sync.Once
	failed    error
}

type shardCursor struct {
	index    int
	shard    Shard
	prepared *preparedShard
	reader   io.ReadCloser
	lines    *lineReader
	line     int64
}

func (c *Consumer) withDefaults() Consumer {
	var out Consumer
	if c != nil {
		out = *c
	}
	if out.Concurrency <= 0 {
		out.Concurrency = 4
	}
	if out.Prefetch <= 0 {
		out.Prefetch = out.Concurrency * 2
	}
	if out.Prefetch < out.Concurrency {
		out.Prefetch = out.Concurrency
	}
	if out.MaxLineBytes <= 0 {
		out.MaxLineBytes = 16 << 20
	}
	if out.Decompress == nil {
		out.Decompress = GzipDecompressor
	}
	if out.TempDir == "" {
		out.TempDir = os.TempDir()
	}
	return out
}

// Open streams the export from its first shard.
func (c *Consumer) Open(ctx context.Context, manifest Manifest) (*Reader, error) {
	normalized, err := manifest.Normalize()
	if err != nil {
		return nil, err
	}
	return c.OpenAt(ctx, normalized, normalized.Start())
}

// OpenAt resumes an export at startSequence, which is normally the watermark
// returned by a previous reader. Shards before startSequence are not read.
// If startSequence is absent, the reader reports a MissingShardError rather
// than skipping ahead.
func (c *Consumer) OpenAt(ctx context.Context, manifest Manifest, startSequence int64) (*Reader, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	normalized, err := manifest.Normalize()
	if err != nil {
		return nil, err
	}
	if len(normalized.Shards) > 0 && startSequence < normalized.Start() {
		return nil, fmt.Errorf("%w: start sequence %d precedes manifest start %d", ErrInvalidManifest, startSequence, normalized.Start())
	}
	if startSequence < 0 {
		return nil, fmt.Errorf("%w: negative start sequence %d", ErrInvalidManifest, startSequence)
	}

	cfg := c.withDefaults()
	if cfg.Downloader == nil {
		return nil, errors.New("dataeng: Downloader is required")
	}

	start := sort.Search(len(normalized.Shards), func(i int) bool {
		return normalized.Shards[i].Sequence >= startSequence
	})
	rctx, cancel := context.WithCancel(ctx)
	r := &Reader{
		shards:  normalized.Shards[start:],
		schema:  normalized.SchemaVersion,
		decomp:  cfg.Decompress,
		maxLine: cfg.MaxLineBytes,
		wm:      NewWatermark(startSequence),
	}
	r.pf = newPrefetcher(rctx, cancel, &cfg, r.shards)
	return r, nil
}

// SchemaVersion returns the global schema version of the export.
func (r *Reader) SchemaVersion() string { return r.schema }

// Watermark returns the first shard sequence that has not been completely
// consumed. It never advances across a missing or failed shard.
func (r *Reader) Watermark() int64 { return r.wm.Value() }

// Next returns the next record, or io.EOF after the last shard.
func (r *Reader) Next() (Record, error) {
	if r.closed {
		return Record{}, ErrClosed
	}
	if r.failed != nil {
		return Record{}, r.failed
	}

	for {
		if r.cur != nil {
			line, err := r.cur.lines.next()
			if err == io.EOF {
				if err := r.finishCurrent(); err != nil {
					r.failed = err
					return Record{}, err
				}
				continue
			}
			if err != nil {
				seq := r.cur.shard.Sequence
				r.abortCurrent()
				r.failed = &ShardError{Sequence: seq, Err: err}
				return Record{}, r.failed
			}
			rec := Record{
				Sequence:      r.cur.shard.Sequence,
				Line:          r.cur.line,
				SchemaVersion: r.cur.shard.SchemaVersion,
				Data:          append([]byte(nil), line...),
			}
			r.cur.line++
			return rec, nil
		}

		if r.next >= len(r.shards) {
			return Record{}, io.EOF
		}
		shard := r.shards[r.next]
		expected := r.wm.Value()
		if shard.Sequence > expected {
			r.failed = &MissingShardError{Sequence: expected}
			return Record{}, r.failed
		}
		if shard.Sequence < expected {
			r.next++
			continue
		}

		idx := r.next
		res, err := r.pf.request(idx)
		if err != nil {
			r.failed = &ShardError{Sequence: shard.Sequence, Err: err}
			return Record{}, r.failed
		}
		if res.err != nil {
			r.pf.release(idx)
			r.failed = res.err
			return Record{}, r.failed
		}
		ps := res.prepared
		if ps == nil {
			r.pf.release(idx)
			r.failed = &ShardError{Sequence: shard.Sequence, Err: errors.New("shard was not prepared")}
			return Record{}, r.failed
		}
		if _, err := ps.file.Seek(0, io.SeekStart); err != nil {
			ps.close()
			r.pf.release(idx)
			r.failed = &ShardError{Sequence: shard.Sequence, Err: err}
			return Record{}, r.failed
		}
		zr, err := r.decomp(ps.file)
		if err != nil {
			ps.close()
			r.pf.release(idx)
			r.failed = &ShardError{Sequence: shard.Sequence, Err: fmt.Errorf("%w: %v", ErrCorruptShard, err)}
			return Record{}, r.failed
		}
		if zr == nil {
			ps.close()
			r.pf.release(idx)
			r.failed = &ShardError{Sequence: shard.Sequence, Err: fmt.Errorf("%w: decompressor returned a nil reader", ErrCorruptShard)}
			return Record{}, r.failed
		}

		r.cur = &shardCursor{
			index:    idx,
			shard:    shard,
			prepared: ps,
			reader:   zr,
			lines:    newLineReader(zr, r.maxLine),
		}
		r.next++
	}
}

func (r *Reader) finishCurrent() error {
	cur := r.cur
	r.cur = nil
	seq := cur.shard.Sequence
	if cur.line != cur.shard.LineCount {
		cur.close()
		r.pf.release(cur.index)
		return &ShardError{
			Sequence: seq,
			Err: fmt.Errorf("%w: manifest=%d, decompressed=%d",
				ErrLineCountMismatch, cur.shard.LineCount, cur.line),
		}
	}
	cur.close()
	r.pf.release(cur.index)
	r.wm.Mark(seq)
	return nil
}

func (r *Reader) abortCurrent() {
	if r.cur == nil {
		return
	}
	r.cur.close()
	r.pf.release(r.cur.index)
	r.cur = nil
}

func (c *shardCursor) close() {
	if c == nil {
		return
	}
	if c.reader != nil {
		_ = c.reader.Close()
		c.reader = nil
	}
	c.prepared.close()
	c.prepared = nil
}

// Close releases staged files and stops outstanding downloads. It is
// idempotent. A partially consumed shard does not advance the watermark.
func (r *Reader) Close() error {
	r.closeOnce.Do(func() {
		r.abortCurrent()
		if r.pf != nil {
			r.pf.Close()
		}
		r.closed = true
	})
	return nil
}

func (c *Consumer) prepareShard(ctx context.Context, shard Shard) (*preparedShard, error) {
	var cacheErr error
	if c.Cache != nil {
		prepared, found, err := c.loadCached(ctx, shard)
		switch {
		case err == nil && found:
			return prepared, nil
		case err != nil:
			cacheErr = err
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	if cacheErr != nil {
		c.reportCacheError(cacheErr)
	}

	body, err := c.Downloader.Download(ctx, shard)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &MissingShardError{Sequence: shard.Sequence, Cause: err}
	}
	if body == nil {
		return nil, &MissingShardError{Sequence: shard.Sequence, Cause: errors.New("downloader returned a nil body")}
	}

	prepared, stageErr := c.stage(ctx, shard, body)
	_ = body.Close()
	if stageErr != nil {
		return nil, &ShardError{Sequence: shard.Sequence, Err: stageErr}
	}

	if c.Cache != nil {
		if _, err := prepared.file.Seek(0, io.SeekStart); err != nil {
			prepared.close()
			return nil, &ShardError{Sequence: shard.Sequence, Err: err}
		}
		storeErr := c.Cache.Store(ctx, shard, io.LimitReader(prepared.file, prepared.size))
		if storeErr != nil {
			c.reportCacheError(storeErr)
		}
		if _, err := prepared.file.Seek(0, io.SeekStart); err != nil {
			prepared.close()
			return nil, &ShardError{Sequence: shard.Sequence, Err: err}
		}
	}
	if err := ctx.Err(); err != nil {
		prepared.close()
		return nil, err
	}
	return prepared, nil
}

func (c *Consumer) loadCached(ctx context.Context, shard Shard) (*preparedShard, bool, error) {
	body, ok, err := c.Cache.Open(ctx, shard)
	if err != nil || !ok {
		return nil, ok, err
	}
	if body == nil {
		return nil, true, errors.New("dataeng: cache returned a nil reader")
	}
	prepared, stageErr := c.stage(ctx, shard, body)
	_ = body.Close()
	if stageErr != nil {
		return nil, true, stageErr
	}
	return prepared, true, nil
}

func (c *Consumer) stage(ctx context.Context, shard Shard, body io.Reader) (*preparedShard, error) {
	f, err := os.CreateTemp(c.TempDir, "dataeng-shard-*.part")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	keep := false
	defer func() {
		if !keep {
			_ = f.Close()
			_ = os.Remove(name)
		}
	}()

	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), &contextReader{ctx: ctx, r: body})
	if err != nil {
		return nil, err
	}
	actual := digestPrefix + hex.EncodeToString(hash.Sum(nil))
	if !digestEqual(actual, shard.Digest) {
		return nil, fmt.Errorf("%w: shard %d: want %s, got %s",
			ErrDigestMismatch, shard.Sequence, shard.Digest, actual)
	}

	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	if err := c.verifyShard(ctx, f, shard); err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}

	keep = true
	return &preparedShard{shard: shard, file: f, size: n}, nil
}

func (c *Consumer) verifyShard(ctx context.Context, r io.Reader, shard Shard) error {
	zr, err := c.Decompress(&contextReader{ctx: ctx, r: r})
	if err != nil {
		return fmt.Errorf("%w: %v", ErrCorruptShard, err)
	}
	if zr == nil {
		return fmt.Errorf("%w: decompressor returned a nil reader", ErrCorruptShard)
	}
	lines := newLineReader(zr, c.MaxLineBytes)

	var count int64
	for {
		_, err := lines.next()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = zr.Close()
			if errors.Is(err, ErrLineTooLong) || errors.Is(err, ErrSplitLine) {
				return fmt.Errorf("%w: shard %d", err, shard.Sequence)
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("%w: shard %d: %v", ErrCorruptShard, shard.Sequence, err)
		}
		count++
		if count > shard.LineCount {
			_ = zr.Close()
			return fmt.Errorf("%w: shard %d: manifest=%d, decompressed more than %d",
				ErrLineCountMismatch, shard.Sequence, shard.LineCount, shard.LineCount)
		}
	}
	if err := zr.Close(); err != nil {
		return fmt.Errorf("%w: shard %d: %v", ErrCorruptShard, shard.Sequence, err)
	}
	if count != shard.LineCount {
		return fmt.Errorf("%w: shard %d: manifest=%d, decompressed=%d",
			ErrLineCountMismatch, shard.Sequence, shard.LineCount, count)
	}
	return nil
}

func (c *Consumer) reportCacheError(err error) {
	if err != nil && c.OnCacheError != nil {
		c.OnCacheError(err)
	}
}
