/** 工人编号：0 = 甲(A)，1 = 乙(B)。 */
export type WorkerId = 0 | 1;

/** 单人任务的技能要求：A 仅工人甲，B 仅工人乙，any 任一人。 */
export type Skill = "A" | "B" | "any";

export interface Task {
  id: string;
  /** 整数时长，>= 1 */
  duration: number;
  /** 1 = 单人任务；2 = 双人任务（必须同步占用两名工人） */
  workers: 1 | 2;
  /** 单人任务的技能要求，默认 "any"；双人任务忽略 */
  skill?: Skill;
  /** 前置任务 id 列表（全部完成后本任务才可开始） */
  deps?: string[];
}

export interface Instance {
  /** 整数时间上限，默认 40，最大 40 */
  horizon?: number;
  tasks: Task[];
}

export interface ScheduleEntry {
  taskId: string;
  start: number;
  end: number;
  /** 占用工人：[0] / [1] / [0,1]（双人任务同步占两人） */
  workers: WorkerId[];
}

export interface Solution {
  makespan: number;
  entries: ScheduleEntry[];
}
