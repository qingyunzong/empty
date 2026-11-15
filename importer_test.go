package dataeng

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestRealGNUTarFormats(t *testing.T) {
	tarPath, err := exec.LookPath("tar")
	if err != nil {
		t.Skip("GNU tar is not installed")
	}

	temp := t.TempDir()
	sparsePath := filepath.Join(temp, "sparse.bin")
	file, err := os.Create(sparsePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte("abc"), 10); err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte("defgh"), 70000); err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(100000); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	tailPath := filepath.Join(temp, "tail.txt")
	if err := os.WriteFile(tailPath, []byte("boundary-check"), 0o644); err != nil {
		t.Fatal(err)
	}

	formats := []struct {
		name string
		args []string
	}{
		{"pax-0.0", []string{"--format=pax", "--sparse", "--sparse-version=0.0"}},
		{"pax-0.1", []string{"--format=pax", "--sparse", "--sparse-version=0.1"}},
		{"pax-1.0", []string{"--format=pax", "--sparse", "--sparse-version=1.0"}},
		{"gnu-legacy", []string{"--format=gnu", "--sparse"}},
	}

	for _, format := range formats {
		t.Run(format.name, func(t *testing.T) {
			archivePath := filepath.Join(temp, format.name+".tar")
			args := append(format.args, "-cf", archivePath, sparsePath, tailPath)
			cmd := exec.Command(tarPath, args...)
			cmd.Dir = temp
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("tar failed: %v\n%s", err, output)
			}

			archive, err := os.Open(archivePath)
			if err != nil {
				t.Fatal(err)
			}
			defer archive.Close()

			reader := NewReader(archive)
			entry, err := reader.Next()
			if err != nil {
				t.Fatal(err)
			}
			if !entry.IsSparse() {
				t.Fatalf("entry is not sparse: %+v", entry.Header)
			}
			if entry.Header.Size != 100000 || entry.LogicalSize != 100000 {
				t.Fatalf("logical size = %d/%d", entry.Header.Size, entry.LogicalSize)
			}
			wantPhysical := int64(8192)
			if format.name == "pax-1.0" {
				wantPhysical = 8704 // in-body map block plus compact data
			}
			if entry.PhysicalSize != wantPhysical {
				t.Fatalf("physical size = %d, want %d", entry.PhysicalSize, wantPhysical)
			}
			content, err := io.ReadAll(entry)
			if err != nil {
				t.Fatal(err)
			}
			if len(content) != 100000 {
				t.Fatalf("expanded size = %d", len(content))
			}
			if string(content[10:13]) != "abc" || string(content[70000:70005]) != "defgh" {
				t.Fatalf("data payload mismatch")
			}
			for index, value := range content {
				if (index < 10 || index >= 13 && index < 70000 || index >= 70005) && value != 0 {
					t.Fatalf("non-zero hole byte at %d", index)
				}
			}

			next, err := reader.Next()
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasSuffix(next.Header.Name, "tail.txt") {
				t.Fatalf("next entry = %q", next.Header.Name)
			}
			tail, err := io.ReadAll(next)
			if err != nil {
				t.Fatal(err)
			}
			if string(tail) != "boundary-check" {
				t.Fatalf("tail content = %q", tail)
			}
			if _, err := reader.Next(); err != io.EOF {
				t.Fatalf("final Next error = %v", err)
			}
		})
	}
}

