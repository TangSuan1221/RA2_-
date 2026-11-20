// 战斗系统框架 · 参考实现 · 纯数学 + 确定性 RNG
// 约束：零分配优先（scratch 复用），逻辑侧禁止 Math.random（不变量 I5）

export const V3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  len2: (a) => a[0] * a[0] + a[1] * a[1] + a[2] * a[2],
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  dist2D: (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]),
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => clamp(v, 0, 1);
export const lerp = (a, b, t) => a + (b - a) * t;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// 角度差归一到 [-180,180)
export function angleDelta(a, b) {
  let d = (a - b) % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
export const wrapDeg = (a) => ((a % 360) + 360) % 360;

// 由 yaw(度) 得到朝向向量（+Z 为 0°，顺时针为正，与 Three.js 一致）
export function yawToDir(yawDeg) {
  const r = yawDeg * DEG;
  return [Math.sin(r), 0, Math.cos(r)];
}
export function dirToYaw(d) {
  return wrapDeg(Math.atan2(d[0], d[2]) * RAD);
}

// ---------- 确定性 RNG：mulberry32 ----------
export class Rng {
  constructor(seed = 12345) { this.s = seed >>> 0; this.calls = 0; }
  next() {
    this.calls++;
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(n) { return Math.floor(this.next() * n) % n; }
  // 拒绝采样高斯（确定性）
  gauss() {
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
export function isSeededRng(x) { return x instanceof Rng; }

// ---------- 哈希（状态指纹，量化后再哈希以保证浮点无关）----------
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export const q3 = (v) => Math.round(v * 1000) / 1000;
export function hashState(obj) {
  return fnv1a(JSON.stringify(obj, (k, v) => (typeof v === 'number' ? q3(v) : v)));
}

// ---------- 2D 圆-圆 / 线段-圆 相交（槽位探针用）----------
export function circleOverlap(ax, az, ar, bx, bz, br) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz <= (ar + br) * (ar + br);
}

// 射线-圆（2D）最近命中距离；无命中返回 Infinity
export function rayCircle2D(ox, oz, dx, dz, cx, cz, r) {
  const fx = ox - cx, fz = oz - cz;
  const a = dx * dx + dz * dz;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
  const t = t1 >= 0 ? t1 : t2 >= 0 ? t2 : Infinity;
  return t;
}

// ---------- OBB 近似（hitbox 用，避免引入矩阵库）----------
// OBB 用中心 + 半长 + yaw 表示；测试 OBB 与球心（胶囊近似为球）
export function obbContainsSphere(c, half, yawDeg, sph, sphR) {
  const d = V3.sub(sph, c);
  const r = -yawDeg * DEG;
  const cs = Math.cos(r), sn = Math.sin(r); // 世界→局部
  const lx = d[0] * cs - d[2] * sn;
  const lz = d[0] * sn + d[2] * cs;
  const ly = d[1];
  const cx = clamp(lx, -half[0], half[0]);
  const cy = clamp(ly, -half[1], half[1]);
  const cz = clamp(lz, -half[2], half[2]);
  const dx = lx - cx, dy = ly - cy, dz = lz - cz;
  return dx * dx + dy * dy + dz * dz <= sphR * sphR;
}
