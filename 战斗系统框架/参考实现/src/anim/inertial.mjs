// 战斗系统框架 · 参考实现 · 惯性化混合（Inertial Blending）
// 04 §4：offset = q_prev · q_cur⁻¹，按指数/弹簧衰减叠加回新姿态；衰减时长 MM.BLEND_T
// 相比 crossfade 的好处：不冻结动画、不产生"速度阶跃"，姿态一阶连续

import { MM } from '../core/constants.mjs';

// 四元数 [x,y,z,w]
export const Q = {
  mul(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
  },
  conj(q) { return [-q[0], -q[1], -q[2], q[3]]; },
  norm(q) {
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  },
  angleDeg(q) {  // 旋转角（度）
    const w = Math.min(1, Math.abs(q[3]));
    return 2 * Math.acos(w) * 180 / Math.PI;
  },
};

/** 建立一次惯性化：从 prevPose 切到 curPose 时记录每个骨骼的 offset */
export function beginInertial(prevPose, curPose) {
  const n = prevPose.length;
  const offset = new Array(n);
  for (let i = 0; i < n; i++) offset[i] = Q.norm(Q.mul(prevPose[i], Q.conj(curPose[i])));
  return { offset, t: 0, duration: MM.BLEND_T };
}

/**
 * 每帧推进：out = offset^decay · curPose
 * decay 用 (1-t/T)^2 保证结束时一阶收敛到 0（速度也归零）
 */
export function stepInertial(state, curPose, dtMs) {
  state.t += dtMs / 1000;
  const T = state.duration;
  const k = state.t >= T ? 0 : Math.pow(1 - state.t / T, 2);
  const out = new Array(curPose.length);
  for (let i = 0; i < curPose.length; i++) {
    const o = state.offset[i];
    const scaled = Q.norm([o[0] * k, o[1] * k, o[2] * k, o[3] * k + (1 - k)]);
    out[i] = Q.norm(Q.mul(scaled, curPose[i]));
  }
  return { pose: out, done: state.t >= T };
}

// 姿态最大逐骨角差（验收 B4 用）
export function poseDeltaDeg(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Q.angleDeg(Q.mul(a[i], Q.conj(b[i])));
    if (d > max) max = d;
  }
  return max;
}
