import assert from "node:assert/strict";
import test from "node:test";

import {
  Database,
  avg,
  canonicalize,
  count,
  max,
  min,
  sum,
  type Row,
} from "../index.ts";

interface Employee extends Row {
  id: string;
  deptId: string;
  salary: number;
  active: boolean;
  managerId?: string | null;
}

interface Department extends Row {
  id: string;
  name: string;
}

function buildWarehouse() {
  const db = new Database();
  const employees = db.table<Employee>("employees", { key: "id" });
  const departments = db.table<Department>("departments", { key: "id" });

  const joined = db.view("joined_employees", {
    from: [employees, departments] as const,
    where: (employee, department) =>
      employee.active && employee.deptId === department.id,
    key: (employee) => employee.id,
    select: (employee, department) => ({
      id: employee.id,
      dept: department.name,
      salary: employee.salary,
    }),
  });

  const stats = db.view("department_stats", {
    from: joined,
    groupBy: (employee: any) => employee.dept,
    aggregates: {
      headcount: count(),
      payroll: sum((employee: any) => employee.salary),
      average: avg((employee: any) => employee.salary),
      lowest: min((employee: any) => employee.salary),
      highest: max((employee: any) => employee.salary),
    },
    select: (department: any, values: Record<string, any>) => ({
      department,
      ...values,
    }),
  });

  const grand = db.view("company_totals", {
    from: stats,
    groupBy: () => "all",
    aggregates: {
      departments: count(),
      employees: sum((row: any) => row.headcount),
      payroll: sum((row: any) => row.payroll),
    },
    select: (scope: any, values: Record<string, any>) => ({ scope, ...values }),
  });

  return { db, employees, departments, joined, stats, grand };
}

function naive(employees: Employee[], departments: Department[]) {
  const byId = new Map(departments.map((department) => [department.id, department]));
  const joined = new Map<string, any>();
  for (const employee of employees) {
    const department = byId.get(employee.deptId);
    if (!employee.active || !department) continue;
    joined.set(employee.id, {
      id: employee.id,
      dept: department.name,
      salary: employee.salary,
    });
  }

  const groups = new Map<string, Employee[]>();
  for (const employee of employees) {
    const department = byId.get(employee.deptId);
    if (!employee.active || !department) continue;
    const rows = groups.get(department.name) ?? [];
    rows.push(employee);
    groups.set(department.name, rows);
  }

  const stats = new Map<string, any>();
  for (const [department, rows] of groups) {
    const salaries = rows.map((employee) => employee.salary);
    stats.set(department, {
      department,
      headcount: rows.length,
      payroll: salaries.reduce((total, salary) => total + salary, 0),
      average: salaries.reduce((total, salary) => total + salary, 0) / salaries.length,
      lowest: Math.min(...salaries),
      highest: Math.max(...salaries),
    });
  }

  let companyEmployees = 0;
  let companyPayroll = 0;
  for (const row of stats.values()) {
    companyEmployees += row.headcount;
    companyPayroll += row.payroll;
  }
  const grand = new Map<string, any>();
  if (stats.size > 0) {
    grand.set("all", {
      scope: "all",
      departments: stats.size,
      employees: companyEmployees,
      payroll: companyPayroll,
    });
  }
  return { joined, stats, grand };
}

function assertViewMatches(
  view: { entries(): IterableIterator<[string, any]> },
  expected: Map<string, any>,
  label: string,
) {
  const actual = new Map<string, any>();
  for (const [key, row] of view.entries()) actual.set(key, row);
  assert.deepEqual(
    [...actual.keys()].sort(),
    [...expected.keys()].sort(),
    `${label}: key sets differ`,
  );
  for (const [key, row] of expected) {
    assert.equal(canonicalize(actual.get(key)), canonicalize(row), `${label}: row ${key} differs`);
  }
}

function assertAllViewsMatch(
  warehouse: ReturnType<typeof buildWarehouse>,
  step: string,
) {
  const expected = naive(warehouse.employees.toArray(), warehouse.departments.toArray());
  assertViewMatches(warehouse.joined, expected.joined, `${step} joined`);
  assertViewMatches(warehouse.stats, expected.stats, `${step} stats`);
  assertViewMatches(warehouse.grand, expected.grand, `${step} grand`);
  warehouse.db.verifyAll();
}

