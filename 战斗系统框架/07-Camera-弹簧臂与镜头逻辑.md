# 战斗系统框架 · 07 Camera：弹簧臂 / 碰撞规避 / 震动 / FOV / 瞄准辅助

**契约层第 4 份。上游：00 §4.2 `CC-*`、00 §4.6 `CAM-*`、03 §2 阶段 10、03 §4.4 `solveSpringArm`、10 §6 `camera_profile.json`。**

| 项 | 规定 |
|---|---|
| 所属层 | 表现层。相机**只读**世界，永不写战斗状态 |
| 逻辑职责 / 渲染职责 | 阶段 10 `camera.solve` 只产出 `CameraIntent`（yaw/pitch/fovTarget/shoulderSign/focusId，0.1 ms）；`renderUpdate(alpha)` 内真实解算 pos/quat/fov，预算 ≤ `CAM-BUDGET-Ms`（§9）|
| 不变量 / 红线 | I1：不参与任何伤害/命中/槽位判定；I5：抖动相位不得用 `Math.random()`，只用 `step` 与 ID 的确定性哈希。`camera/springarm.ts` 禁 import three，几何查询经注入的 `SphereProbe`；单位 m/°/ms（dt 用 s）|

## 0. 失败模式索引（7 条坏镜头，逐条给出消除位置）

| # | 坏表现（玩家原话） | 可观测症状（可判定） | 消除于 |
|---|---|---|---|
| F1 | 镜头穿墙，看得见关卡背面 | 相机落在 BVH 内部；`len > hardLen` 的帧数 > 0 | §2.2 球扫硬截断 |
| F2 | 贴墙时镜头贴脸抽搐 | 相邻帧 `Δlen > 0.05 m` 且方向反复变号 ≥ 3 次 | §2.3 非对称速率 4.67:1 + 死区 |
| F3 | 背靠掩体，自己的背挡住敌人 | 焦点射线被自身胶囊拦截，焦点丢失帧 > 20% | §3.1 pivot 前移/侧移（≤0.35 m）|
| F4 | 冲刺急转时镜头甩大弧 | 相机 yaw 滞后输入 yaw > 8° 持续 > 100 ms | §2.1 角度通道 + §1.1 pivot 跟随 |
| F5 | 震动像随机噪声，看不出从哪挨打 | 抖动位移与 `GameEvent.hit.dir` 夹角 > 45° 的帧占比高 | §5.1 定向脉冲 |
| F6 | FOV 在蹲/冲刺/瞄准切换时突跳 | 单帧 `|Δfov| > 1.5°` | §4.1 过渡 + §4.2 幂次曲线 |
| F7 | 进屋瞬间镜头猛缩、出门猛拉 | profile 切换帧上 `|ΔarmLength| > 0.10 m` | §7 深合并 + 200 ms 过渡 + 迟滞 |

> 7 条全部可写成 §8 断言；不接受"感觉好点了"作为完成标准。

## 1. 相机骨架（pivot → shoulder → arm → near）

### 1.1 pivot：跟踪眼高，恒定 −0.04 m 偏移

pivot 不是独立魔数，由眼高派生，保证两种姿态的过肩构图一致：

```
pivotH_target = eyeH_now − 0.04;   eyeH_now = lerp(CC-CROUCH-EYE-H, CC-EYE-H, stancePct)
pivotH = pivotH + (pivotH_target − pivotH) × (1 − exp(−dt / CAM-PIVOT-T))
```

| 姿态 | 眼高 | pivot 高 | 差值 | 检查 |
|---|---|---|---|---|
| 站立 | 1.62（`CC-EYE-H`）| 1.58（`CAM-PIVOT-H`）| −0.04 | 与 00 §4.6 一致 |
| 蹲姿 | 0.92（`CC-CROUCH-EYE-H`）| 0.88 | −0.04 | 差值恒定 = 验收条件 |

- 平滑用一阶指数 `CAM-PIVOT-T` = 90 ms（`CAM-新增-22`，3τ = 270 ms 到位），不用弹簧：pivot 过冲会让人物上下"点头"。站/蹲胶囊切换（1.78 ↔ 1.05）由第 05 章负责，相机只消费 `stancePct`。

### 1.2 过肩偏移、换肩、臂长与近裁剪

```
right     = (cos(yaw), 0, −sin(yaw))                        // Y 上右手系
shoulderV = right × (CAM-SHOULDER-X × shoulderSign × shoulderFade)
pivot     = actorPos + (0, pivotH, 0) + shoulderV + coverShift
```

