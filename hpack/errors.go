package hpack

import "fmt"

func compressionError(op, format string, args ...any) error {
	return &CompressionError{Op: op, Err: fmt.Errorf(format, args...)}
}
