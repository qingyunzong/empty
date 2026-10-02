// 故障注入: 在指定字节处截断文件, 模拟写盘中途掉电。
import fs from 'node:fs';

export function truncateAt(file, bytes) {
  const size = fs.statSync(file).size;
  if (bytes < 0 || bytes > size) throw new RangeError(`truncate offset ${bytes} out of range 0..${size}`);
  fs.truncateSync(file, bytes);
  return { file, from: size, to: bytes };
}