| 参数 | 值 | 规定 |
|---|---|---|
| 过肩偏移 | `CAM-SHOULDER-X` = 0.52 m | > `CC-CAP-RADIUS` 0.32 ⇒ pivot 落在胶囊外 0.20 m，**pivot 自身也必须球检** |
| 切换插值 | `CAM-SHOULDER-T` = 250 ms（`CAM-新增-01`）| smoothstep `3t²−2t³`；线性切换两端有速度阶跃，观感是"抽一下" |
| 占位冲突检测 | 新肩位置球检半径 `CC-CAP-RADIUS` = 0.32 m | 被挡 → 拒绝本次换肩，请求挂起 300 ms 重试；两肩皆挡 → 双肩回正（同 250 ms）|
| 贴脸回正 | `shoulderFade = clamp((len − CAM-NEAR-MIN)/(CAM-ARM-LEN × 0.25), 0, 1)` | 臂长 < 0.795 m 起按比例收肩，避免压到后脑 |
| 臂长 / 近裁剪 / 近平面 | `CAM-ARM-LEN` = 2.70 m / `CAM-NEAR-MIN` = 0.12 m / 渲染近平面 0.10 m（E3）| 臂长任何情况不得短于近裁剪下限；近平面必须严格小于 `CAM-NEAR-MIN`，0.02 m 差值即防穿模余量 |
| 位置插值 | `CAM-POS-LERP` = 0.18/帧@60 | 只用于最终相机位置；与臂长弹簧不可叠加两次平滑（叠加 = 拖影）|

- 换肩走"请求 → 检测 → 插值"三段，**插值过程中不重检**（否则墙前左右横跳）；冲突检测在**新肩位置**做，不在当前位置做。

## 2. 弹簧臂求解（`camera/springarm.ts`）

**弹簧负责"跟随的手感"，碰撞负责"不许穿墙"，两者必须分开写；混在一起就是 F2 抽搐的根因。**

### 2.1 两通道带阻尼弹簧（半隐式欧拉）

长度通道（`CAM-SPRING-K` / `CAM-SPRING-DAMP`）：`c = 2ζ√k = 2×0.85×√14.0 = 6.361`

```
a = k × (targetLen − len) − c × v;   v += a × dt;   len += v × dt
```

| 派生量 | 值 | 含义 |
|---|---|---|
| ω_n / 周期 | √14.0 = 3.742 rad/s / 1.679 s | 固有频率；过冲 `exp(−πζ/√(1−ζ²))` = 0.63%（ζ=0.85 欠阻尼）|
| 稳定裕度 | k·dt² = 3.9e−3 ≪ 4 | 60 Hz 远离发散；`TM-MAX-CATCHUP` 补算每步仍用 `TM-DT` |
| 建立时间（2%）| 4/(ζω_n) = 1.258 s | 0 → 2.70 m 恢复上限 |

角度通道（**只用于被系统驱动**的角度：锁定、处决运镜、辅助收拢）：

```
k_ang = CAM-SPRING-K × CAM-ANGLE-K-MUL(4.0，CAM-新增-02) = 56.0;  ζ_ang = 1.0（临界，禁过冲）
c_ang = 2√k_ang = 14.97;  a = k_ang*(target−cur) − c_ang*v;  v += a*dt;  cur += v*dt   // 建立 0.535 s
```

- **玩家输入角度绝不走弹簧**，直接积分（角速度上限见 `CC-TURN-*`）。给输入加弹簧等于植入 40–80 ms 延迟，是 F4 之外的另一类投诉。

### 2.2 碰撞规避（与弹簧解耦的三层）

| 层 | 做什么 | 常量 | 为什么在这层 |
|---|---|---|---|
| ① 球扫 | pivot 沿 `dir` 扫半径 `CAM-PROBE-R`=0.28 m 的球到 `desiredLen`，得首次接触距离 `d` | `CAM-PROBE-R` | 唯一读几何处（`three-mesh-bvh` 的 `shapecast`，E3）|
| ② 硬上限 | `hardLen = clamp(d, CAM-NEAR-MIN, desiredLen)` | `CAM-NEAR-MIN` | **不可能被越过的界**，与弹簧无关 |
| ③ 硬截断 | 弹簧解完 `len = min(len, hardLen)`，清零向外速度分量 | — | 顺序不可反：先弹簧后夹紧，夹紧不攒势能，避免恢复瞬间弹射 |

