// 战斗系统框架 · 参考实现 · 连招图（ComboGraph）
// 契约见 03 §4.3：tryAdvance(g, curActionId, pct, input, ctx) → {advanced, next, reason}
// 数据见 10 §2 combo.json：边带 fromPct / require / input

import { CB } from '../core/constants.mjs';

export function makeGraph(spec) {
  const nodes = new Map();
  for (const [id, n] of Object.entries(spec.nodes)) nodes.set(id, { id, edges: n.edges ?? [] });
  return { entry: spec.entry, nodes };
}

function requireOk(req, ctx) {
  switch (req) {
    case 'always': return true;
    case 'hit': return !!ctx.hit;
    case 'whiff': return !!ctx.whiff;
    case 'target_staggered': return !!ctx.targetStaggered;
    case 'target_hp_below': return typeof ctx.targetHpPct === 'number' && ctx.targetHpPct <= CB.EXEC_HP_PCT;
    default:
      if (typeof req === 'string' && req.startsWith('context:')) return (ctx.contextTags ?? []).includes(req.slice(8));
      return false;
  }
}

/**
 * @param {{entry:string, nodes:Map}} g
 * @param {string} curActionId
 * @param {number} pct 当前招式进度 0..1
 * @param {'light'|'heavy'|null} input 本步缓冲到的输入
 * @param {object} ctx { hit, whiff, targetStaggered, targetHpPct, contextTags, consumedInMs }
 */
export function tryAdvance(g, curActionId, pct, input, ctx = {}) {
  const node = g.nodes.get(curActionId);
  if (!node) return { advanced: false, reason: 'unknown_node' };
  // 同一输入 120ms 内只消费一次（串招抑制，见 06 §5）
  if ((ctx.consumedInMs ?? Infinity) < CB.INPUT_BUFFER_MS) return { advanced: false, reason: 'input_cooldown' };

  const cands = [];
  for (const e of node.edges) {
    if (e.input && e.input !== input) continue;
    if (pct < (e.fromPct ?? CB.CANCEL_POINT)) continue;
    if (!requireOk(e.require ?? 'always', ctx)) continue;
    cands.push(e);
  }
  if (!cands.length) return { advanced: false, reason: 'no_edge' };

  // 取 fromPct 最晚（最"接得紧"）的边，保证确定性
  cands.sort((a, b) => (b.fromPct ?? 0) - (a.fromPct ?? 0));
  const e = cands[0];
  if (!g.nodes.has(e.to)) return { advanced: false, reason: 'dangling_edge' };
  return { advanced: true, next: e.to, via: e };
}

// 输入窗口判定（inputWindow: [startPct,endPct]）
export function inWindow(edge, pct) {
  const [a, b] = edge.inputWindow ?? [0, 1];
  return pct >= a && pct <= b;
}
