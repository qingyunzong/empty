package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"imgdiff/imgdiff"
)

func writeManifest(t *testing.T, m *imgdiff.Manifest) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "m.json")
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCLIDiff(t *testing.T) {
	oldM := &imgdiff.Manifest{Size: 16, Extents: []imgdiff.Extent{
		{Start: 0, End: 8, Data: true, Digest: "aaa"},
		{Start: 8, End: 12, Data: true, Digest: "zeros", Zero: true},
	}}
	newM := &imgdiff.Manifest{Size: 16, Parent: oldM, Extents: []imgdiff.Extent{
		{Start: 4, End: 8, Data: true, Digest: "bbb"},
	}}
	oldPath := writeManifest(t, oldM)
	newPath := writeManifest(t, newM)

	var out bytes.Buffer
	if code := run(&out, []string{"diff", oldPath, newPath}); code != 0 {
		t.Fatalf("diff exit code %d", code)
	}
	var got struct {
		Content []imgdiff.Interval `json:"content"`
		Layout  []imgdiff.Interval `json:"layout"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// [4,8): aaa -> bbb differs in content and layout.
	// [8,12): zero block inherited on both sides, no difference.
	if len(got.Content) != 1 || got.Content[0] != (imgdiff.Interval{Start: 4, End: 8}) {
		t.Fatalf("content diff: %+v", got.Content)
	}
	if len(got.Layout) != 1 || got.Layout[0] != (imgdiff.Interval{Start: 4, End: 8}) {
		t.Fatalf("layout diff: %+v", got.Layout)
	}
}

func TestCLIPlan(t *testing.T) {
	oldM := &imgdiff.Manifest{Size: 8, Extents: []imgdiff.Extent{
		{Start: 0, End: 4, Data: true, Digest: "aaa"},
		{Start: 4, End: 8, Data: true, Digest: "bbb"},
	}}
	newM := &imgdiff.Manifest{Size: 8, Extents: []imgdiff.Extent{
		{Start: 0, End: 4, Data: true, Digest: "bbb"},
		{Start: 4, End: 8, Data: true, Digest: "aaa"},
	}}
	oldPath := writeManifest(t, oldM)
	newPath := writeManifest(t, newM)

	var out bytes.Buffer
	if code := run(&out, []string{"plan", "-block", "4", oldPath, newPath}); code != 0 {
		t.Fatalf("plan exit code %d", code)
	}
	var plan imgdiff.Plan
	if err := json.Unmarshal(out.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	// The swap must be broken with the scratch block.
	var saves, restores int
	for _, op := range plan.Steps {
		switch op.Op {
		case "save":
			saves++
		case "restore":
			restores++
		}
	}
	if saves != 1 || restores != 1 {
		t.Fatalf("swap plan should use one save and one restore: %+v", plan.Steps)
	}
	if err := imgdiff.VerifyPlan(oldM, newM, &plan); err != nil {
		t.Fatal(err)
	}
}

func TestCLIRejectsOutOfBounds(t *testing.T) {
	bad := &imgdiff.Manifest{Size: 4, Extents: []imgdiff.Extent{
		{Start: 0, End: 9, Data: true, Digest: "aaa"},
	}}
	good := &imgdiff.Manifest{Size: 4}
	badPath := writeManifest(t, bad)
	goodPath := writeManifest(t, good)
	var out bytes.Buffer
	if code := run(&out, []string{"diff", badPath, goodPath}); code == 0 {
		t.Fatal("expected non-zero exit for out-of-bounds extent")
	}
}
