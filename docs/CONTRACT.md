# 《权衡》接口契约 CONTRACT v1.0（2026-10-27 冻结）

本文件是开发的唯一接口依据。Codex / dsh / 前端都按此实现；改契约须经总控（Muse）修订版本号，任何模块不得私自变更接口。

## 0. 技术栈与运行

- 运行时：Node.js ≥ 20，**零外部依赖**（只用内置模块；测试用 `node:test`）。
- 后端：单个 HTTP 服务（`server/`），提供工具 API 与状态快照；前端：原生 HTML/CSS/JS 单页（`web/`），无构建步骤。
- 数据：内存状态机 + JSON 种子数据（`data/seed.json`）；审计日志追加写文件（`data/audit.log.jsonl`）。
- 金额：整数分（cents）存储与计算，展示层换算元；税率计算用整数/定点运算，禁止浮点漂移（测算引擎内部可用 JS number 但须在输出前按“四舍五入到分”规范化并有测试覆盖边界）。
- 模拟时钟：全局 `now()` 可注入（`server/clock.js`），定时计划与“日累计”基于模拟日期，测试可快进时间。

## 1. 数据模型（server/state.js）

- `User { id, name }` — 本期仅 1 名演示用户 `u1`。
- `Account { id, userId, type: 'demand'|'salary'|'exercise_fund'|'money_market', name, balanceCents }`
  - 预置：工资卡/活期 `acc_demand` 20,000 元；行权资金专户 `acc_exercise` 0 元；货币基金以 Holding 形式持有（见下）。
- `Transaction { id, accountId, ts, direction: 'in'|'out', amountCents, category, counterparty, memo, planId?, toolCallId }` — 流水只增不改。
- `Card { id, userId, kind: 'physical'|'virtual', status: 'active'|'lost'|'frozen', limitCents }`
- `Subscription { id, userId, name, amountCents, cycle: 'monthly', nextChargeAt, status: 'active'|'cancelled' }` — 取消后模拟时钟推进时不再扣费。
- `Product { id, name, riskLevel: 'R1'|'R2'|'R3', expectedReturnBps, minAmountCents }` — 3 个预设产品。
- `Holding { id, userId, productId, sharesCents(金额口径), }` — 预置货币基金产品持仓 100,000 元。
- `Plan { id, userId, type: 'exercise_saving', status: 'active'|'paused'|'cancelled'|'done', monthlyLockCents, redeemSchedule, targetDate, destAccountId, createdWithAuthId }`
- `AuthGrant { id, userId, level: 'yellow'|'red', bindingHash, expiresAt, used }` — 确认/验证与交易参数绑定（见 §3）。
- `AuditEntry { seq, ts, prevHash, hash, actor, event, tool?, paramsDigest, result, reason? }` — 哈希链追加式（见 §5）。

人物资金基线（与设计文档 §5/§9 一致）：月薪 28,000 元（种子流水呈现）、月均支出约 12,000 元、活期 20,000 元、货基 100,000 元；期权 10,000 股、行权价 12 元、现价 28 元、明年 3 月到期。

## 2. 工具清单（server/tools.js；全部经权限闸门，见 §3）

统一返回：`{ ok: true, data } | { ok: false, error: { code, message } }`。每个工具带 `idempotencyKey` 入参，重复键返回首次结果不重执行。

| 工具 | 参数 | 权限 | 说明 |
|---|---|---|---|
| `get_accounts` | — | 绿 | 账户与余额 |
| `get_transactions` | accountId?, month? | 绿 | 流水查询 |
| `analyze_bills` | month | 绿 | 分类统计、异常识别（规则：单笔 ≥ 月均同类 3 倍或陌生大额）、月报 |
| `transfer` | fromId, toRef(账户id/联系人), amountCents, memo? | 黄/红（按 §3） | 普通转账 |
| `schedule_transfer` | 同上 + executeAt | 黄/红 | 定时转账，执行时复检 |
| `get_products` | — | 绿 | 产品列表与对比数据 |
| `assess_risk` | answers[] | 绿 | 风险评估问卷计分 → 等级 |
| `buy_product` | productId, amountCents, fromId | 红 | 申购，真实扣款建仓 |
| `redeem_product` | holdingId, amountCents, toId | 红 | 赎回，真实到账 |
| `calc_exercise` | 见 §4 | 绿 | 测算引擎（纯函数、无副作用） |
| `apply_virtual_card` | — | 黄 | 申请虚拟卡 |
| `set_card_status` | cardId, status | 红（挂失/解挂）/黄（限额） | 卡片状态变更，真实影响可用性 |
| `list_subscriptions` | — | 绿 | 含从流水识别的周期扣费 |
| `cancel_subscription` | subscriptionId | 黄 | 取消后真实停扣 |
| `create_plan` | 见 §3 | 红 | 资金锁定计划（含赎回安排+月锁+到期划转） |
| `cancel_plan` | planId | 黄 | 取消后未执行步骤全部失效 |
| `get_audit_log` | sinceSeq? | 绿 | 面板审计视图 |

