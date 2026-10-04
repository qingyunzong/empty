/** 巡检站点定义（原始 JSON 格式）。 */
export interface StationSpec {
  id: string;
  x: number;
  y: number;
  /** 服务耗时 */
  service: number;
  /** 时间窗：最早可开始服务时刻 */
  open: number;
  /** 时间窗：最晚可开始服务时刻（到达晚于 close 则不可服务） */
  close: number;
  /** 访问收益 */
  profit: number;
}

export interface InstanceSpec {
  name?: string;
  /** 整数总时限（含行驶、等待、服务，以及返回基地） */
  timeLimit: number;
  depot: { x: number; y: number };
  stations: StationSpec[];
}

/** 编译后的求解实例：节点 0 为基地，1..n 为站点。 */
export interface Instance {
  name: string;
  timeLimit: number;
  n: number;
  service: number[];
  open: number[];
  close: number[];
  profit: number[];
  ids: string[];
  /** 欧氏距离矩阵，行驶时间 = 距离（速度 1） */
  dist: number[][];
}

/** 到离时刻证书中的一条停靠记录。 */
export interface CertLeg {
  node: string;
  arrive: number;
  /** 到达后因等待时间窗开启产生的等待时长（基地为 0） */
  wait: number;
  /** 开始服务时刻（基地同 arrive） */
  start: number;
  depart: number;
  window?: [number, number];
  service?: number;
  profit?: number;
}

export interface Certificate {
  instance: string;
  timeLimit: number;
  profit: number;
  distance: number;
  totalTime: number;
  legs: CertLeg[];
}

export interface SolveResult {
  profit: number;
  distance: number;
  totalTime: number;
  /** 访问顺序（站点下标 1..n），空数组表示不访问任何站点 */
  route: number[];
}

export const EPS = 1e-9;
