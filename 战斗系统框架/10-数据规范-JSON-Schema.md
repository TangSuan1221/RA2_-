# 战斗系统框架 · 10 数据规范（JSON Schema 与二进制格式）
**契约层第 3 份。执行 AI 按本文件写 loader 与校验器；字段名一旦发布不得改名。**

---

## 0. 通用约定

| 约定 | 规定 |
|---|---|
| 单位 | 长度 **米**、速度 **米/秒**、时间 **毫秒**（除 `t` 时间轴用秒）、角度 **度**（代码内转弧度） |
| 坐标 | 右手系，Y 上，角色朝向 +Z 局部轴，角度 0° = +Z，顺时针为正（与 Three.js yaw 一致） |
| 命名 | `camelCase`；枚举值全小写 `snake_case` |
| 标识 | 数据内 `id` 用字符串（如 `"atk_light_01"`）；运行时编译为 `u32 hash = fnv1a(id)` |
| 数值区间 | 归一化进度 `pct` ∈ [0,1]；权重 ∈ [0,∞)；概率 ∈ [0,1] |
| 版本 | 每个文件带 `"schemaVersion": 1`；不匹配直接 `throw`，禁止默认值兜底 |
| 路径 | 所有资源路径相对 `public/data/` |

**校验器必须实现的 9 条断言**（第 12 章验收会抽查）：

1. `windupMs + activeMs + recoveryMs` 与 `anim` 片段时长（含 `playRate`）偏差 ≤ 16 ms。
2. `tell.leadMs ≥ 80`（`CB-TELL-MARGIN` 的绝对值），且 `tell.leadMs ≤ windupMs`。
3. 每个 `hitbox` 的 `[startPct,endPct]` 落在 active 段内。
4. `cancel.into` 中 `fromPct ≥ CB-CANCEL-POINT` 或显式标 `"allowEarly": true`。
5. 连招图无悬空边（每条边指向存在的 `actionId`）。
6. `execution` 类招式的 `requirements.targetHpPct ≤ CB-EXEC-HP-PCT`。
7. 运动匹配库 `manifest.sampleHz === 30`，且 `frameCount === floor(duration*sampleHz)+1`。
8. 任何 `hitbox.bone` 存在于骨架表。
9. 无字段为 `NaN`（`JSON.parse` 后深度扫描）。

---

## 1. `moveset.json`（招式表）

```jsonc
{
  "schemaVersion": 1,
  "skeleton": "humanoid_civilian",
  "actions": [
    {
      "id": "atk_light_01",
      "category": "light",              // light|heavy|grab|execution|parry|dodge|reaction|shove
      "anim": {
        "clip": "atk_light_01",         // 对应 anim 烘焙 id
        "playRate": 1.0,
        "blendInMs": 90,                // 惯性化混合时长覆盖值（缺省用 MM-BLEND-T）
        "blendOutMs": 140
      },
      "phases": { "windupMs": 260, "activeMs": 90, "recoveryMs": 300 },   // = CB-LIGHT-*
      "tell": {
        "leadMs": 180,                  // 必须 ≤ windupMs 且 ≥ 80
        "type": "body_lunge",           // body_lunge|weapon_raise|footstep|growl
        "sfx": "sfx_whoosh_light",
        "vfx": "vfx_tell_glint"
      },
      "rootMotion": {
        "mode": "warp",                 // inPlace|rootMotion|warp
        "warpTarget": "target_chest",   // warp 时瞄准的目标骨骼锚
        "maxWarpDist": 1.60,            // 超过此距离不允许 warp（需先 Melee Move 靠近）
        "curve": [[0.0, 0.0], [0.4, 0.55], [1.0, 0.95]]   // pct → 位移占 maxWarpDist 的比例
      },
      "hitboxes": [
        {
          "startPct": 0.0, "endPct": 1.0,          // 相对 active 段
          "bone": "hand_r",
          "localPos": [0, 0, 0.12], "localRot": [0, 0, 0, 1],
          "size": [0.22, 0.22, 0.55],              // 半长（OBB）
          "damage": 22, "poiseDamage": 20,
          "knockback": 2.4, "hitstopMs": 60,
          "hurtGroup": "body",
          "canHitProps": true, "canHitBreakable": false
        }
      ],
      "cancel": {
        "into": [
          { "action": "atk_light_02", "fromPct": 0.60, "require": "hit",  "inputWindow": [0.35, 0.95] },
          { "action": "dodge_back",   "fromPct": 0.50, "require": "always", "allowEarly": true, "inputWindow": [0.30, 1.00] }
        ]
      },
      "requirements": {
        "minDist": 0.0, "maxDist": 1.45,
        "angleDeg": 70,                 // 目标须落在正前方 ±angleDeg/2
        "heightDeltaMax": 0.60,         // 高低位判定（E1：GDC 高位/低位两套）
        "targetState": ["idle", "stagger", "block", "attack"]
      },
      "context": {                      // 上下文近战（详见 06 章 §4）
        "tags": ["any"],
        "replacesTo": {
          "wall_left": "atk_light_01_wall",
          "table": "atk_light_01_table",
          "window": "atk_light_01_window",
          "ledge_high": "atk_light_01_ledge"
        }
      }
    }
  ]
}
```

