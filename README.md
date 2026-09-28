# CTRS — 临床试验随机分组与方案偏离后端（虚构数据）

本仓库是一个**纯本地、仅用于演示与测试**的临床试验后端：TypeScript + Node.js + SQLite。
只提供 REST API、CLI、虚构数据夹具与自动化测试。**不包含网页、不连接任何真实医疗系统、
不提供任何诊疗建议，也不保存可识别个人资料**（仅匿名编号）。

## 功能

- 试验、方案版本（含生效时间）、中心（含 IANA 时区）、盲态角色用户管理
- 受试者匿名编号登记、筛选、知情同意事件
- 按中心 + 分层因子的**可重现区组随机**（HMAC(seed, site|stratum|block) 驱动 Fisher-Yates；
  有种子可复现，普通操作员无法预测）
- 资格或同意未满足时拒绝分配（`ELIGIBILITY_NOT_MET` / `CONSENT_MISSING`）
- 已消耗随机号**永不回收**；撤回后须以新匿名编号重新入组
- 访视窗口按**访视发生时刻生效的方案版本**判定，历史判定不被新版规则改写
- 撤回 / 误入组 / 紧急揭盲各自独立的哈希链审计（`withdrawal` / `misrandomization` / `unblinding`）
- 揭盲与分组查看仅限 `unblinded` / `admin` 角色（`FORBIDDEN_BLINDED_ROLE`）
- API：zod 参数校验、明确错误码、`limit`/`offset` 分页
- 时间与随机性可注入（`Ctx`），测试不依赖真实等待；写操作在事务边界内

## 环境要求

- Node.js >= 22（使用内置 `node:sqlite`，无原生依赖）
- Windows / macOS / Linux 均可

## 安装与测试

```bash
npm install
npm test            # node:test 全量测试（随机化、盲态、偏离、事务回滚、重启恢复、API）
npx tsc --noEmit    # 类型检查
```

## 端到端演示（可重复）

```bash
npm run demo    # 删除并重建 demo.db，跑完整虚构流程并打印审计链与随机池
```

夹具覆盖：分层不平衡、重复入组（被拒绝）、撤回后重新入组、紧急揭盲、
访视窗口边界、方案换版（v1.0 -> v2.0）。

## 启动 / 停止 API

```bash
npm start                            # 默认 ctrs.db，自动选择本机空闲端口（127.0.0.1）
$env:CTRS_PORT=8080; npm start       # 指定端口（PowerShell）
$env:CTRS_DB="my.db"; npm start      # 指定数据库文件
```

停止：`Ctrl+C`（SIGINT/SIGTERM 会优雅关闭并落盘）。迁移在启动时自动执行且可重复执行。

### API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/trials` | 建试验 `{code,title,arms,blockSize,actor}` |
| POST | `/trials/:id/protocol-versions` | 新增方案版本 `{version,effectiveFrom,visitWindows,actor}` |
| POST | `/trials/:id/sites` | 新增中心 `{code,name,timezone,actor}` |
| POST | `/users` | 新增用户 `{name,role: operator/blinded/unblinded/admin}` |
| POST | `/subjects` | 登记筛选 `{trialId,siteId,anonCode,stratum,actor}` |
| GET | `/subjects?limit&offset` | 分页列表（blinded/operator 角色不返回 arm） |
| POST | `/subjects/:id/screening` | 记录筛选 `{criteria,eligible,actor}` |
| POST | `/subjects/:id/consent` | 记录同意 `{consentVersion,signedAt?,actor}` |
| POST | `/subjects/:id/assign` | 随机分配 `{actor}` |
| POST | `/subjects/:id/withdraw` | 撤回 `{reason,actor}` |
| POST | `/subjects/:id/misrandomization` | 误入组报告 |
| GET | `/subjects/:id/arm` | 查看分组（需 `x-actor` 为 unblinded/admin） |
| POST | `/subjects/:id/visits` | 记录访视 `{visitName,occurredAt,actor}` |
| POST | `/subjects/:id/deviations` | 报告偏离 `{type,description,actor}` |
| POST | `/subjects/:id/unblind` | 揭盲 `{reason,emergency,actor}` |
| GET | `/visits` `/deviations` `/audit?chain=` | 分页查询 |
| GET | `/audit/summary` | 审计链完整性 + 计数摘要 |

错误响应统一为 `{ "error": { "code", "message" } }`，错误码见 `src/errors.ts`。

## CLI

```bash
npm run cli -- <command> [options]
# 例：
npm run cli -- trial create --code C1 --title "Demo" --arms "A,B" --block-size 4
npm run cli -- protocol add --trial 1 --version v1 --effective-from 2026-01-01T00:00:00Z --windows "[{\"name\":\"V1\",\"target_day\":7,\"minus_days\":2,\"plus_days\":2}]"
npm run cli -- site add --trial 1 --code S1 --name "Site One" --tz Asia/Shanghai
npm run cli -- user add --name dana --role unblinded
npm run cli -- subject register --trial 1 --site 1 --anon ANON-001 --stratum "{\"age\":\"lt65\"}"
npm run cli -- subject screen --id 1 --eligible true
npm run cli -- subject consent --id 1 --version ICF-1
npm run cli -- subject assign --id 1          # 展示分配前后状态
npm run cli -- visit record --id 1 --name V1 --at 2026-01-12T01:00:00Z
npm run cli -- deviation report --id 1 --type OTHER --desc "fictional"
npm run cli -- unblind --id 1 --reason "fictional SAE" --actor dana --emergency true
npm run cli -- audit summary                  # 导出审计摘要
npm run cli -- status
```

数据库文件由 `CTRS_DB` 环境变量指定（默认 `ctrs.db`）。

## 设计要点

- **随机化**：`src/services/randomize.ts`。每个（中心, 分层）独立序列；区组内臂序由
  `HMAC-SHA256(trial_seed, site|stratum|blockNo)` 决定。种子仅存库、不经 API 暴露。
- **不可回收**：`random_sequences.status` 一旦 `consumed` 永不回退；撤回仅改受试者状态。
- **版本化判定**：访视窗口以 `occurred_at` 时刻生效的方案版本计算（按中心本地日历日），
  判定结果（`in_window`、`protocol_version`）写入即不可变。
- **审计链**：每条链 `prev_hash -> hash`（SHA-256）链接，`verifyChain` 可校验完整性。
- **事务**：分配、撤回等多步写入包在 `BEGIN IMMEDIATE ... COMMIT` 中，失败整体回滚。
- **时间注入**：`Ctx.now` / `Ctx.randomBytes` 可替换，测试使用固定时钟。

## 目录结构

```
src/            服务与 API 源码
src/services/   领域服务（trial / subject / randomize / visit / unblind）
fixtures/       虚构数据夹具
scripts/demo.ts 端到端演示
test/           node:test 测试
```
