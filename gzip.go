package dataeng

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"io"
)

// DefaultMaxBodyBytes is the default decompressed sitemap body limit (64 MiB).
const DefaultMaxBodyBytes int64 = 64 << 20

// IsGzip reports whether data starts with the gzip magic number.
func IsGzip(data []byte) bool {
	return len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b
}

// ReadAllLimit reads r but fails with ErrBodyTooLarge if more than maxBytes are
// available. A non-positive limit means DefaultMaxBodyBytes.
func ReadAllLimit(r io.Reader, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	limited := io.LimitReader(r, maxBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%w: limit %d bytes", ErrBodyTooLarge, maxBytes)
	}
	return data, nil
}

// Gunzip decompresses a complete gzip stream with a decompressed size limit.
func Gunzip(data []byte, maxBytes int64) ([]byte, error) {
	if !IsGzip(data) {
		return nil, fmt.Errorf("sitemap: not gzip encoded")
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("sitemap: gzip: %w", err)
	}
	defer zr.Close()
	out, err := ReadAllLimit(zr, maxBytes)
	if err != nil {
		return nil, fmt.Errorf("sitemap: gzip: %w", err)
	}
	return out, nil
}

// DecodeBody transparently inflates gzip bodies. The returned body is plain
// XML. Both compressed and decompressed sizes are bounded.
func DecodeBody(data []byte, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	if IsGzip(data) {
		return Gunzip(data, maxBytes)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%w: limit %d bytes", ErrBodyTooLarge, maxBytes)
	}
	return data, nil
}
