package cfg

import (
	"strings"
	"testing"
)

func mustResolve(t *testing.T, text string) *Config {
	t.Helper()
	c, err := Parse(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := c.Resolve(); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	return c
}

func mustErr[T any](t *testing.T, text string, run func(*Config) (T, error)) error {
	t.Helper()
	c, err := Parse(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, err = run(c)
	if err == nil {
		t.Fatalf("expected error, got none")
	}
	return err
}

func TestInheritThenOverride(t *testing.T) {
	c := mustResolve(t, `
[base]
host = localhost
port = 5432
[prod]
inherit = base
host = db.internal
`)
	got := c.Sections["prod"].Values
	if got["host"] != "db.internal" {
		t.Errorf("own field must override inherited one, got %q", got["host"])
	}
	if got["port"] != "5432" {
		t.Errorf("inherited field missing, got %q", got["port"])
	}
	if c.Sections["prod"].Origin["host"] != "prod" || c.Sections["prod"].Origin["port"] != "base" {
		t.Errorf("wrong origins: %v", c.Sections["prod"].Origin)
	}
}

func TestMultipleParentsLaterWins(t *testing.T) {
	c := mustResolve(t, `
[a]
x = from-a
[b]
x = from-b
y = only-b
[c]
inherit = a, b
`)
	got := c.Sections["c"].Values
	if got["x"] != "from-b" {
		t.Errorf("later parent should override earlier, got %q", got["x"])
	}
	if got["y"] != "only-b" {
		t.Errorf("missing field from second parent, got %q", got["y"])
	}
}

func TestDiamondInheritance(t *testing.T) {
	c := mustResolve(t, `
[a]
root = /a
shared = a-value
[b]
inherit = a
root = /b
[c]
inherit = a
[d]
inherit = b, c
`)
	got := c.Sections["d"].Values
	// b is merged first, then c; c carries a's root=/a which overrides b's.
	if got["root"] != "/a" {
		t.Errorf("diamond merge order wrong, got %q", got["root"])
	}
	if got["shared"] != "a-value" {
		t.Errorf("common ancestor field lost, got %q", got["shared"])
	}
	if c.Sections["d"].Origin["root"] != "a" {
		t.Errorf("winner should be a (reached via c), got %q", c.Sections["d"].Origin["root"])
	}
}

func TestInheritanceCyclePath(t *testing.T) {
	err := mustErr(t, `
[a]
inherit = c
[b]
inherit = a
[c]
inherit = b
`, func(c *Config) (any, error) { return nil, c.Resolve() })
	ce, ok := err.(*CycleError)
	if !ok {
		t.Fatalf("expected CycleError, got %T: %v", err, err)
	}
	if ce.Kind != "inheritance" {
		t.Errorf("wrong kind %q", ce.Kind)
	}
	msg := ce.Error()
	if !strings.Contains(msg, "a -> c -> b -> a") {
		t.Errorf("cycle path missing or wrong: %q", msg)
	}
}

func TestMissingParentFails(t *testing.T) {
	err := mustErr(t, `
[a]
inherit = ghost
`, func(c *Config) (any, error) { return nil, c.Resolve() })
	if _, ok := err.(*MissingError); !ok {
		t.Fatalf("expected MissingError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), `missing section "ghost"`) {
		t.Errorf("unhelpful message: %q", err)
	}
}

func TestInterpolationUsesFinalFields(t *testing.T) {
	c := mustResolve(t, `
[base]
root = /srv/base
data = ${root}/data
[child]
inherit = base
root = /srv/child
`)
	// data is inherited from base, but interpolation expands against
	// child's final fields, so ${root} is the overridden value.
	if got := c.Sections["child"].Values["data"]; got != "/srv/child/data" {
		t.Errorf("interpolation must use final fields, got %q", got)
	}
	if got := c.Sections["base"].Values["data"]; got != "/srv/base/data" {
		t.Errorf("base section corrupted, got %q", got)
	}
}

func TestCrossSectionReference(t *testing.T) {
	c := mustResolve(t, `
[net]
host = example.com
[web]
url = https://${net.host}/api
`)
	if got := c.Sections["web"].Values["url"]; got != "https://example.com/api" {
		t.Errorf("cross-section reference failed, got %q", got)
	}
}

func TestInterpolationCyclePath(t *testing.T) {
	err := mustErr(t, `
[s]
a = ${b}
b = ${c}
c = ${a}
`, func(c *Config) (any, error) { return nil, c.Resolve() })
	ce, ok := err.(*CycleError)
	if !ok {
		t.Fatalf("expected CycleError, got %T: %v", err, err)
	}
	if ce.Kind != "interpolation" {
		t.Errorf("wrong kind %q", ce.Kind)
	}
	if !strings.Contains(ce.Error(), "s.a -> s.b -> s.c -> s.a") {
		t.Errorf("cycle path missing or wrong: %q", ce.Error())
	}
}

func TestMissingReferenceFails(t *testing.T) {
	err := mustErr(t, `
[s]
a = ${nope}
`, func(c *Config) (any, error) { return nil, c.Resolve() })
	if _, ok := err.(*MissingError); !ok {
		t.Fatalf("expected MissingError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "${nope}") {
		t.Errorf("message should name the reference: %q", err)
	}
}

func TestMissingSectionReferenceFails(t *testing.T) {
	err := mustErr(t, `
[s]
a = ${ghost.field}
`, func(c *Config) (any, error) { return nil, c.Resolve() })
	if _, ok := err.(*MissingError); !ok {
		t.Fatalf("expected MissingError, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), `missing section "ghost"`) {
		t.Errorf("message should name the section: %q", err)
	}
}

func TestTraceProvenance(t *testing.T) {
	c := mustResolve(t, `
[base]
root = /srv
data = ${root}/data
[child]
inherit = base
root = /opt
`)
	tr, err := c.TraceField("child", "data")
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	if tr.Value != "/opt/data" {
		t.Errorf("wrong traced value %q", tr.Value)
	}
	if len(tr.Chain) != 1 || tr.Chain[0].Section != "base" {
		t.Errorf("chain should hold the winning base definition, got %+v", tr.Chain)
	}
	if len(tr.Interp) != 1 || tr.Interp[0].Ref != (Ref{Section: "child", Field: "root"}) {
		t.Fatalf("interp tree should reference child.root, got %+v", tr.Interp)
	}
	if tr.Interp[0].Value != "/opt" || tr.Interp[0].Origin != "child" {
		t.Errorf("interp node should show /opt from [child], got %+v", tr.Interp[0])
	}
	out := tr.String()
	for _, want := range []string{"child.data = /opt/data", "[base] data = ${root}/data", "child.root = /opt"} {
		if !strings.Contains(out, want) {
			t.Errorf("trace output missing %q:\n%s", want, out)
		}
	}
}

func TestTraceChainOrderDiamond(t *testing.T) {
	c := mustResolve(t, `
[a]
x = a-x
[b]
inherit = a
x = b-x
[c]
inherit = a
[d]
inherit = b, c
`)
	tr, err := c.TraceField("d", "x")
	if err != nil {
		t.Fatalf("trace: %v", err)
	}
	// c is merged after b and carries a's definition, so a wins.
	if got := tr.Chain[len(tr.Chain)-1]; got.Section != "a" {
		t.Errorf("winner should be [a] via c, got %+v (chain %+v)", got, tr.Chain)
	}
	if len(tr.Chain) != 2 || tr.Chain[0].Section != "b" {
		t.Errorf("chain should be b then a, got %+v", tr.Chain)
	}
}

const diamondConfig = `
[a]
root = /a
plain = shared
[b]
inherit = a
path = ${root}/b
[c]
inherit = a
who = c
[d]
inherit = b, c
root = /d
`

func TestDiamondFlattenVsRecursive(t *testing.T) {
	c, err := Parse(diamondConfig)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if err := c.Resolve(); err != nil {
		t.Fatalf("resolve: %v", err)
	}
	rec, err := c.ResolveRecursive()
	if err != nil {
		t.Fatalf("recursive: %v", err)
	}
	// Flatten model: interpolation expands against d's final fields,
	// so the inherited path uses d's overridden root.
	if got := c.Sections["d"].Values["path"]; got != "/d/b" {
		t.Errorf("flatten model: got %q, want /d/b", got)
	}
	// Recursive model: path is defined in b, so ${root} expands in b's
	// context, where root still comes from a.
	if got := rec["d"]["path"]; got != "/a/b" {
		t.Errorf("recursive model: got %q, want /a/b", got)
	}
	// Plain fields agree in both models.
	if c.Sections["d"].Values["plain"] != rec["d"]["plain"] {
		t.Errorf("plain fields must agree: %q vs %q", c.Sections["d"].Values["plain"], rec["d"]["plain"])
	}
	if c.Sections["d"].Values["who"] != "c" || rec["d"]["who"] != "c" {
		t.Errorf("plain inherited field wrong")
	}
}

func TestCompareModels(t *testing.T) {
	c, err := Parse(diamondConfig)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	diffs, err := c.CompareModels()
	if err != nil {
		t.Fatalf("compare: %v", err)
	}
	if len(diffs) != 1 {
		t.Fatalf("expected exactly one divergent field, got %+v", diffs)
	}
	d := diffs[0]
	if d.Ref != (Ref{Section: "d", Field: "path"}) || d.Flatten != "/d/b" || d.Recursive != "/a/b" {
		t.Errorf("unexpected diff: %+v", d)
	}
}

func TestRecursiveModelDetectsCyclesToo(t *testing.T) {
	err := mustErr(t, `
[s]
a = ${b}
b = ${a}
`, func(c *Config) (any, error) { return c.ResolveRecursive() })
	ce, ok := err.(*CycleError)
	if !ok || ce.Kind != "interpolation" {
		t.Fatalf("expected interpolation CycleError, got %T: %v", err, err)
	}
	if !strings.Contains(ce.Error(), "s.a -> s.b -> s.a") {
		t.Errorf("cycle path wrong: %q", ce.Error())
	}
}
