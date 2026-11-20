# 战斗系统框架 · 06 Control（输入缓冲 · 上下文近战 · 槽位玩家侧 · 连招 · 双极状态机）
> 契约层第 5 份。常量引用 `00` §4.3–§4.5，新增常量登记在 §10。本章只负责「把玩家意图翻译成一次合法的动作」，不负责动画（04）、移动求解（05）、伤害结算（08）、槽位仲裁的 AI 侧（09）。
> 证据分级：GDC 2021《Melee AI in The Last of Us Part II》原文事实标 **E1**；工程估算标 **E3**。
## 0. 失败模式索引
| # | 坏表现 | 观感 | 消除于 |
|---|---|---|---|
| C1 | 按键吞掉 | 收招末尾按攻击没反应，要多按一次 | §1 缓冲环形 + §5.2 输入窗口与 `CB-CANCEL-POINT` 的关系 |
| C2 | 连招串招 | 快速连按打出三段以外的招，或同一次输入触发两次 | §5.3 串招抑制（120 ms 内只消费一次） |
| C3 | 贴墙攻击变空气挥空 | 目标就在墙边，出招却打空、位移没贴上去 | §4.3 替换失败回退顺序 + §3.4 接近相 |
| C4 | 处决距离判定飘 | 时远时近都能处决，或明显贴身却不触发 | §7 明确"中心距"口径 + 条件 6 第三人占用 |
| C5 | 闪避无敌帧不生效 | 明明闪了还是被打中 | §8 帧区间表（`[0,12)`）+ 预输入窗口 |
| C6 | 受击锁死移动 | 被打一下就定住不动 | §6.4 I4 落点表（Lower 不变，只改 Additive 权重） |
| C7 | AI 与玩家抢同一空间 | AI 站进玩家胶囊里挥拳 | §3 R4（冻结不释放 token）+ 05 §3.5 推挤 |
| C8 | 上下文替换后动画错位 | 换成撞墙招后双方位置错开，手插进对方身体 | §4.3 对齐四要求（锚点误差 ≤ 0.15 m、回退顺序） |
## 1. 输入缓冲
### 1.1 时间戳环形缓冲（`CB-INPUT-BUFFER`）
容量 = `ceil(CB-INPUT-BUFFER / TM-DT) + 1` = `ceil(120/16.667) + 1` = **9 槽**（多 1 槽存"本步待写"）；老化规则：`step − s.step > 8` 的样本在阶段 1 开头丢弃，`consumed` 未置者不再可被消费。
```ts
// input/buffer.ts —— 定长、无分配
export interface RawInputSample {
  step: number; tMs: number; device: 'kbm'|'pad'|'touch';        // tMs 取自 core/time.ts 的逻辑时间，不用 Date.now()（I5）
  kind: number; value: number; phase: 'pressed'|'held'|'released'; consumed: boolean;
}
export function push(s: RawInputSample): void;                                   // 设备回调里唯一的副作用
export function consumeEdge(kind: number, maxAgeSteps: number): RawInputSample | null;  // 仅阶段 1 可调用
```
### 1.2 意图（`Intent`）结构
```ts
// input/intent.ts
export interface Intent {
  step: number;  move: { x: number; y: number };  look: { x: number; y: number };
  // move 已过死区、单位圆内；look 为度/步，已限幅 ±600 °/s × TM-DT
  attack: boolean; attackAge: number;   dodge: boolean;  dodgeAge: number;
  // Age = 距按下经过的逻辑步数，上限 8 步；超过后只保留 held 语义
  parry: boolean;  parryAge: number;    grab: boolean;   grabAge: number;
  interact: boolean; interactAge: number;
  heavy: boolean;    // 修饰键：heavy 按住时 attack 上升为 heavy 意图
  sprint: boolean; crouch: boolean; aim: boolean;
}
```
### 1.3 「按下 - 释放 - 长按」三态
| 态 | 判据 | Intent 表现 | 消费规则 |
|---|---|---|---|
| `pressed` | 本步首次为真 | flag = true，`Age = 0` | 可被消费一次，消费后置 `consumed`；同一边沿 120 ms 内只被消费一次（§5.3） |
| `held` | 连续为真 | flag = true，`Age += 1` | 只服务长按/蓄力，不再触发边沿动作 |
| `released` | 由真变假 | flag = false，`Age = 0` | 服务"松开触发"类（蓄力投掷等 10 章 heavy 变体） |
### 1.4 设备归一化（死区 0.18）
| 设备 | 原始量 | 死区 | 归一化 |
|---|---|---|---|
| 鼠标 look | 像素 delta/帧 | 无 | × 0.022 °/px，累计到本步并限幅 ±600 °/s |
| 手柄 / 触屏摇杆 | 轴向 (−1, 1) | **0.18 径向**（`06-新增-11`） | `r' = (‖r‖ − 0.18)/0.82`，方向保持；`‖r‖ < 0.18` → 0 |
| 键盘 | 8 向布尔 | 无 | 单位向量（斜向 0.7071），多键不叠加 |
### 1.5 原始输入 → 意图 规则表
| 原始 | 条件 | 意图 | 备注 |
|---|---|---|---|
| 攻击键 down | — | `attack`（heavy = false） | 目标可用处决时由 `execution.ts` 接管，attack 被吞，**不进连招图** |
| 攻击键 down | heavy 修饰按住 | `attack` 且 `heavy = true` | 起手用 `CB-HEAVY-WINDUP` |
| 闪避键 down | — | `dodge` | 方向 = `move`；无输入则后撤 |
| 招架键 down | 面向目标 | `parry` | 无目标时降级为 `dodge` |
| 交互键 down | §2 有 confirmed 候选 | `interact` | 无候选则直接丢弃（不排队，否则 C1 会变成"延迟触发"） |
| 抓取键 down | 目标满足 `grab` 条件 | `grab` | 目标 `dodging` 时拒绝（10 §1.1） |
| 冲刺键 hold | `‖move‖ ≥ 0.5` 且非 aim | `sprint` | — |
| 蹲键 down | — | `crouch`（toggle） | 起身被阻断则视为无效（05 §5） |
| 瞄准键 hold | — | `aim` | 与 `sprint` 互斥，aim 优先级更高 |
### 1.6 不变量 I1 的落点：禁止在逻辑步之外消费输入
| I1 落点 | 规则 |
|---|---|
| 设备回调 | 唯一副作用是 `push` 到定长环形；不得直接改 `Intent` / `Actor` |
| 唯一消费点 | `fixedUpdate` 阶段 1（03 §2 表第 1 行）；阶段 2–11 不得读取设备状态 |
| 渲染帧 | `renderUpdate(alpha)` 内禁止读输入做判定，alpha 只用于插值 |
| 可回放 | 每步有且仅有一个 `Intent` 快照，回放不需要设备（12 章 E 组验收） |
## 2. 上下文交互评分（GDD「上下文感知」的落地）
`score = (w_d·D + w_v·V + w_a·A + s_kind·w_t·T) × avail + hyst`，权重和为 1.00，`score ∈ [−0.10, 1.15]`。
| 项 | 符号 | 权重 | 归一化 | 说明 |
|---|---|---|---|---|
| 距离 | `w_d` | 0.34 | `clamp01(1 − d/R_k)` | `R_k` 按候选类型取值（见下表） |
| 视角 | `w_v` | 0.22 | `clamp01(1 − θ_cam/90°)` | `θ_cam` = 相机前向与候选的水平夹角 |
| 朝向差 | `w_a` | 0.24 | `clamp01(1 − θ_fwd/coneHalf)` | `coneHalf` 按类型：处决 35°、翻越 40°、拾取 60° |
| 威胁 | `w_t` | 0.20 | `clamp01(threat/3)` | `threat = Σ` 6 m 内敌人的 `(1 − d/6)`，上限 3 |
| 可用性 | `avail` | **闸门** | 0 或 1 | 不可用 → `score = 0`（乘性闸门，非权重） |
| 迟滞 | `hyst` | 常量 | `+0.15` / `−0.10` | 当前选中者 +0.15；50 ms（`06-新增-02`）内被淘汰者 −0.10 |

