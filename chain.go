package q210

import (
	"bufio"
	"compress/gzip"
	"compress/zlib"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
)

// MaxLayers bounds the number of content-encoding layers a body may carry.
const MaxLayers = 3

var (
	ErrTooManyLayers = errors.New("q210: encoding chain exceeds three layers")
	ErrBadEncoding   = errors.New("q210: unsupported content encoding")
	ErrLimitExceeded = errors.New("q210: decoded output exceeds the configured byte limit")
	ErrTrailingData  = errors.New("q210: non-padding trailing data after compressed stream")
)

// Store is the sink that receives the fully decoded payload. Commit is
// invoked exactly once, and only after the whole decoding chain has passed.
type Store interface {
	Commit(ctx context.Context, payload []byte) error
}

// Limits bounds decoded output. Layers[i] bounds the bytes produced by
// decoding chain[i]; Total bounds the final fully-decoded payload. A limit
// is inclusive: producing exactly the limit is allowed, one byte more
// terminates decoding.
type Limits struct {
	Layers []int64
	Total  int64
}

// Process decodes body through the given content-encoding chain and commits
// the result to st. The chain lists encodings in application order (as in an
// HTTP Content-Encoding header) and is unwound in reverse. The body is always
// closed, staging is always reclaimed, and st is only touched after every
// layer, checksum, and limit check has passed.
func Process(ctx context.Context, body io.ReadCloser, chain []string, lim Limits, st Store) (err error) {
	defer body.Close()

	if len(chain) == 0 {
		chain = []string{"identity"}
		lim.Layers = []int64{lim.Total}
	}
	if err := validate(chain, lim); err != nil {
		return err
	}

	dir, err := os.MkdirTemp("", "q210-decode-*")
	if err != nil {
		return fmt.Errorf("q210: allocate staging: %w", err)
	}
	defer os.RemoveAll(dir)

	var src io.Reader = body
	for step := len(chain) - 1; step >= 0; step-- {
		if err := ctx.Err(); err != nil {
			return err
		}
		limit := lim.Layers[step]
		if step == 0 && lim.Total < limit {
			limit = lim.Total
		}
		out, err := os.CreateTemp(dir, "layer-*")
		if err != nil {
			return fmt.Errorf("q210: allocate staging: %w", err)
		}
		derr := decodeLayer(ctx, src, chain[step], limit, out)
		if prev, ok := src.(*os.File); ok {
			prev.Close()
		}
		if derr != nil {
			out.Close()
			return derr
		}
		if _, err := out.Seek(0, io.SeekStart); err != nil {
			out.Close()
			return fmt.Errorf("q210: rewind staging: %w", err)
		}
		if step == 0 {
			payload, rerr := io.ReadAll(out)
			out.Close()
			if rerr != nil {
				return fmt.Errorf("q210: read staging: %w", rerr)
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := st.Commit(ctx, payload); err != nil {
				return fmt.Errorf("q210: commit: %w", err)
			}
			return nil
		}
		src = out
	}
	return nil
}

func validate(chain []string, lim Limits) error {
	if len(chain) > MaxLayers {
		return ErrTooManyLayers
	}
	for _, enc := range chain {
		switch enc {
		case "identity", "gzip", "deflate":
		default:
			return fmt.Errorf("%w: %q", ErrBadEncoding, enc)
		}
	}
	if len(lim.Layers) != len(chain) {
		return fmt.Errorf("q210: got %d layer limits for %d encoding layers", len(lim.Layers), len(chain))
	}
	for i, l := range lim.Layers {
		if l < 0 {
			return fmt.Errorf("q210: negative limit for layer %d", i)
		}
	}
	if lim.Total < 0 {
		return errors.New("q210: negative total limit")
	}
	return nil
}

func decodeLayer(ctx context.Context, src io.Reader, enc string, limit int64, dst io.Writer) error {
	lw := &limitWriter{w: dst, left: limit}
	switch enc {
	case "identity":
		return copyCtx(ctx, lw, src)
	case "gzip":
		return decodeGzip(ctx, src, lw)
	case "deflate":
		return decodeDeflate(ctx, src, lw)
	default:
		return fmt.Errorf("%w: %q", ErrBadEncoding, enc)
	}
}

// limitWriter fails as soon as the cumulative output would exceed the limit;
// landing exactly on the limit is allowed.
type limitWriter struct {
	w    io.Writer
	left int64
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > l.left {
		return 0, ErrLimitExceeded
	}
	l.left -= int64(len(p))
	return l.w.Write(p)
}

func copyCtx(ctx context.Context, dst io.Writer, src io.Reader) error {
	buf := make([]byte, 32*1024)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				return nil
			}
			return rerr
		}
	}
}

// decodeGzip decodes one or more concatenated gzip members. Zero padding
// after the final member is tolerated; any other trailing byte is an error.
func decodeGzip(ctx context.Context, src io.Reader, dst io.Writer) error {
	br := bufio.NewReader(src)
	for {
		b, err := br.ReadByte()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if b == 0x00 {
			return requireZeroPadding(br)
		}
		if err := br.UnreadByte(); err != nil {
			return err
		}
		zr, err := gzip.NewReader(br)
		if err != nil {
			return err
		}
		zr.Multistream(false)
		derr := copyCtx(ctx, dst, zr)
		cerr := zr.Close()
		if derr != nil {
			return derr
		}
		if cerr != nil {
			return cerr
		}
	}
}

// decodeDeflate decodes a single zlib-wrapped deflate stream and then
// requires the remaining input to be zero padding only.
func decodeDeflate(ctx context.Context, src io.Reader, dst io.Writer) error {
	br := bufio.NewReader(src)
	zr, err := zlib.NewReader(br)
	if err != nil {
		return err
	}
	derr := copyCtx(ctx, dst, zr)
	cerr := zr.Close()
	if derr != nil {
		return derr
	}
	if cerr != nil {
		return cerr
	}
	return requireZeroPadding(br)
}

func requireZeroPadding(br *bufio.Reader) error {
	for {
		b, err := br.ReadByte()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if b != 0x00 {
			return ErrTrailingData
		}
	}
}
