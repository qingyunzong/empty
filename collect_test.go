package dataeng

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"testing"
)

func digestOf(data []byte) [sha256.Size]byte {
	return sha256.Sum256(data)
}

func buildArchive(t *testing.T, write func(aw *Writer)) []byte {
	t.Helper()
	var buf bytes.Buffer
	aw, err := NewWriter(&buf)
	if err != nil {
		t.Fatalf("NewWriter: %v", err)
	}
	write(aw)
	if err := aw.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return buf.Bytes()
}

func assertNoRejectedData(t *testing.T, result *Result) {
	t.Helper()
	for i, rejected := range result.Rejected {
		if rejected.Member.Data != nil {
			t.Fatalf("Rejected[%d] 保留了正文数据", i)
		}
	}
	for i, skipped := range result.Skipped {
		if skipped.Member.Data != nil {
			t.Fatalf("Skipped[%d] 保留了正文数据", i)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestCollectAcceptsValidMembers(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("a.txt", []byte("hello")))
		must(t, aw.WriteMember("dir/b.txt", []byte("world")))
		must(t, aw.WriteMember("empty", nil))
	})

	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if result.Incomplete {
		t.Fatal("完整归档不应标记为不完整")
	}
	if len(result.Members) != 3 {
		t.Fatalf("期望收录 3 个成员，实际 %d", len(result.Members))
	}

	first := result.Members[0]
	if first.Name != "a.txt" || string(first.Data) != "hello" ||
		first.DeclaredSize != 5 || first.ActualSize != 5 || first.Digest != digestOf([]byte("hello")) {
		t.Fatalf("首个成员元数据异常: %+v", first)
	}
	if result.Members[2].ActualSize != 0 || result.Members[2].Data == nil {
		t.Fatal("零字节成员应被正常收录")
	}
}

func TestCollectSkipsUnsafeNames(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("/absolute", []byte("x")))
		must(t, aw.WriteMember("a/../b", []byte("y")))
		must(t, aw.WriteMember("..", []byte("z")))
		must(t, aw.WriteMember("keep.txt", []byte("ok")))
	})

	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Members) != 1 || result.Members[0].Name != "keep.txt" {
		t.Fatalf("非法名称成员应跳过，实际收录: %+v", result.Members)
	}
	if len(result.Skipped) != 3 {
		t.Fatalf("期望跳过 3 个成员，实际 %d", len(result.Skipped))
	}
	for _, skipped := range result.Skipped {
		if !errors.Is(skipped.Reason, ErrUnsafeName) {
			t.Fatalf("跳过原因应为 ErrUnsafeName，实际 %v", skipped.Reason)
		}
	}
	assertNoRejectedData(t, result)
}

func TestCollectDuplicateSameDigestKeepsFirst(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("dup.txt", []byte("first")))
		must(t, aw.WriteMember("other", []byte("x")))
		must(t, aw.WriteMember("dup.txt", []byte("first")))
	})

	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Members) != 2 {
		t.Fatalf("期望保留 2 个成员，实际 %d", len(result.Members))
	}
	if result.Members[0].Name != "dup.txt" || string(result.Members[0].Data) != "first" {
		t.Fatalf("应保留第一份同名成员，实际 %+v", result.Members[0])
	}
	if len(result.Rejected) != 1 || !errors.Is(result.Rejected[0].Reason, ErrDuplicateName) {
		t.Fatalf("第二份同名成员应以 ErrDuplicateName 拒绝: %+v", result.Rejected)
	}
	assertNoRejectedData(t, result)
}

func TestCollectDuplicateDifferentDigestDropsBoth(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("dup.txt", []byte("first")))
		must(t, aw.WriteMember("dup.txt", []byte("second")))
		must(t, aw.WriteMember("dup.txt", []byte("first")))
		must(t, aw.WriteMember("survivor", []byte("ok")))
	})

	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	for _, member := range result.Members {
		if member.Name == "dup.txt" {
			t.Fatalf("摘要冲突的两份成员都不应保留: %+v", result.Members)
		}
	}
	if len(result.Rejected) != 3 {
		t.Fatalf("期望拒绝 3 个冲突成员，实际 %d", len(result.Rejected))
	}
	for _, rejected := range result.Rejected {
		if !errors.Is(rejected.Reason, ErrConflictingName) {
			t.Fatalf("冲突成员应以 ErrConflictingName 拒绝，实际 %v", rejected.Reason)
		}
	}
	if len(result.Members) != 1 || result.Members[0].Name != "survivor" {
		t.Fatalf("其余成员应继续收录: %+v", result.Members)
	}
	assertNoRejectedData(t, result)
}

