// 战斗系统框架 · 参考实现 · 常量真值源
// 唯一作用：把 00-总纲 §4 的常量表落成代码。任何逻辑文件不得内联数字。
// source 标记：S1=GDC2021一手演讲 S2=Epic官方文档 S3=MontageGraph E1=一手事实 E3=工程估算

export const TM = {
  TICK_HZ: 60, DT_MS: 16.667, MAX_CATCHUP: 3,
  BUDGET_LOGIC: 3.75, BUDGET_ANIM: 2.0, BUDGET_MM_SEARCH: 1.2, BUDGET_RENDER: 10.0,
};

export const CC = {
  CAP_RADIUS: 0.32, STAND_H: 1.78, CROUCH_H: 1.05,
  EYE_H: 1.62, CROUCH_EYE_H: 0.92, MASS: 78,
  SPD_WALK: 1.55, SPD_JOG: 3.35, SPD_SPRINT: 5.60, SPD_CROUCH: 1.05,
  SPD_AIM_WALK: 1.35, SPD_AIM_STRAFE: 2.20,
  ACCEL: 14, DECEL: 22,
  TURN_FREE: 640, TURN_AIM: 220, TURN_SPRINT: 180,
  STEP_UP: 0.45, VAULT_MAX: 1.20, CLIMB_MAX: 2.20,
  SLOPE_MAX: 45, SLOPE_SLIDE: 50,
};

export const MM = {
  SAMPLE_HZ: 30, PCA_DIMS: 8, KNN: 32,
  POSE_JUMP_T: 0.25, RESELECT_T: 0.60, SEARCH_THROTTLE_MS: 33, BLEND_T: 0.18,
  TRAJ_PAST: [-0.20, -0.40], TRAJ_FUTURE: [0.20, 0.40, 0.67],
  W_TRAJ: 3.0, W_POSE: 1.0, W_HEADING: 1.5, W_VELOCITY: 2.0,
  CONTINUING_BIAS: -0.05, MAX_DB_SPEED: 12.0,
  KD_LEAF: 16,
};

export const SL = {
  LINES: 16, ANGLE_STEP: 22.5,
  RING_DIST: [1.55, 2.35, 3.20],
  MAX_ATTACKERS: 2, MAX_APPROACH: 3,
  UPDATE_HZ: 4, HYSTERESIS: 0.35,
  PROBE_RADIUS: 0.45, PROBE_HEIGHT: 1.70,
  BLOCK_SHIFT_STEPS: 3,
  RESERVE_TTL_MS: 1500, RELEASE_COOL_MS: 800,
  TELL_SCALE: { novice: 1.35, vet: 1.00, brute: 1.25 },
  TELL_SCALE_BOSS: 1.45,
  // 槽位生命周期（09 §4；与 RESERVE_TTL 互补：reserve 是"申请后被保留"，occupy 是"到岗后占住"）
  APPROACH_TTL_MS: 3000, OCCUPY_TTL_MS: 1200,
  OCCUPY_TOL: 0.25, OCCUPY_ANGLE: 30,
  MAX_VALID: 8, GAP_MERGE: 2,         // 16 线 ÷ 2 = 8 个 gap（E1 事实推论）
  HYST_PCT: 0.35,
  W_BIAS: 1.0, W_CROWD: 0.6, W_RING: 0.4, W_PREF: 0.8,
};

export const CB = {
  INPUT_BUFFER_MS: 120,
  LIGHT: { windup: 260, active: 90, recovery: 300 },
  HEAVY: { windup: 420, active: 110, recovery: 460 },
  CANCEL_POINT: 0.60, TELL_MARGIN_MS: 80,
  DODGE_TOTAL_MS: 550, DODGE_IFRAME: [0, 200],
  PARRY_WINDOW_MS: 140,
  POISE_MAX: 60, POISE_REGEN: 12,
  HITSTOP_LIGHT_MS: 60, HITSTOP_HEAVY_MS: 100, HITSTOP_EXEC_MS: 140,
  TOKEN_FREEZE_MS: 300,             // 06 §3：玩家出招时冻结目标身上 attacker token
  CTX_PICK_MS: 80, CTX_DROP_MS: 50, // 上下文候选确认稳定窗 / 取消滞回窗
  PARRY_HALF_MS: 67,                // 招架窗口半宽（总 140ms）
  EXEC_RANGE: 1.35, EXEC_ANGLE: 70, EXEC_HP_PCT: 0.25, EXEC_STAGGER_WINDOW_MS: 900,
  EXEC_3P_CLEAR_MS: 900,            // 处决保护：第三人不得攻击处决双方的时长
  KNOCKBACK_BASE: 2.4, KNOCKBACK_MASS_REF: 78,
  PART_MUL: { head: 1.8, torso: 1.0, limb: 0.7, leg: 0.55 },
};