pivot 自身也球检（半径 `CAM-PROBE-R`）：`CAM-SHOULDER-X` 0.52 > `CC-CAP-RADIUS` 0.32，贴墙转身时 pivot 会先于胶囊进墙。球扫只扫**一次**、不做二分细化——误差被探针半径 0.28 m 与 0.02 m 余量覆盖，二分要吃掉 §8.1 预算的一半。

### 2.3 非对称速率：收 0.06 s / 复 0.28 s（4.67:1）

| 方向 | 时间常数 | 等效速率（按 `CAM-ARM-LEN` 归一）| 效果 |
|---|---|---|---|
| 收缩 | `CAM-RETRACT-T` = 0.06 s（`CAM-新增-03`）| 2.70/0.06 = **45.0 m/s** | 单步 0.75 m，遮挡窗 ≤1 帧，且被②兜底 |
| 恢复 | `CAM-RECOVER-T` = 0.28 s（`CAM-新增-04`）| 2.70/0.28 = **9.64 m/s** | 0.12 → 2.70 m 用 268 ms，是"推出去"不是"弹出去" |

**为什么必须不对称**：同速率时球探针掠过墙角会一帧判挡、一帧判通，`len` 以 30–60 ms 周期往返 0.1–0.3 m——这就是 F2。4.67:1 提供等效滞回（作用同 `SL-HYSTERESIS` 之于槽位）：进入遮挡瞬时、退出遮挡缓慢，极限环被打断。再叠死区 `CAM-LEN-DEADBAND`（0.015 m，`CAM-新增-05`）吸附，消灭末位抖动。

### 2.4 完整伪代码（签名与 03 §4.4 逐字一致）

```ts
// camera/springarm.ts —— 禁止 import three
export interface SpringArmState { length: number; vel: number; lastHit: number; }

/** 03 §4.4 原签名；state 为 in/out（length/vel/lastHit 回写），返回值只带 pos 与 hit */
export function solveSpringArm(
  pivot: Vec3, dir: Vec3, desiredLen: number,
  probe: SphereProbe, state: SpringArmState, dt: number
): { pos: Vec3; hit: boolean } {
  const K = 14.0;                            // CAM-SPRING-K
  const C = 2 * 0.85 * Math.sqrt(K);         // 6.361，由 CAM-SPRING-DAMP 派生
  // ① 球扫（唯一几何查询；dir 必须单位化）
  const d = probe.sweepSphere(pivot, dir, desiredLen, 0.28 /* CAM-PROBE-R */).dist;
  // ② 硬上限
  const hardLen = clamp(d, 0.12 /* CAM-NEAR-MIN */, desiredLen);
  // ③ 非对称速率：只改"目标"，改不到硬上限
  const rate    = hardLen < state.length ? desiredLen / 0.06    // 45.0 m/s 收缩
                                         : desiredLen / 0.28;   //  9.64 m/s 恢复
  let targetLen = state.length + Math.sign(hardLen - state.length) * rate * dt;
  targetLen = hardLen < state.length ? Math.max(targetLen, hardLen)
                                     : Math.min(targetLen, hardLen);
  if (Math.abs(hardLen - state.length) < 0.015 /* CAM-LEN-DEADBAND */) targetLen = hardLen;
  // ④ 弹簧（两个标量，与碰撞无关）
  const acc = K * (targetLen - state.length) - C * state.vel;
  state.vel    += acc * dt;
  state.length += state.vel * dt;
  // ⑤ 硬截断（顺序不可反；只清外向速度，保留内向速度）
  if (state.length > hardLen) { state.length = hardLen; if (state.vel > 0) state.vel = 0; }
  if (state.length < 0.12)    { state.length = 0.12;    if (state.vel < 0) state.vel = 0; }
  state.lastHit = d;                          // 沿 dir 的接触距离；无阻挡 = Infinity
  return { pos: add(pivot, scale(dir, state.length)), hit: d < desiredLen };
}
```

> 03 §4.4 返回值不含 `length`，长度以 `state.length` 回写——本章不新增返回字段，只把回写约定写明，避免误以为每次调用会重置长度。

## 3. 视线管理（背靠掩体、焦点选择、遮挡消解）

### 3.1 背靠掩体：pivot 前移 + 侧移（合成上限 0.35 m）

