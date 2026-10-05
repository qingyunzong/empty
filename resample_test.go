package resample_test

import (
	"errors"
	"fmt"
	"math/big"
	"math/rand"
	"testing"

	"resample"
)

func rat(n, d int64) *big.Rat { return big.NewRat(n, d) }

func fmtPts(pts []resample.Point) string {
	s := ""
	for _, p := range pts {
		s += fmt.Sprintf(" (%v,%v)", p.T, p.V)
	}
	return s
}

// expectPoints 精确比对输出序列，want 中每项为 {tNum, tDen, vNum, vDen}。
func expectPoints(t *testing.T, got []resample.Point, want ...[4]int64) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d points:%s, want %d", len(got), fmtPts(got), len(want))
	}
	for i, w := range want {
		wt, wv := rat(w[0], w[1]), rat(w[2], w[3])
		if got[i].T.Cmp(wt) != 0 || got[i].V.Cmp(wv) != 0 {
			t.Fatalf("point %d: got (%v, %v), want (%v, %v); all:%s",
				i, got[i].T, got[i].V, wt, wv, fmtPts(got))
		}
	}
}

func ptsEqual(a, b []resample.Point) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].T.Cmp(b[i].T) != 0 || a[i].V.Cmp(b[i].V) != 0 {
			return false
		}
	}
	return true
}

