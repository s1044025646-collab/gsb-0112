# FICT-042 临床试验随机分组与方案偏离后端（全虚构）

仅用于工程演示的 **本地** TypeScript / Node.js / SQLite 后端：提供 API、CLI、虚构试验夹具与自动化测试。

- 不含任何网页界面，不连接任何真实医疗系统，不提供诊疗建议。
- 只保存匿名受试者编号（如 `BJ01-0001-AB12CD34`），不保存姓名、证件号、联系方式等可识别个人资料。
- 所有数据（含试验名 FICT-042、药物代号 ZX-7、中心、人员）均为虚构。

## 前置要求

- Node.js >= 22.5（开发使用 Node 25；依赖内置实验模块 `node:sqlite`，运行时可能出现 ExperimentalWarning，属正常）
- Windows / macOS / Linux 均可，本机运行，默认仅监听 `127.0.0.1`

## 安装

```powershell
npm install
```

## 运行测试

```powershell
npm test
```

测试共 3 个文件、24 个用例，覆盖：

- 资格/同意门控：不合格、撤回后拒绝分配、重复入组拒绝、分层值校验
- 区组随机：同种子可重现、按「试验 × 中心 × 分层」独立序列、区组内均衡、序号永不重复
- 误入组：消耗的随机号不回收，新受试者取下一号
- 盲态：协调员/稽查员看不到臂；仅 `unblinded_admin` 可揭盲并写独立揭盲记录
- 访视窗口：站点本地时区（Asia/Shanghai、Asia/Urumqi）边界判定、提前/迟到偏离
- 方案换版：按事件发生当时生效版本判定；历史偏离行不被新版规则改写
- 事务回滚、六并发分配无重复号、关闭进程重开后数据与哈希审计链完好
- HTTP API：参数校验、错误码、分页、鉴权头、失败路径
- CLI：以独立进程完成 init → seed → 筛选 → 分配 → 揭盲 → 审计，验证跨进程持久化

测试中的时间与随机均为注入式（固定时钟、每试验随机密钥 + 确定性 xorshift 派生），不依赖真实等待。

## 可重复的端到端演示

```powershell
npm run demo
```

该脚本每次删除并重建 `data/demo.db`，输出 9 个编号步骤（筛选失败、撤回拒绝、分层入组、误入组不回收、紧急揭盲、跨版本访视偏离、审计链校验）。重复运行结果一致。

## 启动 API 服务

```powershell
# 端口自动选择（推荐）；启动后首行 JSON 打印实际端口
$env:TRIAL_DB="data/trial.db"
npm start

# 或指定端口
$env:TRIAL_PORT="8787"
npm start
```

服务只绑定 `127.0.0.1`。停止：在该终端按 `Ctrl+C`（会优雅关闭 HTTP 与数据库连接）。

### 角色与鉴权

通过请求头传入（夹具内置三个虚构操作员）：

- `x-operator: fic-coord` + `x-role: coordinator`：筛选、分配（结果遮蔽臂）、访视、报告偏离
- `x-operator: fic-admin` + `x-role: unblinded_admin`：可见臂、误入组、紧急/授权揭盲
- `x-operator: fic-auditor` + `x-role: auditor`：分页审计日志、审计链校验

同一用户名角色固定，换角色返回 403。

### 主要端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/screenings` | 登记筛选+资格结果+同意事件 |
| POST | `/subjects/:id/allocate` | 区组随机分配（非管理员响应中 `arm` 被移除） |
| POST | `/subjects/:id/withdraw` | 撤回知情同意 |
| POST | `/subjects/:id/randomized-in-error` | 误入组（仅管理员；随机号不回收） |
| GET | `/subjects/:id/allocation` | 查询分配（按角色遮蔽/显示臂） |
| POST | `/subjects/:id/unblind` | 授权/紧急揭盲（仅管理员，写独立审计） |
| POST | `/subjects/:id/visits/:code/schedule` | 按当时方案版本安排访视窗口 |
| POST | `/subjects/:id/visits/:code/record` | 记录访视，自动判定偏离 |
| POST | `/subjects/:id/deviations` | 手工报告偏离 |
| GET | `/subjects?limit=&offset=` | 分页受试者 |
| GET | `/deviations?limit=&offset=&trialId=` | 分页偏离 |
| GET | `/audit?limit=&offset=` | 分页审计日志（仅稽查员） |
| GET | `/audit/verify` | 校验 SHA-256 哈希审计链（仅稽查员） |

错误响应统一为 `{"error":{"code":"...","message":"..."}}`，典型代码：`VALIDATION_ERROR`(422)、`FORBIDDEN`(401/403)、`NOT_FOUND`(404)、`SUBJECT_NOT_ALLOCATABLE`/`ALREADY_ALLOCATED`/`VISIT_ALREADY_SCHEDULED`(409)、`INVALID_JSON`(400)。