| 候选 | `R_k` m | `coneHalf` | `s_kind` | 依据 |
|---|---|---|---|---|
| 处决 | 1.35 | 35° | +1 | `CB-EXEC-RANGE` / `CB-EXEC-ANGLE ÷ 2` |
| 翻越·攀爬 | 1.60 | 40° | +1 | `maxWarpDist`（10 §1）/ `05-新增-06` |
| 拾取 | 1.20 | 60° | −1 | E3 |
| 开关门 | 1.40 | 45° | −1 | E3 |
`s_kind` 是**方向符号**：处决/翻越 `+1`（越受威胁越该做），拾取/开关门 `−1`（越受威胁越不该做）——同一公式服务四类交互而不换代码路径，只换参数表。**`avail` 是闸门不是权重**：若做成权重，玩家贴近一扇锁着的门 0.30 m 时会胜过 1.30 m 处的翻越点，表现为"按键没反应"；闸门让不可用候选彻底出局，与 05 §4.3 的失败回写一致。
**选中 → 确认的 80 ms 稳定窗**：候选连续 **5 步 = 83.3 ms**（`06-新增-01`，目标值 80 ms 向上取步）保持首位 → `selected → confirmed`；confirmed 后跌出 top-1 连续 **3 步 = 50 ms**（`06-新增-02`）→ 取消并给该 id 打 −0.10 迟滞。并列（`‖Δscore‖ < 0.05`）按距离近者、再按 `id` 小者（保证 I5 确定性）。
## 3. 近战槽位 · 玩家侧
| # | 规则 |
|---|---|
| R1 | 玩家攻击**不申请槽位、不占 `attackerTokens`**（03 §4.1 中该数组只登记 AI id），因此玩家永不受 I2 的 ≤ 2 限制 |
| R2 | 玩家攻击发起的那一步，其**目标身上**的 attacker token 全部冻结 **300 ms**（`06-新增-03` = 18 步），防止玩家出招瞬间被反打 |
| R3 | 冻结只阻止**新发起**：已处于 windup 的 AI 攻击**不取消**（I3 要求预警一旦开始必须可读） |
| R4 | 冻结**不释放** token（避免玩家出招瞬间第三者补位造成"被围"，C7）；300 ms 后自动解冻，实际恢复最迟在下一次 4 Hz 仲裁（`SL-UPDATE-HZ` 250 ms） |
| R5 | 冻结只作用于"以该目标为攻击目标"的 AI；其它 AI 的 token 不受影响 |
```ts
// combat/aiBridge.ts
export function freezeTokensOnTarget(w: World, targetId: number, step: number): void {
  const until = step + 18;                                 // 300 ms / TM-DT = 18 步
  for (const id of w.slots.attackerTokens) { const ai = w.actors[id].ai;
    if (ai !== undefined && ai.targetId === targetId) ai.tokenFrozenUntilStep = until; }
}
// requestSlot 对已冻结者返回 SlotReject{ reason: 'frozen' }——只加可选字段，不改 03 §4.1 签名
```
**玩家如何选目标**：`export interface TargetPickOpts { maxDist: number; halfAngleDeg: number; hpPctBelow?: number; }`；`export function pickTarget(p: Actor, actors: Actor[], o: TargetPickOpts): Actor | null;` 排序键严格按序（全序无随机）：① `‖Δyaw‖ ≤ halfAngleDeg` 闸门 → ② `d ≤ maxDist` 闸门 → ③ `poise ≥ CB-POISE-MAX` 者优先 → ④ 距离升序 → ⑤ `id` 升序（I5）。`CB-EXEC-RANGE` 之外一律 `halfAngleDeg = CB-EXEC-ANGLE/2 = 35°` 且最近优先；`maxDist` 取招式 `requirements.maxDist`（10 §1，示例 1.45）。
### 3.3 GDC 的 Melee Attack vs Melee Moves 两级结构（E1）
| 层 | GDC 原文职责（E1） | 数据 | 本框架落地 |
|---|---|---|---|
| Melee Behaviors | 高于 Melee Attack 一层：按角色类型与环境生成各自的**攻击指令表**，并决定接近/保持距离、跑还是走、是否加入战斗 | `ai_roles.json` 的 `melee.attackTable` / `approachSpeed` / `giveUpMs` | 09 章 `brain.ts` + 槽位申请 |
| Melee Moves | 「**移动到攻击位**所需的数据」= 接近相 | `moveset.rootMotion.maxWarpDist`、`requirements.minDist/maxDist` | 本章 §3.4 |
| Melee Attack | 「选**哪个近战动作**」= 攻击相 | `actions[]` 的 phases / hitboxes / cancel | 08 章 `action.ts` |
E1 前置判定（GDC 原文第 3 条）落为两道闸门：「NPC 正在做其他动作」→ `Upper ≠ free` 且非硬直 → 拒绝；「不在近战范围」→ `d > requirements.maxDist` → 走接近相。
### 3.4 接近相（Melee Move）与攻击相（Melee Attack）的分工
| 相 | 驱动 | 位移来源 | 进入条件 | 退出 |
|---|---|---|---|---|
| 接近相 | `move` 意图 / AI 寻路 | motor 全权（视作 `inPlace`，05 §1） | `d > maxWarpDist × 0.80`（默认 **1.28 m**） | `d ≤ 1.28 m` 且朝向误差 ≤ 25° → 进攻击相 |
| 攻击相 | 招式时间轴 | 招式 `rootMotion.mode`（05 §2） | 上行满足 **且** 目标落在 `requirements` 内 | phases 走完 / 被取消 / 被处决接管 |
接近相速度取 `min(CC-SPD-JOG, AI-APPROACH-RUN)`；玩家侧接近相 = 相机方向推进（不强制，`requirements.maxDist` 已含 warp 余量）。**`maxWarpDist` 超出时先走接近相**：`d > 1.28 m` → `warpRejected = true`（05 §2.3）→ 本步只允许接近相；若此时仍尝试发起攻击，必须拒绝并返回 `null` / `SlotReject`——**不允许"空气挥空"**（C3）。接近相超时 `06-新增-07` = 1200 ms（72 步）→ 放弃本次攻击，回 Melee Behaviors 重选（对应 E1 的前置失败分支）。0.80 系数理由：`curve(1.0) = 0.95`，留 20% 让 warp 全程有余量吸收目标移动（05 §2.1）。
## 4. 上下文近战替换（Contextual Melee Hijack）
### 4.1 环境探针规格（以目标为圆心，17 条）
| 探针 | 数量 | 高度（相对目标脚） | 方向 | 长度 | 用途 |
|---|---|---|---|---|---|
| 水平环·低 / 高 | 8 + 8 | +0.90 m / +1.50 m | 45° 等分，0° = 目标 yaw | 1.60 m | 低层：桌/矮墙/窗台；高层：墙面/窗框/高台 |
| 向下 | 1 | +0.02 m，前方 0.60 m | 向下 | 2.40 m | 高度差 Δh |
采样 **4 Hz**（沿用 `SL-UPDATE-HZ`），且仅在目标处于 `meleeAction` 或距玩家 ≤ `SL-RING-DIST` 最大环 3.20 m 时执行——否则 17 射线 × N 目标会撞破 `TM-BUDGET-LOGIC`。
### 4.2 环境标签判定（E3）与 `replacesTo` 映射
| 标签 | 判定式 | 优先级 | `replacesTo` 键 |
|---|---|---|---|
| `corner` | 存在方向 i, j 使夹角 ≥ 90°，两者低层均命中且 `d ≤ 1.00 m` | 1 | `corner`（只与 `heavy` 组合生效，§4.4） |
| `wall_left` | 90°±22.5° 的 3 条低层射线中 ≥ 2 条命中且 `d ≤ 1.20 m`，命中面法线与目标前向夹角 ≤ 30° | 2 | `wall_left` |
| `wall_right` | 同上，方向 −90°±22.5° | 2 | `wall_right` |
| `table` | 低层命中点 Δh ∈ [0.70, 1.10] 且连续 ≥ 3 条（135° 扇区）`d ≤ 1.00 m` | 3 | `table` |
| `window` | 高层命中、同方向低层未命中（低处有开口） | 4 | `window` |
| `ledge_high` | 向下探针 1.20 m 内命中且 Δh ∈ (0.45, 1.20] | 5 | `ledge_high` |
| `ledge_low` | Δh ∈ [−1.20, −0.45) | 6 | `ledge_low` |
替换优先级：`corner` > `wall_left/right` > `table` > `window` > `ledge_high` > `ledge_low`；同优先级取距离最近。标签在**节点开始（pct = 0）缓存一次**并要求稳定 ≥ 83.3 ms（`06-新增-01`）；任何标签查表落空 → 直接用原招式（**不是**取消攻击）。对 10 章的最小差异登记：10 §1 示例的 `wall_left`/`table`/`window`/`ledge_high` 四键为**最小集**，本章扩为 7 键（补 `wall_right`/`ledge_low`/`corner`）——属数据取值扩展，不改 10 章字段名与类型，登记为 10 章 v1.1 追加项（本章不改 10 章文件）。
### 4.3 替换后的动画对齐要求
| # | 要求 | 判据 |
|---|---|---|
| 1 | 目标必须被 warp 到锚点 | 目标 Lower 停 `downed`（§7 同机制），位置由 `warp` 曲线驱动，**不走 motor** |
| 2 | 双方锚点世界空间误差 | 每步检查 `‖targetAnchorWorld − attackerAnchorWorld‖ ≤ 0.15 m`。依据：双人动画 0.15 m 内可被手臂 IK 吸收（臂长 0.62 m 的 24%），超出即手穿身或够不着 |
| 3 | 朝向对齐 | 目标 yaw 强制设为「面向执行者 ± 锚点 yaw」，误差 ≤ 10°；演出期间**禁用**程序转身（05 §1.4） |
| 4 | 失败回退顺序（按序尝试，全失败才放弃） | ① 原招式 + warp 到最近合法位 → ② 原招式 + `inPlace`（接受 0.15–0.40 m 空挥距离，`requirements` 仍须成立）→ ③ 降级到同 `category` 的 `*_generic` → ④ 取消攻击，recovery 0 步回 `idle`，给该 target 置 250 ms 上下文冷却（`06-新增-08`） |
### 4.4 `corner` + `heavy` → 推搡 / 撞墙分支
| 项 | 规则 |
|---|---|
| 触发 | 标签 = `corner` 且 `heavy = true` 且目标背后 1.00 m 内有墙面 |
| 招式 | `category: "shove"`（10 §1 `category` 已含 shove） |
| 位移 | 目标沿最近墙面法线反方向推 0.45 m 或到墙为止；撞墙判定 = 推挤结束时球探针（r = `CC-CAP-RADIUS`）与墙面距离 ≤ 0.02 m |
| 伤害 | 基础 `damage × 0.6` + 撞墙固定 12（E3）；冻帧用 `CB-HITSTOP-HEAVY`；撞击点高 1.20 m |
| 层落点 | 目标 Upper → `hitReactAdditive` weight = 1.0，**Lower 不变**（I4） |
## 5. 连招图执行
```ts
// combat/combo.ts —— 签名逐字取自 03 §4.3
export function tryAdvance(g: ComboGraph, cur: ComboNode, pct: number,
                           input: Intent, ctx: CombatContext): ComboNode | null;
```
判定顺序（严格，不可重排）：① 若本窗口内已有边沿被消费 → `null`（串招抑制）；② 遍历 `cur.cancelInto`，**数据顺序即优先级，禁止运行时排序**；③ 每条边依次判 `pct ≥ fromPct`、`input.matches(edge.input)`、`requireSatisfied(edge.require, ctx)`；④ 第一条满足者即结果，成功则置该边沿 `consumed`；⑤ 全不满足 → `null`。10 §2 的边以 `actionId` 键存储，loader 按 `fnv1a` 转 `nodeId`（10 §0）。
### 5.1 `require` 六种条件的判定时机
| `require` | 判定时机 | sticky | 数据来源 |
|---|---|---|---|
| `hit` | active 段内首次命中时置位，节点结束前不清 | 是 | `ctx.hitLanded` |
| `whiff` | active 段结束时若 `hitLanded === false` 置位 | 是 | `ctx.activeEnded` |
| `always` | 恒真 | — | — |
| `target_staggered` | 每次 `tryAdvance` 采样：`poise ≥ CB-POISE-MAX` 或 `state === 'stagger'` | 否 | 08 章 `resolve.ts` |
| `target_hp_below` | 每次采样 `hp/hpMax ≤ CB-EXEC-HP-PCT` | 否 | 08 章 |
| `context:<tag>` | 节点开始（pct = 0）缓存一次，并要求标签稳定 ≥ 83.3 ms | 是 | §4.2 |
`context:<tag>` 必须缓存而不能每步重算：17 条射线 × 60 Hz = 1020 次 raycast/秒/目标，超 `TM-BUDGET-LOGIC`；且替换在演出内不可变更，缓存是语义正确而非仅省性能。
### 5.2 输入窗口与 `CB-CANCEL-POINT` 的关系
`inputWindow [a, b]`（10 §1/§2）是输入被**记住**的 pct 区间（含早输入，`a` 可 < 0.60）；`fromPct`（10 §1/§2）是取消**可执行**的最早 pct，必须 ≥ `CB-CANCEL-POINT`。因此 `a = 0.35` 就按下也会被记住，等 `pct` 到 0.60 立即执行——这是 C1 的正面修复。`fromPct < CB-CANCEL-POINT` 且未标 `"allowEarly": true` → loader 报错（10 §0 断言 4）。记忆失效：记住后 120 ms（`CB-INPUT-BUFFER`）内未被执行即丢弃，防"很久以前按的一下突然打出连招"。
### 5.3 串招抑制与 whiff 惩罚
| 项 | 规则 |
|---|---|
| 串招抑制（C2） | 同一边沿 120 ms 内只被一个消费者拿走：消费后置 `consumedAtStep`，再次判定要求 `step − consumedAtStep > 8` |
| whiff 判定 | active 段结束时 `ctx.hitLanded === false` |
| whiff 代价 | 本次链路中 `require: "hit"` 的边**全部不可用**——因此 10 §2 示例的 heavy 边（`require: "hit"` + `input: "heavy"`）在 whiff 后自动失效，**空挥不能直接接 heavy** |
| 惩罚窗口 | `06-新增-09` = 200 ms（12 步）内 `heavy` 意图降级为 `light` |
| 收招 | whiff 后 recovery 取**完整**时长，不缩短 |
## 6. 双极状态机（`DualStateMachine`）
### 6.1 Lower 状态集
| Lower | 进入 | 退出 | 备注 |
|---|---|---|---|
| `idle` | `‖v‖ < 0.10` 且接地 | 任意移速 > 0.10 | 默认态 |
| `walk` | 0.10 ≤ `‖v‖ < 2.45` | 越界 / 蹲 / 翻越 | 2.45 见 `06-新增-10` |
| `jog` | 2.45 ≤ `‖v‖ < 4.48` | 同上 | 默认移动档 |
| `sprint` | `‖v‖ ≥ 4.48` 且 sprint 且非 aim | 越界 | 掉头必须先降档（05 §1.4） |
| `crouch` | crouch 意图且起身未被阻断 | crouch 取消且头顶净空 | 05 §5 |
| `vault` | 05 §4 分类 = vault 且 §2 confirmed | 招式结束 | — |
| `climb` | 05 §4 分类 = climb 且 §2 confirmed | 招式结束 | — |
| `downed` | poiseBreak（10 §3 `lockLowerBody: true`）或处决被打断 | 起身招式结束 | 处决锁定期间目标停在此态 |
| `dead` | HP ≤ 0 | 终态 | — |
### 6.2 Upper 状态集与优先级
| Upper | 优先级 | 进入 | 可被谁取消 |
|---|---|---|---|
| `free` | 0 | 默认 | 任意 |
| `aim` | 1 | aim 意图 | free / meleeAction / hitReactAdditive |
| `reload` | 2 | reload 意图 | 同 aim |
| `interact` | 2 | interact 意图 + §2 confirmed | 同 aim |
| `meleeAction` | 3 | 攻击 / 闪避 / 招架 / 处决 | 仅 `CB-CANCEL-POINT` 之后经连招边，或被 poiseBreak 打断 |
| `hitReactAdditive` | 4 | 受击 | 仅自身 `decayMs` 结束，**不可主动取消** |
### 6.3 两层冲突仲裁（谁压制谁、谁能被取消）
| Upper 行 / Lower 列 | 速度迁移 walk↔jog↔sprint | crouch 切换 | vault/climb 发起 |
|---|---|---|---|
| `free` | 允许 | 允许 | 允许 |
| `aim` | 允许（上限 `CC-SPD-AIM-*`） | 允许 | 禁止（手被占） |
| `reload` / `interact` | 允许 | 禁止 | 禁止 |
| `meleeAction` | **禁止**（速度由招式 rootMotion 接管，05 §2） | 禁止 | 禁止 |
| `hitReactAdditive` | 允许（I4） | 允许 | 允许 |
### 6.4 不变量 I4 的落点
| 情形 | Lower | Upper | Additive 权重 | 依据 |
|---|---|---|---|---|
| 轻击受击（`lockLowerBody: false`） | **不变** | free → hitReactAdditive | 0.85，`decayMs` 250 | I4 |
| 重击受击（`false`） | **不变** | hitReactAdditive | 1.00，`decayMs` 400 | I4 |
| 破防（`true`） | → `downed` | free（强制） | 1.00 | I4 的"除击倒"例外 |
| 处决锁定中受击 | 不迁移（保持 `downed`） | meleeAction / hitReactAdditive 保持 | 0（伤害延迟结算，§7） | §7 |
断言口径：遍历 `reactions.json` 全部条目，`lockLowerBody === false` 者在 08 章 `resolve` 之后 Lower 状态哈希必须与受击前**逐字节一致**（C6 的正面修复）；`true` 者必须且只能迁到 `downed`。`hitstunMs` 只作用于 Upper（禁止发起攻击/装填），不作用于移动。
### 6.5 状态迁移图的约束
| # | 约束 | 检查方式 |
|---|---|---|
| 1 | **可达性**：以 `idle` 为根 BFS 遍历声明的迁移边，所有 Lower/Upper 状态必须被覆盖 | loader 启动期跑一次，未覆盖者 `throw` 并从声明中删除（"不可达状态必须删除"） |
| 2 | **无死锁**：每个非终态必须存在 ≤ 4 跳通往 `idle` 的路径 | 同上；`dead` 豁免 |
| 3 | 数据不可达 ≠ 代码不可达：关卡若无 `> CC-CLIMB-MAX` 几何，`climb` 标 `debugOnly` 但**不删** | 由 13 章几何扫描报告输出 |
| 4 | 不得跨层写：Lower 迁移不改 Upper，反之亦然；唯一例外是进入 `meleeAction` 时把 Lower 速度置零（同一步内、单向） | 单测：对 `state.ts` 做迁移矩阵全枚举 |
## 7. 处决条件与锁定
| # | 条件 | 常量 / 判据 |
|---|---|---|
| 1 | 距离 | **中心距** ≤ `CB-EXEC-RANGE` 1.35 m。本章锁定"中心距"口径：若按面心距解释则中心距为 1.99 m，超出 warp 末端 1.52 m 的可达范围（05 §2.1） |
| 2 | 方位 | ≤ `CB-EXEC-ANGLE ÷ 2` = **±35°**（玩家 yaw 与 to-target 夹角） |
| 3 | 目标生命 | `hp/hpMax ≤ CB-EXEC-HP-PCT` = 0.25 |
| 4 | 硬直窗口 | `staggerStep + 54 ≥ step`（`CB-EXEC-STAGGER-WINDOW` 900 ms = 54 步） |
| 5 | 双方接地 | `dot(groundNormal, up) ≥ cos(CC-SLOPE-MAX)` |
| 6 | 第三人未占用 | 第三人胶囊到 attacker→target 线段的最小距离 > 2 × `CC-CAP-RADIUS` = **0.64 m**，且其 `combat.locked === null` |

