package config

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func mustParse(t *testing.T, src string) *Config {
	t.Helper()
	c, err := Parse(strings.NewReader(src))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return c
}

func mustResolve(t *testing.T, src string) *Resolved {
	t.Helper()
	r, err := mustParse(t, src).Resolve()
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	return r
}

func mustGet(t *testing.T, r *Resolved, section, key string) string {
	t.Helper()
	v, err := r.Get(section, key)
	if err != nil {
		t.Fatalf("Get(%s.%s): %v", section, key, err)
	}
	return v
}

func TestInheritanceThenOverride(t *testing.T) {
	r := mustResolve(t, `
[base]
host = 0.0.0.0
port = 8080
debug = false

[web]
extends = base
port = 9090
`)
	if got := mustGet(t, r, "web", "host"); got != "0.0.0.0" {
		t.Errorf("web.host = %q, want inherited 0.0.0.0", got)
	}
	if got := mustGet(t, r, "web", "port"); got != "9090" {
		t.Errorf("web.port = %q, want overridden 9090", got)
	}
	if got := mustGet(t, r, "base", "port"); got != "8080" {
		t.Errorf("base.port = %q, want untouched 8080", got)
	}
}

func TestInterpolationUsesFinalFields(t *testing.T) {
	// dir is overridden in the child; path (inherited from base) must
	// interpolate against the child's final dir.
	r := mustResolve(t, `
[base]
dir = /srv
path = ${dir}/app

[child]
extends = base
dir = /opt
`)
	if got := mustGet(t, r, "child", "path"); got != "/opt/app" {
		t.Errorf("child.path = %q, want /opt/app (interpolation on final fields)", got)
	}
	if got := mustGet(t, r, "base", "path"); got != "/srv/app" {
		t.Errorf("base.path = %q, want /srv/app", got)
	}
}

func TestCrossSectionAndNestedInterpolation(t *testing.T) {
	r := mustResolve(t, `
[net]
host = example.com
port = 443

[app]
url = https://${net.host}:${net.port}/${name}
name = shop
`)
	if got := mustGet(t, r, "app", "url"); got != "https://example.com:443/shop" {
		t.Errorf("app.url = %q", got)
	}
}

func TestDiamondInheritanceModelsAgree(t *testing.T) {
	src := `
[d]
shared = from-d
donly = d

[b]
extends = d
shared = from-b
bonly = b

[c]
extends = d
conly = c

[a]
extends = b, c
aonly = a
`
	r := mustResolve(t, src)
	if diffs := r.CompareModels(); len(diffs) != 0 {
		t.Fatalf("models disagree:\n%s", strings.Join(diffs, "\n"))
	}
	// Diamond: a reaches d through both b and c; earlier parent (b) wins.
	if got := mustGet(t, r, "a", "shared"); got != "from-b" {
		t.Errorf("a.shared = %q, want from-b", got)
	}
	for _, k := range []string{"shared", "donly", "bonly", "conly", "aonly"} {
		if _, ok := r.Field("a", k); !ok {
			t.Errorf("a.%s missing after diamond merge", k)
		}
	}
	// Source tracking through the diamond.
	f, _ := r.Field("a", "shared")
	if f.Source != "b" {
		t.Errorf("a.shared source = %q, want b", f.Source)
	}
	f, _ = r.Field("a", "donly")
	if f.Source != "d" {
		t.Errorf("a.donly source = %q, want d", f.Source)
	}
}

func TestMultiParentPrecedence(t *testing.T) {
	r := mustResolve(t, `
[p1]
x = one
[p2]
x = two
[child]
extends = p1, p2
`)
	if got := mustGet(t, r, "child", "x"); got != "one" {
		t.Errorf("child.x = %q, want one (earlier parent wins)", got)
	}
}

func TestInheritanceCyclePath(t *testing.T) {
	c := mustParse(t, `
[a]
extends = b
[b]
extends = c
[c]
extends = a
`)
	_, err := c.Resolve()
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("err = %v, want *CycleError", err)
	}
	if cyc.Kind != "inheritance" {
		t.Errorf("Kind = %q, want inheritance", cyc.Kind)
	}
	if len(cyc.Path) < 2 || cyc.Path[0] != cyc.Path[len(cyc.Path)-1] {
		t.Errorf("Path = %v, want closed cycle path", cyc.Path)
	}
	if got := cyc.Error(); !strings.Contains(got, " -> ") {
		t.Errorf("Error() = %q, want arrow-joined path", got)
	}
	t.Logf("cycle path: %s", cyc.Error())
}

func TestSelfInheritanceCycle(t *testing.T) {
	c := mustParse(t, "[a]\nextends = a\n")
	_, err := c.Resolve()
	var cyc *CycleError
	if !errors.As(err, &cyc) || !reflect.DeepEqual(cyc.Path, []string{"a", "a"}) {
		t.Fatalf("err = %v, want inheritance cycle a -> a", err)
	}
}

