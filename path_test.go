package dataeng

import "testing"

func TestCanonicalPathNormalizesOnlySafeURIComponents(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
	}{
		{name: "scheme and host case", a: "S3://Bucket/Key/File.parquet", b: "s3://bucket/Key/File.parquet"},
		{name: "unreserved escape", a: "s3://bucket/%41%62c", b: "s3://bucket/Abc"},
		{name: "reserved escape case", a: "s3://bucket/a%2fb", b: "s3://bucket/a%2Fb"},
		{name: "ipv6 host case", a: "s3://[ABCD::1]/x", b: "s3://[abcd::1]/x"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got, want := CanonicalPath(test.a), CanonicalPath(test.b); got != want {
				t.Fatalf("CanonicalPath(%q) = %q, CanonicalPath(%q) = %q", test.a, got, test.b, want)
			}
			if !PathsEqual(test.a, test.b) {
				t.Fatalf("expected %q and %q to be equal", test.a, test.b)
			}
		})
	}
}

func TestCanonicalPathDoesNotMergeDistinctObjects(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
	}{
		{name: "trailing slash", a: "s3://bucket/data", b: "s3://bucket/data/"},
		{name: "repeated slash", a: "s3://bucket/data", b: "s3://bucket//data"},
		{name: "dot segment", a: "s3://bucket/data", b: "s3://bucket/./data"},
		{name: "parent segment", a: "s3://bucket/b", b: "s3://bucket/a/../b"},
		{name: "encoded slash", a: "s3://bucket/a/b", b: "s3://bucket/a%2Fb"},
		{name: "path case", a: "s3://bucket/Data", b: "s3://bucket/data"},
		{name: "query value", a: "s3://bucket/data?versionId=1", b: "s3://bucket/data?versionId=2"},
		{name: "fragment", a: "s3://bucket/data#one", b: "s3://bucket/data#two"},
		{name: "scheme", a: "s3://bucket/data", b: "gs://bucket/data"},
		{name: "local relative forms", a: "data/file.parquet", b: "./data/file.parquet"},
		{name: "windows drive", a: `C:\data\file.parquet`, b: `c:\data\file.parquet`},
		{name: "colon in local filename", a: "FOO:bar.parquet", b: "foo:bar.parquet"},
		{name: "single-letter scheme", a: "C://data/file.parquet", b: "c://data/file.parquet"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if PathsEqual(test.a, test.b) {
				t.Fatalf("expected %q and %q to remain distinct (canonical %q vs %q)",
					test.a, test.b, CanonicalPath(test.a), CanonicalPath(test.b))
			}
		})
	}
}

func TestCanonicalPathPreservesQueryAndFragmentBytes(t *testing.T) {
	got := CanonicalPath("S3://Bucket/Key?x=%7e&url=a%2fb#Frag%41")
	want := "s3://bucket/Key?x=~&url=a%2Fb#FragA"
	if got != want {
		t.Fatalf("CanonicalPath() = %q, want %q", got, want)
	}
}

func TestCanonicalPathLeavesMalformedEscapesAlone(t *testing.T) {
	for _, input := range []string{"s3://bucket/a%zz", "s3://bucket/a%2", "plain%2fpath"} {
		if got := CanonicalPath(input); got != input {
			t.Fatalf("CanonicalPath(%q) = %q, want unchanged", input, got)
		}
	}
}

func TestCanonicalPathIsIdempotent(t *testing.T) {
	inputs := []string{
		"S3://Bucket/A%2fb?x=%41#F%2f",
		"s3://[ABCD::1%Eth0]/x",
		`C:\Data\File.parquet`,
		"plain/path",
	}
	for _, input := range inputs {
		once := CanonicalPath(input)
		if twice := CanonicalPath(once); twice != once {
			t.Fatalf("CanonicalPath is not idempotent for %q: %q -> %q", input, once, twice)
		}
	}
}
