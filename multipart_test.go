package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// partSpec 描述夹具中的一个部分。
type partSpec struct {
	headers []Header
	body    []byte
}

// buildMessage 手工编码一条完整的多部分字节流，不依赖 mime/multipart。
func buildMessage(boundary string, parts []partSpec) []byte {
	var b bytes.Buffer
	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("\r\n")
	for i, part := range parts {
		for _, h := range part.headers {
			b.WriteString(h.Name)
			b.WriteString(": ")
			b.WriteString(h.Value)
			b.WriteString("\r\n")
		}
		b.WriteString("\r\n")
		b.Write(part.body)
		b.WriteString("\r\n--")
		b.WriteString(boundary)
		if i == len(parts)-1 {
			b.WriteString("--")
		}
		b.WriteString("\r\n")
	}
	return b.Bytes()
}

// chunkReader 按固定的每次 max 个字节切块返回，模拟分块到达的流。
type chunkReader struct {
	data     []byte
	pos      int
	max      int
	readErrs map[int]error // 在第 n 次 Read 调用时注入错误
	calls    int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if err, ok := c.readErrs[c.calls]; ok {
		c.calls++
		return 0, err
	}
	c.calls++
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	n := c.max
	if n > len(p) {
		n = len(p)
	}
	if n > len(c.data)-c.pos {
		n = len(c.data) - c.pos
	}
	copy(p, c.data[c.pos:c.pos+n])
	c.pos += n
	return n, nil
}

func (c *chunkReader) Close() error { return nil }

func newChunkedReader(data []byte, max int) io.ReadCloser {
	return &chunkReader{data: data, max: max, readErrs: map[int]error{}}
}

// memSink 是基于内存的事务落点，记录提交/撤销调用与暂存内容。
type memSink struct {
	parts       []stagedPart
	committed   bool
	aborted     bool
	beginErrAt  int // 在第 n 个部分 BeginPart 时失败，-1 表示不启用
	writerErrAt int // 在第 n 个部分的写入器上注入错误，-1 表示不启用
	commitErr   error
	abortErr    error
}

type stagedPart struct {
	headers []Header
	body    []byte
	closed  bool
}

type memWriter struct {
	sink  *memSink
	index int
	buf   bytes.Buffer
}

func (w *memWriter) Write(p []byte) (int, error) {
	if w.sink.writerErrAt == w.index {
		return 0, errors.New("injected writer failure")
	}
	return w.buf.Write(p)
}

func (w *memWriter) Close() error {
	w.sink.parts[w.index].body = append(w.sink.parts[w.index].body, w.buf.Bytes()...)
	w.sink.parts[w.index].closed = true
	return nil
}

func (s *memSink) BeginPart(index int, headers []Header) (io.WriteCloser, error) {
	if s.beginErrAt == index {
		return nil, errors.New("injected begin failure")
	}
	cp := make([]Header, len(headers))
	copy(cp, headers)
	s.parts = append(s.parts, stagedPart{headers: cp})
	return &memWriter{sink: s, index: index}, nil
}

func (s *memSink) Commit() error {
	if s.commitErr != nil {
		return s.commitErr
	}
	s.committed = true
	return nil
}

func (s *memSink) Abort() error {
	s.aborted = true
	return s.abortErr
}

var testLimits = Limits{MaxPartBody: 1 << 20, MaxHeaderBytes: 1 << 16}

// TestHappyPathAcrossChunkSizes 用从 1 到 8 的切块宽度反复解析同一消息，
// 覆盖所有分隔符与边界前缀的跨块切分。
func TestHappyPathAcrossChunkSizes(t *testing.T) {
	boundary := "Ab3Z9"
	parts := []partSpec{
		{
			headers: []Header{{Name: "Content-ID", Value: "a-1"}, {Name: "X-Custom", Value: "v"}},
			body:    []byte("hello multipart world"),
		},
		{
			headers: []Header{{Name: "content-id", Value: "a-2"}},
			body:    []byte("second-part-body"),
		},
	}
	msg := buildMessage(boundary, parts)

	for chunk := 1; chunk <= 8; chunk++ {
		t.Run(fmt.Sprintf("chunk=%d", chunk), func(t *testing.T) {
			sink := &memSink{beginErrAt: -1, writerErrAt: -1}
			n, err := Parse(context.Background(), newChunkedReader(msg, chunk), boundary, testLimits, sink)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if n != len(parts) {
				t.Fatalf("parts = %d, want %d", n, len(parts))
			}
			if !sink.committed || sink.aborted {
				t.Fatalf("commit state wrong: committed=%v aborted=%v", sink.committed, sink.aborted)
			}
			for i, want := range parts {
				got := sink.parts[i]
				if !bytes.Equal(got.body, want.body) {
					t.Fatalf("part %d body = %q, want %q", i, got.body, want.body)
				}
				if !got.closed {
					t.Fatalf("part %d writer not closed", i)
				}
				if v, ok := Get(got.headers, "CONTENT-ID"); !ok || v != want.headers[0].Value {
					t.Fatalf("part %d Content-ID lookup failed: %q ok=%v", i, v, ok)
				}
			}
		})
	}
}

