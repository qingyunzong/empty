package formal_test

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	formal "example.org/dlks/formal/q10094"
)

type fakeClock struct {
	t time.Time
}

func (c *fakeClock) Now() time.Time          { return c.t }
func (c *fakeClock) Advance(d time.Duration) { c.t = c.t.Add(d) }

func gzipBytes(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	if _, err := gz.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func gunzip(t *testing.T, data []byte) []byte {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return out
}

// ---------------------------------------------------------------------------
// Naive file-table model

type modelSegment struct {
	data       []byte
	diskSize   int64
	compressed bool
}

type naiveModel struct {
	cfg      formal.Config
	clock    *fakeClock
	active   []byte
	openedAt time.Time
	backups  []modelSegment
}

func newNaiveModel(cfg formal.Config, clock *fakeClock) *naiveModel {
	return &naiveModel{cfg: cfg, clock: clock, openedAt: clock.Now()}
}

func (m *naiveModel) usage() int64 {
	u := int64(len(m.active))
	for _, b := range m.backups {
		u += b.diskSize
	}
	return u
}

func (m *naiveModel) write(t *testing.T, p []byte) error {
	t.Helper()
	if len(p) == 0 {
		return nil
	}
	now := m.clock.Now()
	if m.mustRotate(len(p), now) {
		m.rotate(t)
	} else if len(m.active) == 0 && m.cfg.MaxAge > 0 &&
		now.Sub(m.openedAt) >= m.cfg.MaxAge {
		m.openedAt = now
	}
	if m.cfg.MaxTotalBytes > 0 &&
		int64(len(p)) > m.cfg.MaxTotalBytes-m.usage() {
		return formal.ErrDiskFull
	}
	m.active = append(m.active, p...)
	return nil
}

func (m *naiveModel) mustRotate(n int, now time.Time) bool {
	if len(m.active) == 0 {
		return false
	}
	if m.cfg.MaxSize > 0 && int64(n) > m.cfg.MaxSize-int64(len(m.active)) {
		return true
	}
	return m.cfg.MaxAge > 0 && now.Sub(m.openedAt) >= m.cfg.MaxAge
}

func (m *naiveModel) rotate(t *testing.T) {
	t.Helper()
	if len(m.active) == 0 {
		return
	}
	rawSize := int64(len(m.active))
	seg := modelSegment{
		data:     append([]byte(nil), m.active...),
		diskSize: rawSize,
	}
	m.backups = append(m.backups, seg)
	m.active = nil
	m.openedAt = m.clock.Now()

	// The real writer compresses the new backup before applying retention.
	if m.cfg.Compress {
		gzSize := int64(len(gzipBytes(t, seg.data)))
		newUsage := m.usage() - rawSize + gzSize
		if m.cfg.MaxTotalBytes == 0 || newUsage <= m.cfg.MaxTotalBytes {
			m.backups[len(m.backups)-1].diskSize = gzSize
			m.backups[len(m.backups)-1].compressed = true
		}
	}
	for len(m.backups) > m.cfg.MaxBackups {
		m.backups = m.backups[1:]
	}
}

func (m *naiveModel) manualRotate(t *testing.T) {
	t.Helper()
	m.rotate(t)
}

type actualFile struct {
	name       string
	size       int64
	compressed bool
	data       []byte
	seq        uint64
}

func scanActual(t *testing.T, dir, base string) ([]byte, []actualFile, int64) {
	t.Helper()
	active, err := os.ReadFile(filepath.Join(dir, base))
	if err != nil {
		t.Fatalf("read active: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	prefix := base + "."
	var files []actualFile
	var total int64 = int64(len(active))
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		if name == base {
			continue
		}
		if !strings.HasPrefix(name, prefix) {
			t.Fatalf("unexpected file %q", name)
		}
		rest := strings.TrimPrefix(name, prefix)
		compressed := false
		switch {
		case strings.HasSuffix(rest, ".log.gz"):
			rest = strings.TrimSuffix(rest, ".log.gz")
			compressed = true
		case strings.HasSuffix(rest, ".log"):
			rest = strings.TrimSuffix(rest, ".log")
		default:
			t.Fatalf("unexpected file suffix %q", name)
		}
		parts := strings.Split(rest, ".")
		if len(parts) != 2 {
			t.Fatalf("unexpected backup name %q", name)
		}
		seq, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil {
			t.Fatalf("bad sequence in %q: %v", name, err)
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		data := raw
		if compressed {
			data = gunzip(t, raw)
		}
		info, err := ent.Info()
		if err != nil {
			t.Fatal(err)
		}
		total += info.Size()
		files = append(files, actualFile{
			name:       name,
			size:       info.Size(),
			compressed: compressed,
			data:       data,
			seq:        seq,
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].seq < files[j].seq })
	return active, files, total
}

func compareWithModel(t *testing.T, dir string, w *formal.Writer, m *naiveModel) {
	t.Helper()
	active, files, total := scanActual(t, dir, m.cfg.BaseName)
	if !bytes.Equal(active, m.active) {
		t.Fatalf("active content mismatch: got %q want %q", active, m.active)
	}
	if len(files) != len(m.backups) {
		t.Fatalf("backup count mismatch: got %d want %d", len(files), len(m.backups))
	}
	for i := range files {
		got, want := files[i], m.backups[i]
		if got.compressed != want.compressed {
			t.Fatalf("backup %d compressed=%v want %v", i, got.compressed, want.compressed)
		}
		if got.size != want.diskSize {
			t.Fatalf("backup %d size=%d want %d", i, got.size, want.diskSize)
		}
		if !bytes.Equal(got.data, want.data) {
			t.Fatalf("backup %d content mismatch: got %q want %q", i, got.data, want.data)
		}
	}
	if total != m.usage() {
		t.Fatalf("disk usage=%d want %d", total, m.usage())
	}
	stats := w.Stats()
	if stats.Usage != total {
		t.Fatalf("Stats.Usage=%d want %d", stats.Usage, total)
	}
	if stats.ActiveSize != int64(len(m.active)) {
		t.Fatalf("Stats.ActiveSize=%d want %d", stats.ActiveSize, len(m.active))
	}
	if stats.Backups != len(m.backups) {
		t.Fatalf("Stats.Backups=%d want %d", stats.Backups, len(m.backups))
	}
	if stats.MaintenanceError != nil {
		t.Fatalf("unexpected maintenance error: %v", stats.MaintenanceError)
	}
}

// ---------------------------------------------------------------------------
// Exhaustive event-sequence check

type testEvent struct {
	kind byte // 'w', 't', or 'r'
	n    int  // write bytes or milliseconds
}

func (e testEvent) String() string {
	switch e.kind {
	case 'w':
		return fmt.Sprintf("W%d", e.n)
	case 't':
		return fmt.Sprintf("T%d", e.n)
	default:
		return "R"
	}
}

type sequenceCase struct {
	name     string
	cfg      formal.Config
	alphabet []testEvent
	depth    int
}

func TestExhaustiveEventSequencesAgainstNaiveModel(t *testing.T) {
	base := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	cases := []sequenceCase{
		{
			name: "size",
			cfg: formal.Config{
				MaxSize:    5,
				MaxBackups: 2,
			},
			alphabet: []testEvent{
				{kind: 'w', n: 1}, {kind: 'w', n: 2}, {kind: 'w', n: 4},
				{kind: 'w', n: 9}, {kind: 'r'},
			},
			depth: 4,
		},
		{
			name: "age",
			cfg: formal.Config{
				MaxAge:     2 * time.Second,
				MaxBackups: 1,
			},
			alphabet: []testEvent{
				{kind: 'w', n: 2}, {kind: 'w', n: 5}, {kind: 't', n: 1000},
				{kind: 't', n: 2000}, {kind: 'r'},
			},
			depth: 4,
		},
		{
			name: "size_and_age_compressed",
			cfg: formal.Config{
				MaxSize:    7,
				MaxAge:     3 * time.Second,
				MaxBackups: 2,
				Compress:   true,
			},
			alphabet: []testEvent{
				{kind: 'w', n: 1}, {kind: 'w', n: 3}, {kind: 'w', n: 8},
				{kind: 't', n: 2000}, {kind: 'r'},
			},
			depth: 4,
		},
		{
			name: "budget_compressed",
			cfg: formal.Config{
				MaxSize:       4,
				MaxBackups:    3,
				Compress:      true,
				MaxTotalBytes: 40,
			},
			alphabet: []testEvent{
				{kind: 'w', n: 1}, {kind: 'w', n: 2}, {kind: 'w', n: 5},
				{kind: 't', n: 1000}, {kind: 'r'},
			},
			depth: 4,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runExhaustive(t, base, tc)
		})
	}
}

func runExhaustive(t *testing.T, base time.Time, tc sequenceCase) {
	t.Helper()
	root := t.TempDir()
	seq := make([]testEvent, 0, tc.depth)
	runs := 0

	var walk func()
	walk = func() {
		if len(seq) == tc.depth {
			runs++
			dir := filepath.Join(root, strconv.Itoa(runs))
			runOneSequence(t, dir, base, tc.cfg, seq)
			return
		}
		for _, ev := range tc.alphabet {
			seq = append(seq, ev)
			walk()
			seq = seq[:len(seq)-1]
		}
	}
	walk()
	t.Logf("checked %d event sequences", runs)
}

func runOneSequence(t *testing.T, dir string, base time.Time, cfg formal.Config, events []testEvent) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	clock := &fakeClock{t: base}
	cfg.Dir = dir
	cfg.BaseName = "app.log"
	cfg.Now = clock.Now

	w, err := formal.NewWriter(cfg)
	if err != nil {
		t.Fatalf("%v: NewWriter: %v", eventPath(events), err)
	}
	m := newNaiveModel(cfg, clock)
	payloadID := 0
	for i, ev := range events {
		switch ev.kind {
		case 'w':
			payloadID++
			p := bytes.Repeat([]byte{byte(payloadID%251 + 1)}, ev.n)
			wantErr := m.write(t, p)
			n, gotErr := w.Write(p)
			if !errors.Is(gotErr, wantErr) {
				t.Fatalf("%s at %d: Write error %v want %v", eventPath(events), i, gotErr, wantErr)
			}
			if wantErr == nil && n != len(p) {
				t.Fatalf("%s at %d: short write %d/%d", eventPath(events), i, n, len(p))
			}
			if wantErr != nil && n != 0 {
				t.Fatalf("%s at %d: failed write consumed %d bytes", eventPath(events), i, n)
			}
		case 't':
			clock.Advance(time.Duration(ev.n) * time.Millisecond)
		case 'r':
			m.manualRotate(t)
			if err := w.Rotate(); err != nil {
				t.Fatalf("%s at %d: Rotate: %v", eventPath(events), i, err)
			}
		}
		compareWithModel(t, dir, w, m)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("%s: Close: %v", eventPath(events), err)
	}
	compareWithModel(t, dir, w, m)
}

func TestDeterministicRandomLongSequences(t *testing.T) {
	base := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	cfg := formal.Config{
		MaxSize:       6,
		MaxAge:        3 * time.Second,
		MaxBackups:    3,
		Compress:      true,
		MaxTotalBytes: 60,
	}
	alphabet := []testEvent{
		{kind: 'w', n: 1}, {kind: 'w', n: 2}, {kind: 'w', n: 4},
		{kind: 'w', n: 7}, {kind: 'w', n: 13},
		{kind: 't', n: 1000}, {kind: 't', n: 3000}, {kind: 'r'},
	}
	root := t.TempDir()
	for seed := int64(0); seed < 100; seed++ {
		rng := rand.New(rand.NewSource(seed))
		events := make([]testEvent, 40)
		for i := range events {
			events[i] = alphabet[rng.Intn(len(alphabet))]
		}
		dir := filepath.Join(root, fmt.Sprintf("seed-%03d", seed))
		runOneSequence(t, dir, base, cfg, events)
	}
}

func eventPath(events []testEvent) string {
	parts := make([]string, len(events))
	for i, e := range events {
		parts[i] = e.String()
	}
	return strings.Join(parts, ",")
}

// ---------------------------------------------------------------------------
// Boundary and policy tests

func newWriter(t *testing.T, cfg formal.Config, clock *fakeClock) (*formal.Writer, string) {
	t.Helper()
	dir := t.TempDir()
	cfg.Dir = dir
	if cfg.BaseName == "" {
		cfg.BaseName = "app.log"
	}
	if clock != nil {
		cfg.Now = clock.Now
	}
	w, err := formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return w, dir
}

func TestSizeBoundaryIsClosedAtCapacity(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxSize: 4, MaxBackups: 10}, clock)
	defer w.Close()

	mustWrite(t, w, "abc")
	mustWrite(t, w, "d") // exactly MaxSize: no rotation
	if got := readActive(t, dir); string(got) != "abcd" {
		t.Fatalf("active=%q", got)
	}
	mustWrite(t, w, "e") // one byte over: rotate first
	assertBackupData(t, dir, []string{"abcd"})
	if got := readActive(t, dir); string(got) != "e" {
		t.Fatalf("active=%q", got)
	}
	mustWrite(t, w, "fgh")
	mustWrite(t, w, "i")
	assertBackupData(t, dir, []string{"abcd", "efgh"})
	if got := readActive(t, dir); string(got) != "i" {
		t.Fatalf("active=%q", got)
	}
}

