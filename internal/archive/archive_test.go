package archive

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// buildSourceTree 构造含目录、普通文件、硬链接、相对符号链接及循环符号链接的源树。
func buildSourceTree(t *testing.T) string {
	t.Helper()
	src := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(src, "sub", "deep"), 0o755))
	must(os.WriteFile(filepath.Join(src, "a.txt"), []byte("hello world"), 0o644))
	must(os.WriteFile(filepath.Join(src, "sub", "b.txt"), []byte("second file\n"), 0o640))
	// 硬链接：同组两个名字
	must(os.Link(filepath.Join(src, "a.txt"), filepath.Join(src, "sub", "deep", "a-link.txt")))
	// 相对符号链接
	must(os.Symlink("../a.txt", filepath.Join(src, "sub", "rel-link")))
	// 循环符号链接：x -> y, y -> x，归档/恢复均不得跟随
	must(os.Symlink("loop-y", filepath.Join(src, "loop-x")))
	must(os.Symlink("loop-x", filepath.Join(src, "loop-y")))
	return src
}

func roundTrip(t *testing.T, src string) (archiveBytes []byte, dest string) {
	t.Helper()
	var buf bytes.Buffer
	if err := Create(src, &buf); err != nil {
		t.Fatalf("Create 失败: %v", err)
	}
	dest = filepath.Join(t.TempDir(), "release")
	if err := Restore(&buf, dest); err != nil {
		t.Fatalf("Restore 失败: %v", err)
	}
	return buf.Bytes(), dest
}

func TestRoundTripPreservesContentAndStructure(t *testing.T) {
	src := buildSourceTree(t)
	_, dest := roundTrip(t, src)

	srcSnap, err := Snapshot(src)
	if err != nil {
		t.Fatal(err)
	}
	destSnap, err := Snapshot(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(srcSnap, destSnap) {
		t.Fatalf("内容摘要不一致:\n源:   %v\n目标: %v", srcSnap, destSnap)
	}
}

func TestRoundTripPreservesInodeRelations(t *testing.T) {
	src := buildSourceTree(t)
	_, dest := roundTrip(t, src)

	srcGroups, err := InodeGroups(src)
	if err != nil {
		t.Fatal(err)
	}
	destGroups, err := InodeGroups(dest)
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"a.txt", "sub/deep/a-link.txt"}}
	if !reflect.DeepEqual(srcGroups, want) {
		t.Fatalf("源硬链接组异常: %v", srcGroups)
	}
	if !reflect.DeepEqual(destGroups, want) {
		t.Fatalf("恢复后 inode 关系不一致: got %v want %v", destGroups, want)
	}
}

func TestSymlinkLoopNotFollowed(t *testing.T) {
	src := buildSourceTree(t)
	_, dest := roundTrip(t, src)

	for _, name := range []string{"loop-x", "loop-y"} {
		fi, err := os.Lstat(filepath.Join(dest, name))
		if err != nil {
			t.Fatalf("循环链接 %s 未恢复: %v", name, err)
		}
		if fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("%s 不是符号链接", name)
		}
	}
	target, err := os.Readlink(filepath.Join(dest, "loop-x"))
	if err != nil || target != "loop-y" {
		t.Fatalf("loop-x 目标错误: %q, %v", target, err)
	}
}

// makeTar 手工构造归档，便于制造乱序与非法条目。
func makeTar(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		mode := int64(0o644)
		if e.typ == tar.TypeDir {
			mode = 0o755
		}
		hdr := &tar.Header{
			Name:     e.name,
			Typeflag: e.typ,
			Mode:     mode,
			Linkname: e.link,
			Size:     int64(len(e.body)),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if len(e.body) > 0 {
			if _, err := tw.Write(e.body); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type tarEntry struct {
	name string
	typ  byte
	link string
	body []byte
}

func TestHardlinkTargetMayArriveLate(t *testing.T) {
	// 硬链接条目先于其目标文件出现。
	arc := makeTar(t, []tarEntry{
		{name: "dir/", typ: tar.TypeDir},
		{name: "dir/copy.txt", typ: tar.TypeLink, link: "dir/orig.txt"},
		{name: "dir/orig.txt", typ: tar.TypeReg, body: []byte("payload")},
	})
	dest := filepath.Join(t.TempDir(), "release")
	if err := Restore(bytes.NewReader(arc), dest); err != nil {
		t.Fatalf("晚到目标的硬链接应恢复成功: %v", err)
	}
	groups, err := InodeGroups(dest)
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"dir/copy.txt", "dir/orig.txt"}}
	if !reflect.DeepEqual(groups, want) {
		t.Fatalf("inode 关系错误: got %v want %v", groups, want)
	}
	data, err := os.ReadFile(filepath.Join(dest, "dir", "copy.txt"))
	if err != nil || string(data) != "payload" {
		t.Fatalf("硬链接内容错误: %q, %v", data, err)
	}
}

// prepareOldDest 预置旧目标目录并返回其摘要。
func prepareOldDest(t *testing.T) (dest string, snap []string) {
	t.Helper()
	dest = filepath.Join(t.TempDir(), "release")
	if err := os.MkdirAll(dest, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dest, "keep.txt"), []byte("do not touch"), 0o644); err != nil {
		t.Fatal(err)
	}
	snap, err := Snapshot(dest)
	if err != nil {
		t.Fatal(err)
	}
	return dest, snap
}

