// 战斗系统框架 · 回放器（Replay Harness）
// 用法：
//   node tests/replay.mjs --script tests/inputs/combat_basic.json
//   node tests/replay.mjs --script tests/inputs/arena_01.json --twice
//   node tests/replay.mjs --script ... --dump      # 逐 tick 打印 JSON 行
//
// 判定口径（13 章 §3）：每 tick 输出量化后的状态 + fnv1a 哈希；--twice 跑两遍逐 tick 比对，
// 首个不一致处打印两侧状态。这就是 12 章 E1（同 seed 可复现）的可执行形态。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CB, CC, AI, DT } from '../src/core/constants.mjs';
import { Rng, hashState, clamp, yawToDir, dirToYaw, V3 } from '../src/core/math.mjs';
import { createTable, updateTable, requestSlot, releaseSlot, countAttackers } from '../src/combat/slot.mjs';
import { createFighter, beginAttack, attackInfo, applyHit, canExecute, beginExecution } from '../src/combat/resolve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const SCRIPT = opt('script', path.join(__dirname, 'inputs', 'combat_basic.json'));
const TWICE = argv.includes('--twice');
const DUMP = argv.includes('--dump');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const moveset = readJson(path.join(DATA, 'moveset.json'));
const roles = readJson(path.join(DATA, 'ai_roles.json'));
const script = readJson(path.resolve(SCRIPT));
const world = readJson(path.join(__dirname, script.world));

const actionById = new Map(moveset.actions.map((a) => [a.id, a]));
const roleById = new Map(roles.roles.map((r) => [r.id, r]));
const LIGHT = actionById.get('atk_light_01');
const msToSteps = (ms) => Math.round(ms / 1000 / DT);
const obstacles = world.obstacles ?? [];

// 数据里的招式是 { phases: {...} }，而 resolve.beginAttack 吃的是拍平后的 { windupMs, ... }。
// 必须经此转换——直接传 JSON 动作会让 windup 变成 undefined → NaN → 该招式永不进入 active（真人踩过的坑）。
const moveSpec = (a) => ({
  id: a.id,
  windupMs: a.phases.windupMs,
  activeMs: a.phases.activeMs,
  recoveryMs: a.phases.recoveryMs,
});