func TestAgeBoundaryIsClosedAtMaxAge(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxAge: time.Second, MaxBackups: 10}, clock)
	defer w.Close()

	mustWrite(t, w, "a")
	clock.Advance(time.Second - time.Nanosecond)
	mustWrite(t, w, "b")
	if got := readActive(t, dir); string(got) != "ab" {
		t.Fatalf("before boundary active=%q", got)
	}

	clock.Advance(time.Nanosecond) // exactly MaxAge
	mustWrite(t, w, "c")
	assertBackupData(t, dir, []string{"ab"})
	if got := readActive(t, dir); string(got) != "c" {
		t.Fatalf("at boundary active=%q", got)
	}

	clock.Advance(time.Second - time.Nanosecond)
	mustWrite(t, w, "d")
	mustWrite(t, w, "e")
	if got := readActive(t, dir); string(got) != "cde" {
		t.Fatalf("second segment active=%q", got)
	}
}

func TestEmptyWritesNeverRotate(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxAge: time.Second, MaxBackups: 10}, clock)
	defer w.Close()

	clock.Advance(10 * time.Second)
	mustWrite(t, w, "")
	if _, err := os.Stat(filepath.Join(dir, "app.log")); err != nil {
		t.Fatal(err)
	}
	if got := countBackups(t, dir); got != 0 {
		t.Fatalf("empty write created %d backups", got)
	}
	mustWrite(t, w, "x")
	if got := countBackups(t, dir); got != 0 {
		t.Fatalf("first non-empty write into empty old segment created %d backups", got)
	}
}