| 保护项 | 实现（锁定期双方状态机僵死、第三人无法打断） |
|---|---|
| 锁定标记 | 双方 `combat.locked = { partnerId, untilStep: step + actionTotalSteps, kind: 'execution' }`。**不新增 FSM 状态**（§6 状态集不变）：目标 Lower 停在 `downed`，执行者 Upper = `meleeAction` |
| 命中过滤 | 08 章 `hitbox.ts` 候选过滤第一项：跳过 `combat.locked ≠ null` 的目标 |
| 伤害 | `resolve.ts` 对 locked 目标 incoming damage = 0；AoE/爆炸伤害**延迟到锁定期结束那一步一次性结算**（不丢伤害、不变演出） |
| 槽位 | `slot.arbitrate` 把 locked 双方占用的槽位置 `blocked`，AI 不得申请 |
| 第三人 | 任何招式都无法打断；唯一例外是 13 章脚本事件显式置 `canBreakExecution = true` |

| # | 打断原因（中途被打断的四种） | 检测点 | 回退 |
|---|---|---|---|
| 1 | 任一方 HP ≤ 0 | `resolve` 结算后（含延迟伤害） | 立即解锁；目标 `dead`；执行者 Upper→free 并给 300 ms 无敌（`06-新增-03` 同值）防顺势围杀 |
| 2 | 距离脱离 | 每步 `‖Δpos‖ > CB-EXEC-RANGE × 1.5 = 2.03 m` 连续 2 步 | 目标回 `downed` 并保留 8 步 stagger；执行者从 recovery 的 `CB-CANCEL-POINT` 处接 `free` |
| 3 | 目标状态失效 | 锁定建立瞬间（step 0）重校验条件 1–6 | 取消；玩家输入在 `CB-INPUT-BUFFER` 内**退回为 attack**（不吞键） |
| 4 | 环境 / 脚本事件 | 13 章扩展事件（可破坏物坍塌等） | 双方回 `idle`；触发一次镜头颤抖（07 章 `CAM-TRAUMA-DECAY` 管辖）；上下文冷却 250 ms（`06-新增-08`） |
## 8. 闪避与招架窗口（固定步内的帧号换算）
| 规则 | 内容 | 理由 |
|---|---|---|
| R1 多段招式 | 先对 `windup+active+recovery` **总时长**取整步，再按 ms 比例分配各段，余数优先给"宽容段"（windup / active），从 recovery 扣 | 满足 10 §0 断言 1「总时长偏差 ≤ 16 ms」，且 active 只变长不变短 |
| R2 单窗口 | 宽容类（缓冲 / 无敌帧 / 招架窗 / 处决窗）用 **ceil**；惩罚类（冻帧 / 收招）用 **floor** | 两类偏差都朝玩家有利方向，避免验收出现"差半帧"的不可复现失败 |
| R1 优先级 | 10 §0 断言 1 优先于 R2 的段落倾向 | 断言不通过即 loader 报错 |