// ---------- 单次回放 ----------
function runOnce() {
  const rng = new Rng(script.seed);
  const table = createTable();
  const events = [];

  const player = createFighter('player', { hp: script.entities.player.hp ?? 100, pos: [...script.entities.player.spawn] });
  player.yaw = script.entities.player.yawDeg ?? 0;
  player.attack = null;
  player.attackTargetId = null;
  player.knockback = [0, 0, 0];

  const ais = script.entities.ai.map((cfg, i) => {
    const role = roleById.get(cfg.role) ?? roleById.get('veteran');
    const f = createFighter(`ai${i}`, { hp: role.stats.hp, mass: role.stats.mass, poise: role.stats.poise, pos: [...cfg.spawn] });
    f.yaw = cfg.yawDeg ?? 0;
    f.roleId = role.id;
    f.role = role;
    f.attack = null;
    f.attackTargetId = null;
    f.nextAttackStep = -1;
    f.knockback = [0, 0, 0];
    return f;
  });

  const inputByTick = new Map();
  for (const inp of script.inputs) {
    // 同一 tick 写多条记录时合并而不是覆盖（否则后一条会吃掉前一条的 attack/dodge/exec 意图）
    const prev = inputByTick.get(inp.tick) ?? {};
    inputByTick.set(inp.tick, { ...prev, ...inp });
  }

  const intent = { move: [0, 0], attack: false, dodge: false, exec: false };
  const records = [];
  let execLock = null;
  let hitsOnPlayer = 0;
  let hitsByPlayer = 0;

  const playerAdapter = () => ({ pos: [player.pos[0], player.pos[2]], yaw: player.yaw });

  for (let step = 0; step < script.ticks; step++) {
    const tickEvents = [];
    const inp = inputByTick.get(step);
    if (inp) {
      if (inp.move) intent.move = inp.move;
      intent.attack = !!inp.attack;
      intent.dodge = !!inp.dodge;
      intent.exec = !!inp.exec;
    } else {
      intent.attack = false; intent.dodge = false; intent.exec = false;
    }

    // ---- 1. 玩家位移 ----
    const alive = player.hp > 0;
    if (alive && step >= player.hitstopUntil) {
      const m = intent.move;
      const len = Math.hypot(m[0], m[1]);
      if (len > 1e-6) {
        const spd = CC.SPD_JOG;
        player.pos[0] += (m[0] / len) * spd * DT;
        player.pos[2] += (m[1] / len) * spd * DT;
        player.yaw = dirToYaw([m[0] / len, 0, m[1] / len]);
      }
      if (intent.dodge && player.iframeUntil < step) {
        player.iframeUntil = step + msToSteps(CB.DODGE_IFRAME[1]);
        tickEvents.push('player_dodge');
      }
    }
    // 击退衰减
    player.pos[0] += player.knockback[0] * DT; player.pos[2] += player.knockback[2] * DT;
    player.knockback = V3.mul(player.knockback, 0.85);

    // ---- 2. 槽位仲裁（4Hz 内部节流）----
    updateTable(table, playerAdapter(), obstacles, step);

    // ---- 3. AI ----
    for (const ai of ais) {
      if (ai.hp <= 0) continue;
      ai.pos[0] += ai.knockback[0] * DT; ai.pos[2] += ai.knockback[2] * DT;
      ai.knockback = V3.mul(ai.knockback, 0.85);
      if (step < ai.hitstopUntil) continue;

      const tok = table.tokens.get(ai.id);
      const role = ai.role;
      let slot = tok ? table.slots[tok.slotIndex] : null;
      if (!slot) {
        let best = null, bestD = Infinity;
        for (const s of table.slots) {
          if ([...table.tokens.values()].some((t) => t.slotIndex === s.index)) continue;
          const d = Math.hypot(s.x - ai.pos[0], s.z - ai.pos[2]);
          if (d < bestD) { bestD = d; best = s; }
        }
        slot = best;
      }
      if (slot) {
        const dx = slot.x - ai.pos[0], dz = slot.z - ai.pos[2];
        const d = Math.hypot(dx, dz);
        const spd = AI.APPROACH_RUN;
        if (d > 0.05) {
          const v = Math.min(spd * DT, d);
          ai.pos[0] += (dx / d) * v; ai.pos[2] += (dz / d) * v;
          ai.yaw = dirToYaw([dx / d, 0, dz / d]);
        }
        if (!tok) {
          const dist = Math.hypot(slot.x - ai.pos[0], slot.z - ai.pos[2]);
          if (dist <= 0.6) {
            const res = requestSlot(table, { actorId: ai.id, role: 'attacker', slotIndex: slot.index, distanceToSlot: dist, actorPos: [ai.pos[0], ai.pos[2]], targetId: 'player' }, step);
            if (res.granted) { ai.nextAttackStep = step + msToSteps(role.melee.attackGapMs ?? 250); tickEvents.push(`slot_grant:${ai.id}`); }
          }
        }
      }
      // 出手
      if (table.tokens.has(ai.id) && ai.nextAttackStep >= 0 && step >= ai.nextAttackStep && !ai.attack) {
        const move = actionById.get(role.melee.attackTable[0]);
        ai.attack = beginAttack(ai, moveSpec(move), step);
        ai.attack.hitboxTemplate = move.hitboxes[0];
        ai.attackTargetId = 'player';
        ai.nextAttackStep = -1;
        tickEvents.push(`tell:${ai.id}`);
        releaseSlot(table, ai.id, step, 'attacked');
      }
      // 推进自己的攻击
      if (ai.attack) {
        const info = attackInfo(ai.attack, step);
        if (info.phase === 'active' && player.hp > 0 && step >= player.hitstopUntil) {
          const dist = V3.dist2D(ai.pos, player.pos);
          const inRange = dist <= (actionById.get(ai.attack.move.id).requirements.maxDist + 0.2);
          const facing = Math.abs(dirToYaw(V3.norm(V3.sub(player.pos, ai.pos))) - ai.yaw) % 360;
          const inCone = facing <= 70 || facing >= 290;
          if (inRange && inCone) {
            const r = applyHit(ai, player, ai.attack, ai.attack.hitboxTemplate, step, { part: ai.attack.hitboxTemplate.hurtGroup });
            if (!r.blocked) { hitsOnPlayer++; tickEvents.push(...r.events); }
          }
        }
        if (info.phase === 'done') ai.attack = null;
      }
    }

    // ---- 4. 玩家攻击 ----
    if (alive && intent.attack && !player.attack && step >= player.hitstopUntil) {
      let target = null, bestD = Infinity;
      for (const ai of ais) {
        if (ai.hp <= 0) continue;
        const d = V3.dist2D(player.pos, ai.pos);
        if (d < bestD) { bestD = d; target = ai; }
      }
      player.attack = beginAttack(player, moveSpec(LIGHT), step);
      player.attack.hitboxTemplate = LIGHT.hitboxes[0];
      player.attackTargetId = target?.id ?? null;
      tickEvents.push('tell:player');
    }
    if (player.attack) {
      const info = attackInfo(player.attack, step);
      if (info.phase === 'active' && step >= player.hitstopUntil) {
        for (const ai of ais) {
          if (ai.hp <= 0) continue;
          const d = V3.dist2D(player.pos, ai.pos);
          if (d > LIGHT.requirements.maxDist + 0.2) continue;
          const r = applyHit(player, ai, player.attack, player.attack.hitboxTemplate, step, { part: 'torso' });
          if (!r.blocked) { hitsByPlayer++; tickEvents.push(...r.events); }
        }
      }
      if (info.phase === 'done') player.attack = null;
    }

    // ---- 5. 处决尝试 ----
    if (alive && intent.exec && !execLock) {
      let target = null, bestD = Infinity;
      for (const ai of ais) {
        if (ai.hp <= 0 || ai.state !== 'stagger') continue;
        const d = V3.dist2D(player.pos, ai.pos);
        if (d < bestD) { bestD = d; target = ai; }
      }
      if (target) {
        const res = canExecute(player, target, { step, angleOffDeg: 10 });
        if (res.ok) {
          execLock = beginExecution(player, target, { executionMs: CB.EXEC_STAGGER_WINDOW_MS }, step);
          tickEvents.push(`exec_begin:${target.id}`);
        } else {
          tickEvents.push(`exec_reject:${res.reasons.join('+')}`);
        }
      } else {
        tickEvents.push('exec_reject:no_staggered_target');
      }
    }
    if (execLock && step > execLock.endStep) execLock = null;

    events.push(...tickEvents);

    // ---- 6. 记录 ----
    const rec = {
      tick: step,
      p: { x: player.pos[0], z: player.pos[2], hp: player.hp, st: player.hp > 0 ? (player.attack ? 'atk' : 'idle') : 'dead' },
      a: ais.map((ai) => ({ id: ai.id, x: ai.pos[0], z: ai.pos[2], hp: ai.hp, tk: table.tokens.has(ai.id) ? 1 : 0, st: ai.state })),
      tk: countAttackers(table),
      ev: tickEvents.slice(),
    };
    rec.hash = hashState({ p: rec.p, a: rec.a, tk: rec.tk, ev: rec.ev });
    records.push(rec);
    if (DUMP) console.log(JSON.stringify(rec));
  }

  return { records, summary: { hitsOnPlayer, hitsByPlayer, playerHp: player.hp, aiHp: ais.map((a) => a.hp), ticks: script.ticks } };
}