func TestOversizedSingleWrite(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxSize: 3, MaxBackups: 10}, clock)
	defer w.Close()

	mustWrite(t, w, "12345")
	if got := countBackups(t, dir); got != 0 {
		t.Fatalf("oversized first write rotated %d times", got)
	}
	mustWrite(t, w, "6")
	assertBackupData(t, dir, []string{"12345"})
}

func TestRetentionKeepsOnlyNewestBackups(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxSize: 2, MaxBackups: 2}, clock)
	defer w.Close()

	for _, s := range []string{"aa", "bb", "cc", "dd"} {
		mustWrite(t, w, s)
	}
	assertBackupData(t, dir, []string{"bb", "cc"})
	if got := readActive(t, dir); string(got) != "dd" {
		t.Fatalf("active=%q", got)
	}
}

func TestZeroRetentionDeletesAllBackups(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxSize: 2, MaxBackups: 0}, clock)
	defer w.Close()

	mustWrite(t, w, "aa")
	mustWrite(t, w, "bb")
	if got := countBackups(t, dir); got != 0 {
		t.Fatalf("backups=%d", got)
	}
	if got := readActive(t, dir); string(got) != "bb" {
		t.Fatalf("active=%q", got)
	}
}

func TestCompressionConservesBytesAndContent(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{
		MaxSize:    40,
		MaxBackups: 10,
		Compress:   true,
	}, clock)
	defer w.Close()

	inputs := []string{
		strings.Repeat("alpha-", 100),
		strings.Repeat("bravo-", 100),
		strings.Repeat("charlie-", 100),
	}
	for _, s := range inputs {
		mustWrite(t, w, s)
	}
	// Rotate the last segment too, so every input is a compressed backup.
	if err := w.Rotate(); err != nil {
		t.Fatal(err)
	}

	_, files, total := scanActual(t, dir, "app.log")
	if len(files) != len(inputs) {
		t.Fatalf("backups=%d want %d", len(files), len(inputs))
	}
	var got []string
	for i, f := range files {
		if !f.compressed {
			t.Fatalf("backup %d is not compressed", i)
		}
		got = append(got, string(f.data))
	}
	if strings.Join(got, "|") != strings.Join(inputs, "|") {
		t.Fatalf("backup contents=%q want %q", got, inputs)
	}

	stats := w.Stats()
	if stats.Usage != total {
		t.Fatalf("Stats.Usage=%d actual=%d", stats.Usage, total)
	}
	if stats.CompressedBackups != len(inputs) {
		t.Fatalf("compressed backups=%d", stats.CompressedBackups)
	}
}

