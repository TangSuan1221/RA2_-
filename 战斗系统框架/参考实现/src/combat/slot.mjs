// 战斗系统框架 · 参考实现 · 槽位系统（TLOU 战局调度的核心）
// 契约见 03 §4.1：buildSlotTable(player, obstacles, step, prev) / requestSlot(table, req, step)
//
// E1 依据（GDC 2021 · Strafe Slots）：
//   · 槽位点位于以玩家为中心的 16 条延伸线上，NPC 进入"线之间的空隙"
//   · 延伸线被障碍挡住时，跟踪被挡的线并改位避开
//   · 系统自行调整槽位避免物件阻碍
// 工程实现（E3）：16 线 × 3 环 = 48 候选 → 剔除障碍 → 相邻有效线合并成 gap → 每 gap 出 1 槽（≤8）
// 不变量 I2：同时持有 attacker token 的 AI ≤ SL.MAX_ATTACKERS

import { SL, CB } from '../core/constants.mjs';
import { DT } from '../core/constants.mjs';
import { circleOverlap, rayCircle2D, angleDelta, wrapDeg, yawToDir } from '../core/math.mjs';

const TTL_STEPS = Math.round(SL.RESERVE_TTL_MS / 1000 / DT);   // 1500ms → 90 步
const COOL_STEPS = Math.round(SL.RELEASE_COOL_MS / 1000 / DT); // 800ms → 48 步
const FREEZE_PLAYER_STEPS = Math.round(CB.TOKEN_FREEZE_MS / 1000 / DT); // 06 §3：300ms → 18 步

export function hasClearance(x, z, obstacles, probe = SL.PROBE_RADIUS) {
  for (const o of obstacles) if (circleOverlap(x, z, probe, o.x, o.z, o.r)) return false;
  return true;
}

function lineBlocked(px, pz, dx, dz, dist, obstacles) {
  for (const o of obstacles) {
    const t = rayCircle2D(px, pz, dx, dz, o.x, o.z, o.r + 0.10);
    if (t < dist - 0.05) return true;     // 射线在到达槽位前就撞到障碍
  }
  return false;
}

// 前/侧/后 权重（lineBias）：0°=正前
function biasFor(relAngleAbs) {
  if (relAngleAbs <= 45) return 1.0;      // front
  if (relAngleAbs <= 135) return 0.8;     // side
  return 0.55;                            // back
}

/**
 * 纯函数：同一 (player, obstacles, step, prev) 必得同一输出（A 组额外断言）
 * @param {{pos:[number,number], yaw:number}} player  pos=[x,z]
 * @param {{x:number,z:number,r:number}[]} obstacles 圆形障碍（2D）
 * @param {number} step 逻辑步
 * @param {object|null} prev 上一次的表（用于迟滞 SL.HYSTERESIS）
 */
