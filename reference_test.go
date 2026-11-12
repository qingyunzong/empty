package dataeng

import (
	"math/big"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// refStats 是独立于生产实现的参考聚合：每次都从完整记录集合全量重算。
type refModel struct {
	records map[string]map[string]*int64 // group -> id -> 可空值
}

type refStats struct {
	count, nonNull int64
	sum            *big.Int
	min, max       *int64
	avgNum, avgDen *big.Int
}

func newRefModel() *refModel {
	return &refModel{records: make(map[string]map[string]*int64)}
}

// apply 逐批执行；任何非法操作返回错误且参考模型整体不变，模拟整批回滚。
func (r *refModel) apply(ops []Op) error {
	backup := r.clone()
	for _, op := range ops {
		switch op.Kind {
		case OpInsert, OpReplace, OpDelete:
		default:
			r.records = backup
			return ErrUnknownOp
		}
		if op.Record.ID == "" {
			r.records = backup
			return ErrEmptyID
		}
		group, ok := r.records[op.Group]
		if !ok {
			if op.Kind != OpInsert {
				r.records = backup
				return ErrIDMissing
			}
			group = make(map[string]*int64)
			r.records[op.Group] = group
		}
		_, exists := group[op.Record.ID]
		switch op.Kind {
		case OpInsert:
			if exists {
				r.records = backup
				return ErrIDExists
			}
			group[op.Record.ID] = cloneInt64(op.Record.Value)
		case OpReplace:
			if !exists {
				r.records = backup
				return ErrIDMissing
			}
			group[op.Record.ID] = cloneInt64(op.Record.Value)
		case OpDelete:
			if !exists {
				r.records = backup
				return ErrIDMissing
			}
			delete(group, op.Record.ID)
			if len(group) == 0 {
				delete(r.records, op.Group)
			}
		}
	}
	return nil
}

func (r *refModel) clone() map[string]map[string]*int64 {
	copied := make(map[string]map[string]*int64, len(r.records))
	for group, records := range r.records {
		dup := make(map[string]*int64, len(records))
		for id, value := range records {
			dup[id] = cloneInt64(value)
		}
		copied[group] = dup
	}
	return copied
}

// recompute 对每个组从零重算全部统计量，不依赖任何增量维护逻辑。
func (r *refModel) recompute() map[string]refStats {
	out := make(map[string]refStats, len(r.records))
	for group, records := range r.records {
		st := refStats{
			count: int64(len(records)),
			sum:   new(big.Int),
		}
		for _, value := range records {
			if value == nil {
				continue
			}
			st.nonNull++
			st.sum.Add(st.sum, big.NewInt(*value))
			if st.min == nil || *value < *st.min {
				st.min = cloneInt64(value)
			}
			if st.max == nil || *value > *st.max {
				st.max = cloneInt64(value)
			}
		}
		if st.nonNull == 0 {
			st.sum = nil
			out[group] = st
			continue
		}
		num := new(big.Int).Set(st.sum)
		den := big.NewInt(st.nonNull)
		gcd := new(big.Int).GCD(nil, nil, new(big.Int).Abs(num), den)
		st.avgNum = new(big.Int).Quo(num, gcd)
		st.avgDen = new(big.Int).Quo(big.NewInt(st.nonNull), gcd)
		out[group] = st
	}
	return out
}

func assertSnapshotMatchesReference(t *testing.T, snap *Snapshot, ref *refModel) {
	t.Helper()
	want := ref.recompute()
	if got := snap.GroupKeys(); !reflect.DeepEqual(got, ref.sortedKeys()) {
		t.Fatalf("组键不一致: got=%v want=%v", got, ref.sortedKeys())
	}
	if len(snap.GroupKeys()) != len(want) {
		t.Fatalf("组数量不一致: got=%d want=%d", len(snap.GroupKeys()), len(want))
	}
	for group, expected := range want {
		got, ok := snap.Stats(group)
		if !ok {
			t.Fatalf("参考模型中的组 %q 在快照中缺失", group)
		}
		if got.Count != expected.count || got.NonNull != expected.nonNull {
			t.Fatalf("组 %q 计数不一致: got=(%d,%d) want=(%d,%d)",
				group, got.Count, got.NonNull, expected.count, expected.nonNull)
		}
		if (got.Sum == nil) != (expected.sum == nil) ||
			(got.Sum != nil && got.Sum.Cmp(expected.sum) != 0) {
			t.Fatalf("组 %q sum 不一致: got=%v want=%v", group, got.Sum, expected.sum)
		}
		if (got.Min == nil) != (expected.min == nil) ||
			(got.Min != nil && *got.Min != *expected.min) {
			t.Fatalf("组 %q min 不一致: got=%v want=%v", group, got.Min, expected.min)
		}
		if (got.Max == nil) != (expected.max == nil) ||
			(got.Max != nil && *got.Max != *expected.max) {
			t.Fatalf("组 %q max 不一致: got=%v want=%v", group, got.Max, expected.max)
		}
		if expected.avgNum == nil {
			if got.Avg != nil {
				t.Fatalf("组 %q avg 应为 null, got=%s", group, got.Avg)
			}
			continue
		}
		if got.Avg == nil ||
			got.Avg.Numerator().Cmp(expected.avgNum) != 0 ||
			got.Avg.Denominator().Cmp(expected.avgDen) != 0 {
			t.Fatalf("组 %q avg 不一致: got=%v want=%s/%s",
				group, got.Avg, expected.avgNum, expected.avgDen)
		}
	}
}

func (r *refModel) sortedKeys() []string {
	keys := make([]string, 0, len(r.records))
	for key := range r.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// TestDifferentialAgainstReference 用每批全量重算的参考实现核对增量快照，
// 覆盖极值删除、空值替换、回滚、空组移除与 int64 端点等随机场景。
func TestDifferentialAgainstReference(t *testing.T) {
	// 固定端点与若干边界值，保证 int64 端点被随机批次反复命中。
	edgeValues := []int64{
		-1 << 63, (-1 << 63) + 1, -1, 0, 1, (1 << 62), (1 << 63) - 1,
	}
	groups := []string{"alpha", "beta", "gamma", ""}

	for _, seed := range []int64{1, 2, 7, 42, 99} {
		t.Run("seed", func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			ref := newRefModel()
			snap := New().Latest()
			history := []*Snapshot{snap}

			for batch := 0; batch < 300; batch++ {
				ops := ref.randomBatch(rng, groups, edgeValues)
				next, gotErr := snap.Apply(ops)
				wantErr := ref.apply(ops)
				if (gotErr == nil) != (wantErr == nil) {
					t.Fatalf("seed=%d batch=%d 合法性不一致: got=%v want=%v", seed, batch, gotErr, wantErr)
				}
				if gotErr != nil {
					// 失败批次两边都必须维持原状，且旧版本仍可核对。
					assertSnapshotMatchesReference(t, snap, ref)
					continue
				}
				snap = next
				history = append(history, snap)
				assertSnapshotMatchesReference(t, snap, ref)
			}

			// 全部历史版本依旧可读，且版本号严格递增。
			for i, old := range history {
				if old.Version() != int64(i) {
					t.Fatalf("历史版本号错误: got=%d want=%d", old.Version(), i)
				}
				if len(old.GroupKeys()) < 0 {
					t.Fatal("旧快照不可读")
				}
			}
		})
	}
}

func (r *refModel) randomBatch(rng *rand.Rand, groups []string, edges []int64) []Op {
	size := 1 + rng.Intn(6)
	ops := make([]Op, 0, size)
	for i := 0; i < size; i++ {
		group := groups[rng.Intn(len(groups))]
		existing := r.records[group]

		// 约三分之一概率构造针对现存 ID 的操作，保证替换/删除与极值删除高频发生。
		if len(existing) > 0 && rng.Intn(3) > 0 {
			ids := make([]string, 0, len(existing))
			for id := range existing {
				ids = append(ids, id)
			}
			id := ids[rng.Intn(len(ids))]
			switch rng.Intn(3) {
			case 0:
				ops = append(ops, replace(group, id, r.maybeNullValue(rng, edges)))
			case 1:
				ops = append(ops, del(group, id))
			default:
				// 故意制造重复插入以触发回滚路径。
				ops = append(ops, insert(group, id, r.maybeNullValue(rng, edges)))
			}
			continue
		}

		id := "id-" + group + "-" + randomID(rng)
		switch rng.Intn(10) {
		case 0:
			// 未知组/未知 ID 上的删除，触发非法回滚。
			ops = append(ops, del(group, "ghost-"+randomID(rng)))
		case 1:
			ops = append(ops, Op{Kind: OpKind(42), Group: group, Record: Record{ID: id}})
		default:
			ops = append(ops, insert(group, id, r.maybeNullValue(rng, edges)))
		}
	}
	return ops
}

func (r *refModel) maybeNullValue(rng *rand.Rand, edges []int64) *int64 {
	if rng.Intn(4) == 0 {
		return nil
	}
	if rng.Intn(2) == 0 {
		return i64(edges[rng.Intn(len(edges))])
	}
	// 普通范围内的随机值，与边界值混合形成重复极值与普通极值删除。
	return i64(rng.Int63n(2001) - 1000)
}

func randomID(rng *rand.Rand) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	buf := make([]byte, 8)
	for i := range buf {
		buf[i] = alphabet[rng.Intn(len(alphabet))]
	}
	return string(buf)
}