func TestDiskBudgetStopsWritesWithoutOverwriting(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{
		MaxSize:       10,
		MaxBackups:    10,
		MaxTotalBytes: 8,
	}, clock)
	defer w.Close()

	mustWrite(t, w, "aaaa")
	if err := w.Rotate(); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, w, "bbbb")
	assertBackupData(t, dir, []string{"aaaa"})
	if got := readActive(t, dir); string(got) != "bbbb" {
		t.Fatalf("active=%q", got)
	}

	// The active file has room below MaxSize, but accepting the write would
	// exceed the total budget. The write must be rejected and no existing
	// file may be changed.
	n, err := w.Write([]byte("cc"))
	if !errors.Is(err, formal.ErrDiskFull) {
		t.Fatalf("err=%v want ErrDiskFull", err)
	}
	if n != 0 {
		t.Fatalf("wrote %d bytes on failure", n)
	}
	assertBackupData(t, dir, []string{"aaaa"})
	if got := readActive(t, dir); string(got) != "bbbb" {
		t.Fatalf("active after failure=%q", got)
	}
}

func TestDiskBudgetAppliesAfterRotationAndRetention(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{
		MaxSize:       4,
		MaxBackups:    10,
		MaxTotalBytes: 8,
	}, clock)
	defer w.Close()

	mustWrite(t, w, "aaaa")
	mustWrite(t, w, "bbbb")
	// This write forces a rotation. The old 4-byte segment is retained, so
	// after rotation usage is still 8 and the write cannot fit.
	if _, err := w.Write([]byte("dddd")); !errors.Is(err, formal.ErrDiskFull) {
		t.Fatalf("err=%v want ErrDiskFull", err)
	}
	assertBackupData(t, dir, []string{"aaaa", "bbbb"})
	if got := readActive(t, dir); len(got) != 0 {
		t.Fatalf("active should be empty after guarded rotation, got %q", got)
	}
}