### 1.1 `category` 的硬语义

| category | 语义约束 |
|---|---|
| `light` | 可从 idle/移动取消；`poiseDamage ≤ 30` |
| `heavy` | 起手 ≥ 380 ms；命中后攻击者获得 `armorFrames`（可选字段，默认 0） |
| `grab` | 必须先通过 `requirements` 且目标 `state !== 'dodging'`；命中即进入 `locked` 双人状态 |
| `execution` | 只能由 `combat/execution.ts` 发起，玩家不可直接按键触发 |
| `parry` | 无 hitbox，只有 `parryWindow: [startPct,endPct]`；命中走 `resolve.ts` 的 parry 分支 |
| `dodge` | 无 hitbox；`iframe: [startPct,endPct]`（`CB-DODGE-IFRAME` 折算） |
| `reaction` | 受击反应，走 Additive 层，不占用 Lower 状态机（不变量 I4） |

---

## 2. `combo.json`（连招图，可选：也可从 moveset.cancel 自动生成）

```jsonc
{
  "schemaVersion": 1,
  "graphs": {
    "unarmed": {
      "entry": "atk_light_01",
      "nodes": {
        "atk_light_01": { "edges": [
          { "to": "atk_light_02", "fromPct": 0.60, "require": "hit" },
          { "to": "atk_heavy_01", "fromPct": 0.70, "require": "hit", "input": "heavy" }
        ]},
        "atk_light_02": { "edges": [
          { "to": "atk_light_03", "fromPct": 0.60, "require": "hit" },
          { "to": "execution_finisher", "fromPct": 0.60, "require": "target_staggered" }
        ]}
      }
    }
  }
}
```

`require` 取值：`hit` | `whiff` | `always` | `target_staggered` | `target_hp_below` | `context:<tag>`。

---

## 3. `reactions.json`（受击反应表）

```jsonc
{
  "schemaVersion": 1,
  "reactions": [
    {
      "id": "hit_light_front",
      "trigger": { "dir": "front", "heavy": false, "poiseBreak": false },
      "additive": { "clip": "add_light_front", "layer": "hitReaction", "weight": 0.85, "decayMs": 250 },
      "hitstunMs": 220,
      "lockLowerBody": false,          // 必须为 false，除非 poiseBreak
      "knockbackScale": 1.0,
      "sfx": "sfx_flesh_hit"
    },
    {
      "id": "hit_heavy_front_break",
      "trigger": { "dir": "front", "heavy": true, "poiseBreak": true },
      "additive": { "clip": "add_stagger_front", "layer": "hitReaction", "weight": 1.0, "decayMs": 400 },
      "hitstunMs": 900,                 // = CB-EXEC-STAGGER-WINDOW
      "lockLowerBody": true,
      "knockbackScale": 1.6
    }
  ],
  "directionBands": [ { "name": "front", "fromDeg": -45, "toDeg": 45 }, { "name": "left", "fromDeg": 45, "toDeg": 135 } ]
}
```

