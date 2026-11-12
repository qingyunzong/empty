package dataeng

import (
	"fmt"
	"math/big"
	"runtime"
	"sync"
	"testing"
)

func TestSnapshotImmutabilityAndOldVersions(t *testing.T) {
	db := New()
	v1, err := db.Apply([]Op{insert("g", "a", i64(5)), insert("g", "b", nil)})
	if err != nil {
		t.Fatal(err)
	}
	v2, err := db.Apply([]Op{replace("g", "a", i64(9)), insert("h", "k", i64(1))})
	if err != nil {
		t.Fatal(err)
	}

	// 读者保留的旧版本内容不随后续提交变化。
	old, ok := v1.Stats("g")
	if !ok || old.Count != 2 || old.NonNull != 1 || old.Sum.Cmp(big.NewInt(5)) != 0 {
		t.Fatalf("v1 被污染: %+v", old)
	}
	if v1.Version() != 1 || v2.Version() != 2 || db.Version() != 2 {
		t.Fatalf("版本号错误 v1=%d v2=%d db=%d", v1.Version(), v2.Version(), db.Version())
	}
	if _, ok := v1.Stats("h"); ok {
		t.Fatal("v1 不应出现后建的组 h")
	}

	// 通过访问器返回的副本做修改，不能影响快照内部状态。
	stats, _ := v2.Stats("g")
	stats.Sum.SetInt64(12345)
	*stats.Min = -1
	stats.Avg.Numerator().SetInt64(999)
	again, _ := v2.Stats("g")
	if again.Sum.Cmp(big.NewInt(9)) != 0 || *again.Min != 9 || again.Avg.String() != "9/1" {
		t.Fatalf("访问器返回值未与内部状态隔离: %+v", again)
	}

	// GroupKeys 返回副本，修改不影响快照。
	keys := v2.GroupKeys()
	keys[0] = "tampered"
	if v2.GroupKeys()[0] != "g" {
		t.Fatal("GroupKeys 未返回独立副本")
	}
}

func TestEmptyBatchBumpsVersion(t *testing.T) {
	db := New()
	s1, err := db.Apply(nil)
	if err != nil {
		t.Fatal(err)
	}
	if s1.Version() != 1 || len(s1.GroupKeys()) != 0 {
		t.Fatalf("空批次结果错误: version=%d keys=%v", s1.Version(), s1.GroupKeys())
	}
	s2, err := s1.Apply([]Op{})
	if err != nil || s2.Version() != 2 {
		t.Fatalf("空切片批次错误: %v", err)
	}
}

func TestDBConcurrentReadersAndWriter(t *testing.T) {
	db := New()
	var wg sync.WaitGroup

	// 读者持续持有并读取历史快照，验证并发下旧版本始终可用。
	for worker := 0; worker < 4; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for iteration := 0; iteration < 500; iteration++ {
				snap := db.Latest()
				for _, key := range snap.GroupKeys() {
					stats, ok := snap.Stats(key)
					if !ok {
						t.Errorf("组 %q 在 GroupKeys 中却无法读取", key)
						return
					}
					if stats.NonNull > stats.Count {
						t.Errorf("非空数 %d 超过计数 %d", stats.NonNull, stats.Count)
						return
					}
				}
				runtime.Gosched()
			}
		}()
	}

	// 写者交替提交合法批次与注定失败的非法批次。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := int64(0); i < 100; i++ {
			id := fmt.Sprintf("id-%d", i)
			ops := []Op{
				insert("g", id, i64(i)),
				insert("g", id+"-null", nil),
			}
			if _, err := db.Apply(ops); err != nil {
				t.Errorf("合法批次失败: %v", err)
				return
			}
			if _, err := db.Apply([]Op{del("g", "never-exists")}); err == nil {
				t.Error("非法批次应失败")
				return
			}
			if _, err := db.Apply([]Op{
				replace("g", id, nil),
				del("g", id+"-null"),
			}); err != nil {
				t.Errorf("替换/删除批次失败: %v", err)
				return
			}
			runtime.Gosched()
		}
	}()

	wg.Wait()
	// 每轮：插入 2 条、再删除 1 条，最终组内只剩每条的空值记录。
	final := db.Latest()
	if final.Count("g") != 100 {
		t.Fatalf("最终 count=%d, want 100", final.Count("g"))
	}
	stats, _ := final.Stats("g")
	if stats.NonNull != 0 || stats.Sum != nil || stats.Min != nil || stats.Max != nil || stats.Avg != nil {
		t.Fatalf("最终应全空: %+v", stats)
	}
}