func TestCompressionSkippedWhenItWouldExceedBudget(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{
		MaxBackups:    10,
		Compress:      true,
		MaxTotalBytes: 1,
	}, clock)
	defer w.Close()

	mustWrite(t, w, "x")
	if err := w.Rotate(); err != nil {
		t.Fatal(err)
	}
	_, files, total := scanActual(t, dir, "app.log")
	if len(files) != 1 {
		t.Fatalf("backups=%d", len(files))
	}
	if files[0].compressed {
		t.Fatal("tiny gzip should have been skipped to respect the byte budget")
	}
	if string(files[0].data) != "x" {
		t.Fatalf("backup data=%q", files[0].data)
	}
	if total != 1 {
		t.Fatalf("usage=%d want 1", total)
	}
	if err := w.Stats().MaintenanceError; err != nil {
		t.Fatalf("skip should not be reported as maintenance failure: %v", err)
	}
}

func TestInterleavedRotationAndCompressionLosesNothing(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{
		MaxSize:    6,
		MaxAge:     5 * time.Second,
		MaxBackups: 100,
		Compress:   true,
	}, clock)

	var all []byte
	for i := 0; i < 60; i++ {
		payload := []byte(fmt.Sprintf("record-%03d-%s|", i, strings.Repeat("z", i%5)))
		all = append(all, payload...)
		mustWrite(t, w, string(payload))
		if i%7 == 0 {
			clock.Advance(2 * time.Second)
		}
		if i%11 == 0 {
			if err := w.Rotate(); err != nil {
				t.Fatal(err)
			}
		}
		if i%13 == 0 {
			_, _, total := scanActual(t, dir, "app.log")
			if got := w.Stats().Usage; got != total {
				t.Fatalf("Stats.Usage=%d actual=%d", got, total)
			}
		}
	}
	if err := w.Rotate(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	_, files, _ := scanActual(t, dir, "app.log")
	var recovered []byte
	for _, f := range files {
		recovered = append(recovered, f.data...)
	}
	if !bytes.Equal(recovered, all) {
		t.Fatalf("recovered %d bytes, want %d", len(recovered), len(all))
	}
	if got := countBackups(t, dir); got != 60 {
		t.Fatalf("backups=%d want 60 (every payload rotated)", got)
	}
}