---

## 4. `slots.json`（槽位系统配置）

```jsonc
{
  "schemaVersion": 1,
  "lines": 16, "angleStepDeg": 22.5,
  "rings": [1.55, 2.35, 3.20],
  "maxAttackers": 2, "maxApproach": 3,
  "updateHz": 4, "hysteresis": 0.35,
  "probe": { "radius": 0.45, "height": 1.70, "ignoreTags": ["low_cover"] },
  "blockShiftMaxSteps": 3,
  "reserveTtlMs": 1500, "releaseCooldownMs": 800,
  "lineBias": {                       // 期望分布权重（0 = 该线不生成槽位）
    "front": 1.0, "side": 0.8, "back": 0.55
  },
  "roleReservations": {               // 角色类型占位规则（详见 09 章）
    "attacker": { "maxTokens": 2, "preferRings": [0, 1], "preferAngleDeg": 60 },
    "flanker":  { "maxTokens": 2, "preferRings": [2],    "preferAngleDeg": 140 },
    "rusher":   { "maxTokens": 3, "preferRings": [0],    "preferAngleDeg": 30 }
  }
}
```

---

## 5. `ai_roles.json`（Melee Behaviors 指令表）

```jsonc
{
  "schemaVersion": 1,
  "roles": [
    {
      "id": "veteran",
      "perception": { "viewDist": 32, "fovDeg": 110, "noticeMs": 350 },
      "melee": {
        "tellScale": 1.00,             // = SL-TELL-SCALE-VET
        "approachSpeed": 4.20, "walkSpeed": 1.80,
        "attackTable": ["atk_light_01", "atk_light_02", "atk_heavy_01"],
        "finisherTable": ["execution_finisher"],
        "feintChance": 0.25,
        "giveUpMs": 2500,
        "preferHeight": "any"          // any|high|low（E1 高低位近战）
      },
      "social": { "canShout": true, "shoutRadius": 25, "shareDelayMs": 400 }
    },
    {
      "id": "infected_runner",
      "perception": { "viewDist": 16, "fovDeg": 150, "noticeMs": 180 },
      "melee": { "tellScale": 1.25, "approachSpeed": 5.00, "walkSpeed": 2.10,
                 "attackTable": ["infected_swipe"], "finisherTable": [], "feintChance": 0.0,
                 "giveUpMs": 1500, "preferHeight": "any" },
      "social": { "canShout": false, "shoutRadius": 0, "shareDelayMs": 0 }
    }
  ]
}
```

`melee.attackTable` 就是 GDC 所述的**每角色类型各自的攻击指令表**（E1）。若表为空则该角色不会近战。

---

## 6. `camera_profile.json`

```jsonc
{
  "schemaVersion": 1,
  "profiles": {
    "default": {
      "armLength": 2.70, "shoulderX": 0.52, "pivotHeight": 1.58,
      "probeRadius": 0.28, "springK": 14.0, "springDamp": 0.85,
      "nearMin": 0.12, "posLerp": 0.18,
      "fov": { "base": 55, "sprint": 62, "aim": 42, "transitionMs": 220 },
      "shake": { "traumaDecay": 1.8, "maxPos": 0.09, "maxRoll": 2.2, "freq": 18.0 },
      "aimAssist": { "coneDeg": 6, "maxDist": 25, "pullStrength": 0.35 }
    },
    "tight_indoor": { "armLength": 1.90, "shoulderX": 0.44, "fov": { "base": 60 }, "inherit": true }
  }
}
```

`inherit: true` 表示未写字段从 `default` 深合并。

