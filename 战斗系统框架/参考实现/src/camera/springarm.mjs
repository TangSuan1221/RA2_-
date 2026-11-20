// 战斗系统框架 · 参考实现 · 弹簧臂与镜头（07 章的纯数学部分）
// 契约见 03 §4.4：solveSpringArm(pivot, dir, desiredLen, probe, state, dt) → SpringArmState
//
// 关键设计（07 §2）：
//   · 收缩快（撞墙立刻缩）、恢复慢（离开墙缓慢伸长）—— 否则镜头"抽搐"
//   · 阻尼按"阻尼比 ζ"给（CAM.SPRING_DAMP = 0.85），不是裸阻尼系数：
//       ω = sqrt(k), c = 2ζω
//   · 长度硬下限 CAM.NEAR_MIN，硬上限 desiredLen

import { CAM } from '../core/constants.mjs';
import { clamp } from '../core/math.mjs';

export function createSpringArmState(len = CAM.ARM_LEN) {
  return { len, v: 0, target: len, hitDist: Infinity, collided: false, profile: 'default' };
}

/**
 * @param {[number,number,number]} dir 相机**前向**（pivot 指向视线方向）；手臂沿 -dir 伸出
 * @param {(pivot:[number,number,number], back:[number,number,number], maxDist:number)=>number} probe 沿 -dir 的首次命中距离
 */
export function solveSpringArm(pivot, dir, desiredLen, probe, state, dt) {
  const back = [-dir[0], -dir[1], -dir[2]];
  const free = probe(pivot, back, desiredLen + CAM.PROBE_R);
  const allowed = Math.max(CAM.NEAR_MIN, Math.min(desiredLen, free - CAM.PROBE_R));
  state.hitDist = free;
  state.collided = free < desiredLen + CAM.PROBE_R - 1e-6;
  state.target = allowed;

  const shrinking = allowed < state.len;
  const k = shrinking ? CAM.SPRING_K * 6.0 : CAM.SPRING_K;   // 收缩更快
  const zeta = CAM.SPRING_DAMP;
  const c = 2 * zeta * Math.sqrt(k);

  const a = (allowed - state.len) * k - c * state.v;
  state.v += a * dt;
  state.len += state.v * dt;

  // 硬钳制：伸长靠弹簧（平滑），收缩可瞬时（绝不穿墙）——这是 D1 的关键不变量
  if (state.len > allowed) { state.len = allowed; if (state.v > 0) state.v = 0; }
  if (state.len < CAM.NEAR_MIN) { state.len = CAM.NEAR_MIN; if (state.v < 0) state.v = 0; }
  if (state.len > desiredLen) { state.len = desiredLen; if (state.v > 0) state.v = 0; }

  return state;
}

// 玩家位置 + 臂长 + 相机朝向 → 相机世界位置
export function armToPosition(pivot, dir, len) {
  return [pivot[0] - dir[0] * len, pivot[1] - dir[1] * len, pivot[2] - dir[2] * len];
}

/** FOV 曲线（07 §4）：速度驱动，1.5 次幂让低中速变化更细腻 */
export function fovFor(speed, aiming = false) {
  if (aiming) return CAM.FOV_AIM;
  const t = Math.pow(clamp(speed / 5.60, 0, 1), 1.5);
  return CAM.FOV_BASE + (CAM.FOV_SPRINT - CAM.FOV_BASE) * t;
}

/** FOV 平滑（CAM.FOV_T_MS 时间常数的一阶滤波，运行时用） */
export function stepFov(cur, target, dtMs) {
  const alpha = clamp(dtMs / CAM.FOV_T_MS, 0, 1);
  return cur + (target - cur) * alpha;
}

/** FOV 过渡（验收用：smoothstep 保证在 FOV_T_MS 处精确到位且一阶连续） */
export function fovTransition(from, to, elapsedMs) {
  const t = clamp(elapsedMs / CAM.FOV_T_MS, 0, 1);
  const s = t * t * (3 - 2 * t);
  return from + (to - from) * s;
}

/**
 * 定向震动（07 §5）：沿受击方向的脉冲 × 指数衰减 × 正弦包络
 * 与"随机噪点震动"的区别：方向可读，且玩家能从中读出"被谁、从哪个方向打中"
 * @param {number} trauma 0..1
 * @param {[number,number,number]} dir 受击方向（世界空间，已归一）
 * @param {number} tSec 距震动开始的时间
 */
export function shakeOffset(trauma, dir, tSec) {
  const amp = CAM.SHAKE_MAX_POS * clamp(trauma, 0, 1);
  const env = Math.exp(-CAM.TRAUMA_DECAY * tSec);
  const osc = Math.sin(2 * Math.PI * 18.0 * tSec);
  const s = amp * env * osc;
  return [dir[0] * s, dir[1] * s * 0.6, dir[2] * s];
}

/** trauma 自身衰减（CAM.TRAUMA_DECAY/s） */
export function decayTrauma(trauma, dtSec) {
  return Math.max(0, trauma - CAM.TRAUMA_DECAY * dtSec);
}

/** 遮挡视线迭代（07 §3）：返回 pivot 需要的偏移量，最多 4 步 */
export function resolveOcclusion(pivot, camPos, raycastFn, maxShift = 0.35, steps = 4) {
  const dir = [camPos[0] - pivot[0], camPos[1] - pivot[1], camPos[2] - pivot[2]];
  const L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const n = [dir[0] / L, dir[1] / L, dir[2] / L];
  if (raycastFn(pivot, n, L) >= L) return { shift: 0, occluded: false };
  for (let i = 1; i <= steps; i++) {
    const shift = (maxShift * i) / steps;
    const p = [pivot[0] + n[0] * shift, pivot[1] + n[1] * shift, pivot[2] + n[2] * shift];
    if (raycastFn(p, n, L - shift) >= L - shift) return { shift, occluded: true };
  }
  return { shift: maxShift, occluded: true };
}