func TestBasicInterpolation(t *testing.T) {
	s, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err := s.Write([]resample.Sample{{rat(0, 1), rat(0, 1)}, {rat(2, 1), rat(4, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts, [4]int64{0, 1, 0, 1}, [4]int64{1, 1, 2, 1}, [4]int64{2, 1, 4, 1})

	pts, err = s.Write([]resample.Sample{{rat(3, 1), rat(7, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts, [4]int64{3, 1, 7, 1})
	if err := s.End(); err != nil {
		t.Fatal(err)
	}
}

func TestFractionalStep(t *testing.T) {
	s, err := resample.New(rat(1, 2))
	if err != nil {
		t.Fatal(err)
	}
	pts, err := s.Write([]resample.Sample{{rat(0, 1), rat(0, 1)}, {rat(1, 1), rat(3, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts,
		[4]int64{0, 1, 0, 1}, [4]int64{1, 2, 3, 2}, [4]int64{1, 1, 3, 1})
}

func TestOriginExplicit(t *testing.T) {
	// 首样本在 t=2：t=0,1 的网格点位于序列头部缺失区，不产生输出。
	s, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err := s.Write([]resample.Sample{{rat(2, 1), rat(10, 1)}, {rat(4, 1), rat(20, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts,
		[4]int64{2, 1, 10, 1}, [4]int64{3, 1, 15, 1}, [4]int64{4, 1, 20, 1})

	// 首样本在 t=0：原点是显式网格点，必须输出。
	s2, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err = s2.Write([]resample.Sample{{rat(0, 1), rat(5, 1)}, {rat(1, 1), rat(5, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts, [4]int64{0, 1, 5, 1}, [4]int64{1, 1, 5, 1})
}

func TestGapNotInterpolated(t *testing.T) {
	s, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	var got []resample.Point
	pts, err := s.Write([]resample.Sample{{rat(0, 1), rat(0, 1)}, {rat(2, 1), rat(2, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, pts...)
	if err := s.Break(); err != nil {
		t.Fatal(err)
	}
	pts, err = s.Write([]resample.Sample{{rat(5, 1), rat(10, 1)}, {rat(6, 1), rat(12, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, pts...)
	// t=3,4 位于缺失段，不插值。
	expectPoints(t, got,
		[4]int64{0, 1, 0, 1}, [4]int64{1, 1, 1, 1}, [4]int64{2, 1, 2, 1},
		[4]int64{5, 1, 10, 1}, [4]int64{6, 1, 12, 1})
}

func TestNoExtrapolationAtTail(t *testing.T) {
	// 最后一个样本之后没有右端点，即使 End 也不外推。
	s, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err := s.Write([]resample.Sample{{rat(0, 1), rat(0, 1)}, {rat(2, 1), rat(4, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts, [4]int64{0, 1, 0, 1}, [4]int64{1, 1, 2, 1}, [4]int64{2, 1, 4, 1})
	if err := s.End(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write([]resample.Sample{{rat(3, 1), rat(0, 1)}}); !errors.Is(err, resample.ErrEnded) {
		t.Fatalf("Write after End: got %v, want ErrEnded", err)
	}

	// 孤立的非网格样本：左右都没有可插值的端点，零输出。
	s2, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err = s2.Write([]resample.Sample{{rat(3, 2), rat(5, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts)
	if err := s2.End(); err != nil {
		t.Fatal(err)
	}

	// 孤立样本恰好落在网格上：输出其自身精确值。
	s3, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err = s3.Write([]resample.Sample{{rat(2, 1), rat(5, 1)}})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts, [4]int64{2, 1, 5, 1})
}

func TestSampleExactlyOnGrid(t *testing.T) {
	s, err := resample.New(rat(1, 1))
	if err != nil {
		t.Fatal(err)
	}
	pts, err := s.Write([]resample.Sample{
		{rat(0, 1), rat(0, 1)}, {rat(2, 1), rat(6, 1)}, {rat(4, 1), rat(0, 1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	expectPoints(t, pts,
		[4]int64{0, 1, 0, 1}, [4]int64{1, 1, 3, 1}, [4]int64{2, 1, 6, 1},
		[4]int64{3, 1, 3, 1}, [4]int64{4, 1, 0, 1})
}

func TestErrors(t *testing.T) {
	if _, err := resample.New(nil); !errors.Is(err, resample.ErrBadStep) {
		t.Fatalf("New(nil): got %v", err)
	}
	if _, err := resample.New(rat(0, 1)); !errors.Is(err, resample.ErrBadStep) {
		t.Fatalf("New(0): got %v", err)
	}
	if _, err := resample.New(rat(-1, 2)); !errors.Is(err, resample.ErrBadStep) {
		t.Fatalf("New(-1/2): got %v", err)
	}

	s, _ := resample.New(rat(1, 1))
	if _, err := s.Write([]resample.Sample{{nil, rat(0, 1)}}); !errors.Is(err, resample.ErrNilRat) {
		t.Fatalf("nil T: got %v", err)
	}
	if _, err := s.Write([]resample.Sample{{rat(0, 1), nil}}); !errors.Is(err, resample.ErrNilRat) {
		t.Fatalf("nil V: got %v", err)
	}
	if _, err := s.Write([]resample.Sample{{rat(-1, 1), rat(0, 1)}}); !errors.Is(err, resample.ErrNegativeTime) {
		t.Fatalf("negative T: got %v", err)
	}
	if _, err := s.Write([]resample.Sample{{rat(1, 1), rat(0, 1)}, {rat(1, 1), rat(0, 1)}}); !errors.Is(err, resample.ErrNonMonotonic) {
		t.Fatalf("equal times: got %v", err)
	}
	if _, err := s.Write([]resample.Sample{{rat(0, 1), rat(0, 1)}}); !errors.Is(err, resample.ErrNonMonotonic) {
		t.Fatalf("decreasing times: got %v", err)
	}
	// 跨 Break 也必须递增。
	if err := s.Break(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Write([]resample.Sample{{rat(1, 2), rat(0, 1)}}); !errors.Is(err, resample.ErrNonMonotonic) {
		t.Fatalf("decreasing across Break: got %v", err)
	}
	if err := s.End(); err != nil {
		t.Fatal(err)
	}
	if err := s.End(); !errors.Is(err, resample.ErrEnded) {
		t.Fatalf("double End: got %v", err)
	}
	if err := s.Break(); !errors.Is(err, resample.ErrEnded) {
		t.Fatalf("Break after End: got %v", err)
	}
}

// model 是独立的整序列参照实现：对每个连续段，直接枚举覆盖区间内的
// 网格点并做精确有理插值。用于与流式实现交叉核对。
func model(step *big.Rat, runs [][]resample.Sample) []resample.Point {
	var out []resample.Point
	for _, run := range runs {
		if len(run) == 0 {
			continue
		}
		last := run[len(run)-1].T
		k := ceilRat(new(big.Rat).Quo(run[0].T, step))
		for {
			gt := new(big.Rat).Mul(step, new(big.Rat).SetInt(k))
			if gt.Cmp(last) > 0 {
				break
			}
			out = append(out, resample.Point{T: gt, V: modelValue(run, gt)})
			k.Add(k, big.NewInt(1))
		}
	}
	return out
}

func modelValue(run []resample.Sample, t *big.Rat) *big.Rat {
	for i, sm := range run {
		switch sm.T.Cmp(t) {
		case 0:
			return new(big.Rat).Set(sm.V)
		case 1:
			prev := run[i-1]
			frac := new(big.Rat).Quo(new(big.Rat).Sub(t, prev.T), new(big.Rat).Sub(sm.T, prev.T))
			dv := new(big.Rat).Sub(sm.V, prev.V)
			return new(big.Rat).Add(prev.V, dv.Mul(dv, frac))
		}
	}
	panic("model: grid time outside run")
}

func ceilRat(q *big.Rat) *big.Int {
	quo, rem := new(big.Int).QuoRem(q.Num(), q.Denom(), new(big.Int))
	if rem.Sign() != 0 {
		quo.Add(quo, big.NewInt(1))
	}
	return quo
}

// genRuns 生成随机有理数序列：多个连续段，段间有随机间隙，首段可能起于原点。
func genRuns(rng *rand.Rand) (step *big.Rat, runs [][]resample.Sample) {
	step = rat(int64(1+rng.Intn(3)), int64(1+rng.Intn(4)))
	cur := rat(int64(rng.Intn(4)), int64(1+rng.Intn(2)))
	for r := 0; r < 1+rng.Intn(4); r++ {
		var run []resample.Sample
		for i := 0; i < 1+rng.Intn(8); i++ {
			v := rat(int64(rng.Intn(41)-20), int64(1+rng.Intn(4)))
			run = append(run, resample.Sample{T: new(big.Rat).Set(cur), V: v})
			cur.Add(cur, rat(int64(1+rng.Intn(6)), int64(1+rng.Intn(3))))
		}
		runs = append(runs, run)
		cur.Add(cur, rat(int64(1+rng.Intn(4)), int64(1+rng.Intn(2)))) // 段间间隙
	}
	return step, runs
}

// TestRandomChunkingVsModel 核对三种口径完全一致：
// 随机切块流式写入、整序列一次性 Resample、独立的有理参照模型。
func TestRandomChunkingVsModel(t *testing.T) {
	for seed := int64(0); seed < 500; seed++ {
		rng := rand.New(rand.NewSource(seed))
		step, runs := genRuns(rng)
		want := model(step, runs)

		// 整序列一次性处理。
		whole, err := resample.Resample(step, runs)
		if err != nil {
			t.Fatalf("seed %d: Resample: %v", seed, err)
		}
		if !ptsEqual(whole, want) {
			t.Fatalf("seed %d: whole != model\nwhole:%s\nmodel:%s", seed, fmtPts(whole), fmtPts(want))
		}

		// 随机切块流式处理，块间随机插入空写。
		s, err := resample.New(step)
		if err != nil {
			t.Fatal(err)
		}
		var got []resample.Point
		for _, run := range runs {
			for i := 0; i < len(run); {
				n := 1 + rng.Intn(3)
				if i+n > len(run) {
					n = len(run) - i
				}
				pts, err := s.Write(run[i : i+n])
				if err != nil {
					t.Fatalf("seed %d: Write: %v", seed, err)
				}
				got = append(got, pts...)
				if rng.Intn(4) == 0 {
					pts, err := s.Write(nil)
					if err != nil {
						t.Fatalf("seed %d: empty Write: %v", seed, err)
					}
					got = append(got, pts...)
				}
				i += n
			}
			if err := s.Break(); err != nil {
				t.Fatalf("seed %d: Break: %v", seed, err)
			}
		}
		if err := s.End(); err != nil {
			t.Fatalf("seed %d: End: %v", seed, err)
		}
		if !ptsEqual(got, want) {
			t.Fatalf("seed %d: chunked != model\nchunked:%s\nmodel:%s", seed, fmtPts(got), fmtPts(want))
		}

		// 输出不变量：时间严格递增且都落在网格上（T/step 为整数）。
		for i, p := range got {
			q := new(big.Rat).Quo(p.T, step)
			if q.Denom().Cmp(big.NewInt(1)) != 0 {
				t.Fatalf("seed %d: point %d off grid: T=%v step=%v", seed, i, p.T, step)
			}
			if i > 0 && got[i-1].T.Cmp(p.T) >= 0 {
				t.Fatalf("seed %d: point %d not increasing", seed, i)
			}
		}
	}
}
