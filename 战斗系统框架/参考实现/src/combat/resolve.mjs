// 战斗系统框架 · 参考实现 · 伤害管线与回溯命中（08 章的可执行部分）
// 管线顺序不可调换（08 §1）：
//   ①命中查询 ②去重 ③无敌帧 ④招架 ⑤部位/护甲 ⑥伤害+poise ⑦反应 ⑧击退+冻帧 ⑨事件
// 回溯命中（08 §2，移植 MontageGraph 的 Collision Caching 思路）：OBB 中心/朝向在两步之间插值取样，防跳帧漏判

import { CB, CC, DT } from '../core/constants.mjs';
import { obbContainsSphere, V3, clamp } from '../core/math.mjs';

const msToSteps = (ms) => Math.round(ms / 1000 / DT);

export function createFighter(id, opts = {}) {
  return {
    id,
    hp: opts.hp ?? 100, maxHp: opts.hp ?? 100,
    poise: opts.poise ?? CB.POISE_MAX,
    state: 'idle',
    pos: opts.pos ?? [0, 0, 0],   // 世界坐标（x,y,z）
    yaw: opts.yaw ?? 0,
    mass: opts.mass ?? CC.MASS,
    maxSpeed: opts.maxSpeed ?? CC.SPD_JOG,
    iframeUntil: -1, parryUntil: -1, staggerUntil: -1, hitstopUntil: -1,
    brokenLeg: false, armor: opts.armor ?? 0,   // armor = 减伤比例（0..0.7）
    lastHitStep: -99,
  };
}

export function beginAttack(fighter, move, step) {
  const windup = msToSteps(move.windupMs), active = msToSteps(move.activeMs), recovery = msToSteps(move.recoveryMs);
  return {
    id: `${fighter.id}:${move.id}:${step}`,
    attackerId: fighter.id,
    move,
    startStep: step,
    endStep: step + windup + active + recovery,
    windup, active, recovery,
    hitSet: new Set(),
    ended: false,
  };
}

export function attackInfo(attack, step) {
  const t = step - attack.startStep;
  if (t < 0) return { phase: 'pending', pct: 0, t };
  if (t < attack.windup) return { phase: 'windup', pct: t / attack.windup, t };
  if (t < attack.windup + attack.active) {
    const p = (t - attack.windup) / attack.active;
    return { phase: 'active', pct: p, t };
  }
  if (t < attack.windup + attack.active + attack.recovery) {
    const p = (t - attack.windup - attack.active) / attack.recovery;
    return { phase: 'recovery', pct: p, t };
  }
  return { phase: 'done', pct: 1, t };
}

// 招式整体进度（0..1），用于连招图 fromPct
export function actionPct(attack, step) {
  const total = attack.windup + attack.active + attack.recovery;
  return clamp((step - attack.startStep) / total, 0, 1);
}

/** 回溯命中：两步之间的 OBB 扫掠（3 段插值 + SAT 近似） */
export function sweptHit(prev, cur, targetPos, targetRadius, samples = 3) {
  for (let s = 0; s <= samples; s++) {
    const t = samples === 0 ? 1 : s / samples;
    const c = V3.lerp(prev.center, cur.center, t);
    const yaw = prev.yaw + (cur.yaw - prev.yaw) * t;
    if (obbContainsSphere(c, cur.half, yaw, targetPos, targetRadius)) return { hit: true, at: t };
  }
  return { hit: false, at: -1 };
}

/**
 * 结算一次命中（08 §1 的九步）。
 * @returns {{events:string[], damage:number, blocked:boolean, reason?:string}}
 */
