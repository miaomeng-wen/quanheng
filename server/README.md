# 第一阶段模块使用说明

零依赖，CommonJS，Node.js >=20。运行 `node --test`。

```js
const { createClock } = require('./clock');
const { createTools } = require('./tools');
const clock = createClock('2026-10-27T08:00:00Z');
const tools = createTools({ clock });
const params = {
  fromId: 'acc_demand', toRef: 'acc_exercise', amountCents: 10000,
  idempotencyKey: 'transfer-1'
};
const grant = tools.authorize('transfer', params, { confirmed: true });
const result = tools.transfer(params, { authId: grant.data.id });
clock.advance(86400000);
tools.runDueSteps();
```

所有工具通过 `call(name, params, ctx)` 或同名方法调用；统一返回契约结果。
授权凭据通过上下文 `ctx.authId` 传递，不属于交易参数。红级证明为
`{ code: '246810' }` 或 `{ faceConfirmed: true }`。
授权绑定规范化业务参数与用户，不含幂等键；任意业务参数变更会失效。
每个用户的幂等键跨工具唯一；重复键附带 `replay: 'IDEMPOTENT_REPLAY'`，
回放首次完整结果。若先调用工具收到授权挑战，确认执行需新幂等键。
`authorize` 是授权交互辅助方法，并非新增银行工具。

契约未给出 create_plan 的完整入参，本实现采用其 Plan 字段的最小集合：
`{ monthlyLockCents, redeemSchedule: [{ holdingId, amountCents, executeAt }],
targetDate, destAccountId, idempotencyKey }`。
创建后每月从 acc_demand 划入 acc_exercise，赎回安排到账 acc_demand，
到期将 acc_exercise 的余额划至 destAccountId。计划和定时转账步骤保存在
快照 `steps`，包含 tool、params、executeAt、status、authId、authorization
以及可选 planId。待执行步骤使用原始授权级别复检；黄级授权不足以自动升级红级。
步骤授权依据独立于交互 grant 的五分钟窗口，撤销后仍会拦截。
步骤只执行一次，复检失败暂停并记录 notifications；取消计划使剩余步骤失效。
调用方推进模拟时钟后调用 `runDueSteps()`；不使用真实计时器。

卡片限额通过 `set_card_status({ cardId, limitCents, idempotencyKey })` 调整；
解挂接受契约中的 `unlost` 并存储为模型规定的 `active`。
`cardTransaction` 为测试模拟卡消费入口，检查状态、限额、余额与熔断，支持幂等。
`gate.recordInjection()` 记录注入拦截；`gate.revoke(authId)` 撤销执行授权。
风险问卷每题整数 0..4，按均分 <=1、<=2.5、>2.5 映射 R1/R2/R3。

state 仅提供脱离内部引用的 snapshot；一次性内部 capability 由工具工厂领取，
不向消费层提供状态 setter。审计默认追加 data/audit.log.jsonl，启动校验已有链；
测试可传 `createAudit({ filePath: null, clock })` 使用内存日志。

契约没有 §9，本阶段种子数据按 §1 与任务列举的数据项实现。
未实现 calc、HTTP 或前端；未修改 CONTRACT.md。

## 第三阶段：HTTP 与 Agent

启动：`node server/app.js`，访问 http://localhost:4173 。默认模拟日期为
2026-10-27，内存银行状态重启重置，审计继续追加。演示联系人含张三、李四。
种子历史账单为 7—9 月；可说“分析2026-09账单”查看异常，本月无历史流水会如实返回零。

- `GET /api/state`：面板快照、steps、notifications、最近30条流水/审计及审计摘要；不泄露 AuthGrant。
- `POST /api/chat {message}`：返回 `{reply,cards,stateVersion}`。
- `POST /api/authorize {toolCallRef,proof}`：黄级 `{confirmed:true}`，红级
  `{code:"246810"}` 或 `{faceConfirmed:true}`。失败可重试，修改参数/停止后旧引用失效，五分钟过期。
- `POST /api/clock/advance {days}`：0..366 整数天，推进后执行到期步骤及有效订阅扣费。
- `GET /`：静态托管 web，附最小对话与面板页面。

主线：输入“我有10000股期权，行权价12，现价28，分两年呢” → 二维测算 →
“同意” → 红色验证 → 面板显示计划与步骤。计划建议预设为每月锁定与两批货基赎回，
并非根据测算金额自动作出的个性化资金充足保证。也可直接说“每月发薪帮我锁2000，明年3月转专户”。
金额修改示例：“转800给张三” → “改成5000”，必须使用新验证卡。

可选 LLM：同时设置 `QH_LLM_BASE_URL`（如服务的 `/v1` 根地址）、
`QH_LLM_API_KEY`、`QH_LLM_MODEL`。确定性解析器优先，未识别时调用 OpenAI 兼容
chat completions；未配置、超时、异常或无效JSON自动降级。LLM 只返回白名单意图与槽位，
不生成回复，不持有工具执行权限。流水备注等外部数据不会发送给解析器，按不可信数据展示。

测试：`node --test`；受限环境可用 `node --test --test-isolation=none`。
HTTP 测试直接调用真实请求处理器，避免测试环境监听端口限制。