func TestLegacyExtensionHeaders(t *testing.T) {
	tarPath, err := exec.LookPath("tar")
	if err != nil {
		t.Skip("GNU tar is not installed")
	}

	temp := t.TempDir()
	sparsePath := filepath.Join(temp, "many.bin")
	file, err := os.Create(sparsePath)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 10; index++ {
		if _, err := file.WriteAt([]byte{byte('a' + index)}, int64(index*100000)); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Truncate(1000000); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	tailPath := filepath.Join(temp, "tail.txt")
	if err := os.WriteFile(tailPath, []byte("after-extension"), 0o644); err != nil {
		t.Fatal(err)
	}

	archivePath := filepath.Join(temp, "many.tar")
	cmd := exec.Command(tarPath, "--format=gnu", "--sparse", "-cf", archivePath, sparsePath, tailPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tar failed: %v\n%s", err, output)
	}

	archive, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()

	reader := NewReader(archive)
	entry, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if len(entry.Extents) <= 4 {
		t.Fatalf("expected extension headers, got %d extents", len(entry.Extents))
	}
	content, err := io.ReadAll(entry)
	if err != nil {
		t.Fatal(err)
	}
	if len(content) != 1000000 {
		t.Fatalf("expanded size = %d", len(content))
	}
	for index := 0; index < 10; index++ {
		if content[index*100000] != byte('a'+index) {
			t.Fatalf("data at %d is %q", index*100000, content[index*100000])
		}
	}
	next, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	tail, err := io.ReadAll(next)
	if err != nil {
		t.Fatal(err)
	}
	if string(tail) != "after-extension" {
		t.Fatalf("entry after extension headers = %q", tail)
	}
}

func TestSkippingSparseBodyKeepsAlignment(t *testing.T) {
	tarPath, err := exec.LookPath("tar")
	if err != nil {
		t.Skip("GNU tar is not installed")
	}

	temp := t.TempDir()
	sparsePath := filepath.Join(temp, "skip.bin")
	file, err := os.Create(sparsePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte("payload"), 50000); err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(200000); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	tailPath := filepath.Join(temp, "after.txt")
	if err := os.WriteFile(tailPath, []byte("after"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"--format=pax", "--sparse", "--sparse-version=1.0"},
		{"--format=gnu", "--sparse"},
	} {
		archivePath := filepath.Join(temp, strings.Join(args, "-")+".tar")
		commandArgs := append(append([]string{}, args...), "-cf", archivePath, sparsePath, tailPath)
		if output, err := exec.Command(tarPath, commandArgs...).CombinedOutput(); err != nil {
			t.Fatalf("tar failed: %v\n%s", err, output)
		}
		archive, err := os.Open(archivePath)
		if err != nil {
			t.Fatal(err)
		}
		reader := NewReader(archive)
		if _, err := reader.Next(); err != nil {
			archive.Close()
			t.Fatal(err)
		}
		// Deliberately do not read the sparse body.
		next, err := reader.Next()
		if err != nil {
			archive.Close()
			t.Fatal(err)
		}
		content, err := io.ReadAll(next)
		archive.Close()
		if err != nil {
			t.Fatal(err)
		}
		if string(content) != "after" {
			t.Fatalf("following entry = %q", content)
		}
	}
}

func TestAllHoleFile(t *testing.T) {
	tarPath, err := exec.LookPath("tar")
	if err != nil {
		t.Skip("GNU tar is not installed")
	}

	temp := t.TempDir()
	holePath := filepath.Join(temp, "hole.bin")
	file, err := os.Create(holePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(10000); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	for _, version := range []string{"0.0", "0.1", "1.0"} {
		archivePath := filepath.Join(temp, "hole-"+version+".tar")
		cmd := exec.Command(tarPath, "--format=pax", "--sparse", "--sparse-version="+version,
			"-cf", archivePath, holePath)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("tar failed: %v\n%s", err, output)
		}
		archive, err := os.Open(archivePath)
		if err != nil {
			t.Fatal(err)
		}
		entry, err := NewReader(archive).Next()
		if err != nil {
			archive.Close()
			t.Fatal(err)
		}
		content, err := io.ReadAll(entry)
		archive.Close()
		if err != nil {
			t.Fatal(err)
		}
		if len(content) != 10000 {
			t.Fatalf("version %s: size = %d", version, len(content))
		}
		for index, value := range content {
			if value != 0 {
				t.Fatalf("version %s: non-zero byte at %d", version, index)
			}
		}
	}
}

func TestPAX10MultiBlockMap(t *testing.T) {
	tarPath, err := exec.LookPath("tar")
	if err != nil {
		t.Skip("GNU tar is not installed")
	}

	temp := t.TempDir()
	sparsePath := filepath.Join(temp, "multiblock.bin")
	file, err := os.Create(sparsePath)
	if err != nil {
		t.Fatal(err)
	}
	const fragments = 100
	for index := 0; index < fragments; index++ {
		if _, err := file.WriteAt([]byte{byte(index)}, int64(index*200000)); err != nil {
			t.Fatal(err)
		}
	}
	if err := file.Truncate(fragments * 200000); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	tailPath := filepath.Join(temp, "tail.txt")
	if err := os.WriteFile(tailPath, []byte("after-map"), 0o644); err != nil {
		t.Fatal(err)
	}

	archivePath := filepath.Join(temp, "multiblock.tar")
	cmd := exec.Command(tarPath, "--format=pax", "--sparse", "--sparse-version=1.0",
		"-cf", archivePath, sparsePath, tailPath)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("tar failed: %v\n%s", err, output)
	}

	archive, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()

	reader := NewReader(archive)
	entry, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	if entry.Format != SparsePAX10 {
		t.Fatalf("format = %v", entry.Format)
	}
	if len(entry.Extents) < fragments/2 {
		t.Fatalf("extent count = %d", len(entry.Extents))
	}
	content, err := io.ReadAll(entry)
	if err != nil {
		t.Fatal(err)
	}
	if len(content) != fragments*200000 {
		t.Fatalf("expanded size = %d", len(content))
	}
	for index := 0; index < fragments; index++ {
		if content[index*200000] != byte(index) {
			t.Fatalf("data at %d is %q", index*200000, content[index*200000])
		}
	}
	next, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	tail, err := io.ReadAll(next)
	if err != nil {
		t.Fatal(err)
	}
	if string(tail) != "after-map" {
		t.Fatalf("entry after multi-block map = %q", tail)
	}
}