func TestInterpolationCyclePath(t *testing.T) {
	r := mustResolve(t, `
[sec]
a = ${b}
b = ${c}
c = ${a}
`)
	_, err := r.Get("sec", "a")
	var cyc *CycleError
	if !errors.As(err, &cyc) {
		t.Fatalf("err = %v, want *CycleError", err)
	}
	if cyc.Kind != "interpolation" {
		t.Errorf("Kind = %q, want interpolation", cyc.Kind)
	}
	want := []string{"sec.a", "sec.b", "sec.c", "sec.a"}
	if !reflect.DeepEqual(cyc.Path, want) {
		t.Errorf("Path = %v, want %v", cyc.Path, want)
	}
	t.Logf("cycle path: %s", cyc.Error())
}

func TestInterpolationSelfCycle(t *testing.T) {
	r := mustResolve(t, "[s]\nx = ${x}\n")
	_, err := r.Get("s", "x")
	var cyc *CycleError
	if !errors.As(err, &cyc) || !reflect.DeepEqual(cyc.Path, []string{"s.x", "s.x"}) {
		t.Fatalf("err = %v, want interpolation cycle s.x -> s.x", err)
	}
}

func TestMissingReferenceFails(t *testing.T) {
	r := mustResolve(t, `
[s]
a = ${nope}
b = ${ghost.field}
`)
	for _, tc := range []struct{ key, wantRef string }{
		{"a", "s.nope"},
		{"b", "ghost.field"},
	} {
		_, err := r.Get("s", tc.key)
		var miss *MissingRefError
		if !errors.As(err, &miss) {
			t.Fatalf("Get(s.%s) err = %v, want *MissingRefError", tc.key, err)
		}
		if miss.Ref != tc.wantRef {
			t.Errorf("Get(s.%s) missing ref = %q, want %q", tc.key, miss.Ref, tc.wantRef)
		}
	}
	if _, err := r.Get("nosuch", "x"); err == nil {
		t.Error("Get on unknown section should fail")
	}
}

func TestUnknownParentFails(t *testing.T) {
	c := mustParse(t, "[a]\nextends = ghost\n")
	if _, err := c.Resolve(); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("err = %v, want unknown-parent error naming ghost", err)
	}
}

func TestUnterminatedInterpolation(t *testing.T) {
	r := mustResolve(t, "[s]\nx = ${oops\n")
	if _, err := r.Get("s", "x"); err == nil || !strings.Contains(err.Error(), "unterminated") {
		t.Fatalf("err = %v, want unterminated-reference error", err)
	}
}

func TestPerFieldModelMatchesMergedModel(t *testing.T) {
	// Deeper diamond plus extra parents and overrides at every level.
	src := `
[root]
a = root-a
b = root-b
c = root-c

[m1]
extends = root
a = m1-a

[m2]
extends = root
b = m2-b

[mid]
extends = m1, m2
c = mid-c

[leaf]
extends = mid, root
d = leaf-d
`
	r := mustResolve(t, src)
	if diffs := r.CompareModels(); len(diffs) != 0 {
		t.Fatalf("models disagree:\n%s", strings.Join(diffs, "\n"))
	}
	if got := mustGet(t, r, "leaf", "a"); got != "m1-a" {
		t.Errorf("leaf.a = %q, want m1-a", got)
	}
	// m1 is the earlier parent of mid, so m1's whole subtree (including
	// root's b) wins over m2's own b in both models.
	if got := mustGet(t, r, "leaf", "b"); got != "root-b" {
		t.Errorf("leaf.b = %q, want root-b", got)
	}
}

func TestSourceTracking(t *testing.T) {
	c := mustParse(t, "\n[base]\nx = 1\ny = 2\n\n[child]\nextends = base\ny = 20\n")
	r, err := c.Resolve()
	if err != nil {
		t.Fatal(err)
	}
	x, _ := r.Field("child", "x")
	if x.Source != "base" || x.Line != 3 {
		t.Errorf("child.x source = %q line %d, want base line 3", x.Source, x.Line)
	}
	y, _ := r.Field("child", "y")
	if y.Source != "child" || y.Line != 8 {
		t.Errorf("child.y source = %q line %d, want child line 8", y.Source, y.Line)
	}
	if path := c.InheritancePath("child", "base"); !reflect.DeepEqual(path, []string{"child", "base"}) {
		t.Errorf("InheritancePath = %v", path)
	}
	if path := c.InheritancePath("base", "child"); path != nil {
		t.Errorf("InheritancePath(base, child) = %v, want nil", path)
	}
}

func TestParseErrors(t *testing.T) {
	for _, src := range []string{
		"key = value\n",       // outside section
		"[s]\nbad line\n",     // no '='
		"[s]\n[s]\n",          // duplicate section
		"[s]\na = 1\na = 2\n", // duplicate key
		"[unclosed\n",         // malformed header
	} {
		if _, err := Parse(strings.NewReader(src)); err == nil {
			t.Errorf("Parse(%q) succeeded, want error", src)
		}
	}
}
