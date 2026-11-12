import { compareRows } from '../src/canonical.ts';
import type { JoinInput, ReductionResult, Row } from '../src/types.ts';

export function relation(
  name: string,
  attributes: string[],
  rows: Array<Record<string, bigint | string>>,
): JoinInput['relations'][number] {
  return { name, attributes, rows };
}

export function rowKey(
  row: Row,
  attributes: readonly string[],
): string {
  return attributes
    .map((attribute) => {
      const value = row[attribute];
      return typeof value === 'bigint' ? `i:${value.toString()}` : `s:${value}`;
    })
    .join('|');
}

export function bruteForceJoin(input: JoinInput): Row[] {
  const orderedNames = input.relations.map((item) => item.name).sort();
  const schema = new Map(
    input.relations.map((item) => [item.name, [...item.attributes].sort()]),
  );
  const distinctByName = new Map<string, Row[]>();
  for (const item of input.relations) {
    const seen = new Map<string, Row>();
    for (const row of item.rows) {
      seen.set(rowKey(row, item.attributes), row);
    }
    distinctByName.set(item.name, [...seen.values()]);
  }

  const output: Row[] = [];

  const visit = (
    position: number,
    merged: Map<string, bigint | string>,
  ): void => {
    if (position === orderedNames.length) {
      output.push(Object.fromEntries(merged));
      return;
    }
    const name = orderedNames[position];
    for (const candidate of distinctByName.get(name)!) {
      const additions: Array<[string, bigint | string]> = [];
      let compatible = true;
      for (const attribute of schema.get(name)!) {
        const value = candidate[attribute];
        const existing = merged.get(attribute);
        if (existing !== undefined && existing !== value) {
          compatible = false;
          break;
        }
        if (existing === undefined) {
          additions.push([attribute, value]);
        }
      }
      if (!compatible) {
        continue;
      }
      for (const [attribute, value] of additions) {
        merged.set(attribute, value);
      }
      visit(position + 1, merged);
      for (const [attribute] of additions) {
        merged.delete(attribute);
      }
    }
  };

  visit(0, new Map());
  return output;
}

export function joinKey(row: Row, allAttributes: readonly string[]): string {
  return rowKey(row, allAttributes);
}

export function allAttributes(input: JoinInput): string[] {
  const attributes = new Set<string>();
  for (const item of input.relations) {
    for (const attribute of item.attributes) {
      attributes.add(attribute);
    }
  }
  return [...attributes].sort();
}

export function assertCanonicalVectorOrder(result: ReductionResult): void {
  const names = result.plan.relations;
  for (let relationPosition = 0; relationPosition < names.length; relationPosition += 1) {
    const name = names[relationPosition];
    const rows = result.reduced[name];
    for (let index = 1; index < rows.length; index += 1) {
      if (compareRows(rows[index - 1], rows[index], result.plan.attributes[name]) >= 0) {
        throw new Error(`relation ${name} surviving rows are not in canonical order`);
      }
    }
  }
}

export function lineInput(): JoinInput {
  return {
    relations: [
      relation('supplier', ['sid', 'city'], [
        { sid: 1n, city: 'BJ' },
        { sid: 2n, city: 'SH' },
        { sid: 3n, city: 'GZ' },
        { sid: 3n, city: 'GZ' },
      ]),
      relation('stock', ['sid', 'pid', 'qty'], [
        { sid: 1n, pid: 10n, qty: 5n },
        { sid: 2n, pid: 10n, qty: 7n },
        { sid: 9n, pid: 11n, qty: 1n },
      ]),
      relation('product', ['pid', 'pname'], [
        { pid: 10n, pname: 'bolt' },
        { pid: 12n, pname: 'nut' },
      ]),
    ],
    edges: [
      ['supplier', 'stock'],
      ['stock', 'product'],
    ],
  };
}

export function starInput(): JoinInput {
  return {
    relations: [
      relation('center', ['k', 'tag'], [
        { k: 1n, tag: 'a' },
        { k: 2n, tag: 'b' },
        { k: 3n, tag: 'c' },
      ]),
      relation('leaf_a', ['k', 'va'], [
        { k: 1n, va: 10n },
        { k: 2n, va: 20n },
        { k: 4n, va: 40n },
      ]),
      relation('leaf_b', ['k', 'vb'], [
        { k: 1n, vb: 100n },
        { k: 3n, vb: 300n },
      ]),
    ],
    edges: [
      ['leaf_a', 'center'],
      ['center', 'leaf_b'],
    ],
  };
}

export function emptySharedKeyInput(
  leftRows: Array<Record<string, bigint | string>>,
  rightRows: Array<Record<string, bigint | string>>,
): JoinInput {
  return {
    relations: [
      relation('alpha', ['a'], leftRows),
      relation('bravo', ['b'], rightRows),
    ],
    edges: [['alpha', 'bravo']],
  };
}

export function emptyRelationInput(): JoinInput {
  return {
    relations: [
      relation('r1', ['x'], [{ x: 1n }, { x: 2n }]),
      relation('r2', ['x', 'y'], []),
      relation('r3', ['y'], [{ y: 9n }]),
    ],
    edges: [
      ['r1', 'r2'],
      ['r2', 'r3'],
    ],
  };
}

export function ripViolationInput(): JoinInput {
  return {
    relations: [
      relation('left', ['k', 'a'], [{ k: 1n, a: 1n }]),
      relation('middle', ['k'], [{ k: 1n }]),
      relation('right', ['k', 'a'], [{ k: 1n, a: 2n }]),
    ],
    edges: [
      ['left', 'middle'],
      ['middle', 'right'],
    ],
  };
}

export function cycleInput(): JoinInput {
  return {
    relations: [
      relation('n1', ['x'], [{ x: 1n }]),
      relation('n2', ['x'], [{ x: 1n }]),
      relation('n3', ['x'], [{ x: 1n }]),
    ],
    edges: [
      ['n1', 'n2'],
      ['n2', 'n3'],
      ['n3', 'n1'],
    ],
  };
}

export function disconnectedInput(): JoinInput {
  return {
    relations: [
      relation('n1', ['x'], [{ x: 1n }]),
      relation('n2', ['x'], [{ x: 1n }]),
      relation('n3', ['y'], [{ y: 1n }]),
    ],
    edges: [['n1', 'n2']],
  };
}

export function sameAttributeAcrossPathInput(): JoinInput {
  return {
    relations: [
      relation('a', ['k', 'z'], [
        { k: 1n, z: 7n },
        { k: 2n, z: 8n },
      ]),
      relation('b', ['k'], [
        { k: 1n },
        { k: 2n },
        { k: 5n },
      ]),
      relation('c', ['k', 'w'], [
        { k: 1n, w: 3n },
        { k: 5n, w: 4n },
      ]),
    ],
    edges: [
      ['a', 'b'],
      ['b', 'c'],
    ],
  };
}
