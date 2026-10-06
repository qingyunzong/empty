import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture {
  root: string;
  cleanup(): Promise<void>;
}

export async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dirscan-fixture-"));
  await writeFile(join(root, "alpha.txt"), "hello alpha");
  await mkdir(join(root, "sub"));
  await mkdir(join(root, "sub", "empty"));
  await writeFile(join(root, "sub", "beta.txt"), "hello beta");
  await symlink("alpha.txt", join(root, "link-to-alpha"));
  await symlink("sub", join(root, "link-to-sub"));
  await symlink(join("nope", "missing"), join(root, "broken-link"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
