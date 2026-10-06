/** 极简测试运行器：沙箱禁止子进程，node --test 不可用，改为进程内执行 */
type TestFn = () => void | Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];

export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

export async function run(): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      process.stdout.write(`ok ${pass + fail} - ${t.name}\n`);
    } catch (e) {
      fail++;
      process.stdout.write(`not ok ${pass + fail} - ${t.name}\n`);
      process.stderr.write(String(e instanceof Error ? e.stack : e) + "\n");
    }
  }
  process.stdout.write(`# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n`);
  if (fail > 0) process.exitCode = 1;
}