func TestSparseMapValidation(t *testing.T) {
	valid := &SparseMap{
		LogicalSize: 100,
		Extents: []Extent{
			{Offset: 10, Length: 5},
			{Offset: 30, Length: 10},
		},
	}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	h := valid.Holes()
	wantHoles := []Extent{{Offset: 0, Length: 10}, {Offset: 15, Length: 15}, {Offset: 40, Length: 60}}
	if len(h) != len(wantHoles) {
		t.Fatalf("holes = %+v", h)
	}
	for index := range h {
		if h[index] != wantHoles[index] {
			t.Fatalf("holes = %+v", h)
		}
	}

	bad := []*SparseMap{
		{LogicalSize: 100, Extents: []Extent{{Offset: 20, Length: 5}, {Offset: 10, Length: 5}}},
		{LogicalSize: 100, Extents: []Extent{{Offset: 10, Length: 5}, {Offset: 12, Length: 5}}},
		{LogicalSize: 100, Extents: []Extent{{Offset: 99, Length: 2}}},
		{LogicalSize: 100, Extents: []Extent{{Offset: -1, Length: 2}}},
	}
	for _, m := range bad {
		if err := m.Validate(); !errors.Is(err, ErrInvalidSparseMap) {
			t.Fatalf("Validate(%+v) = %v", m.Extents, err)
		}
	}
}

func TestSparseReaderReadAtAndExtract(t *testing.T) {
	m := &SparseMap{
		LogicalSize: 20,
		Extents: []Extent{
			{Offset: 2, Length: 4},
			{Offset: 12, Length: 4},
		},
	}
	compact := bytes.NewReader([]byte("abcdWXYZ"))
	reader, err := NewSparseReader(m, compact)
	if err != nil {
		t.Fatal(err)
	}

	want := []byte("\x00\x00abcd\x00\x00\x00\x00\x00\x00WXYZ\x00\x00\x00\x00")
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("logical content = %q", got)
	}

	reader, err = NewSparseReader(m, bytes.NewReader([]byte("abcdWXYZ")))
	if err != nil {
		t.Fatal(err)
	}
	part := make([]byte, 7)
	n, err := reader.ReadAt(part, 9)
	if err != nil {
		t.Fatal(err)
	}
	if n != 7 || !bytes.Equal(part, []byte("\x00\x00\x00WXYZ")) {
		t.Fatalf("ReadAt = %d, %q", n, part)
	}

	reader, err = NewSparseReader(m, bytes.NewReader([]byte("abcdWXYZ")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(reader); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 6)
	if _, err := io.ReadFull(reader, head); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(head, []byte("\x00\x00abcd")) {
		t.Fatalf("content after backward seek = %q", head)
	}

	var sink countingSeeker
	reader, err = NewSparseReader(m, bytes.NewReader([]byte("abcdWXYZ")))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.WriteTo(&sink); err != nil {
		t.Fatal(err)
	}
	if sink.written != 9 {
		t.Fatalf("wrote %d bytes; holes should be seeked", sink.written)
	}
	if sink.position != 20 {
		t.Fatalf("final position = %d", sink.position)
	}
}

