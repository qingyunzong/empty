import { createReadStream, createWriteStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as readline from "node:readline";

export interface LineWriter {
  write(line: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * File-system abstraction used by the sorter. Tests wrap this interface to
 * inject write failures and to observe which operations a resume performs.
 */
export interface Io {
  mkdir(dir: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  stat(p: string): Promise<{ size: number; mtimeMs: number }>;
  readJson(p: string): Promise<unknown>;
  writeJsonAtomic(p: string, value: unknown): Promise<void>;
  writeLinesAtomic(p: string, lines: string[]): Promise<void>;
  readLines(p: string): AsyncIterable<string>;
  createWriter(p: string): LineWriter;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  removeDir(p: string): Promise<void>;
}

export const nodeIo: Io = {
  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },

  async exists(p) {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  },

  stat(p) {
    return fsp.stat(p);
  },

  async readJson(p) {
    return JSON.parse(await fsp.readFile(p, "utf8")) as unknown;
  },

  async writeJsonAtomic(p, value) {
    const tmp = p + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsp.rename(tmp, p);
  },

  async writeLinesAtomic(p, lines) {
    const tmp = p + ".tmp";
    await fsp.writeFile(tmp, lines.map((l) => l + "\n").join(""), "utf8");
    await fsp.rename(tmp, p);
  },

  readLines(p) {
    return readline.createInterface({
      input: createReadStream(p, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
  },

  createWriter(p) {
    const ws = createWriteStream(p, { encoding: "utf8" });
    return {
      write(line) {
        return new Promise<void>((resolve, reject) => {
          ws.write(line + "\n", (err?: Error | null) => (err ? reject(err) : resolve()));
        });
      },
      close() {
        return new Promise<void>((resolve, reject) => {
          ws.once("error", reject);
          ws.end(() => resolve());
        });
      },
    };
  },

  rename(from, to) {
    return fsp.rename(from, to);
  },

  async remove(p) {
    await fsp.rm(p, { force: true });
  },

  async removeDir(p) {
    await fsp.rm(p, { recursive: true, force: true });
  },
};