function seed(warehouse: ReturnType<typeof buildWarehouse>) {
  warehouse.departments.insert({ id: "d0", name: "Engineering" });
  warehouse.departments.insert({ id: "d1", name: "Sales" });
  warehouse.employees.insert({
    id: "e0",
    deptId: "d0",
    salary: 100,
    active: true,
  });
  warehouse.employees.insert({
    id: "e1",
    deptId: "d0",
    salary: 200,
    active: true,
  });
  warehouse.employees.insert({
    id: "e2",
    deptId: "d1",
    salary: 300,
    active: false,
  });
}

function applyOperation(
  warehouse: ReturnType<typeof buildWarehouse>,
  operation: string,
): void {
  const { employees, departments } = warehouse;
  switch (operation) {
    case "insert-e2-on":
      if (!employees.has("e2")) {
        employees.insert({ id: "e2", deptId: "d1", salary: 90, active: true });
      }
      break;
    case "delete-e0":
      employees.delete("e0");
      break;
    case "raise-e0":
      if (employees.has("e0")) {
        employees.update("e0", (row) => ({ ...row, salary: row.salary + 37 }));
      }
      break;
    case "move-e1":
      if (employees.has("e1")) {
        employees.update("e1", { deptId: "d1" });
      }
      break;
    case "deactivate-e0":
      if (employees.has("e0")) {
        employees.update("e0", { active: false });
      }
      break;
    case "rename-d1":
      if (departments.has("d1")) {
        departments.update("d1", { name: "Revenue" });
      }
      break;
    case "delete-d0":
      departments.delete("d0");
      break;
    case "insert-d2":
      if (!departments.has("d2")) departments.insert({ id: "d2", name: "Support" });
      break;
    default:
      throw new Error(`unknown operation ${operation}`);
  }
}

test("exhaustive short change sequences match naive full recomputation", () => {
  const operations = [
    "insert-e2-on",
    "delete-e0",
    "raise-e0",
    "move-e1",
    "deactivate-e0",
    "rename-d1",
    "delete-d0",
    "insert-d2",
  ];

  for (const first of operations) {
    for (const second of operations) {
      for (const third of operations) {
        for (const fourth of operations) {
          const warehouse = buildWarehouse();
          seed(warehouse);
          assertAllViewsMatch(warehouse, "seed");
          for (const operation of [first, second, third, fourth]) {
            applyOperation(warehouse, operation);
            assertAllViewsMatch(warehouse, operation);
          }
        }
      }
    }
  }
});

test("long interleaved insertion, update, deletion, and recompute sequences agree", () => {
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  const warehouse = buildWarehouse();
  seed(warehouse);
  const { employees, departments } = warehouse;

  for (let step = 0; step < 400; step++) {
    const roll = random();
    const employeeId = `e${Math.floor(random() * 5)}`;
    const departmentId = `d${Math.floor(random() * 3)}`;

    if (roll < 0.22) {
      if (!employees.has(employeeId)) {
        employees.insert({
          id: employeeId,
          deptId: departmentId,
          salary: Math.floor(random() * 500),
          active: random() > 0.25,
        });
      }
    } else if (roll < 0.46) {
      if (!departments.has(departmentId)) {
        departments.insert({ id: departmentId, name: `Dept-${departmentId}-${step}` });
      }
    } else if (roll < 0.68) {
      if (employees.has(employeeId)) {
        employees.update(employeeId, {
          deptId: departmentId,
          salary: Math.floor(random() * 500),
          active: random() > 0.3,
        });
      }
    } else if (roll < 0.84) {
      employees.delete(employeeId);
    } else {
      departments.delete(departmentId);
    }

    assertAllViewsMatch(warehouse, `step ${step}`);
    if (step === 199) {
      warehouse.joined.recompute();
      assertAllViewsMatch(warehouse, "manual joined recompute");
    }
  }

  warehouse.db.recomputeAll();
  assertAllViewsMatch(warehouse, "full recompute");
});

