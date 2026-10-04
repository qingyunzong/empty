package main

import (
	"math/rand"
	"reflect"
	"strconv"
	"testing"
)

func TestReplayOK(t *testing.T) {
	h := mustParse(t, "W1(x) R2(x1) W2(y) R3(y2)")
	checks, ok := Replay(h, []int{1, 2, 3})
	if !ok {
		t.Fatalf("replay failed: %v", checks)
	}
	if len(checks) != 2 {
		t.Fatalf("checks = %v", checks)
	}
}

func TestReplayMismatch(t *testing.T) {
	h := mustParse(t, "W1(x) W2(x) R3(x1)")
	// 串行序 T2,T1,T3: T3 读 x 时最新版本是 x1? 否——T1 在 T2 后写, 读到 x1 仍成立。
	// 改用 T1,T3,T2: T3 读时最新为 x1, 成立; 再构造真正失败的:
	// 串行序 T2,T3,T1: T3 读时最新版本是 x2, 与声明 x1 不符。
	checks, ok := Replay(h, []int{2, 3, 1})
	if ok {
		t.Fatal("expected replay failure")
	}
	if len(checks) != 1 || checks[0].Want != 1 || checks[0].Got != 2 {
		t.Fatalf("checks = %+v", checks)
	}
}

func TestEnumeratePermutations(t *testing.T) {
	h := mustParse(t, "W1(x) R2(x1) W2(y) R3(y2)")
	valid, total := EnumeratePermutations(h)
	if total != 6 {
		t.Fatalf("total = %d, want 6", total)
	}
	// 约束: T1<T2, T2<T3 => 唯一有效序 T1,T2,T3。
	if len(valid) != 1 || !reflect.DeepEqual(valid[0], []int{1, 2, 3}) {
		t.Fatalf("valid = %v", valid)
	}
}

func TestEnumerateCyclicHasNoValidPerm(t *testing.T) {
	h := mustParse(t, "W1(x) W3(y) R1(y3) R2(x1) W3(x)")
	valid, total := EnumeratePermutations(h)
	if total != 6 {
		t.Fatalf("total = %d, want 6", total)
	}
	if len(valid) != 0 {
		t.Fatalf("valid = %v, want none", valid)
	}
}

// 随机小历史: 图判定(无环) 必须与排列枚举(存在有效串行序)一致;
// 且无环时拓扑序重放必须通过。
func TestRandomHistoriesConsistent(t *testing.T) {
	rng := rand.New(rand.NewSource(20261005))
	items := []string{"x", "y", "z"}
	for trial := 0; trial < 5000; trial++ {
		nTxn := 2 + rng.Intn(5) // 2..6 事务
		nOps := 1 + rng.Intn(14)
		written := map[string][]int{} // item -> 已写版本(事务ID)
		txnUsed := map[int]bool{}
		var input []byte
		pos := 0
		for pos < nOps {
			txn := 1 + rng.Intn(nTxn)
			item := items[rng.Intn(len(items))]
			canWrite := true
			for _, w := range written[item] {
				if w == txn {
					canWrite = false
				}
			}
			doRead := len(written[item]) > 0 && (!canWrite || rng.Intn(2) == 0)
			if pos > 0 {
				input = append(input, ' ')
			}
			if doRead {
				vers := written[item]
				v := vers[rng.Intn(len(vers))]
				if !canWrite { // 自己写过该项, 只能读自己的版本
					v = txn
				}
				input = append(input, []byte("R"+strconv.Itoa(txn)+"("+item+strconv.Itoa(v)+")")...)
			} else if canWrite {
				input = append(input, []byte("W"+strconv.Itoa(txn)+"("+item+")")...)
				written[item] = append(written[item], txn)
			} else {
				continue
			}
			txnUsed[txn] = true
			pos++
		}
		h, err := ParseHistory(string(input))
		if err != nil {
			t.Fatalf("trial %d: generated history %q failed parse: %v", trial, input, err)
		}
		rep := Analyze(h)
		if !rep.EnumDone {
			t.Fatalf("trial %d: enumeration should run for %d txns", trial, len(h.Txns))
		}
		if !rep.EnumMatch {
			t.Fatalf("trial %d: mismatch on %q: acyclic=%v validPerms=%d",
				trial, input, rep.Acyclic, len(rep.EnumValid))
		}
		if rep.Acyclic && !rep.ReplayOK {
			t.Fatalf("trial %d: topo order replay failed on %q: %v", trial, input, rep.Checks)
		}
	}
}