export const CAM = {
  ARM_LEN: 2.70, SHOULDER_X: 0.52, PIVOT_H: 1.58,
  PROBE_R: 0.28, SPRING_K: 14.0, SPRING_DAMP: 0.85,
  POS_LERP: 0.18, NEAR_MIN: 0.12,
  FOV_BASE: 55, FOV_SPRINT: 62, FOV_AIM: 42, FOV_T_MS: 220,
  TRAUMA_DECAY: 1.8, SHAKE_MAX_POS: 0.09, SHAKE_MAX_ROLL: 2.2,
  AIMASSIST_CONE: 6, AIMASSIST_DIST: 25,
  BUDGET_MS: 0.15,                  // 07 §8：每帧相机求解预算
};

export const AI = {
  PERCEPT_HZ: 6, VIEW_DIST: 32, VIEW_FOV: 110, VIEW_FOV_COMBAT: 150,
  NOTICE_T: 0.35, NOTICE_T_FAR: 1.10,
  HEAR: { walk: 6, sprint: 14, gunshot: 55, silenced: 8, whistle: 25 },
  HEAR_WALL_ATT: 0.70, HEAR_WALL_MAX: 3, HEAR_AWARE_BURST: 0.55,
  LKP_DECAY: 0.90, SHARE_DELAY_MS: 400, SHARE_RADIUS: 18,
  APPROACH_WALK: 1.80, APPROACH_RUN: 4.20,
  GIVEUP_T: 2.50, FEINT_CHANCE: 0.25,
  FEINT_SIDE: 0.90,                 // 假动作侧移距离（m）
  LOD_DIST_NEAR: 25, LOD_DIST_FAR: 45, LOD_EXTRAP_T: 2.0,
  LOD_HZ_FAR: 1, LOD_HZ_OFFSCREEN: 0.5,
  POLITE_WINDOW_MS: 200,            // 玩家翻滚/受击硬直后的"AI 礼貌窗"
  SUSPICIOUS_T: 3.0, ALERT_SUSPICIOUS: 0.25,
  HORDE_ATTACK_MAX: 3,              // 感染者同时攻击上限（GDD §6.1）
  CAMP_RADIUS: 1.5, CAMP_STILL_T: 12, CAMP_MOVE_EPS: 0.15,   // 反蹲狗（GDD §7）
  BUDGET_MS: 1.5,
};

// 状态机分档（06 §6）：Lower 速度分档与 Upper 层混合
export const SM = {
  V_THRESH_WALK_JOG: 2.45,   // (1.55+3.35)/2
  V_THRESH_JOG_SPRINT: 4.48, // (3.35+5.60)/2
  UPPER_BLEND_MS: 120,       // Upper 层状态切换混合（与 CB-INPUT-BUFFER 同值）
};

// 输入（06 §1）
export const IN = {
  DEADZONE: 0.18,            // 摇杆/触屏径向死区
};

// 调参判据常量（11 章 §8）：不是玩法参数，是"验收判据/冻结标记"
export const TN = {
  DIFF_BUDGET_MS: 100,     // 输入→首帧表现上限（定律①）
  JUMP_EPS: 0.12,          // 镜头单帧位移跳变判据（m）
  AB_DIFF_REL: 0.03,       // A/B 指标等价阈值（3%）
  AB_SEED: 0x5EED,         // 回放/A-B 固定种子（禁止时间戳）
  TTK_WARN_PCT: 0.15,      // TTK 变化超过 15% 视为玩法级改动
  SLIDE_EPS: 0.25,         // 单步内足部滑移上限（m）
  REACT_MIN_MS: 200,       // 人类简单视觉反应参考值（定律②下限）
  PARAM_LOCK: 1,           // L0 参数冻结标记：同一 PR 内改动即拒绝合入
};

// 单位换算工具（DT 用毫秒，逻辑用秒）
export const DT = TM.DT_MS / 1000;
export const fmt = (v) => Number(v.toFixed(4));