test("aggregate changes correspond to one affected group and only affected rows are examined", () => {
  const warehouse = buildWarehouse();
  for (let department = 0; department < 5; department++) {
    warehouse.departments.insert({ id: `d${department}`, name: `D${department}` });
  }
  for (let employee = 0; employee < 100; employee++) {
    warehouse.employees.insert({
      id: `e${employee}`,
      deptId: `d${employee % 5}`,
      salary: 100 + employee,
      active: true,
    });
  }

  warehouse.db.resetStats();
  warehouse.employees.update("e42", { salary: 999 });
  assertAllViewsMatch(warehouse, "single salary update");

  const stats = warehouse.stats.stats;
  assert.equal(stats.groupsUpdated, 1, "only the affected aggregate group is finalized");
  assert.equal(stats.tuplesExamined, 2, "the updated row is examined before and after only");
  assert.equal(stats.aggregateAdds, 5);
  assert.equal(stats.aggregateRemoves, 5);
  assert.equal(stats.insertedRows + stats.deletedRows, 0);
  assert.equal(stats.updatedRows, 1);

  const joinedStats = warehouse.joined.stats;
  assert.ok(
    joinedStats.tuplesExamined < 100 * 5,
    "join maintenance must not rescan the entire Cartesian product",
  );
});

test("transaction rollback never double counts and nested savepoints restore exactly", () => {
  const warehouse = buildWarehouse();
  seed(warehouse);

  for (let round = 0; round < 60; round++) {
    const before = naive(warehouse.employees.toArray(), warehouse.departments.toArray());
    const outer = warehouse.db.begin();
    outer.update(warehouse.employees, "e0", (row) => ({
      ...row,
      salary: row.salary + 1000,
    }));
    outer.update(warehouse.employees, "e1", { deptId: "d1" });

    const inner = warehouse.db.begin();
    inner.update(warehouse.employees, "e1", (row) => ({
      ...row,
      salary: row.salary + 500,
    }));
    if (round % 2 === 0) inner.rollback();
    else inner.commit();

    if (round % 3 === 0) {
      outer.rollback();
      assertViewMatches(
        warehouse.stats,
        before.stats,
        `round ${round} rolled back`,
      );
      assertViewMatches(
        warehouse.grand,
        before.grand,
        `round ${round} grand rolled back`,
      );
    } else {
      outer.update(warehouse.employees, "e2", { salary: 700 });
      outer.commit();
    }

    assertAllViewsMatch(warehouse, `transaction round ${round}`);
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    assert.throws(() =>
      warehouse.db.transaction((transaction) => {
        transaction.update(warehouse.employees, "e0", { salary: 123456 });
        transaction.insert(warehouse.departments, { id: "dX", name: "Transient" });
        transaction.insert(warehouse.employees, {
          id: "eX",
          deptId: "dX",
          salary: 1,
          active: true,
        });
        throw new Error("abort");
      }),
    );
    assertAllViewsMatch(warehouse, `throwing transaction ${attempt}`);
  }
});

test("primary key changes, self joins, and diamond dependencies stay consistent", () => {
  const db = new Database();
  const employees = db.table<Employee>("employees", { key: "id" });
  const departments = db.table<Department>("departments", { key: "id" });

  const managers = db.view("management_chain", {
    from: [employees, employees] as const,
    where: (employee, manager) =>
      employee.managerId === manager.id && employee.id !== manager.id,
    key: (employee) => employee.id,
    select: (employee, manager) => ({
      employee: employee.id,
      manager: manager.id,
      managerSalary: manager.salary,
    }),
  });

  const byDepartment = db.view("by_department", {
    from: employees,
    where: (employee) => employee.active,
    key: (employee) => employee.id,
    select: (employee) => ({
      id: employee.id,
      deptId: employee.deptId,
      salary: employee.salary,
    }),
  });
  const activePeople = db.view("active_people", {
    from: employees,
    where: (employee) => employee.active,
    key: (employee) => employee.id,
    select: (employee) => ({
      id: employee.id,
      deptId: employee.deptId,
      salary: employee.salary,
    }),
  });
  const diamond = db.view("diamond_join", {
    from: [byDepartment, activePeople] as const,
    where: (left, right) => left.id === right.id && left.deptId === right.deptId,
    key: (left) => left.id,
    select: (left, right) => ({
      id: left.id,
      deptId: left.deptId,
      salary: right.salary,
    }),
  });

  departments.insert({ id: "d0", name: "Engineering" });
  employees.insert({ id: "m", deptId: "d0", salary: 500, active: true, managerId: null });
  employees.insert({ id: "a", deptId: "d0", salary: 100, active: true, managerId: "m" });
  employees.insert({ id: "b", deptId: "d0", salary: 120, active: true, managerId: "a" });

  const check = (label: string) => {
    const expectedChain = new Map<string, any>();
    const people = employees.toArray();
    for (const employee of people) {
      const manager = people.find((candidate) => candidate.id === employee.managerId);
      if (manager && manager.id !== employee.id) {
        expectedChain.set(employee.id, {
          employee: employee.id,
          manager: manager.id,
          managerSalary: manager.salary,
        });
      }
    }
    const expectedDiamond = new Map<string, any>();
    for (const employee of people) {
      if (!employee.active) continue;
      expectedDiamond.set(employee.id, {
        id: employee.id,
        deptId: employee.deptId,
        salary: employee.salary,
      });
    }
    assertViewMatches(managers, expectedChain, `${label} chain`);
    assertViewMatches(diamond, expectedDiamond, `${label} diamond`);
    db.verifyAll();
  };

  check("initial");
  employees.update("m", (row) => ({ ...row, salary: 550 }));
  check("manager salary update");
  employees.update("a", (row) => ({ ...row, managerId: "m", salary: 140 }));
  check("reparent");
  employees.delete("m");
  check("delete manager");
  employees.insert({ id: "c", deptId: "d0", salary: 80, active: true, managerId: "b" });
  check("insert report");
  employees.update("b", (row) => ({ ...row, id: "b-renamed" }));
  check("key rename");
  db.transaction((transaction) => {
    transaction.update(employees, "a", { active: false });
    transaction.update(employees, "c", { managerId: "a" });
  });
  check("multi-row update");
});