export function applyHit(attacker, target, attack, hitbox, step, opts = {}) {
  const events = [];
  // 冻帧：攻击者被冻住时整条管线挂起（08 §6）
  if (step < attacker.hitstopUntil) return { events, damage: 0, blocked: true, reason: 'attacker_frozen' };
  // ② 去重
  if (attack.hitSet.has(target.id)) return { events, damage: 0, blocked: true, reason: 'duplicate' };
  attack.hitSet.add(target.id);

  // ③ 无敌帧
  if (step <= target.iframeUntil) {
    events.push(`hit_dodged:${target.id}`);
    return { events, damage: 0, blocked: true, reason: 'iframe' };
  }
  // ④ 招架
  if (step <= target.parryUntil) {
    attacker.staggerUntil = step + msToSteps(400);
    attacker.state = 'stagger';
    events.push(`parried:${attacker.id}->${target.id}`);
    return { events, damage: 0, blocked: true, reason: 'parried' };
  }

  // ⑤ 部位与护甲
  const part = opts.part ?? hitbox.hurtGroup ?? 'torso';
  const partMul = CB.PART_MUL[part] ?? 1.0;
  const dmg = hitbox.damage * partMul * (1 - clamp(target.armor, 0, 0.7));

  // ⑥ 伤害与 poise
  target.hp = Math.max(0, target.hp - dmg);
  target.poise = Math.max(0, target.poise - (hitbox.poiseDamage ?? 0));
  const poiseBreak = target.poise <= 0;
  if (poiseBreak) {
    target.poise = CB.POISE_MAX;
    target.staggerUntil = step + msToSteps(CB.EXEC_STAGGER_WINDOW_MS);
    target.state = 'stagger';
    events.push(`poise_break:${target.id}`);
  }

  // ⑦ 反应（这里只给状态，动画层在 render 侧取 reactions.json）
  const dir = V3.sub(attacker.pos, target.pos);
  const heavy = (hitbox.poiseDamage ?? 0) >= 25;
  events.push(`hit:${target.id}:${Math.round(dmg * 100) / 100}:${part}:${poiseBreak ? 'break' : heavy ? 'heavy' : 'light'}`);

  // 腿部打断（GDD §3.2：击中腿部骨折无法奔跑）
  if (part === 'leg') { target.brokenLeg = true; target.maxSpeed = CC.SPD_WALK; events.push(`broken_leg:${target.id}`); }

  // ⑧ 击退 + 冻帧
  const kb = (hitbox.knockback ?? CB.KNOCKBACK_BASE) * (CB.KNOCKBACK_MASS_REF / target.mass);
  target.knockback = V3.mul(V3.norm(dir), kb);
  const stopMs = hitbox.hitstopMs ?? (heavy ? CB.HITSTOP_HEAVY_MS : CB.HITSTOP_LIGHT_MS);
  attacker.hitstopUntil = step + msToSteps(stopMs);
  target.hitstopUntil = step + msToSteps(stopMs);
  target.lastHitStep = step;

  return { events, damage: dmg, blocked: false, part, poiseBreak };
}

/** 处决条件（08 §5 八条，全部满足才可发起） */
export function canExecute(player, target, extra = {}) {
  const dist = V3.dist2D(player.pos, target.pos);
  const reasons = [];
  if (target.hp / target.maxHp > CB.EXEC_HP_PCT && target.state !== 'stagger') reasons.push('hp');
  if (dist > CB.EXEC_RANGE) reasons.push('range');
  if ((extra.angleOffDeg ?? 0) > CB.EXEC_ANGLE / 2) reasons.push('angle');
  if (target.state !== 'stagger' && target.hp / target.maxHp > CB.EXEC_HP_PCT) reasons.push('not_staggered');
  if (extra.targetBusy) reasons.push('target_busy');
  if (extra.thirdPartyOccupied) reasons.push('third_party');
  if (player.hitstopUntil > extra.step || player.staggerUntil > extra.step) reasons.push('player_busy');
  if (extra.isBoss) reasons.push('boss_immune');
  if (extra.airborne) reasons.push('airborne');
  return { ok: reasons.length === 0, reasons };
}

/** 处决锁定：返回 execLock 表项（槽位仲裁会跳过这些目标，见 08 §5） */
export function beginExecution(player, target, move, step) {
  const dur = msToSteps(move?.executionMs ?? CB.EXEC_STAGGER_WINDOW_MS);
  return {
    attackerId: player.id, targetId: target.id,
    startStep: step, endStep: step + dur,
    protectSteps: msToSteps(CB.EXEC_STAGGER_WINDOW_MS),
  };
}
export function execLocks(lock, step) {
  if (!lock) return [];
  return step <= lock.endStep ? [lock.attackerId, lock.targetId] : [];
}