export function buildSlotTable(player, obstacles, step, prev = null) {
  const [px, pz] = player.pos;
  const yaw = player.yaw;

  // ---- 1. 48 候选：16 线 × 3 环 ----
  const cells = new Array(SL.LINES);
  let linesBlocked = 0;
  for (let i = 0; i < SL.LINES; i++) {
    const ang = wrapDeg(yaw + i * SL.ANGLE_STEP);
    const d = yawToDir(ang);
    const row = [];
    let anyValid = false;
    for (let r = 0; r < SL.RING_DIST.length; r++) {
      const dist = SL.RING_DIST[r];
      const x = px + d[0] * dist, z = pz + d[2] * dist;
      const ok = hasClearance(x, z, obstacles) && !lineBlocked(px, pz, d[0], d[2], dist, obstacles);
      if (ok) anyValid = true;
      row.push({ ring: r, dist, x, z, ok });
    }
    if (!anyValid) linesBlocked++;
    cells[i] = { line: i, angle: ang, dir: d, rings: row, anyValid };
  }

  // ---- 2. 相邻有效线合并成 gap（环形）----
  const valid = cells.map((c) => c.anyValid);
  const gaps = [];
  if (valid.every((v) => v)) {
    gaps.push({ id: 0, lines: cells.map((c) => c.line) });
  } else {
    let start = valid.findIndex((v, i) => v && !valid[(i - 1 + SL.LINES) % SL.LINES]);
    if (start < 0) start = 0;
    for (let k = 0, i = start; k < SL.LINES; k++, i = (i + 1) % SL.LINES) {
      if (!valid[i]) continue;
      if (!valid[(i - 1 + SL.LINES) % SL.LINES]) gaps.push({ id: gaps.length, lines: [i] });
      else gaps[gaps.length - 1].lines.push(i);
    }
  }

  // ---- 3. 每个 gap 按"每 2 条相邻线 1 个槽"切组（开阔地 16 线 → 8 槽，环绕角 45°）----
  //        每组建 1 槽（得分最高的那条线），并做改位（≤ BLOCK_SHIFT_STEPS 步）
  const groups = [];
  for (const gap of gaps) {
    for (let k = 0; k * 2 < gap.lines.length; k++) {
      const lines = gap.lines.slice(k * 2, k * 2 + 2);
      if (lines.length === 0) continue;
      groups.push({ id: `${gap.id}:${k}`, gapId: gap.id, groupIdx: k, lines });
    }
  }

  const prevByGroup = new Map();
  if (prev?.slots) for (const s of prev.slots) prevByGroup.set(s.groupId, s);

  const slots = [];
  for (const gap of groups) {
    let best = null;
    for (const line of gap.lines) {
      const c = cells[line];
      const ringIdx = c.rings.findIndex((r) => r.ok);
      if (ringIdx < 0) continue;
      const rel = Math.abs(angleDelta(c.angle, yaw));
      const ring = c.rings[ringIdx];
      // 得分：位置偏好 − 环代价 − 与相邻被挡线的接近程度
      const score =
        biasFor(rel) * (1 - 0.12 * ringIdx) -
        0.05 * Math.min(ringIdx, 2) -
        0.02 * Math.abs(rel) / 45;
      if (!best || score > best.score) best = { line, angle: c.angle, ring: ringIdx, x: ring.x, z: ring.z, score };
    }
    if (!best) continue;

    // 改位：若最佳点实际不可用（理论上不会），沿线两侧平移
    if (!hasClearance(best.x, best.z, obstacles)) {
      let fixed = null;
      for (let s = 1; s <= SL.BLOCK_SHIFT_STEPS && !fixed; s++) {
        for (const sign of [1, -1]) {
          const line = (best.line + sign * s + SL.LINES) % SL.LINES;
          const c = cells[line];
          const ringIdx = c.rings.findIndex((r) => r.ok);
          if (ringIdx < 0) continue;
          const ring = c.rings[ringIdx];
          if (hasClearance(ring.x, ring.z, obstacles)) { fixed = { line, angle: c.angle, ring: ringIdx, x: ring.x, z: ring.z, score: best.score * 0.99 }; break; }
        }
      }
      if (!fixed) continue;            // 无法改位 → 放弃该槽（让出 token）
      best = fixed;
    }

    // ---- 4. 迟滞：同组的旧槽只要新得分没高出 35% 就保留（A6）----
    const prevSlot = prevByGroup.get(gap.id);
    if (prevSlot && best.score <= prevSlot.score * (1 + SL.HYSTERESIS)) {
      const c = cells.find((cc) => cc.line === prevSlot.line);
      const ring = c?.rings[prevSlot.ring];
      if (c && ring?.ok) {
        slots.push({ ...prevSlot, groupId: gap.id, gapId: gap.gapId, x: ring.x, z: ring.z, angle: c.angle, stale: false });
        continue;
      }
    }
    slots.push({
      groupId: gap.id, gapId: gap.gapId, groupIdx: gap.groupIdx,
      line: best.line, ring: best.ring, angle: best.angle,
      x: best.x, z: best.z, score: best.score, stale: false,
    });
  }

  slots.sort((a, b) => a.gapId - b.gapId || a.groupIdx - b.groupIdx || a.line - b.line);
  slots.forEach((s, i) => { s.index = i; });

  return { step, slots, linesBlocked, blockedMask: cells.map((c) => !c.anyValid) };
}

// ---------------- 有状态部分：token 生命周期 ----------------
export function createTable() {
  return {
    slots: [], linesBlocked: 0, step: -1,
    tokens: new Map(),                 // actorId → { role, slotIndex, grantedStep, expiresStep }
    cooldownUntil: new Map(),          // actorId → step
    freezeUntil: new Map(),            // targetId → step（06 §3 玩家出招冻结）
    grants: [],                        // 授予历史（验收 A1/A4/A5 用）
    releases: [],
  };
}

