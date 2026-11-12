package dataeng

import "math/rand"

// randomSpec 生成受小边界约束的随机规格（总单元格 <= 8、枚举域 <= 3），
// 保证全枚举在测试预算内完成。
func randomSpec(rng *rand.Rand) (Spec, []Constraint) {
	tableCount := 1 + rng.Intn(2)
	tables := make([]Table, 0, tableCount)
	for ti := 0; ti < tableCount; ti++ {
		colCount := 1 + rng.Intn(2)
		rows := rng.Intn(4)
		if rng.Intn(4) == 0 {
			rows = 0
		}
		for rows*colCount > 8 {
			rows--
		}
		cols := make([]Column, 0, colCount)
		for ci := 0; ci < colCount; ci++ {
			domainSize := 1 + rng.Intn(3)
			domain := make([]string, domainSize)
			for d := range domain {
				domain[d] = string(rune('v' + d))
			}
			cols = append(cols, Column{
				ID:     ColumnID("c" + string(rune('0'+ci))),
				Domain: domain,
			})
		}
		tables = append(tables, Table{
			ID:      TableID("t" + string(rune('a'+ti))),
			Rows:    rows,
			Columns: cols,
		})
	}

	constraints := make([]Constraint, 0)
	nameSeq := 0
	newName := func(prefix string) string {
		nameSeq++
		return prefix + itoa(nameSeq)
	}

	for _, table := range tables {
		if rng.Intn(2) == 0 && len(table.Columns) > 0 {
			pkWidth := 1
			if len(table.Columns) > 1 && rng.Intn(2) == 0 {
				pkWidth = 2
			}
			pkCols := make([]ColumnID, pkWidth)
			for i := range pkCols {
				pkCols[i] = table.Columns[i].ID
			}
			constraints = append(constraints, PrimaryKey(newName("pk_"), table.ID, pkCols...))
		}
		for _, col := range table.Columns {
			if rng.Intn(3) == 0 {
				constraints = append(constraints, NotNull(newName("nn_"), table.ID, col.ID))
			}
			if rng.Intn(4) == 0 {
				refTable := tables[rng.Intn(len(tables))]
				refCol := refTable.Columns[rng.Intn(len(refTable.Columns))]
				constraints = append(constraints, ForeignKey(
					newName("fk_"), table.ID, col.ID, refTable.ID, refCol.ID))
			}
		}
	}

	// 防御性去重同表主键（构造器已基本保证不重复）。
	seenPK := map[TableID]bool{}
	dedup := make([]Constraint, 0, len(constraints))
	for _, c := range constraints {
		if c.Kind == KindPrimaryKey {
			if seenPK[c.Table] {
				continue
			}
			seenPK[c.Table] = true
		}
		dedup = append(dedup, c)
	}
	return Spec{Tables: tables}, dedup
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
