package dataeng

import "io"

// readFullAt 从不可变 ReaderAt 的绝对偏移 off 精确读满 len(p) 字节。
// ReaderAt 允许一次调用返回部分字节，因此循环补齐；短读或报错都拒绝。
func readFullAt(r io.ReaderAt, p []byte, off int64) error {
	if off < 0 {
		return io.ErrUnexpectedEOF
	}
	for len(p) > 0 {
		n, err := r.ReadAt(p, off)
		if n > 0 {
			p = p[n:]
			off += int64(n)
		}
		if err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return err
		}
		if n == 0 {
			return io.ErrNoProgress
		}
	}
	return nil
}