## 3. 权限闸门（server/gate.js，确定性策略引擎，不经大模型）

等级定义（对齐官网）：绿=查询自动执行；黄=展示详情+用户明确确认；红=强验证（演示版：模拟短信码 `246810` 或人脸占位按钮）。

分级规则：
- 转账类：当日累计转出（含本次）≤ 100,000 分（1000 元）→ 黄；> 1000 元 → 红。日累计按模拟时钟的自然日统计全部已执行转出。
- `buy_product` / `redeem_product` / `set_card_status(lost|unlost)` / `create_plan` → 红。
- `cancel_subscription` / `apply_virtual_card` / `cancel_plan` / 限额调整 → 黄。
- 查询与 `calc_exercise` → 绿。

执行协议：
1. 工具调用先经 `gate.check(tool, params, ctx)` → 返回 `allow | need_confirm(level) | need_verify(level) | deny(reason)`。
2. 黄/红：生成 `AuthGrant`，`bindingHash = sha256(tool + 规范化params + userId)`；用户完成确认/验证后凭 grant 执行。**任一参数变更 → hash 不符 → grant 失效，须重新授权。** grant 5 分钟过期、一次性使用。
3. **执行时复检**：定时转账与计划的每一步在实际执行时刻重新跑 `gate.check`（余额、日累计、收款对象、plan 状态、授权撤销情况）；复检不过 → 该步暂停、写审计、通知用户，不得自动放行。
4. 熔断：强验证连续失败 3 次或注入拦截累计 3 次 → 敏感操作（黄/红）锁定 30 分钟（模拟时钟），查询与测算仍可用；锁定与解锁均写审计。
5. 所有状态变更只能经工具层；状态模块不暴露直接修改接口给其他层。

## 4. 测算引擎（server/calc.js，纯函数）

输入：
```json
{ "shares": 10000, "exercisePriceCents": 1200,
  "priceScenariosCents": [2800, 3360, 2240],
  "sellPriceCents": 2800,
  "priorYearIncentiveIncomeCents": 0,
  "batches": [ {"shares": 10000, "yearOffset": 0} ] }
```
输出：对每种价格情景 × 每种行权安排（一次行权 / 分批跨年）× 每种退出方式（立即卖出 / 持有再卖）给出：
`{ exerciseCostCents, incentiveIncomeCents, taxCents, netProceedsCents, assumptions: [...], taxBreakdown: {...} }`，另含不行权基线（netProceeds=0、机会成本=内在价值）。
规则：
- 行权环节税额按 `data/tax-policy.json` 参数计算（税率表、速算扣除、合并计算口径、政策出处与有效期都在该文件内；参数由政策核验任务产出，未核实项标注 `unverified: true` 且引擎在 assumptions 中明示）。同一年度多批行权与 `priorYearIncentiveIncomeCents` **合并**计算边际税额。
- 结果必须标注假设（价格情景、政策版本）；引擎不输出“必然节税”类断言字段。
- 延期缴税只作信息提示字段 `deferralNote`，不改变税额计算。

## 5. 审计（server/audit.js）

- 追加式 JSONL；`hash = sha256(prevHash + JSON.stringify(entry 作不含 hash 字段))`，`seq` 单调递增。
- 必记事件：`tool_call`（含被闸门拒绝）、`gate_decision`、`auth_granted`、`auth_failed`、`plan_step_executed`、`plan_step_blocked`、`injection_blocked`、`breaker_on/off`、`calc_run`。
- 面板只读展示；任何模块不得改写既有条目。

## 6. 错误码

`INSUFFICIENT_FUNDS` `GATE_DENY` `NEED_CONFIRM` `NEED_VERIFY` `AUTH_EXPIRED` `AUTH_BINDING_MISMATCH` `BREAKER_LOCKED` `NOT_FOUND` `INVALID_PARAMS` `IDEMPOTENT_REPLAY`（非错误，回放首次结果时附带标记）。

## 7. 红线

- 一切金额只能出自工具/引擎返回值；对话层与前端不得自行计算金额。
- 税务参数只认 `data/tax-policy.json` 且必须带出处；禁止把税率写死在代码里。
- 不接真实银行/真实资金/真实行情接口；股价手动输入 + 情景预设。