| 项 | 规则 |
|---|---|
| 触发 / 前移 | 背面（−forward）墙距 ≤ 0.80 m 且前方 2.0 m 通畅（墙距由 −forward 球检，半径 `CC-CAP-RADIUS`，不用射线：凹墙上射线给错点）；`coverFwd = clamp((0.80 − wallDist)/0.80, 0, 1) × CAM-COVER-SHIFT-MAX`（0.35 m，`CAM-新增-06`）|
| 侧移 | `coverSide = −shoulderSign × CAM-COVER-SHIFT-MAX × 0.5`（向肩部对侧让出墙侧视野，≤0.175 m）|
| 上限 | 前移与侧移的**合成模长** ≤ 0.35 m（不是各自 0.35）；超过则按比例归一 |
| 平滑 / 禁止 | 与 pivot 同时间常数 `CAM-PIVOT-T` 90 ms（退出同样 90 ms，不瞬间归零）；偏移不得改变臂长，偏移后必须重做 §2.2 的 pivot 球检 |

0.35 m 的取值理由：`CC-CAP-RADIUS` 0.32 + 0.03 余量。超过它 pivot 钻出身体前方，人物在画面里消失。

### 3.2 焦点（look-at）优先级

| 优先级 | 焦点 | 取法 | 何时启用 |
|---|---|---|---|
| P0 | 玩家瞄准点 | 相机沿视线射线首个交点；无交点取 `CAM-AIMASSIST-DIST`=25 m 处点 | 举枪/瞄准/有锁定目标 |
| P1 | 前方环境点 | `pivot + fwdXZ × CAM-LOOKAHEAD`(6 m，`CAM-新增-07`)，再沿视线下压 15° 采样，取首个交点或端点 | 自由移动（默认）|
| P2 | 屏幕中心 | `pivot + fwd × CAM-ARM-LEN` | 前两者均不可用（空中/无几何）|

档位切换时焦点位置用 `CAM-POS-LERP` 同速平滑，避免瞄准瞬间镜头"抬头"。

### 3.3 遮挡消解（迭代上限 4 步）

从 pivot 向焦点打射线；在 `|focus−pivot| − 0.05 m` 内被挡则两阶段消解：

| 阶段 | 动作 | 步长 | 上限 |
|---|---|---|---|
| A | pivot 沿 **pivot→焦点** 前推 | 0.10 m/步 | `CAM-VIEW-ITER` = 4 步（0.40 m，`CAM-新增-08`）|
| B | 仍被挡：缩短有效臂长（相机向 pivot 靠），让遮挡物落到近裁剪之后 | 0.25 m/步 | `CAM-VIEW-PULL-MAX` = 0.50 m（2 步，`CAM-新增-09`）|
| 兜底 | 仍失败：焦点降级为**挡点本身**，永不把镜头推进玩家身体 | — | — |

> **口径说明**：任务书写"把 pivot 向相机方向偏移"。字面沿臂后撤会让视线退到遮挡物更深处（加剧遮挡），故该意图实现为阶段 B（缩短臂长把遮挡物推过近裁剪），阶段 A 用前推做真正的视线解除；阶段顺序固定不可交换。

## 4. FOV 与动态表现

### 4.1 三档与过渡

| 档位 | FOV | 触发 | 优先级 |
|---|---|---|---|
| 基准 | `CAM-FOV-BASE` = 55° | 默认 | 3 |
| 冲刺 | `CAM-FOV-SPRINT` = 62° | `speed ≥ 0.85 × CC-SPD-SPRINT` 且非瞄准 | 2 |
| 瞄准 | `CAM-FOV-AIM` = 42° | 举枪/举镜/锁定 | 1（压制冲刺）|
| 过渡 | `CAM-FOV-T` = 0.22 s | 一阶指数，τ = `CAM-FOV-T`/3 = 73 ms（3τ 到位）；任一帧 `|Δfov| ≤ 1.5°` | — |

档位单向压制：瞄准时即使冲刺也走 42°（否则冲刺瞄准得 62°，画面撕裂）。

### 4.2 速度驱动的 FOV 微调制

```
speedRatio = clamp(speed / CC-SPD-SPRINT, 0, 1)
fov        = base + (CAM-FOV-SPRINT − base) × speedRatio^CAM-FOV-SPEED-POW   // 幂次 1.5，CAM-新增-10
fovTarget  = 瞄准态 ? CAM-FOV-AIM : fov
```

| 速度状态 | speed | ratio | ratio^1.5 | FOV |
|---|---|---|---|---|
| 步行 | 1.55（`CC-SPD-WALK`）| 0.277 | 0.146 | 56.02 |
| 小跑 | 3.35（`CC-SPD-JOG`）| 0.598 | 0.463 | 58.24 |
| 冲刺 | 5.60（`CC-SPD-SPRINT`）| 1.000 | 1.000 | 62.00 |

