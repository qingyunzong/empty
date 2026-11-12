package dataeng

import (
	"errors"
	"math"
	"math/big"
	"testing"
)

func i64(v int64) *int64 { return &v }

func deref(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

func insert(group, id string, value *int64) Op {
	return Op{Kind: OpInsert, Group: group, Record: Record{ID: id, Value: value}}
}

func replace(group, id string, value *int64) Op {
	return Op{Kind: OpReplace, Group: group, Record: Record{ID: id, Value: value}}
}

func del(group, id string) Op {
	return Op{Kind: OpDelete, Group: group, Record: Record{ID: id}}
}

func checkStats(t *testing.T, snap *Snapshot, group string, want Stats) {
	t.Helper()
	got, ok := snap.Stats(group)
	if !ok {
		t.Fatalf("group %q missing", group)
	}
	if got.Count != want.Count || got.NonNull != want.NonNull {
		t.Fatalf("group %q count=%d nonnull=%d, want %d/%d", group, got.Count, got.NonNull, want.Count, want.NonNull)
	}
	if (got.Sum == nil) != (want.Sum == nil) || (got.Sum != nil && got.Sum.Cmp(want.Sum) != 0) {
		t.Fatalf("group %q sum=%v, want %v", group, got.Sum, want.Sum)
	}
	if (got.Min == nil) != (want.Min == nil) || (got.Min != nil && want.Min != nil && *got.Min != *want.Min) {
		t.Fatalf("group %q min=%v, want %v", group, deref(got.Min), deref(want.Min))
	}
	if (got.Max == nil) != (want.Max == nil) || (got.Max != nil && want.Max != nil && *got.Max != *want.Max) {
		t.Fatalf("group %q max=%v, want %v", group, deref(got.Max), deref(want.Max))
	}
	if (got.Avg == nil) != (want.Avg == nil) {
		t.Fatalf("group %q avg nil=%v, want nil=%v", group, got.Avg == nil, want.Avg == nil)
	}
	if got.Avg != nil && want.Avg != nil {
		if got.Avg.Numerator().Cmp(want.Avg.Numerator()) != 0 ||
			got.Avg.Denominator().Cmp(want.Avg.Denominator()) != 0 {
			t.Fatalf("group %q avg=%s, want %s", group, got.Avg, want.Avg)
		}
	}
}

func frac(num, den int64) *Fraction {
	return &Fraction{numerator: big.NewInt(num), denominator: big.NewInt(den)}
}

func TestBasicAggregationAndDuplicateValues(t *testing.T) {
	snap, err := New().Latest().Apply([]Op{
		insert("g", "a", i64(2)),
		insert("g", "b", i64(2)),
		insert("g", "c", i64(8)),
	})
	if err != nil {
		t.Fatal(err)
	}
	// 值相同但 ID 不同分别计数：count=3，sum=12，avg=12/3=4/1。
	checkStats(t, snap, "g", Stats{
		Count: 3, NonNull: 3,
		Sum: big.NewInt(12), Min: i64(2), Max: i64(8), Avg: frac(4, 1),
	})
	if keys := snap.GroupKeys(); len(keys) != 1 || keys[0] != "g" {
		t.Fatalf("keys=%v", keys)
	}
}

func TestAllNullGroup(t *testing.T) {
	snap, err := New().Latest().Apply([]Op{
		insert("g", "a", nil),
		insert("g", "b", nil),
	})
	if err != nil {
		t.Fatal(err)
	}
	got, ok := snap.Stats("g")
	if !ok {
		t.Fatal("group missing")
	}
	if got.Count != 2 || got.NonNull != 0 {
		t.Fatalf("count=%d nonnull=%d", got.Count, got.NonNull)
	}
	if got.Sum != nil || got.Min != nil || got.Max != nil || got.Avg != nil {
		t.Fatalf("全空组除计数外应为 null, got %+v", got)
	}
}

func TestNullReplacement(t *testing.T) {
	snap, err := New().Latest().Apply([]Op{insert("g", "a", i64(10)), insert("g", "b", i64(20))})
	if err != nil {
		t.Fatal(err)
	}
	// 非空 -> 空值。
	snap, err = snap.Apply([]Op{replace("g", "a", nil)})
	if err != nil {
		t.Fatal(err)
	}
	checkStats(t, snap, "g", Stats{
		Count: 2, NonNull: 1,
		Sum: big.NewInt(20), Min: i64(20), Max: i64(20), Avg: frac(20, 1),
	})
	// 最后一个非空值也替换为空：除计数外全部 null。
	snap, err = snap.Apply([]Op{replace("g", "b", nil)})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := snap.Stats("g")
	if got.Count != 2 || got.NonNull != 0 || got.Sum != nil || got.Min != nil || got.Max != nil || got.Avg != nil {
		t.Fatalf("全空状态错误: %+v", got)
	}
	// 空值 -> 非空，聚合恢复。
	snap, err = snap.Apply([]Op{replace("g", "a", i64(-7))})
	if err != nil {
		t.Fatal(err)
	}
	checkStats(t, snap, "g", Stats{
		Count: 2, NonNull: 1,
		Sum: big.NewInt(-7), Min: i64(-7), Max: i64(-7), Avg: frac(-7, 1),
	})
}

func TestExtremeDeletion(t *testing.T) {
	snap, err := New().Latest().Apply([]Op{
		insert("g", "lo", i64(1)),
		insert("g", "mid", i64(2)),
		insert("g", "hi", i64(3)),
	})
	if err != nil {
		t.Fatal(err)
	}
	// 删除最小值后 min 重算。
	snap, err = snap.Apply([]Op{del("g", "lo")})
	if err != nil {
		t.Fatal(err)
	}
	checkStats(t, snap, "g", Stats{
		Count: 2, NonNull: 2, Sum: big.NewInt(5),
		Min: i64(2), Max: i64(3), Avg: frac(5, 2),
	})
	// 删除最大值后 max 重算。
	snap, err = snap.Apply([]Op{del("g", "hi")})
	if err != nil {
		t.Fatal(err)
	}
	checkStats(t, snap, "g", Stats{
		Count: 1, NonNull: 1, Sum: big.NewInt(2),
		Min: i64(2), Max: i64(2), Avg: frac(2, 1),
	})
	// 重复极值：删掉一个 5，max 仍是 5。
	snap, err = snap.Apply([]Op{
		insert("g", "x", i64(5)),
		insert("g", "y", i64(5)),
		insert("g", "z", i64(-4)),
	})
	if err != nil {
		t.Fatal(err)
	}
	snap, err = snap.Apply([]Op{del("g", "x")})
	if err != nil {
		t.Fatal(err)
	}
	checkStats(t, snap, "g", Stats{
		Count: 3, NonNull: 3, Sum: big.NewInt(3),
		Min: i64(-4), Max: i64(5), Avg: frac(1, 1),
	})
	// 删空整组：空组从结果移除。
	snap, err = snap.Apply([]Op{
		del("g", "mid"), del("g", "y"), del("g", "z"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := snap.Stats("g"); ok {
		t.Fatal("空组应从结果移除")
	}
	if len(snap.GroupKeys()) != 0 || snap.Count("g") != 0 {
		t.Fatal("空快照不应残留组")
	}
}

func TestInt64Endpoints(t *testing.T) {
	var maxV int64 = math.MaxInt64
	var minV int64 = math.MinInt64
	snap, err := New().Latest().Apply([]Op{
		insert("g", "m1", i64(maxV)),
		insert("g", "m2", i64(maxV)),
		insert("g", "m3", i64(maxV)),
		insert("g", "lo", i64(minV)),
	})
	if err != nil {
		t.Fatal(err)
	}
	// 3*MaxInt64 + MinInt64 超出 int64 范围，必须以任意精度保存。
	wantSum := new(big.Int).Mul(big.NewInt(3), big.NewInt(maxV))
	wantSum.Add(wantSum, big.NewInt(minV))
	got, _ := snap.Stats("g")
	if got.Sum.Cmp(wantSum) != 0 {
		t.Fatalf("sum=%s, want %s", got.Sum, wantSum)
	}
	if *got.Min != minV || *got.Max != maxV {
		t.Fatalf("min=%d max=%d", *got.Min, *got.Max)
	}
	// 仅两个 MaxInt64：avg=(2*max)/2=max/1，约分正确且无 int64 溢出。
	snap2, err := snap.Apply([]Op{del("g", "m1"), del("g", "lo")})
	if err != nil {
		t.Fatal(err)
	}
	got2, _ := snap2.Stats("g")
	if got2.Avg.Numerator().Cmp(big.NewInt(maxV)) != 0 ||
		got2.Avg.Denominator().Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("avg=%s", got2.Avg)
	}
	// MinInt64 单独成组，负数最简分数与 sum 均正确。
	snap3, err := New().Latest().Apply([]Op{insert("h", "k", i64(minV))})
	if err != nil {
		t.Fatal(err)
	}
	got3, _ := snap3.Stats("h")
	if got3.Sum.Cmp(big.NewInt(minV)) != 0 || got3.Avg.String() != "-9223372036854775808/1" {
		t.Fatalf("sum=%s avg=%s", got3.Sum, got3.Avg)
	}
}

func TestFractionReductionWithNegatives(t *testing.T) {
	snap, err := New().Latest().Apply([]Op{
		insert("g", "a", i64(-4)),
		insert("g", "b", i64(2)),
	})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := snap.Stats("g")
	if got.Avg.String() != "-1/1" {
		t.Fatalf("avg=%s, want -1/1", got.Avg)
	}
	if got.Avg.Denominator().Sign() <= 0 {
		t.Fatal("分母必须恒为正数")
	}
}

func TestInvalidBatchRollback(t *testing.T) {
	db := New()
	before, err := db.Apply([]Op{insert("g", "a", i64(1))})
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		ops  []Op
		want error
		idx  int
	}{
		{"删除不存在的 ID", []Op{insert("g", "b", i64(2)), del("g", "ghost")}, ErrIDMissing, 1},
		{"替换不存在的 ID", []Op{replace("g", "ghost", i64(2))}, ErrIDMissing, 0},
		{"插入重复 ID", []Op{insert("g", "a", i64(2))}, ErrIDExists, 0},
		{"空 ID", []Op{insert("g", "", i64(2))}, ErrEmptyID, 0},
		{"未知操作类型", []Op{{Kind: OpKind(99), Group: "g", Record: Record{ID: "a"}}}, ErrUnknownOp, 0},
		{"向不存在的组删除", []Op{del("nope", "a")}, ErrIDMissing, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := db.Apply(tc.ops)
			if err == nil {
				t.Fatal("期望批次失败")
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("err=%v, 未包装 %v", err, tc.want)
			}
			var batchErr *BatchError
			if !errors.As(err, &batchErr) || batchErr.Index != tc.idx {
				t.Fatalf("BatchError 索引=%v, want %d", err, tc.idx)
			}
		})
	}

	// 整批回滚：DB 最新版本与内容保持失败前状态。
	if db.Version() != 1 || db.Latest() != before {
		t.Fatal("失败批次不应推进版本")
	}
	got, _ := db.Latest().Stats("g")
	if got.Count != 1 || got.Sum.Cmp(big.NewInt(1)) != 0 {
		t.Fatalf("回滚后状态被污染: %+v", got)
	}

	// 批次中途失败：第一条合法操作也必须回滚。
	_, err = before.Apply([]Op{insert("g", "b", i64(9)), del("g", "ghost")})
	if !errors.Is(err, ErrIDMissing) {
		t.Fatalf("err=%v", err)
	}
	if before.Count("g") != 1 {
		t.Fatal("接收者快照应保持不变")
	}
	if _, ok := before.Stats("g"); !ok {
		t.Fatal("旧快照应仍可读")
	}
}