func TestCollectDigestMismatchRejectsAndContinues(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		badDigest := digestOf([]byte("not-the-body"))
		must(t, aw.WriteMemberWithDigest("bad", 4, badDigest, []byte("body")))
		must(t, aw.WriteMember("good", []byte("fine")))
	})

	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Members) != 1 || result.Members[0].Name != "good" {
		t.Fatalf("摘要不符成员失败后应继续处理: %+v", result.Members)
	}
	if len(result.Rejected) != 1 || !errors.Is(result.Rejected[0].Reason, ErrDigestMismatch) {
		t.Fatalf("应以 ErrDigestMismatch 拒绝: %+v", result.Rejected)
	}
	rejected := result.Rejected[0].Member
	if rejected.ActualSize != rejected.DeclaredSize || rejected.Data != nil {
		t.Fatalf("失败成员应记录实际字节数且不保留正文: %+v", rejected)
	}
	assertNoRejectedData(t, result)
}

func TestCollectUnexpectedDigestFromCaller(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("a", []byte("actual")))
		must(t, aw.WriteMember("b", []byte("data")))
	})
	expected := map[string][sha256.Size]byte{
		"a": digestOf([]byte("wrong-expectation")),
		"b": digestOf([]byte("data")),
	}

	result, err := Collect(bytes.NewReader(archive), 0, expected)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Members) != 1 || result.Members[0].Name != "b" {
		t.Fatalf("仅期望摘要一致的成员可收录: %+v", result.Members)
	}
	if !errors.Is(result.Rejected[0].Reason, ErrUnexpectedDigest) {
		t.Fatalf("应以 ErrUnexpectedDigest 拒绝: %+v", result.Rejected)
	}
	assertNoRejectedData(t, result)
}

func TestCollectSizeMismatchOnTruncation(t *testing.T) {
	var buf bytes.Buffer
	aw, err := NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	must(t, aw.WriteMember("good", []byte("keep-me")))
	// 声明 10 字节但只写入 5 字节正文，随后归档直接截断。
	must(t, aw.WriteMemberWithDigest("short", 10, digestOf([]byte("12345")), []byte("12345")))

	result, err := Collect(bytes.NewReader(buf.Bytes()), 0, nil)
	if result == nil {
		t.Fatal("截断时应返回已采集结果而不是 nil")
	}
	if !errors.Is(err, ErrIncomplete) || !result.Incomplete {
		t.Fatalf("截断错误应包装 ErrIncomplete 并标记 Incomplete，err=%v incomplete=%v", err, result.Incomplete)
	}
	if len(result.Members) != 1 || result.Members[0].Name != "good" {
		t.Fatalf("截断前已通过的成员应保留: %+v", result.Members)
	}
	if len(result.Rejected) != 1 || !errors.Is(result.Rejected[0].Reason, ErrSizeMismatch) {
		t.Fatalf("短读成员应以 ErrSizeMismatch 失败: %+v", result.Rejected)
	}
	short := result.Rejected[0].Member
	if short.DeclaredSize != 10 || short.ActualSize != 5 || short.Data != nil {
		t.Fatalf("应记录声明/实际字节数且不保留正文: %+v", short)
	}
	assertNoRejectedData(t, result)
}

func TestCollectTruncatedHeaderKeepsAccepted(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("good", []byte("data")))
	})
	// 去掉结束标记及部分字节，模拟成员头中途截断。
	truncated := archive[:len(archive)-2]

	result, err := Collect(bytes.NewReader(truncated), 0, nil)
	if result == nil {
		t.Fatal("截断时应返回已采集结果而不是 nil")
	}
	if !errors.Is(err, ErrIncomplete) || !result.Incomplete {
		t.Fatalf("应返回 ErrIncomplete，实际 %v", err)
	}
	if len(result.Members) != 1 || result.Members[0].Name != "good" {
		t.Fatalf("已通过成员应保留: %+v", result.Members)
	}
}