**为什么 1.5 次幂而非线性**：① 线性时 `dfov/dspeed` 恒为 1.25 °/(m/s)，1.55→1.75 m/s 的细微速度波动就带来可见的 FOV 呼吸；1.5 次幂低速段斜率趋 0（0.277 处仅 +1.02°），把抖动压掉。② 幂次 >1 使 0 处导数为 0（C¹ 连续），起步无 FOV 阶跃。③ 高速段斜率拉满，越接近冲刺上限越"拉风"——这是把手感翻译成可判定曲线的唯一方式。

### 4.3 瞄准时 shoulder 收紧

`shoulderX_aim = CAM-SHOULDER-X × CAM-SHOULDER-AIM-MUL(0.70，CAM-新增-11) = 0.364 m`，随瞄准进度插值（`aimPct` 由 FOV 过渡进度代理，不新增状态），走 `CAM-SHOULDER-T` 250 ms 曲线——不与 FOV 的 220 ms 共用，否则两者产生拍频。收紧使准星更靠画面中轴，减少"过肩 + 42° 窄 FOV"的右侧盲区。

## 5. 震动系统（定向，而非随机噪声）

### 5.1 trauma 模型与定向脉冲

```
trauma = clamp(trauma + Δ_source, 0, 1);   trauma = max(0, trauma − CAM-TRAUMA-DECAY × dt)
amp    = trauma²                                        // 1.8/s ⇒ 1.0→0 用 556 ms
offset(t) = dirHit × CAM-SHAKE-MAX-POS × amp × exp(−t/τ) × sin(2π f t)
roll(t)   = CAM-SHAKE-MAX-ROLL × amp × exp(−t/τ) × sin(2π f t + φ + π/2)
```

| 符号 | 来源 | 说明 |
|---|---|---|
| `dirHit` | **`GameEvent.hit.dir`** | 世界空间单位向量，**从攻击者指向受害者**（与击退同向）；相机沿该方向推离打击轴线 |
| `f` | `camera_profile.shake.freq`（默认 18.0, E3）× 源频率倍率 | 爆炸低频大位移、刀击高频小位移 |
| `τ` | §5.3 每源一个 | 控制余震条数（3τ 衰减到 5%）|
| `amp` | `trauma²`（00 §3 术语表：平方映射）| 小 trauma 几乎无感；三次轻击累到 0.66 时幅度是 0.22 的 9 倍——"越打越沉"自然涌现 |
| `φ` | `2π × ((fnv1a(attackerId,victimId,step) & 0xFFFF)/65536)` | **不得用 `Math.random()`**（I5），保证回放一致 |
| 死区 | `trauma < CAM-SHAKE-EPS`(0.05，`CAM-新增-16`) → 输出 0 | 切掉尾部 28 ms 残余 |

**数据通路（唯一允许相机读事件的点）**：`phase 4 combat.tick` 把 `bus.push({t:'hit',…,dir})` 写入环形队列（03 §4.5）→ `phase 10 camera.solve` 用 `bus.peekByType('hit')` **只读不消费**地取本步命中并调用 `director.pushTrauma(Δ, τ, fMul, dir)` → `phase 11 bus.flush` 才出队给音效/特效消费者。

阶段 10 用 `peek`（只读游标），因为阶段 11 才 `flush`——一次命中同时被相机与音效消费、互不抢事件。`dir` 必须在阶段 4 生成时就写死为世界向量，不得在相机侧从朝向反推（受击 reaction 动画会把朝向带偏）。

### 5.3 四类震动源（幅度 / 时长 / 频率）

| 源 | Δtrauma | τ | 频率 → f | trauma 寿命 Δ/1.8 | 3τ 包络 | 峰值位移 Δ²×0.09 | 峰值滚转 Δ²×2.2° | 约束 |
|---|---|---|---|---|---|---|---|---|
| 命中他人（轻）| +0.22 | 0.035 s | ×1.0 → 18.0 Hz | 122 ms | 105 ms | 4.4 mm | 0.11° | 105 ≤ 122 ✓ |
| 自己被命中 | +0.35 | 0.055 s | ×1.0 → 18.0 Hz | 194 ms | 165 ms | 11.0 mm | 0.27° | 165 ≤ 194 ✓ |
| 爆炸 | +0.85 | 0.140 s | ×0.55 → 9.9 Hz | 472 ms | 420 ms | 65.0 mm | 1.59° | 420 ≤ 472 ✓ |
| 处决终结 | +0.55 | 0.090 s | ×0.75 → 13.5 Hz | 306 ms | 270 ms | 27.2 mm | 0.67° | 270 ≤ 306 ✓ |