// TestEmptyBody 验证空正文部分可以正常解析，且分隔符前的 CRLF 不进正文。
func TestEmptyBody(t *testing.T) {
	boundary := "B"
	parts := []partSpec{
		{headers: []Header{{Name: "Content-ID", Value: "empty"}}, body: nil},
		{headers: nil, body: []byte("after")},
	}
	msg := buildMessage(boundary, parts)
	for chunk := 1; chunk <= 4; chunk++ {
		sink := &memSink{beginErrAt: -1, writerErrAt: -1}
		n, err := Parse(context.Background(), newChunkedReader(msg, chunk), boundary, testLimits, sink)
		if err != nil {
			t.Fatalf("chunk=%d Parse: %v", chunk, err)
		}
		if n != 2 || len(sink.parts[0].body) != 0 {
			t.Fatalf("chunk=%d n=%d firstBody=%q", chunk, n, sink.parts[0].body)
		}
		if string(sink.parts[1].body) != "after" {
			t.Fatalf("second body = %q", sink.parts[1].body)
		}
	}
}

// TestBoundaryPrefixInsideBody 验证正文内的边界前缀、伪结束边界均原样保留，
// 只有完整分隔行才生效。
func TestBoundaryPrefixInsideBody(t *testing.T) {
	boundary := "BX9"
	body := []byte("--BX9\r\ndata\r\n--BX9-\r\n--BX9--x\r\n--BX99\r\nreal-end")
	parts := []partSpec{{headers: []Header{{Name: "Content-ID", Value: "p"}}, body: body}}
	msg := buildMessage(boundary, parts)

	for chunk := 1; chunk <= 6; chunk++ {
		sink := &memSink{beginErrAt: -1, writerErrAt: -1}
		n, err := Parse(context.Background(), newChunkedReader(msg, chunk), boundary, testLimits, sink)
		if err != nil {
			t.Fatalf("chunk=%d Parse: %v", chunk, err)
		}
		if n != 1 || !bytes.Equal(sink.parts[0].body, body) {
			t.Fatalf("chunk=%d body mismatch: %q", chunk, sink.parts[0].body)
		}
	}
}

// TestCRLFBeforeBoundaryNotBody 验证紧邻分隔符的 CRLF 被剥除，
// 而正文内部的 CRLF 完整保留。
func TestCRLFBeforeBoundaryNotBody(t *testing.T) {
	boundary := "qq"
	body := []byte("line1\r\nline2")
	msg := buildMessage(boundary, []partSpec{{body: body}})
	sink := &memSink{beginErrAt: -1, writerErrAt: -1}
	if _, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink); err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !bytes.Equal(sink.parts[0].body, body) {
		t.Fatalf("body = %q want %q", sink.parts[0].body, body)
	}
}

// TestTruncationDoesNotPublish 覆盖多种截断形态，断言全部撤销且不提交。
func TestTruncationDoesNotPublish(t *testing.T) {
	boundary := "ABC"
	full := buildMessage(boundary, []partSpec{
		{headers: []Header{{Name: "Content-ID", Value: "x"}}, body: []byte("payload")},
		{headers: []Header{{Name: "Content-ID", Value: "y"}}, body: []byte("tail")},
	})
	cuts := []int{
		2,                             // 起始边界内部
		len("--" + boundary),          // 缺少起始 CRLF
		len("--"+boundary) + 4,        // 头部中途
		len(full) - 1,                 // 结束分隔行少一个字节
		len(full) - 4,                 // 结束边界不完整
		len(full) - len("--\r\n") - 2, // 第二部分正文后缺少分隔符
	}
	for _, cut := range cuts {
		t.Run(fmt.Sprintf("cut=%d", cut), func(t *testing.T) {
			sink := &memSink{beginErrAt: -1, writerErrAt: -1}
			_, err := Parse(context.Background(), newChunkedReader(full[:cut], 1), boundary, testLimits, sink)
			if !errors.Is(err, ErrTruncated) {
				t.Fatalf("cut=%d err=%v, want ErrTruncated", cut, err)
			}
			if sink.committed || !sink.aborted {
				t.Fatalf("cut=%d committed=%v aborted=%v", cut, sink.committed, sink.aborted)
			}
		})
	}
}