func TestPAXRecords00(t *testing.T) {
	body := []byte(
		"26 GNU.sparse.size=100000\n" +
			"26 GNU.sparse.numblocks=3\n" +
			"23 GNU.sparse.offset=0\n" +
			"28 GNU.sparse.numbytes=4096\n" +
			"27 GNU.sparse.offset=69632\n" +
			"28 GNU.sparse.numbytes=4096\n" +
			"28 GNU.sparse.offset=100000\n" +
			"25 GNU.sparse.numbytes=0\n",
	)
	records, err := ParsePAXRecords(body)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := prepareTestEntry(records, nil, 8192)
	if err != nil {
		t.Fatal(err)
	}
	if entry.LogicalSize != 100000 || len(entry.Extents) != 3 {
		t.Fatalf("map = %+v", entry)
	}
}

func prepareTestEntry(records map[string]string, body io.Reader, physicalSize int64) (*SparseMap, error) {
	m, _, _, err := parseSparsePAX(records, nil, false, body, physicalSize)
	return m, err
}

type countingSeeker struct {
	position int64
	written  int64
}

func (w *countingSeeker) Write(p []byte) (int, error) {
	w.position += int64(len(p))
	w.written += int64(len(p))
	return len(p), nil
}

func (w *countingSeeker) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
		w.position = offset
	case io.SeekCurrent:
		w.position += offset
	case io.SeekEnd:
		return 0, errors.New("unexpected SeekEnd")
	}
	return w.position, nil
}

func TestBodySizeMismatchRejected(t *testing.T) {
	records := map[string]string{
		PAXGNUSparseSize:      "10",
		PAXGNUSparseNumBlocks: "1",
		PAXGNUSparseMap:       "0,4",
	}
	if _, _, _, err := parseSparsePAX(records, nil, false, nil, 8); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("error = %v", err)
	}
}

func TestEmptySparseMap(t *testing.T) {
	records := map[string]string{
		PAXGNUSparseSize:      "100",
		PAXGNUSparseNumBlocks: "0",
		PAXGNUSparseMap:       "",
	}
	m, format, _, err := parseSparsePAX(records, nil, false, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if format != SparsePAX01 || m.LogicalSize != 100 || len(m.Extents) != 0 {
		t.Fatalf("map = %+v, format = %v", m, format)
	}
}

func TestParseSparseMapCallForms(t *testing.T) {
	records := map[string]string{
		PAXGNUSparseSize:      "20",
		PAXGNUSparseNumBlocks: "2",
		PAXGNUSparseMap:       "2,4,12,4",
	}
	m, err := ParseSparseMap(records)
	if err != nil {
		t.Fatal(err)
	}
	if m.LogicalSize != 20 || len(m.Extents) != 2 {
		t.Fatalf("records map = %+v", m)
	}

	header := &tar.Header{PAXRecords: records}
	m, err = ParseSparseMap(header, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.LogicalSize != 20 || len(m.Extents) != 2 {
		t.Fatalf("header map = %+v", m)
	}

	var mapBody bytes.Buffer
	mapBody.WriteString("1\n2\n4\n")
	mapBody.Write(make([]byte, blockSize-mapBody.Len()))
	m, err = ParseSparseMap(bytes.NewReader(mapBody.Bytes()), 10)
	if err != nil {
		t.Fatal(err)
	}
	if m.LogicalSize != 10 || len(m.Extents) != 1 || m.Extents[0].Offset != 2 {
		t.Fatalf("body map = %+v", m)
	}
}

func TestRegularTar(t *testing.T) {
	var archive bytes.Buffer
	writer := tar.NewWriter(&archive)
	if err := writer.WriteHeader(&tar.Header{Name: "a", Mode: 0o644, Size: 3, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	reader := NewReader(bytes.NewReader(archive.Bytes()))
	entry, err := reader.Next()
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(entry)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "abc" {
		t.Fatalf("content = %q", content)
	}
}