test("grouped views support having and aggregate-only output changes", () => {
  const db = new Database();
  const orders = db.table<{ id: string; customer: string; amount: number }>("orders", {
    key: "id",
  });
  const totals = db.view("customer_totals", {
    from: orders,
    groupBy: (order) => order.customer,
    aggregates: {
      orders: count(),
      revenue: sum((order) => order.amount),
    },
    having: (_customer, values) => (values.orders as number) >= 2,
    select: (customer, values) => ({ customer, ...values }),
  });

  orders.insert({ id: "o0", customer: "a", amount: 10 });
  assert.equal(totals.size, 0);
  orders.insert({ id: "o1", customer: "a", amount: 15 });
  assert.deepEqual(totals.toArray(), [{ customer: "a", orders: 2, revenue: 25 }]);
  orders.delete("o1");
  assert.equal(totals.size, 0);
  orders.insert({ id: "o2", customer: "a", amount: 1 });
  assert.deepEqual(totals.toArray(), [{ customer: "a", orders: 2, revenue: 11 }]);
  db.verifyAll();
});

test("record-shaped inputs, automatic table keys, and batch changes are supported", () => {
  const db = new Database();
  const events = db.table("events");
  const users = db.table<{ id: string; team: string }>("users", { key: "id" });
  const teams = db.table<{ id: string; label: string }>("teams", { key: "id" });

  const decorated = db.view("decorated_users", {
    from: { user: users, team: teams },
    where: ({ user, team }: any) => user.team === team.id,
    key: ({ user }: any) => user.id,
    select: ({ user, team }: any) => ({
      id: user.id,
      team: team.label,
    }),
  });

  const firstEventKey = events.insert({ message: "one" });
  events.update(firstEventKey, { message: "two" });
  assert.deepEqual(events.toArray(), [{ message: "two" }]);
  assert.equal(events.size, 1);

  db.applyChanges([
    { type: "insert", table: "teams", row: { id: "t0", label: "Core" } },
    { type: "insert", table: "users", row: { id: "u0", team: "t0" } },
    { type: "update", table: users, key: "u0", patch: { team: "t0" } },
  ]);
  assert.deepEqual(decorated.toArray(), [{ id: "u0", team: "Core" }]);

  db.applyChanges([
    { type: "update", table: "teams", key: "t0", row: { id: "t0", label: "Platform" } },
    { type: "delete", table: "users", key: "u0" },
  ]);
  assert.equal(decorated.size, 0);
  db.verifyAll();
});

test("cascade notifications are emitted in topological dependency order", () => {
  const warehouse = buildWarehouse();
  seed(warehouse);
  const seen: string[] = [];
  const unsubscribe = warehouse.db.onChange((event) => seen.push(event.view));

  assert.deepEqual(warehouse.db.topologicalOrder(), [
    "joined_employees",
    "department_stats",
    "company_totals",
  ]);
  warehouse.employees.update("e0", { salary: 777 });
  assert.deepEqual(seen, [
    "joined_employees",
    "department_stats",
    "company_totals",
  ]);
  unsubscribe();
  warehouse.employees.update("e0", { salary: 778 });
  assert.equal(seen.length, 3);
});
