package logindex

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"
)

// --- reference implementations (naive full scan) ---

// refLines returns the byte ranges of all complete lines in data.
func refLines(data []byte) []Line {
	var lines []Line
	start := 0
	for i, b := range data {
		if b == '\n' {
			lines = append(lines, Line{Offset: int64(start), Length: i + 1 - start})
			start = i + 1
		}
	}
	return lines
}

// refSearch scans all of data (complete lines plus a partial tail line).
func refSearch(data, query []byte) []Hit {
	var hits []Hit
	lineNo, start := 0, 0
	for start < len(data) {
		lineNo++
		n := bytes.IndexByte(data[start:], '\n') + 1
		if n <= 0 {
			n = len(data) - start
		}
		seg := data[start : start+n]
		if bytes.Contains(seg, query) {
			hits = append(hits, Hit{
				Line:   lineNo,
				Offset: int64(start),
				Length: n,
				Text:   string(bytes.TrimSuffix(seg, []byte{'\n'})),
			})
		}
		start += n
	}
	return hits
}

// --- helpers ---

var alphabet = []rune("abXYZ 09消息日志错误é漢字🙂🔥\t")

func randLine(r *rand.Rand, n int) string {
	rs := make([]rune, n)
	for i := range rs {
		rs[i] = alphabet[r.Intn(len(alphabet))]
	}
	return string(rs)
}

// genLog builds a log of nlines lines with variable-length UTF-8 content.
// The final line may lack a trailing newline.
func genLog(r *rand.Rand, nlines int) []byte {
	var buf bytes.Buffer
	for i := 0; i < nlines; i++ {
		fmt.Fprintf(&buf, "2026-10-05T%02d:%02d:%02dZ L%d ", i%24, i%60, i%60, i)
		buf.WriteString(randLine(r, r.Intn(120)))
		if i < nlines-1 || r.Intn(2) == 0 {
			buf.WriteByte('\n')
		}
	}
	return buf.Bytes()
}

func writeFile(t *testing.T, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "test.log")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func appendFile(t *testing.T, path string, data []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
}

func checkAgainstRef(t *testing.T, idx *Index, data []byte) {
	t.Helper()
	want := refLines(data)
	if len(idx.Lines) != len(want) {
		t.Fatalf("line count: got %d, want %d", len(idx.Lines), len(want))
	}
	for i := range want {
		if idx.Lines[i] != want[i] {
			t.Fatalf("line %d: got %+v, want %+v", i, idx.Lines[i], want[i])
		}
	}
	var indexedLen int64
	if len(want) > 0 {
		last := want[len(want)-1]
		indexedLen = last.Offset + int64(last.Length)
	}
	if idx.IndexedLen != indexedLen {
		t.Fatalf("IndexedLen: got %d, want %d", idx.IndexedLen, indexedLen)
	}
	sum := sha256.Sum256(data[:indexedLen])
	if idx.Digest != sum {
		t.Fatal("digest mismatch against sha256 of indexed prefix")
	}
}

// --- tests ---

func TestBuildMatchesFullScan(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for trial := 0; trial < 20; trial++ {
		data := genLog(r, 1+r.Intn(300))
		path := writeFile(t, data)
		idx, err := Build(path)
		if err != nil {
			t.Fatal(err)
		}
		checkAgainstRef(t, idx, data)
	}
}

func TestBuildEdgeCases(t *testing.T) {
	for _, data := range [][]byte{
		{},
		[]byte("no newline at all"),
		[]byte("\n"),
		[]byte("\n\n\n"),
		[]byte("单行日志\n"),
		[]byte("🙂\n\n尾巴无换行"),
	} {
		path := writeFile(t, data)
		idx, err := Build(path)
		if err != nil {
			t.Fatalf("%q: %v", data, err)
		}
		checkAgainstRef(t, idx, data)
	}
}

func TestIncrementalUpdateOnAppend(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	part1 := genLog(r, 100)
	part2 := genLog(r, 80)
	path := writeFile(t, part1)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, path, part2)
	grown, err := Update(path, idx)
	if err != nil {
		t.Fatal(err)
	}
	if !grown {
		t.Fatal("expected index to grow after append")
	}
	full := append(append([]byte{}, part1...), part2...)
	checkAgainstRef(t, idx, full)

	// Idempotent: a second update with no changes reports no growth.
	grown, err = Update(path, idx)
	if err != nil {
		t.Fatal(err)
	}
	if grown {
		t.Fatal("unexpected growth without new data")
	}
}

func TestRandomChunkedAppends(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	full := genLog(r, 500)
	path := writeFile(t, nil)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	var written []byte
	for len(written) < len(full) {
		n := 1 + r.Intn(257)
		if n > len(full)-len(written) {
			n = len(full) - len(written)
		}
		written = append(written, full[len(written):len(written)+n]...)
		appendFile(t, path, full[len(written)-n:len(written)])
		if _, err := Update(path, idx); err != nil {
			t.Fatalf("update after %d bytes: %v", len(written), err)
		}
		// The incrementally maintained index must match a full scan of
		// everything written so far.
		checkAgainstRef(t, idx, written)
	}
	// And it must equal a from-scratch build of the final file.
	fresh, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.IndexedLen != idx.IndexedLen || fresh.Digest != idx.Digest ||
		len(fresh.Lines) != len(idx.Lines) {
		t.Fatal("incremental index differs from fresh build")
	}
}