func TestReopenContinuesSequenceAndRetention(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	dir := t.TempDir()
	cfg := formal.Config{
		Dir:        dir,
		BaseName:   "app.log",
		MaxSize:    2,
		MaxBackups: 2,
		Now:        clock.Now,
	}
	w, err := formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"aa", "bb", "cc"} {
		mustWrite(t, w, s)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	firstNames := backupNames(t, dir)

	w, err = formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, w, "dd")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	secondNames := backupNames(t, dir)
	if len(secondNames) != 2 {
		t.Fatalf("retention failed on reopen: %v", secondNames)
	}
	firstSeqs := backupSeqs(t, firstNames)
	secondSeqs := backupSeqs(t, secondNames)
	if fmt.Sprint(firstSeqs) != "[1 2]" {
		t.Fatalf("first sequences=%v", firstSeqs)
	}
	if fmt.Sprint(secondSeqs) != "[2 3]" {
		t.Fatalf("sequence did not continue across reopen: %v", secondSeqs)
	}
}

func TestOpenCompressesExistingRawBackup(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	dir := t.TempDir()
	cfg := formal.Config{
		Dir:        dir,
		BaseName:   "app.log",
		MaxSize:    2,
		MaxBackups: 10,
		Now:        clock.Now,
	}
	w, err := formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, w, "aa")
	mustWrite(t, w, "bb")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if got := backupSeqs(t, backupNames(t, dir)); fmt.Sprint(got) != "[1]" {
		t.Fatalf("backups=%v", got)
	}

	cfg.Compress = true
	w, err = formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	_, files, total := scanActual(t, dir, "app.log")
	if len(files) != 1 || !files[0].compressed || string(files[0].data) != "aa" {
		t.Fatalf("backup not compressed on open: %+v", files)
	}
	if stats := w.Stats(); stats.Usage != total || stats.CompressedBackups != 1 {
		t.Fatalf("stats=%+v total=%d", stats, total)
	}
}

func TestOpenDeduplicatesRawAndCompressedBackup(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	dir := t.TempDir()
	cfg := formal.Config{
		Dir:        dir,
		BaseName:   "app.log",
		MaxSize:    2,
		MaxBackups: 10,
		Now:        clock.Now,
	}
	w, err := formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, w, "aa")
	mustWrite(t, w, "bb")
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	names := backupNames(t, dir)
	if len(names) != 1 {
		t.Fatalf("backups=%v", names)
	}
	rawName := names[0]
	if err := os.WriteFile(filepath.Join(dir, rawName+".gz"),
		gzipBytes(t, []byte("aa")), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg.Compress = true
	w, err = formal.NewWriter(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := os.Stat(filepath.Join(dir, rawName)); !os.IsNotExist(err) {
		t.Fatalf("raw duplicate still exists: %v", err)
	}
	_, files, total := scanActual(t, dir, "app.log")
	if len(files) != 1 || !files[0].compressed || string(files[0].data) != "aa" {
		t.Fatalf("deduplicated backup=%+v", files)
	}
	if w.Stats().Usage != total {
		t.Fatalf("usage=%d total=%d", w.Stats().Usage, total)
	}
}

func TestSyncAndClosedOperations(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{MaxBackups: 2}, clock)
	mustWrite(t, w, "abc")
	if err := w.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := w.Write([]byte("x")); !errors.Is(err, formal.ErrClosed) {
		t.Fatalf("Write after Close: %v", err)
	}
	if err := w.Rotate(); !errors.Is(err, formal.ErrClosed) {
		t.Fatalf("Rotate after Close: %v", err)
	}
	if err := w.Sync(); !errors.Is(err, formal.ErrClosed) {
		t.Fatalf("Sync after Close: %v", err)
	}
	if err := w.Maintain(); !errors.Is(err, formal.ErrClosed) {
		t.Fatalf("Maintain after Close: %v", err)
	}
	if got := readActive(t, dir); string(got) != "abc" {
		t.Fatalf("active=%q", got)
	}
	if got := w.Stats().Usage; got != 3 {
		t.Fatalf("usage=%d", got)
	}
}

