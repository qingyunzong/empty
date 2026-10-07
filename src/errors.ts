export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 文档结构或字段值不合法。 */
export class ValidationError extends SnapshotError {}

/** 引用指向不存在的对象(悬空引用)。 */
export class BadReferenceError extends SnapshotError {}