---

## 7. `*.mmdb`（运动匹配数据库，二进制）

```
offset  size    field
0       4       magic  "MMDB"
4       2       version = 1
6       2       flags (bit0: 含 PCA, bit1: 含 KDTree, bit2: 含 rawFeatures 原始 32 维特征块)
8       4       frameCount          // 采样帧总数
12      4       dims                // 原始特征维度
16      4       pcaDims             // MM-PCA-DIMS = 8
20      4       sampleHz            // MM-SAMPLE-HZ = 30
24      4       clipCount
28      ...     clipTable: clipCount × { u32 clipIdHash, u32 startFrame, u32 frameCount, f32 durationSec }
...     f32[dims]                    pcaMean
...     f32[dims*pcaDims]            pcaBasis（行主序）
...     f32[frameCount*pcaDims]      projected    // KDTree 建在此上
...     u8[?]                        kdTree（节点数 + 每节点 {u32 splitDim, f32 splitVal, u32 left, u32 right, u32 start, u32 count}）
...     u32[frameCount]              clipIndexOfFrame
...     f32[frameCount]              timeOfFrame（秒）
...     u8[frameCount]               tagOfFrame（locomotionTag）
...     u8[frameCount * 2]           footPhase（左右足相位 0..255）
...     f32[frameCount*32]           rawFeatures（**仅当 flags bit2 = 1**，见下方格式扩展说明）
```

**格式扩展（04 §1 提出，本版已登记）**：`flags` 置 **bit2**，文件末尾追加 `rawFeatures f32[frameCount×32]` 的原始归一化特征块。
理由：PCA 是跨通道线性变换，8 维投影空间里**无法施加分通道权重**（轨迹 3.0 vs 姿态 1.0）。因此检索必须两段式——
**PCA 空间做 KDTree 粗筛（`MM-KNN`=32）→ 回到 rawFeatures 做分通道加权精算**。
该扩展**不改动前面所有字段的偏移顺序**；加载器按 `flags & 4` 决定是否读取该块，缺失即抛错（03 §6 禁止静默降级）。

**加载即校验**：`magic`、`version`、`sampleHz === 30`、`dims` 与 schema 一致、KDTree 节点数 > 0、`flags & 4` 时 `rawFeatures` 块长度正确。任一条失败抛错终止启动（见 03 §6）。

---

## 8. `anim/<clip>.bin`（烘焙关键帧）

```
magic "ANIM" (4) | version u16 | skeletonId u32 | boneCount u16 | frameCount u32 | fps f32 | loopFlag u8
then: quat: f32[frameCount*boneCount*4] | trans: f32[frameCount*boneCount*3]
then: notifyTable: u16[n] × { f32 time, u16 typeHash, u16 paramHash }
```

根运动通道另存于末尾：`rootDelta: f32[frameCount*3]`（每帧相对前一帧的位移），供 `rootMotion.mode === 'rootMotion'` 与轨迹预测使用。

---

## 9. 最小可玩数据包（M1 门槛，必须交齐）

| 文件 | 最低内容 |
|---|---|
| `moveset.json` | 2 个 light、1 个 heavy、1 个 dodge、1 个 parry、1 个 execution、1 个 reaction |
| `combo.json` | 1 张图，至少 3 节点 2 边 |
| `reactions.json` | 前/左/右/后 × 轻/重 = 8 条 |
| `slots.json` | 完整（上表默认值即可） |
| `ai_roles.json` | 2 个角色（veteran + infected_runner） |
| `camera_profile.json` | `default` + `tight_indoor` |
| `*.mmdb` | idle/walk/jog/sprint/crouch 五组，≥ 6000 采样帧，`MM-SAMPLE-HZ` = 30 |

> 数量下限不是拍脑袋：6000 帧 ≈ 5 组 × 40 秒素材。少于这个量，运动匹配会出现"永远选中同一段动画"的退化解（第 04 章 §7 有诊断方法）。
