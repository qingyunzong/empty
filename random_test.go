package bracketdiag

import (
	"math/rand"
	"testing"
)

// chunks 是构造随机文本的切块：既有成对/单个括号，也有引号、注释
// 定界符、转义符与代码片段，组合后可覆盖各种词法状态迁移。
var chunks = []string{
	"(", ")", "[", "]", "{", "}",
	"()", "[]", "{}", "([])", "{a(b[c]d)}",
	`"`, `'`, "`", `\`,
	`"s"`, `'c'`, "`raw`", `"\""`, `'\\'`,
	"//", "/*", "*/", "// c\n", "/* c */", "/* a\nb */",
	"a", "foo", " ", "\n", "\n\n", "0", ";", "f(x)",
	"\"unterminated", "/* unterminated", "'x",
}

func randomText(r *rand.Rand, n int) string {
	s := ""
	for i := 0; i < n; i++ {
		s += chunks[r.Intn(len(chunks))]
	}
	return s
}

// assertConsistent 校验增量维护的诊断结果与全量扫描一致，
// 重点核对匹配对及最早错误位置。
func assertConsistent(t *testing.T, d *Document) {
	t.Helper()
	text := d.Text()
	want := Analyze(text)
	got := d.Diagnostics()
	if equalDiagnostics(got, want) {
		return
	}
	t.Fatalf("incremental != full scan\ntext: %q\ngot:  %+v\nwant: %+v", text, got, want)
}

// TestRandomChunkCombinations 用随机切块组合构建文档，核对匹配对
// 与最早错误位置同全量扫描一致。
func TestRandomChunkCombinations(t *testing.T) {
	for seed := int64(0); seed < 200; seed++ {
		r := rand.New(rand.NewSource(seed))
		d := NewDocument(randomText(r, 20+r.Intn(30)))
		assertConsistent(t, d)
	}
}

// TestRandomEdits 在随机文本上执行随机插入/删除，每步都将增量结果
// （匹配对、未配对位置、最早错误）与全量扫描对拍。
func TestRandomEdits(t *testing.T) {
	for seed := int64(0); seed < 100; seed++ {
		r := rand.New(rand.NewSource(seed))
		d := NewDocument(randomText(r, 15+r.Intn(20)))
		assertConsistent(t, d)
		for step := 0; step < 60; step++ {
			n := d.Len()
			if n > 0 && r.Intn(2) == 0 {
				// 删除随机区间。
				start := r.Intn(n)
				end := start + r.Intn(min(n-start, 12)+1)
				if err := d.Edit(start, end, ""); err != nil {
					t.Fatalf("seed %d step %d delete: %v", seed, step, err)
				}
			} else {
				// 在随机位置插入随机切块组合。
				pos := 0
				if n > 0 {
					pos = r.Intn(n + 1)
				}
				if err := d.Edit(pos, pos, randomText(r, 1+r.Intn(3))); err != nil {
					t.Fatalf("seed %d step %d insert: %v", seed, step, err)
				}
			}
			assertConsistent(t, d)
		}
	}
}

// TestRandomEditsOnCode 在类代码文本上执行随机编辑并对拍。
func TestRandomEditsOnCode(t *testing.T) {
	base := `package main

// greet prints "hello (world)"
func greet(name string) {
	msg := "hi, " + name + "!" // trailing ) comment
	/* multi
	   line (comment) */
	if len(msg) > 0 {
		println(msg[0], '}')
	}
}
`
	for seed := int64(0); seed < 50; seed++ {
		r := rand.New(rand.NewSource(seed + 100000))
		d := NewDocument(base)
		assertConsistent(t, d)
		for step := 0; step < 80; step++ {
			n := d.Len()
			switch r.Intn(3) {
			case 0: // 插入随机切块
				pos := r.Intn(n + 1)
				if err := d.Edit(pos, pos, chunks[r.Intn(len(chunks))]); err != nil {
					t.Fatal(err)
				}
			case 1: // 删除随机区间
				if n == 0 {
					continue
				}
				start := r.Intn(n)
				end := start + r.Intn(min(n-start, 8)+1)
				if err := d.Edit(start, end, ""); err != nil {
					t.Fatal(err)
				}
			default: // 替换随机区间
				if n == 0 {
					continue
				}
				start := r.Intn(n)
				end := start + r.Intn(min(n-start, 8)+1)
				if err := d.Edit(start, end, randomText(r, 1+r.Intn(2))); err != nil {
					t.Fatal(err)
				}
			}
			assertConsistent(t, d)
		}
	}
}