func TestConcurrentWrites(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	w, dir := newWriter(t, formal.Config{
		MaxSize:    32,
		MaxBackups: 1000,
		Compress:   true,
	}, clock)
	defer w.Close()

	const goroutines, perG = 8, 50
	errs := make(chan error, goroutines)
	for g := 0; g < goroutines; g++ {
		go func(g int) {
			for i := 0; i < perG; i++ {
				if _, err := w.Write([]byte(fmt.Sprintf("g%02d-i%03d|", g, i))); err != nil {
					errs <- err
					return
				}
			}
			errs <- nil
		}(g)
	}
	for g := 0; g < goroutines; g++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	_, files, _ := scanActual(t, dir, "app.log")
	for _, f := range files {
		if len(f.data) == 0 {
			t.Fatal("empty compressed backup")
		}
	}
}

func TestConfigValidation(t *testing.T) {
	bad := []formal.Config{
		{BaseName: "x"},
		{Dir: "x"},
		{Dir: "x", BaseName: "a/b"},
		{Dir: "x", BaseName: "a", MaxSize: -1},
		{Dir: "x", BaseName: "a", MaxAge: -1},
		{Dir: "x", BaseName: "a", MaxBackups: -1},
		{Dir: "x", BaseName: "a", MaxTotalBytes: -1},
	}
	for _, cfg := range bad {
		if _, err := formal.NewWriter(cfg); !errors.Is(err, formal.ErrInvalidConfig) {
			t.Errorf("cfg=%+v err=%v", cfg, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers

func mustWrite(t *testing.T, w *formal.Writer, s string) {
	t.Helper()
	n, err := w.Write([]byte(s))
	if err != nil {
		t.Fatalf("Write(%q): %v", s, err)
	}
	if n != len(s) {
		t.Fatalf("Write(%q) wrote %d", s, n)
	}
}

func readActive(t *testing.T, dir string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "app.log"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func backupNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, ent := range entries {
		if ent.Name() != "app.log" && strings.HasPrefix(ent.Name(), "app.log.") {
			names = append(names, ent.Name())
		}
	}
	sort.Strings(names)
	return names
}

func countBackups(t *testing.T, dir string) int {
	t.Helper()
	return len(backupNames(t, dir))
}

func backupSeqs(t *testing.T, names []string) []uint64 {
	t.Helper()
	seqs := make([]uint64, 0, len(names))
	for _, name := range names {
		rest := strings.TrimPrefix(name, "app.log.")
		rest = strings.TrimSuffix(rest, ".gz")
		rest = strings.TrimSuffix(rest, ".log")
		parts := strings.Split(rest, ".")
		if len(parts) != 2 {
			t.Fatalf("bad backup name %q", name)
		}
		seq, err := strconv.ParseUint(parts[0], 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, seq)
	}
	return seqs
}

func assertBackupData(t *testing.T, dir string, want []string) {
	t.Helper()
	_, files, _ := scanActual(t, dir, "app.log")
	var got []string
	for _, f := range files {
		got = append(got, string(f.data))
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("backups=%q want %q", got, want)
	}
}
