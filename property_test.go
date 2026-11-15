package dataeng

import (
	"math/rand"
	"testing"
	"time"
)

func TestQ0206RandomizedPruningZeroFalseNegatives(t *testing.T) {
	rng := rand.New(rand.NewSource(20261116))
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	names := []string{"alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"}
	base := time.Date(2020, 10, 25, 0, 0, 0, 0, loc)
	var rows []q0206TestRow
	for i := 0; i < 40; i++ {
		var row q0206TestRow = map[string]any{}
		if rng.Intn(10) != 0 {
			row["id"] = int64(rng.Intn(20) - 5)
		}
		if rng.Intn(8) != 0 {
			row["name"] = names[rng.Intn(len(names))]
		}
		if rng.Intn(10) != 0 {
			row["ts"] = base.Add(time.Duration(rng.Intn(14*24)) * time.Hour).Add(time.Duration(rng.Intn(4)) * 15 * time.Minute)
		}
		if rng.Intn(12) != 0 {
			row["flag"] = rng.Intn(2) == 0
		}
		rows = append(rows, row)
	}
	var stripes [][]q0206TestRow
	for i := 0; i < len(rows); i += 13 {
		end := i + 13
		if end > len(rows) {
			end = len(rows)
		}
		stripes = append(stripes, rows[i:end])
	}

	cases := []q0206TestSchema{
		{timezone: "America/New_York", writerVersion: 6, hasVersion: true, stride: 5, bloomColumns: []string{"id", "name", "ts"}},
		{timezone: "America/New_York", writerVersion: 3, hasVersion: true, legacyStats: true, stride: 5, bloomColumns: []string{"id", "name"}},
		{timezone: "America/New_York", writerVersion: 3, hasVersion: true, legacyStats: true, legacyEpoch2015: true, stride: 4},
	}
	for ci, schema := range cases {
		path := q0206BuildTestORC(t, schema, stripes)
		r, err := Open(path)
		if err != nil {
			t.Fatalf("case %d: %v", ci, err)
		}
		for _, p := range q0206RandomPredicates(rng, names, base) {
			res, err := r.Prune(p)
			if err != nil {
				t.Fatalf("case %d predicate %s: %v", ci, p, err)
			}
			for i, row := range rows {
				if p.Evaluate(q0206RowValueMap(row)) && !ContainsRow(res.Ranges, int64(i)) {
					t.Fatalf("case %d predicate %s: false negative at row %d (ranges %v)", ci, p, i, res.Ranges)
				}
			}
		}
		r.Close()
	}
}

func q0206RandomPredicates(rng *rand.Rand, names []string, base time.Time) []Predicate {
	var out []Predicate
	for i := 0; i < 60; i++ {
		id := int64(rng.Intn(30) - 8)
		name := names[rng.Intn(len(names))]
		ts := base.Add(time.Duration(rng.Intn(14*24)) * time.Hour)
		switch rng.Intn(12) {
		case 0:
			out = append(out, Eq("id", IntValue(id)))
		case 1:
			out = append(out, Lt("id", IntValue(id)))
		case 2:
			out = append(out, Ge("id", IntValue(id)))
		case 3:
			out = append(out, In("id", IntValue(id), IntValue(id+2), IntValue(id-3)))
		case 4:
			out = append(out, Eq("name", StringValue(name)))
		case 5:
			out = append(out, Lt("name", StringValue(name)))
		case 6:
			out = append(out, IsNull("name"))
		case 7:
			out = append(out, Eq("ts", TimestampValue(ts)))
		case 8:
			out = append(out, And(Ge("ts", TimestampValue(ts)), Lt("ts", TimestampValue(ts.Add(36*time.Hour)))))
		case 9:
			out = append(out, Or(Eq("id", IntValue(id)), Eq("name", StringValue(name))))
		case 10:
			out = append(out, Not(IsNull("name")))
		case 11:
			out = append(out, Not(Eq("id", IntValue(id))))
		}
	}
	return out
}