// ---------- 执行 ----------
const t0 = process.hrtime.bigint();
const first = runOnce();
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`\n=== 回放：${script.label ?? path.basename(SCRIPT)} ===`);
console.log(`脚本 ${SCRIPT}`);
console.log(`世界 ${script.world}   seed ${script.seed}   ticks ${script.ticks}   实体 1 玩家 + ${script.entities.ai.length} AI`);
console.log(`玩家受到 ${first.summary.hitsOnPlayer} 次命中，打出 ${first.summary.hitsByPlayer} 次命中；玩家剩余 HP ${first.summary.playerHp}`);
console.log(`AI 剩余 HP ${first.summary.aiHp.join(' / ')}`);
const maxTokens = Math.max(...first.records.map((r) => r.tk));
console.log(`token 峰值 ${maxTokens}（上限 ${2}）  ${maxTokens <= 2 ? 'OK' : '违反不变量 I2'}`);
console.log(`耗时 ${ms.toFixed(0)}ms（${(ms / script.ticks).toFixed(3)}ms/步）`);

if (TWICE) {
  const second = runOnce();
  let diverge = -1;
  for (let i = 0; i < first.records.length; i++) {
    if (first.records[i].hash !== second.records[i].hash) { diverge = i; break; }
  }
  if (diverge < 0) {
    console.log(`\n复现性：两次回放 ${first.records.length} 步哈希完全一致 ✅（E1 通过）`);
  } else {
    console.log(`\n复现性：第 ${diverge} 步出现分歧 ❌`);
    console.log('  A: ' + JSON.stringify(first.records[diverge]));
    console.log('  B: ' + JSON.stringify(second.records[diverge]));
  }
  process.exitCode = diverge < 0 ? 0 : 1;
} else {
  console.log('（加 --twice 做两次回放哈希比对）');
}
console.log('');