| 常量 | ms | 精确步 | 取整步 | 实际 ms | 偏差 |
|---|---|---|---|---|
| `CB-LIGHT-*` 三段 260/90/300 | 650 | 39.0 | 16 / 6 / 17 | 266.7 / 100.0 / 283.3 | 合计 **0.0** |
| `CB-HEAVY-*` 三段 420/110/460 | 990 | 59.4 | 26 / 7 / 26 | 983.3 | −6.7 |
| `CB-DODGE-TOTAL` | 550 | 33.0 | 33 | 550.0 | 0.0 |
| `CB-DODGE-IFRAME`（0→200） | 200 | 12.0 | 12 | 200.0 | 0.0 |
| `CB-PARRY-WINDOW` | 140 | 8.4 | 9（±4） | 150.0 | +10.0 |
| `CB-EXEC-STAGGER-WINDOW` | 900 | 54.0 | 54 | 900.0 | 0.0 |
| `CB-HITSTOP-*` 60/100/140 | — | 3.6 / 6.0 / 8.4 | 3 / 6 / 8 | 50.0 / 100.0 / 133.3 | −10.0 / 0.0 / −6.7 |
| `CB-TELL-MARGIN`（−80） | 80 | 4.8 | 5 | 83.3 | +3.3（更早，安全侧） |
| `CB-INPUT-BUFFER` | 120 | 7.2 | 8 | 133.3 | +13.3 |

