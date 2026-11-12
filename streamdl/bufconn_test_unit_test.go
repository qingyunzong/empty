package streamdl

import (
	"io"
	"testing"
)

// TestBufferedPipeDataBeforeClose verifies bytes written before a close are
// fully delivered, after which reads report EOF.
func TestBufferedPipeDataBeforeClose(t *testing.T) {
	a, b := bufferedPipe()
	if _, err := a.Write([]byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := b.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	buf := make([]byte, 16)
	n, err := io.ReadFull(b, buf[:5])
	if err != nil || n != 5 || string(buf[:5]) != "hello" {
		t.Fatalf("buffered read n=%d err=%v", n, err)
	}
	if _, err := b.Read(buf); err == nil {
		t.Fatalf("expected a terminal read error after drain and close")
	}
}

// TestBufferedPipeHalfClose verifies the write half-close signals EOF to the
// peer without tearing down the whole connection.
func TestBufferedPipeHalfClose(t *testing.T) {
	a, b := bufferedPipe()
	go func() {
		_, _ = a.Write([]byte("abc"))
		_ = a.(*pipeConn).CloseWrite()
	}()
	buf := make([]byte, 16)
	n, err := b.Read(buf)
	if err != nil || string(buf[:n]) != "abc" {
		t.Fatalf("first read n=%d err=%v", n, err)
	}
	if _, err := b.Read(buf); err != io.EOF {
		t.Fatalf("expected EOF, got %v", err)
	}
}