每源 `τ` 均为新增常量（`CAM-新增-12..15`）；`Δ` 的取值保证 `3τ ≤ Δ/1.8`，否则包络没走完 trauma 已归零，脉冲被腰斩。多源叠加时 trauma 线性相加后 clamp 到 1.0，位移矢量求和后再 clamp 到 `CAM-SHAKE-MAX-POS`（防爆表），滚转同法。

## 6. 锁定与瞄准辅助

### 6.1 软锁 vs 硬锁

| 维度 | 软锁（本框架实现）| 硬锁（**不实现**）|
|---|---|---|
| 影响对象 | 只改 `aimDir`（子弹/近战意图朝向），**不动相机 yaw/pitch** | 直接接管相机 yaw |
| 玩家权威 | 100% 保留（相机角度仍是输入积分）| 被部分剥夺 |
| 参数 | `CAM-AIMASSIST-CONE`=6°、`CAM-AIMASSIST-DIST`=25 m、拉向强度 0.35 | — |
| 切换条件 | 无（常开，权重自 0 连续起算）| 若未来做手柄辅助：须"举枪 >400 ms 且目标在锥内且未冲刺"，且**仅 PvE 目标** |

```
w      = 0.35 × (1 − angle/CAM-AIMASSIST-CONE)² × (1 − dist/CAM-AIMASSIST-DIST)   // ≤ 0.35 封顶
aimDir = normalize(lerp(inputDir, dirToTarget, w))
```

二次项让锥边缘吸附迅速归零（6°→0）；封顶 0.35 是必须的，超过后玩家开始感到"准星被偷走"。距离项按 `CAM-AIMASSIST-DIST` 归一，故用线性。

### 6.2 近战自动锁定（只决定"这一击打谁"）

| 项 | 规则 | 常量来源 |
|---|---|---|
| 半角 / 距离 | ±35° / ≤ 4.05 m | `CB-EXEC-ANGLE`/2（70°/2）；`CB-EXEC-RANGE`×3（1.35×3）|
| 评分 | `score = 0.6×(1 − d/4.05) + 0.4×threat` | threat = 0.5×持有攻击席位 + 0.3×windup 中 + 0.2×朝向玩家 |
| 重算 / 迟滞 | 4 Hz（250 ms）/ 新目标须超出当前 ≥ 0.35 归一单位 | `SL-UPDATE-HZ` / 数值借 `SL-HYSTERESIS` |
| 优先级 | **最近 + 威胁**，不是"正前方"：背后正在 windup 的老兵 > 正前 4 m 的静止感染者 | — |

锁定只写 `CameraIntent.focusId`；实际打击对象仍由 `moveset.requirements`（`minDist/maxDist/angleDeg`）判定——锁定是**意图**，命中的是**几何**，两者不可互相替代。

### 6.3 解锁条件

| 条件 | 阈值 |
|---|---|
| 目标死亡 | 下一逻辑步即解（≤1 步）|
| 视线累计遮挡 | > `CAM-LOCK-BREAK-T` = 0.6 s（`CAM-新增-17`）；累计而非连续，掩体后闪现不掉锁 |
| 距离超限 | > 4.05 + `SL-HYSTERESIS`(0.35) = 4.40 m |
| 玩家反向转视角 / 目标被第三方处决（`execLock`，08 §5）| 偏离 > 60° / 立即解 |
| 解锁后重锁同一目标 | 冷却 `CAM-LOCK-COOL` = 0.30 s（`CAM-新增-18`）|

## 7. camera_profile 切换（default ↔ tight_indoor）

| 判据 | 进屋阈值 | 出屋阈值（迟滞）| 探针 |
|---|---|---|---|
| 头顶净空 | < `CAM-PROFILE-INDOOR-CLEAR` = 2.60 m（`CAM-新增-19`）| > 2.90 m | pivot 向上单射线 |
| 水平围合 | 四向 `CAM-PROFILE-INDOOR-RAY` = 2.50 m 内 **≥3 向**被挡（`CAM-新增-23`）| ≤2 向 | pivot 水平 4 向射线 |
| 判定频率 | 4 Hz（与 `SL-UPDATE-HZ` 同拍摊平）| 同 | — |

