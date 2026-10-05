// CLI: node dist/src/cli.js <输入目录>   退出码: 0=全部一致, 1=存在冲突, 2=存在未知/用法错误
import { loadInputDocs } from './loader.js';
import { formatReport } from './report.js';
import { verify } from './verify.js';

function main(): void {
  const dir = process.argv[2] ?? '.';
  let report;
  try {
    const docs = loadInputDocs(dir);
    report = verify(docs.manifest, docs.trajectories, docs.fileSummaries);
  } catch (err) {
    console.error(`核验失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  console.log(formatReport(report));
  if (report.summary.conflict > 0) process.exitCode = 1;
  else if (report.summary.unknown > 0 || report.summary.orphans > 0) process.exitCode = 2;
}

main();