| 窗口 | 步区间（60Hz，step 0 = 该动作输入被消费的那一步） | 说明 |
|---|---|---|
| 闪避无敌 | `[0, 12)` | 第 0–11 步；命中落在第 11 步**仍算无敌**（C5） |
| 闪避总时长 | `[0, 33)` | 第 32 步末结束，第 33 步可输入下一动作 |
| 招架生效 | `[hit−4, hit+4]` 含端点 | 9 步 = 150 ms，居中于命中步 |
| 处决窗 | `[staggerStep, staggerStep+54)` | 54 步 = 900 ms |
| 轻击 active | `[16, 22)` | windup 16 步之后 |
| 轻击取消最早 | `≥ 16+6+11 = 33` | recovery 已过 11/17 = 0.647 ≥ `CB-CANCEL-POINT` 0.60 |

| 动作 | 超前窗口 | 滞后窗口 | 说明 |
|---|---|---|---|
| `attack` | 8 步 / 133.3 ms | 8 步 | 吃满 `CB-INPUT-BUFFER` |
| `dodge` | 6 步 / **100.0 ms**（`06-新增-06`） | 0 | 闪避若吃满 133 ms 会变成"读指令"，系统回拨 6 步反而不公平 |
| `parry` | 4 步 / 66.7 ms | 0 | 与招架半窗同值；命中之后再按无效 |
| `interact` | 5 步 / 83.3 ms | 3 步 / 50.0 ms | 与 `06-新增-01` 稳定窗同值 |
| `heavy` 修饰 | 与 `attack` 同步 | 同 | 修饰键与攻击必须同步计时 |
## 9. 验收断言表
| ID | 断言 | 判定方法 |
|---|---|---|
| B1 | 输入不吞（C1）：在收招第 5 步按下攻击 | 该边沿在 `CB-INPUT-BUFFER` 内被记住，并在 `pct ≥ 0.647` 的第 33 步执行；未执行则失败 |
| B2 | 串招不重（C2）：120 ms 内连按 4 次攻击 | 只有 1 次被消费；`tryAdvance` 调用 4 次仅 1 次返回非 null；第 9 步才完成的输入不执行且不报错 |
| B3 | I1 落点：回放 600 步无需设备 | 只喂录制的 `Intent` 数组，两次结果哈希相同（I5） |
| B4 | 上下文闸门：锁着的门 0.30 m + 可用翻越点 1.30 m | 翻越点 score 胜出；门的 `avail = 0` 使 score 恰为 0 |
| B5 | 稳定窗：候选交替闪烁 4 步 / 6 步 | 4 步闪烁不触发 confirmed；6 步触发且后续跌出 3 步才取消 |
| B6 | 玩家 token 冻结：玩家出招瞬间 AI 申请目标 token | 该步返回 `SlotReject{ reason: 'frozen' }`；已 windup 的 AI 攻击**不取消** |
| B7 | 接近相门槛：目标距 1.29 m / 1.27 m | 1.29 m 拒绝 warp 并进入接近相；1.27 m 直接进攻击相 |
| B8 | 上下文替换对齐：撞墙招在 corner 触发 | 双方锚点世界误差 ≤ 0.15 m；人为把误差拉到 0.16 m 必须回退到顺序 ② |
| B9 | whiff 惩罚：轻击空挥后立刻按 heavy | heavy 边拒绝，`attack` 降级为 light；200 ms 后恢复 |
| B10 | I4 不动移动：轻击受击同时按住前进 | 受击帧前后 Lower 状态哈希一致，位移不中断（C6） |
| B11 | 状态可达性：加载全部数据文件 | loader 的 BFS 覆盖声明的全部 Lower/Upper 状态，未覆盖即启动失败 |
| B12 | 处决锁定：处决期间第三人攻击双方 | 伤害恒为 0 且 hitbox 候选跳过 locked 目标；第三人无法打断 |
| B13 | 闪避窗口：命中落在闪避第 11 步 / 第 12 步 | 第 11 步判无效（无敌），第 12 步命中生效（C5） |
| B14 | 招架窗：命中落在 `hit±4` 步 / `hit±5` 步 | 前者招架成功；后者失败（窗口 9 步 = 150 ms） |
## 10. 新增常量（`06-新增-*`，ID 稳定，允许调值）
| ID | 建议标识 | 值 | 含义 | E | 校准方法 |
|---|---|---|---|---|---|
| `06-新增-01` | `CB-CTX-PICK-T` | 80 ms → 5 步 / 83.3 ms | 上下文候选确认稳定窗 | E3 | B5 用 4/6 步闪烁反证 |
| `06-新增-02` | `CB-CTX-DROP-T` | 50 ms → 3 步 | 已确认候选被取消的滞回窗 | E3 | 与 01 之比 ≈ 0.6，避免确认即可取消 |
| `06-新增-03` | `CB-TOKEN-FREEZE` | 300 ms → 18 步 | 玩家出招时目标身上 attacker token 冻结时长 | E3 | 取 `CB-LIGHT-WINDUP` 260 ms + 1 步余量 → 向上取 300 |
| `06-新增-04` | `SM-UPPER-BLEND` | 120 ms → 7 步 | Upper 层状态切换混合时长 | E3 | 与 `CB-INPUT-BUFFER` 同值，保证"切状态"与"记输入"同步 |
| `06-新增-05` | `CB-PARRY-HALF` | 4 步 / 66.7 ms | 招架窗口半宽（对应 9 步 = 150 ms） | E3 | 招架成功率 > 35% 时收窄到 3 步 / 116.7 ms |
| `06-新增-06` | `CB-PREINPUT-DODGE` | 100 ms → 6 步 | 闪避/招架专用预输入窗 | E3 | 比通用缓冲短 2 步，防"读指令"；B13 反证 |
| `06-新增-07` | `CB-APPROACH-TMO` | 1200 ms → 72 步 | 接近相（Melee Move）超时 | E3 | = `AI-GIVEUP-T` 2500 ms 的 48%，留出重选余量 |
| `06-新增-08` | `CB-CTX-REPL-COOL` | 250 ms → 15 步 | 上下文替换失败/被打断后的冷却 | E3 | 与 `SL-UPDATE-HZ` 250 ms 同频 |
| `06-新增-09` | `CB-WHIFF-PENALTY` | 200 ms → 12 步 | whiff 后 heavy 降级为 light 的窗口 | E3 | B9 断言 |
| `06-新增-10` | `SM-V-THRESH` | 2.45 / 4.48 m/s | Lower 的 walk↔jog↔sprint 分档阈值 | E3 | 2.45 = (1.55+3.35)/2；4.48 = (3.35+5.60)/2 |
| `06-新增-11` | `IN-DEADZONE` | 0.18（径向） | 摇杆/触屏死区 | E3 | 0.18 以下输入归零；与 `CC-SPD-WALK` 的 0.10 m/s 起步门槛对齐 |
> 本章不改 `00` §4 既有常量的语义；§2 的六个评分权重与四类候选的 `R_k/coneHalf/s_kind` 属**数据**（建议落 `contextual.json`），登记为 10 章 v1.1 的追加项，不进常量表。