func TestUpdateRejectsModifiedPrefix(t *testing.T) {
	r := rand.New(rand.NewSource(4))
	data := genLog(r, 50)
	path := writeFile(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	savedDigest := idx.Digest

	// Flip one byte inside the indexed region, keeping the file size.
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	orig := make([]byte, 1)
	if _, err := f.ReadAt(orig, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{orig[0] ^ 0xFF}, 10); err != nil {
		t.Fatal(err)
	}
	f.Close()

	if _, err := Update(path, idx); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("modified prefix: got %v, want ErrSourceChanged", err)
	}
	if idx.Digest != savedDigest {
		t.Fatal("rejected update must not mutate the old index")
	}

	// Search must also refuse to cite positions from the stale index.
	src, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if _, err := Search(src, idx, []byte("L1")); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("search with stale index: got %v, want ErrSourceChanged", err)
	}
}

func TestUpdateRejectsTruncation(t *testing.T) {
	r := rand.New(rand.NewSource(5))
	data := genLog(r, 50)
	path := writeFile(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	if idx.IndexedLen == 0 {
		t.Fatal("test requires a non-empty index")
	}
	if err := os.Truncate(path, idx.IndexedLen/2); err != nil {
		t.Fatal(err)
	}
	if _, err := Update(path, idx); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("truncated source: got %v, want ErrSourceChanged", err)
	}
	src, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if _, err := Search(src, idx, []byte("x")); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("search after truncation: got %v, want ErrSourceChanged", err)
	}
}

func TestSearchMatchesFullScan(t *testing.T) {
	r := rand.New(rand.NewSource(6))
	data := genLog(r, 400)
	path := writeFile(t, nil)
	// Feed the log in random chunks, maintaining the index incrementally.
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	for written := 0; written < len(data); {
		n := 1 + r.Intn(200)
		if n > len(data)-written {
			n = len(data) - written
		}
		appendFile(t, path, data[written:written+n])
		written += n
		if _, err := Update(path, idx); err != nil {
			t.Fatal(err)
		}
	}
	src, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()

	queries := [][]byte{
		[]byte("2026-10-05"), []byte("消息"), []byte("🙂"), []byte("L37 "),
		[]byte("不存在的词"), []byte("a"), []byte("é漢"),
	}
	// Plus random substrings of the source (may cut across runes; both the
	// index search and the reference scan treat the log as bytes).
	for i := 0; i < 60; i++ {
		start := r.Intn(len(data))
		n := 1 + r.Intn(9)
		if start+n > len(data) {
			n = len(data) - start
		}
		queries = append(queries, data[start:start+n])
	}
	for _, q := range queries {
		if bytes.Contains(q, []byte("\n")) {
			continue // cross-line queries are out of scope for line search
		}
		got, err := Search(src, idx, q)
		if err != nil {
			t.Fatalf("search %q: %v", q, err)
		}
		want := refSearch(data, q)
		if len(got) != len(want) {
			t.Fatalf("query %q: got %d hits, want %d", q, len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("query %q hit %d: got %+v, want %+v", q, i, got[i], want[i])
			}
		}
	}
}

func TestSearchSeesUnindexedTail(t *testing.T) {
	path := writeFile(t, []byte("alpha\nbeta\n"))
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	// Append complete and partial lines without updating the index.
	appendFile(t, path, []byte("gamma 消息\ndelta 部分"))
	src, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	for q, wantLines := range map[string][]int{
		"gamma": {3},
		"消息":    {3},
		"部分":    {4},
		"alpha": {1},
	} {
		hits, err := Search(src, idx, []byte(q))
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != len(wantLines) {
			t.Fatalf("query %q: got %d hits, want %d", q, len(hits), len(wantLines))
		}
		for i, ln := range wantLines {
			if hits[i].Line != ln {
				t.Fatalf("query %q: got line %d, want %d", q, hits[i].Line, ln)
			}
		}
	}
}

func TestUTF8LineBoundaries(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	data := genLog(r, 300)
	path := writeFile(t, data)
	if !utf8.Valid(data) {
		t.Fatal("generator produced invalid UTF-8")
	}
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	for i, ln := range idx.Lines {
		seg := data[ln.Offset : ln.Offset+int64(ln.Length)]
		if !utf8.Valid(seg) {
			t.Fatalf("line %d is not valid UTF-8", i)
		}
		if ln.Offset > 0 && !utf8.RuneStart(data[ln.Offset]) {
			t.Fatalf("line %d starts mid-rune at offset %d", i, ln.Offset)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(8))
	data := genLog(r, 100)
	path := writeFile(t, data)
	idx, err := Build(path)
	if err != nil {
		t.Fatal(err)
	}
	ip := path + ".idx"
	if err := Save(idx, ip); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(ip)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.IndexedLen != idx.IndexedLen || loaded.Digest != idx.Digest ||
		len(loaded.Lines) != len(idx.Lines) {
		t.Fatal("round-trip mismatch")
	}
	for i := range idx.Lines {
		if loaded.Lines[i] != idx.Lines[i] {
			t.Fatalf("line %d differs after round-trip", i)
		}
	}
}