func TestCollectMemberTooLargeSkipsWithoutReadingBody(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("huge", make([]byte, 10)))
		must(t, aw.WriteMember("small", []byte("ok")))
	})

	// 同时覆盖支持 Seek 与不支持 Seek 两种跳过路径。
	readers := []io.Reader{
		bytes.NewReader(archive),
		&noSeekReader{r: bytes.NewReader(archive)},
	}
	for _, reader := range readers {
		result, err := Collect(reader, 4, nil)
		if err != nil {
			t.Fatalf("Collect: %v", err)
		}
		if len(result.Members) != 1 || result.Members[0].Name != "small" {
			t.Fatalf("超限成员跳过后应继续收录后续成员: %+v", result.Members)
		}
		if len(result.Skipped) != 1 || !errors.Is(result.Skipped[0].Reason, ErrMemberTooLarge) {
			t.Fatalf("超限成员应以 ErrMemberTooLarge 跳过: %+v", result.Skipped)
		}
		if result.Skipped[0].Member.Data != nil {
			t.Fatal("超限成员不应保留任何已读字节")
		}
		assertNoRejectedData(t, result)
	}
}

func TestCollectZeroMeansNoLimit(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {
		must(t, aw.WriteMember("big", make([]byte, 4096)))
	})
	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Members) != 1 || result.Members[0].ActualSize != 4096 {
		t.Fatalf("上限为 0 应视为不限制: %+v", result.Members)
	}
}

func TestCollectTruncationWhileSkippingKeepsAccepted(t *testing.T) {
	var buf bytes.Buffer
	aw, err := NewWriter(&buf)
	if err != nil {
		t.Fatal(err)
	}
	must(t, aw.WriteMember("good", []byte("keep")))
	// 超限成员声明 8 字节但只写入 3 字节正文，归档随即截断。
	must(t, aw.WriteMemberWithDigest("huge", 8, digestOf([]byte("abc")), []byte("abc")))

	result, err := Collect(&noSeekReader{r: bytes.NewReader(buf.Bytes())}, 4, nil)
	if result == nil {
		t.Fatal("截断时应返回已采集结果而不是 nil")
	}
	if !errors.Is(err, ErrIncomplete) || !result.Incomplete {
		t.Fatalf("应返回 ErrIncomplete，实际 %v", err)
	}
	if len(result.Members) != 1 || result.Members[0].Name != "good" {
		t.Fatalf("截断前已通过的成员应保留: %+v", result.Members)
	}
	if len(result.Skipped) != 1 || !errors.Is(result.Skipped[0].Reason, ErrMemberTooLarge) {
		t.Fatalf("超限成员应先计入跳过: %+v", result.Skipped)
	}
}

func TestCollectEmptyArchive(t *testing.T) {
	archive := buildArchive(t, func(aw *Writer) {})
	result, err := Collect(bytes.NewReader(archive), 0, nil)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Members) != 0 || result.Incomplete {
		t.Fatalf("空归档应得到空且完整的结果: %+v", result)
	}
}

func TestCollectBadMagic(t *testing.T) {
	result, err := Collect(bytes.NewReader([]byte("BADARC\n")), 0, nil)
	if !errors.Is(err, ErrBadArchive) || result != nil {
		t.Fatalf("坏归档应返回 ErrBadArchive 和 nil 结果，result=%v err=%v", result, err)
	}
}

func TestUnsafeNameRules(t *testing.T) {
	cases := map[string]bool{
		"/etc/passwd": true,
		"../secret":   true,
		"a/../../b":   true,
		"..":          true,
		"normal.txt":  false,
		"a/b/c":       false,
		"dir/..name":  true,
	}
	for name, want := range cases {
		if got := UnsafeName(name); got != want {
			t.Errorf("UnsafeName(%q) = %v，期望 %v", name, got, want)
		}
	}
}

type noSeekReader struct {
	r io.Reader
}

func (n *noSeekReader) Read(p []byte) (int, error) {
	return n.r.Read(p)
}