/** 4Hz 重算槽位（SL.UPDATE_HZ）+ 过期回收 */
export function updateTable(table, player, obstacles, step) {
  const due = table.step < 0 || step - table.step >= Math.round(1000 / SL.UPDATE_HZ / 1000 / DT);
  if (due) {
    const prev = { slots: table.slots };
    const next = buildSlotTable(player, obstacles, step, prev);
    table.slots = next.slots;
    table.linesBlocked = next.linesBlocked;
    table.blockedMask = next.blockedMask;
    table.step = step;
  }
  tickTokens(table, step);
  return table;
}

export function tickTokens(table, step) {
  for (const [actorId, tok] of [...table.tokens]) {
    if (step >= tok.expiresStep) {
      table.tokens.delete(actorId);
      table.cooldownUntil.set(actorId, step + COOL_STEPS);
      table.releases.push({ actorId, step, reason: 'ttl' });
    }
  }
}

export function countAttackers(table) {
  let n = 0;
  for (const t of table.tokens.values()) if (t.role === 'attacker') n++;
  return n;
}
export function countApproach(table) {
  let n = 0;
  for (const t of table.tokens.values()) if (t.role === 'approach') n++;
  return n;
}

/**
 * 申请槽位/token。签名见 03 §4.1。
 * @param {object} req { actorId, role:'attacker'|'approach', slotIndex?:number, distanceToSlot?:number, targetId?:string }
 * @returns {{granted:boolean, slot?:object, token?:object, reason:string}}
 */
export function requestSlot(table, req, step) {
  const { actorId, role = 'attacker', distanceToSlot = 0, targetId = 'player' } = req;

  // 处决锁 / 冻结：目标被锁定时一律拒绝（08 §5 处决保护）
  const frozenUntil = table.freezeUntil.get(targetId) ?? -1;
  if (step < frozenUntil) return { granted: false, reason: 'target_frozen' };

  const cool = table.cooldownUntil.get(actorId) ?? -1;
  if (step < cool) return { granted: false, reason: 'cooldown' };

  const existing = table.tokens.get(actorId);
  if (existing) {
    // 续期
    existing.expiresStep = step + TTL_STEPS;
    return { granted: true, token: existing, slot: table.slots[existing.slotIndex], reason: 'renewed' };
  }

  const cap = role === 'attacker' ? SL.MAX_ATTACKERS : SL.MAX_APPROACH;
  const used = role === 'attacker' ? countAttackers(table) : countApproach(table);
  if (used >= cap) return { granted: false, reason: role === 'attacker' ? 'attacker_cap' : 'approach_cap' };

  // 必须真正到达槽位才能持 token（A5：命中必须来自持 token 者，且 token 只在到岗后授予）
  if (distanceToSlot > 0.60) return { granted: false, reason: 'not_arrived' };

  // 选槽：优先指定，否则选最近的空槽
  let slotIndex = req.slotIndex;
  if (slotIndex === undefined || !table.slots[slotIndex]) {
    let best = -1, bestD = Infinity;
    for (const s of table.slots) {
      if ([...table.tokens.values()].some((t) => t.slotIndex === s.index)) continue;
      const d = Math.hypot(s.x - (req.actorPos?.[0] ?? s.x), s.z - (req.actorPos?.[1] ?? s.z));
      if (d < bestD) { bestD = d; best = s.index; }
    }
    if (best < 0) return { granted: false, reason: 'no_free_slot' };
    slotIndex = best;
  }

  const token = { actorId, role, slotIndex, grantedStep: step, expiresStep: step + TTL_STEPS };
  table.tokens.set(actorId, token);
  table.grants.push({ actorId, role, slotIndex, step });
  return { granted: true, token, slot: table.slots[slotIndex], reason: 'granted' };
}

export function releaseSlot(table, actorId, step, reason = 'manual') {
  const tok = table.tokens.get(actorId);
  if (!tok) return false;
  table.tokens.delete(actorId);
  table.cooldownUntil.set(actorId, step + COOL_STEPS);
  table.releases.push({ actorId, step, reason });
  return true;
}

/** 06 §3：玩家发起攻击 → 冻结其目标的 token 300ms（防止出招瞬间被反打） */
export function freezeTargetTokens(table, targetId, step) {
  table.freezeUntil.set(targetId, step + FREEZE_PLAYER_STEPS);
  let n = 0;
  for (const [actorId, tok] of [...table.tokens]) {
    if (tok.role === 'attacker') { table.tokens.delete(actorId); table.releases.push({ actorId, step, reason: 'frozen_by_player' }); n++; }
  }
  return n;
}

/** 断言用：当前 token 表快照 */
export function snapshotTokens(table) {
  return [...table.tokens.entries()].map(([id, t]) => ({ actorId: id, ...t }));
}
