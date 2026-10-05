import {
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  mkdirSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";

/**
 * Low-level durable device. Every method except readFile is one write
 * boundary: a point at which a crash may interrupt the commit protocol.
 */
export interface Device {
  writeTmp(path: string, data: string): void;
  fsyncFile(path: string): void;
  rename(tmpPath: string, finalPath: string): void;
  fsyncDir(path: string): void;
  readFile(path: string): string | null;
}

export class RealDevice implements Device {
  writeTmp(path: string, data: string): void {
    writeFileSync(path, data);
  }

  fsyncFile(path: string): void {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  rename(tmpPath: string, finalPath: string): void {
    renameSync(tmpPath, finalPath);
  }

  fsyncDir(path: string): void {
    mkdirSync(path, { recursive: true });
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  readFile(path: string): string | null {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }
}