两条判据是 **OR**：2.4 m 净空的矮走廊或三面墙的储藏间，任一成立即进 `tight_indoor`。迟滞带宽 0.30 m / 1 向，防止在门槛上来回走时反复切换（F7）。

| 字段 | default | tight_indoor | 过渡期行为 |
|---|---|---|---|
| `armLength` | 2.70（`CAM-ARM-LEN`）| 1.90 | 线性插值，0.80 m/200 ms = 4.0 m/s |
| `shoulderX` | 0.52（`CAM-SHOULDER-X`）| 0.44 | 线性插值 |
| `fov.base` | 55（`CAM-FOV-BASE`）| 60 | 走 §4.1 的 220 ms FOV 过渡，**不**用 200 ms |
| `pivotHeight`/`probeRadius`/`springK`/`springDamp`/`nearMin`/`posLerp` | 继承 | 继承 | 不插值；过渡时长 `CAM-PROFILE-T` = 200 ms（`CAM-新增-20`）|

深合并规则（与 10 §6 `inherit: true` 一致）：① 只对 plain object 递归合并，**数组整体替换**（否则 `fov` 子对象会被拆错）；② `null` = 显式清空，不是沿用默认；③ profile 出现 `default` 没有的字段 → schema 校验失败并抛出（10 §0：不匹配直接 throw，禁止兜底）；④ 过渡期间碰撞钳制必须用**插值后的 `probeRadius` 与实际 `armLength`**，§2.2 硬截断全程有效——宁可相机瞬移，不可穿墙。

## 8. 性能与验收断言表

### 8.1 每帧预算（`renderUpdate` 内，60 Hz）

| 子项 | 单次（E3）| 频率 | 摊平 | 说明 |
|---|---|---|---|---|
| 球扫 ×1 + pivot/掩体球检 ×2 | 0.020 + 0.010×2 ms | 每帧 | 0.040 | `three-mesh-bvh` 的 `shapecast`（E3）|
| 视线射线 + 消解迭代 | 0.005 ms × ≤6 | 每帧 | 0.030 | 阶段 A 4 步 + B 2 步 |
| 弹簧 / 震动 / FOV 算术 | <0.003 ms | 每帧 | 0.005 | 纯标量，无分配 |
| profile 判定（5 射线）+ 换肩检测 | 0.030 / 0.020 ms | 4 Hz / 事件 | 0.010 | 摊平 |
| **合计** | — | — | **≈0.085 ms** | 上限 `CAM-BUDGET-Ms` = 0.15 ms（`CAM-新增-21`）|

### 8.2 断言表（12 条，全部黑盒可判）

| ID | 断言 | 判定方法 |
|---|---|---|
| CAM-AC-01 | 任意人造障碍布局下每帧 `len ≥ CAM-NEAR-MIN`(0.12) 且 `len ≤ hardLen` | 驱动 300 帧记录 `len`/`hardLen` |
| CAM-AC-02 | 镜头到墙距离恒 ≥ `CAM-NEAR-MIN` − 探针余量；穿墙帧数 = 0 | BVH 点内测试相机位置 |
| CAM-AC-03 | 连续 300 帧无 `|Δlen| > 0.02 m`（`hardLen` 阶跃那一帧允许 ≤0.75 m）| 逐帧差 |
| CAM-AC-04 | 无遮挡 0 → 2.70 m 建立时间 1.258 s ±10% | 阶跃输入 |
| CAM-AC-05 | 过冲 ≤ 标称长度 1%（理论 0.63%）| 峰值采样 |
| CAM-AC-06 | 碰撞释放后 0.12 → 2.70 m 用时 268 ms ±10% | 阶跃释放 |
| CAM-AC-07 | 给定 `dir`，镜头位移方向与 `dir` 夹角 ≤ 15° | 20 次随机 `dir` 采样 |
| CAM-AC-08 | trauma 1.0 → 0 用时 556 ms ±10% | 无新事件下采样 |
| CAM-AC-09 | 爆炸震动首帧位移 = 0.065 m ±5%，472 ms 内归零 | 单源脉冲 |
| CAM-AC-10 | FOV 55→62 用时 220 ms ±10%，单帧 `|Δfov| ≤ 1.5°` | 阶跃输入 |
| CAM-AC-11 | 站↔蹲 pivot 高变化 0.70 m，无单帧 >0.05 m 跳变，末态差值恒为 −0.04 m | 逐帧差 + 末态 |
| CAM-AC-12 | 1000 帧均值 ≤0.15 ms、p99 ≤0.22 ms；600 步 seeded 回放两次哈希相同（I5）| 计时 + 哈希 |