// expectReleaseFailure 断言恢复失败、错误信息匹配、且旧目标目录保持不变。
func expectReleaseFailure(t *testing.T, arc []byte, wantErr string) {
	t.Helper()
	dest, before := prepareOldDest(t)
	err := Restore(bytes.NewReader(arc), dest)
	if err == nil {
		t.Fatalf("应失败但成功了")
	}
	if !strings.Contains(err.Error(), wantErr) {
		t.Fatalf("错误信息 %q 不含 %q", err, wantErr)
	}
	after, serr := Snapshot(dest)
	if serr != nil {
		t.Fatal(serr)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("失败后旧目标目录被修改:\n前: %v\n后: %v", before, after)
	}
	// 临时目录不得残留
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(dest), ".arc-release-*"))
	if len(matches) != 0 {
		t.Fatalf("临时目录残留: %v", matches)
	}
}

func TestRejectPathTraversalName(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "../evil.txt", typ: tar.TypeReg, body: []byte("x")},
	})
	expectReleaseFailure(t, arc, "路径穿越")
}

func TestRejectAbsoluteName(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "/abs/evil.txt", typ: tar.TypeReg, body: []byte("x")},
	})
	expectReleaseFailure(t, arc, "绝对路径")
}

func TestRejectAbsoluteSymlinkTarget(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "link", typ: tar.TypeSymlink, link: "/etc/passwd"},
	})
	expectReleaseFailure(t, arc, "绝对目标")
}

func TestRejectEscapingSymlinkTarget(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "sub/", typ: tar.TypeDir},
		{name: "sub/link", typ: tar.TypeSymlink, link: "../../outside"},
	})
	expectReleaseFailure(t, arc, "逃出根目录")
}

func TestRejectHardlinkTraversalTarget(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "copy", typ: tar.TypeLink, link: "../victim"},
	})
	expectReleaseFailure(t, arc, "路径穿越")
}

func TestRejectMissingHardlinkTarget(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "copy", typ: tar.TypeLink, link: "never-exists"},
	})
	expectReleaseFailure(t, arc, "硬链接目标缺失")
}

func TestRejectUnsupportedType(t *testing.T) {
	arc := makeTar(t, []tarEntry{
		{name: "fifo", typ: tar.TypeFifo},
	})
	expectReleaseFailure(t, arc, "不支持的类型")
}

func TestSuccessfulRestoreReplacesOldDest(t *testing.T) {
	src := buildSourceTree(t)
	var buf bytes.Buffer
	if err := Create(src, &buf); err != nil {
		t.Fatal(err)
	}
	dest, _ := prepareOldDest(t)
	if err := Restore(&buf, dest); err != nil {
		t.Fatalf("Restore 失败: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dest, "keep.txt")); !os.IsNotExist(err) {
		t.Fatalf("成功发布后旧文件应被替换")
	}
	if _, err := os.Lstat(filepath.Join(dest, "a.txt")); err != nil {
		t.Fatalf("新内容缺失: %v", err)
	}
}

func TestCreateRejectsIllegalSymlink(t *testing.T) {
	src := t.TempDir()
	if err := os.Symlink("/etc/passwd", filepath.Join(src, "bad")); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := Create(src, &buf); err == nil || !strings.Contains(err.Error(), "绝对目标") {
		t.Fatalf("归档应拒绝绝对符号链接目标: %v", err)
	}
}