// TestStreamFailureDoesNotPublish 验证读取中途失败时事务被撤销。
func TestStreamFailureDoesNotPublish(t *testing.T) {
	boundary := "ABC"
	msg := buildMessage(boundary, []partSpec{{body: []byte(strings.Repeat("x", 400))}})
	in := &chunkReader{data: msg, max: 1, readErrs: map[int]error{50: errors.New("boom")}}
	sink := &memSink{beginErrAt: -1, writerErrAt: -1}
	_, err := Parse(context.Background(), in, boundary, testLimits, sink)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err=%v, want stream failure", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}

// TestWriterFailureDoesNotPublish 验证暂存写入失败时事务被撤销。
func TestWriterFailureDoesNotPublish(t *testing.T) {
	boundary := "ABC"
	msg := buildMessage(boundary, []partSpec{{body: []byte(strings.Repeat("z", 100))}})
	sink := &memSink{beginErrAt: -1, writerErrAt: 0}
	_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
	if err == nil || !strings.Contains(err.Error(), "writer failure") {
		t.Fatalf("err=%v", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}

// TestBeginFailureDoesNotPublish 验证开启部分失败时事务被撤销。
func TestBeginFailureDoesNotPublish(t *testing.T) {
	boundary := "ABC"
	msg := buildMessage(boundary, []partSpec{{body: []byte("x")}, {body: []byte("y")}})
	sink := &memSink{beginErrAt: 1, writerErrAt: -1}
	_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
	if err == nil || !strings.Contains(err.Error(), "begin failure") {
		t.Fatalf("err=%v", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}

// TestLimits 验证头部与正文超限均被拒绝且撤销。
func TestLimits(t *testing.T) {
	boundary := "L"
	msg := buildMessage(boundary, []partSpec{
		{headers: []Header{{Name: "Content-ID", Value: "id"}, {Name: "Big", Value: "vv"}}, body: []byte("12345")},
	})

	t.Run("body limit", func(t *testing.T) {
		sink := &memSink{beginErrAt: -1, writerErrAt: -1}
		_, err := Parse(context.Background(), newChunkedReader(msg, 2), boundary,
			Limits{MaxPartBody: 4, MaxHeaderBytes: 1 << 16}, sink)
		if !errors.Is(err, ErrLimitExceeded) {
			t.Fatalf("err=%v want ErrLimitExceeded", err)
		}
		if sink.committed || !sink.aborted {
			t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
		}
	})

	t.Run("header limit", func(t *testing.T) {
		sink := &memSink{beginErrAt: -1, writerErrAt: -1}
		_, err := Parse(context.Background(), newChunkedReader(msg, 2), boundary,
			Limits{MaxPartBody: 1 << 20, MaxHeaderBytes: 8}, sink)
		if !errors.Is(err, ErrLimitExceeded) {
			t.Fatalf("err=%v want ErrLimitExceeded", err)
		}
		if sink.committed || !sink.aborted {
			t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
		}
	})
}

// TestDuplicateContentID 验证重复 Content-ID 被拒绝且事务撤销。
func TestDuplicateContentID(t *testing.T) {
	boundary := "D"
	msg := buildMessage(boundary, []partSpec{
		{headers: []Header{{Name: "Content-ID", Value: "same"}}, body: []byte("a")},
		{headers: []Header{{Name: "CONTENT-ID", Value: "same"}}, body: []byte("b")},
	})
	sink := &memSink{beginErrAt: -1, writerErrAt: -1}
	_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
	if !errors.Is(err, ErrDuplicateContentID) {
		t.Fatalf("err=%v want ErrDuplicateContentID", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}

// TestMalformedHeaders 覆盖头部语法的各种非法形态。
func TestMalformedHeaders(t *testing.T) {
	boundary := "D"
	cases := map[string][]byte{
		"bad name char":   []byte("--D\r\nBad_Header: v\r\n\r\nx\r\n--D--\r\n"),
		"missing space":   []byte("--D\r\nName:v\r\n\r\nx\r\n--D--\r\n"),
		"bare lf":         []byte("--D\r\nName: v\n\r\nx\r\n--D--\r\n"),
		"non ascii value": []byte("--D\r\nName: v\xff\r\n\r\nx\r\n--D--\r\n"),
		"no colon":        []byte("--D\r\nNameValue\r\n\r\nx\r\n--D--\r\n"),
		"empty name":      []byte("--D\r\n: value\r\n\r\nx\r\n--D--\r\n"),
	}
	for name, msg := range cases {
		t.Run(name, func(t *testing.T) {
			sink := &memSink{beginErrAt: -1, writerErrAt: -1}
			_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
			if !errors.Is(err, ErrMalformed) {
				t.Fatalf("err=%v want ErrMalformed", err)
			}
			if sink.committed || !sink.aborted {
				t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
			}
		})
	}
}

// TestTrailingData 验证结束分隔行之后出现任何字节都被拒绝。
func TestTrailingData(t *testing.T) {
	boundary := "D"
	msg := append(buildMessage(boundary, []partSpec{{body: []byte("x")}}), 'x')
	sink := &memSink{beginErrAt: -1, writerErrAt: -1}
	_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
	if !errors.Is(err, ErrMalformed) {
		t.Fatalf("err=%v want ErrMalformed", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}

// TestBadOpening 验证输入未以 --B+CRLF 起始时被拒绝。
func TestBadOpening(t *testing.T) {
	boundary := "D"
	msg := []byte("pre\r\n--D\r\n\r\nx\r\n--D--\r\n")
	sink := &memSink{beginErrAt: -1, writerErrAt: -1}
	_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
	if !errors.Is(err, ErrMalformed) {
		t.Fatalf("err=%v want ErrMalformed", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}

// TestInvalidBoundary 验证边界参数校验。
func TestInvalidBoundary(t *testing.T) {
	for _, b := range []string{"", "has space", "under_score", "dash-ok!"} {
		sink := &memSink{beginErrAt: -1, writerErrAt: -1}
		_, err := Parse(context.Background(), newChunkedReader(nil, 1), b, testLimits, sink)
		if !errors.Is(err, ErrInvalidBoundary) {
			t.Fatalf("boundary=%q err=%v want ErrInvalidBoundary", b, err)
		}
	}
}

// blockingReader 在读到第 threshold 次后阻塞，直到被 Close 解除。
type blockingReader struct {
	data      []byte
	pos       int
	threshold int
	closed    chan struct{}
	closeOnce sync.Once
}

func (r *blockingReader) Read(p []byte) (int, error) {
	if r.pos >= r.threshold {
		select {
		case <-r.closed:
			return 0, errors.New("reader closed")
		}
	}
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

func (r *blockingReader) Close() error {
	r.closeOnce.Do(func() { close(r.closed) })
	return nil
}

// TestCancellationClosesInput 验证取消时关闭输入、撤销事务并返回 ctx 错误。
func TestCancellationClosesInput(t *testing.T) {
	boundary := "D"
	msg := buildMessage(boundary, []partSpec{{body: []byte(strings.Repeat("x", 50))}})
	in := &blockingReader{data: msg, threshold: 10, closed: make(chan struct{})}
	sink := &memSink{beginErrAt: -1, writerErrAt: -1}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var n int
	var err error
	go func() {
		n, err = Parse(ctx, in, boundary, testLimits, sink)
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Parse did not return after cancellation")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v want context.Canceled", err)
	}
	if n != 0 || sink.committed || !sink.aborted {
		t.Fatalf("n=%d committed=%v aborted=%v", n, sink.committed, sink.aborted)
	}
	select {
	case <-in.closed:
	default:
		t.Fatal("input was not closed on cancellation")
	}
}

// TestCommitFailureAborts 验证提交失败时仍会撤销事务。
func TestCommitFailureAborts(t *testing.T) {
	boundary := "D"
	msg := buildMessage(boundary, []partSpec{{body: []byte("x")}})
	sink := &memSink{beginErrAt: -1, writerErrAt: -1, commitErr: errors.New("commit boom")}
	_, err := Parse(context.Background(), newChunkedReader(msg, 1), boundary, testLimits, sink)
	if err == nil || !strings.Contains(err.Error(), "commit boom") {
		t.Fatalf("err=%v", err)
	}
	if sink.committed || !sink.aborted {
		t.Fatalf("committed=%v aborted=%v", sink.committed, sink.aborted)
	}
}