## 9. 新增常量（`CAM-新增-NN`，全部 E3；允许调值不允许改 ID）

| 登记号 | ID | 值 | 含义 |
|---|---|---|---|
| `CAM-新增-01` | `CAM-SHOULDER-T` | 250 ms | 左右肩切换 smoothstep 插值时长 |
| `CAM-新增-02` | `CAM-ANGLE-K-MUL` | 4.0 | 角度通道刚度 = `CAM-SPRING-K`×此值（=56.0），ζ 固定 1.0 |
| `CAM-新增-03` | `CAM-RETRACT-T` | 0.06 s | 碰撞收缩时间常数 → 45.0 m/s |
| `CAM-新增-04` | `CAM-RECOVER-T` | 0.28 s | 碰撞恢复时间常数 → 9.64 m/s；与收缩之比 4.67:1 |
| `CAM-新增-05` | `CAM-LEN-DEADBAND` | 0.015 m | 臂长抖动死区 |
| `CAM-新增-06` | `CAM-COVER-SHIFT-MAX` | 0.35 m | 背靠掩体 pivot 位移合成上限（=`CC-CAP-RADIUS`+0.03）|
| `CAM-新增-07` | `CAM-LOOKAHEAD` | 6.0 m | P1 级焦点沿前方取点距离 |
| `CAM-新增-08` | `CAM-VIEW-ITER` | 4 步 | 遮挡消解阶段 A 迭代上限（0.10 m/步）|
| `CAM-新增-09` | `CAM-VIEW-PULL-MAX` | 0.50 m | 阶段 B（缩短臂长把遮挡物推过近裁剪）位移上限 |
| `CAM-新增-10` | `CAM-FOV-SPEED-POW` | 1.5 | 速度→FOV 曲线幂次（C¹ 连续，低速压抖）|
| `CAM-新增-11` | `CAM-SHOULDER-AIM-MUL` | 0.70 | 瞄准时 shoulder 收紧倍率（0.52→0.364 m）|
| `CAM-新增-12` | `CAM-SHAKE-HIT` | Δ+0.22 / τ 0.035 s / f×1.0 | 命中他人：trauma 增量、包络、频率倍率 |
| `CAM-新增-13` | `CAM-SHAKE-TAKEN` | Δ+0.35 / τ 0.055 s / f×1.0 | 自己被命中：同三项 |
| `CAM-新增-14` | `CAM-SHAKE-EXPL` | Δ+0.85 / τ 0.140 s / f×0.55 | 爆炸：同三项（低频大位移）|
| `CAM-新增-15` | `CAM-SHAKE-EXEC` | Δ+0.55 / τ 0.090 s / f×0.75 | 处决终结：同三项 |
| `CAM-新增-16` | `CAM-SHAKE-EPS` | 0.05 | trauma 死区，低于此值输出恒 0 |
| `CAM-新增-17` | `CAM-LOCK-BREAK-T` | 0.6 s | 视线累计遮挡多久解锁 |
| `CAM-新增-18` | `CAM-LOCK-COOL` | 0.30 s | 同一目标再次锁定冷却 |
| `CAM-新增-19` | `CAM-PROFILE-INDOOR-CLEAR` | 2.60 m | 头顶净空进屋阈值（出屋 2.90 m）|
| `CAM-新增-20` | `CAM-PROFILE-T` | 200 ms | profile 标量（armLength/shoulderX）过渡时长 |
| `CAM-新增-21` | `CAM-BUDGET-Ms` | 0.15 ms/帧 | 相机解算总预算（§8.1 实测 ≈0.085 ms）|
| `CAM-新增-22` | `CAM-PIVOT-T` | 90 ms | pivot 高度与掩体偏移的一阶跟随时间常数 |
| `CAM-新增-23` | `CAM-PROFILE-INDOOR-RAY` | 2.50 m | 水平围合判定探针距离（≥3 向被挡即室内）|

**派生量（不登记，写清算式）**：贴脸肩偏衰减起点 = `CAM-NEAR-MIN + CAM-ARM-LEN×0.25` = 0.795 m；近战锁定半角 = `CB-EXEC-ANGLE/2` = 35°；锁定距离 = `CB-EXEC-RANGE×3` = 4.05 m；弹簧阻尼 `c` = `2×CAM-SPRING-DAMP×√CAM-SPRING-K` = 6.361；角度阻尼 `c_ang` = `2√56` = 14.97。