快速示例（PowerShell，端口以启动输出为准）：

```powershell
$port = 0  # 替换为启动时打印的端口
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

## CLI

```powershell
# 初始化/重复迁移（幂等）
npx tsx src/cli/main.ts init-db

# 安装全虚构夹具（FICT-042：3 中心、2×2 分层、v1.0/v2.0 访视窗口、3 个角色）
npx tsx src/cli/main.ts seed-fixtures

# 登记筛选（打印 before / screening result / after 三段状态）
npx tsx src/cli/main.ts screen --trial FICT-042 --site BJ01 `
  --strata-json '{\"age_band\":\"<65\",\"disease_stage\":\"II\"}' `
  --criteria-json '{\"inclusion_age\":true,\"inclusion_diagnosis\":true,\"exclusion_pregnancy\":true}' `
  --consent-at 2026-01-04T08:00:00Z --operator fic-coord

# 分配（协调员视图不显示 arm）
npx tsx src/cli/main.ts allocate --subject-id <id> --operator fic-coord

# 撤回 / 误入组 / 安排并记录访视 / 手工偏离
npx tsx src/cli/main.ts withdraw --subject-id <id> --operator fic-coord
npx tsx src/cli/main.ts randomized-in-error --subject-id <id> --justification "fictional paperwork error" --operator fic-admin
npx tsx src/cli/main.ts visit-schedule --subject-id <id> --visit V2_WEEK4 --baseline-at 2026-01-05T08:00:00Z --operator fic-coord
npx tsx src/cli/main.ts visit-record --subject-id <id> --visit V2_WEEK4 --occurred-at 2026-01-28T08:00:00Z --operator fic-coord
npx tsx src/cli/main.ts deviation-report --subject-id <id> --kind wrong_drug_administered --detail "fictional event" --event-at 2026-02-01T08:00:00Z --operator fic-coord

# 授权揭盲（打印 arm，并在 unblinding_events 与 audit_log 各留一条）
npx tsx src/cli/main.ts unblind --subject-id <id> --reason emergency --justification "fictional emergency drill" --operator fic-admin

# 导出审计摘要并验证哈希链
npx tsx src/cli/main.ts audit-summary

npx tsx src/cli/main.ts help
```

数据库路径由 `TRIAL_DB` 环境变量控制（默认 `data/trial.db`）。

## 设计要点

- **随机化**：每个试验生成 32 字节随机密钥（不暴露给普通操作员）；分配时按 `密钥|中心|分层签名|区组号|区组大小` 派生确定性洗牌序列，因此结果可重现、可审计，操作员无法从序号预测下一个臂。分配在 `BEGIN IMMEDIATE` 事务内取 `MAX(sequence_index)+1`，并发安全。
- **不回收号码**：误入组只把分配标记为 `consumed_in_error`、受试者标记为 `randomized_in_error`；唯一约束 `(试验,中心,分层,序号)` 保证序号不复用。
- **资格与同意双门控**：分配在同一事务中复核最新资格结果与「同意时间点最新事件是否为 given」；任一不满足即拒绝，且不产生分配行。
- **独立审计链**：所有写操作追加 `audit_log`，每行含前一行哈希与自身 SHA-256；揭盲另有独立 `unblinding_events` 表。`/audit/verify` 与 CLI `audit-summary` 可检测篡改。
- **时间与版本**：访视窗口按中心 IANA 时区把基线日换算为本地日界；偏离以事件时刻生效的方案版本判定，调度时的版本快照存在 `protocol_version_at_schedule`，历史行永不更新（新规则只能通过新版本进入）。
- **迁移可重复执行**：`schema.sql` 全部使用 `IF NOT EXISTS`，并以 `schema_migrations` 记录版本；反复运行 `init-db` 安全。
- **无 PII**：数据库无姓名/证件/联系方式字段；受试者编号为中心码+序号+单向哈希后缀。

## 目录

```
src/db            SQLite 连接、幂等迁移、事务封装
src/domain        可注入 RNG、哈希审计链、错误码
src/services      试验/版本/中心/分层、筛选同意、随机化、访视偏离
src/fixtures      全虚构 FICT-042 夹具
src/api           仅 localhost 的 HTTP API
src/cli           命令行工具
src/server        服务入口（自动端口）
scripts/demo.ts   可重复端到端演示
tests             领域、API、CLI（含进程重启）测试
```

## 停止与清理

- 停止服务：服务终端按 `Ctrl+C`。
- 删除演示/运行数据：删除 `data/` 目录即可（数据库与 WAL 会一并清除）。
