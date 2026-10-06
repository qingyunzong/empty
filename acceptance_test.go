package main

import (
	"math/rand"
	"strings"
	"testing"

	"libread/checker"
	"libread/genlog"
)

func parseLines(t *testing.T, lines []string) []checker.Event {
	t.Helper()
	events, err := checker.Parse(strings.NewReader(strings.Join(lines, "\n")))
	if err != nil {
		t.Fatalf("解析失败: %v\n日志:\n%s", err, strings.Join(lines, "\n"))
	}
	return events
}

// 随机生成的合法日志必须全部通过检查。
func TestRandomValidLogsPass(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		lines := genlog.Generate(rng, 60)
		if v := checker.CheckEvents(parseLines(t, lines)); v != nil {
			t.Fatalf("seed %d: 合法日志被误判:\n%v\n日志:\n%s",
				seed, v, strings.Join(lines, "\n"))
		}
	}
}

// 对随机合法日志施加单处破坏，检查器必须报出首错及完整因果链。
func TestSinglePointCorruptionDetected(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		rng := rand.New(rand.NewSource(seed))
		lines := genlog.Generate(rng, 60)
		for _, c := range genlog.All() {
			bad, ok := c.Apply(lines, rng)
			if !ok {
				continue
			}
			v := checker.CheckEvents(parseLines(t, bad))
			if v == nil {
				t.Fatalf("seed %d: 破坏「%s」未被检出\n日志:\n%s",
					seed, c.Name, strings.Join(bad, "\n"))
			}
			if len(v.Chain) == 0 {
				t.Fatalf("seed %d: 破坏「%s」的因果链为空", seed, c.Name)
			}
			if v.Line < 1 || v.Line > len(bad) {
				t.Fatalf("seed %d: 破坏「%s」首错行号 %d 越界", seed, c.Name, v.Line)
			}
		}
	}
}

// 随机单点破坏（模拟验收流程：合法日志 -> 单处破坏 -> 必须检出）。
func TestRandomSingleCorruptionAcceptance(t *testing.T) {
	for seed := int64(1000); seed < 1200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		lines := genlog.Generate(rng, 80)
		if v := checker.CheckEvents(parseLines(t, lines)); v != nil {
			t.Fatalf("seed %d: 合法日志被误判: %v", seed, v)
		}
		bad, name, ok := genlog.Corrupt(lines, rng)
		if !ok {
			t.Fatalf("seed %d: 无适用破坏器", seed)
		}
		if v := checker.CheckEvents(parseLines(t, bad)); v == nil {
			t.Fatalf("seed %d: 随机破坏「%s」未被检出", seed, name)
		}
	}
}
