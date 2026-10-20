# 候选 A：单所有者控制器与事务型 Windows 执行器

同模型独立设计候选；继承当前会话模型，未进行多模型调用。依据 WORKLOG 中的只读调研事实设计，不运行参考项目的网络修改脚本。

## Problem

在 Windows 10/11 上用零构建工具，把用户选择的两个网卡、精确域名/IP/CIDR 规则转换为可恢复的系统状态。真正的难点不是生成 route 命令，而是区分自身与系统/用户状态、让应用程序实际使用正确 DNS、以及进程在任意一步终止后的恢复。参考项目的全私网硬编码、按目的地址删除和静默忽略错误均不继承。

## Usage：先定义使用者看到什么

用户双击 `启动.cmd`，一次 UAC 后在浏览器打开本地管理页。取消 UAC 可进入只读预览；应用、恢复和自动同步均不可用。探测只读取系统，不自动写路由。用户选择外网和内网网卡，维护规则，预览变化，再点击应用。随后自动同步复用已授权管理员进程；关闭进程停止同步，但保留已应用配置。点击恢复删除工具拥有的资源并恢复它改过的接口属性。外网默认路由缺失、内网 DNS 无法解析等情况都有逐条错误。

```js
// server.mjs：调用者只见业务操作，不协调 journal 或 PowerShell 步骤。
const manager = await openManager({ dataDir, platform: windows });
const view = await manager.inspect();
const saved = await manager.saveConfig(input, { expectedRevision: view.revision });
const preview = await manager.preview(saved.revision);
const result = await manager.apply({ planId: preview.id });

// 自动同步：与手动应用同一入口，不存在第二套路由写入流程。
const result = await manager.reconcile({ reason: 'timer' });

// 一键恢复：包括崩溃遗留；不需要 UI 自行读取所有权清单。
const recovery = await manager.reset();
```

`apply` 必须重新探测并核对计划依据；网卡、配置或系统路由变化时返回 `STALE_PLAN` 与新预览，绝不盲目执行旧计划。`reconcile` 在用户明确启用自动同步之后使用最新配置，保留失败域名的上一次成功地址。

## Shape：数据和边界

### 模块图

| 文件 | 唯一拥有的知识 | 对外能力 |
| --- | --- | --- |
| `server.mjs` | localhost HTTP、认证、生命周期 | 静态页面和少量 JSON 操作；不接受命令文本 |
| `lib/manager.mjs` | 配置 revision、同步策略、单写队列 | `openManager` 返回上述业务门面 |
| `lib/model.mjs` | 域名/IP/CIDR 归一化、规则冲突、期望资源计算 | 纯函数 `normalizeConfig`、`deriveDesired` |
| `lib/windows.mjs` | PowerShell JSON 协议、进程超时、错误映射 | `inspect`、`resolve`、`transact` |
| `platform/windows.ps1` | Windows 精确资源身份、journal、系统写入与恢复 | 固定 action 枚举；所有变更必须经过事务入口 |
| `public/index.html`、`app.js`、`style.css` | 展示与用户编辑 | 调 manager 的 HTTP 门面；无系统知识 |
| `test/*.test.mjs` | 纯规划、假平台事务故障注入 | Node 内置测试运行器 |

调用链为 HTTP → manager → Windows 边界；纯规则模块只参与计算。PowerShell 是单个有深度的边界，隐藏读取、精确匹配、两种 route store、NRPT、接口属性和恢复细节，避免 Node 与 PowerShell 各维护一份所有权算法。`windows.ps1` 不开放任意命令/脚本/文件路径参数。

### 核心类型草图

```ts
// 描述契约，运行时仍是 Node 原生 ESM + 边界校验，无 TypeScript 构建链。
type Role = 'internal' | 'external';
type NicId = string; // 持久 interface GUID；ifIndex 仅为每次探测所得临时值。
type Rule =
  | { id: string; kind: 'cidr'; prefix: IPv4Prefix; role: Role; enabled: boolean; remark: string }
  | { id: string; kind: 'ip'; address: IPv4; role: Role; enabled: boolean; remark: string }
  | { id: string; kind: 'domain'; host: AsciiHost; role: Role; enabled: boolean; remark: string };
type NicChoice = { guid: NicId; gatewayOverride: IPv4 | null; dnsOverride: IPv4[] | null };
type Config = { revision: number; external: NicChoice; internal: NicChoice;
  rules: Rule[]; syncMinutes: number; autoSync: boolean; startup: boolean };
type RouteKey = { prefix: IPv4Prefix; nicGuid: NicId; nextHop: IPv4;
  store: 'ActiveStore' | 'PersistentStore' };
type RouteResource = { kind: 'route'; key: RouteKey; metric: number };
type NrptResource = { kind: 'nrpt'; namespace: AsciiHost; nameServers: IPv4[];
  ownerComment: string; systemName?: string };
type MetricResource = { kind: 'interfaceMetric'; nicGuid: NicId;
  automatic: boolean; metric: number };
type Resource = RouteResource | NrptResource | MetricResource;
type Change = { before: Resource | null; after: Resource | null; key: string };
type Journal = { schema: 1; installationId: string; transactionId: string;
  state: 'prepared' | 'applying' | 'committed' | 'rollingBack' | 'needsAttention';
  changes: Change[]; verifiedSteps: string[]; previousOwnership: Resource[] };
type Resolution = { host: AsciiHost; role: Role; addresses: IPv4[];
  expiresAt: string; source: 'fresh' | 'lastGood'; error?: string };
type Outcome = { status: 'applied' | 'unchanged' | 'rolledBack' | 'needsAttention';
  resources: Resource[]; errors: { code: string; detail: string }[] };
```

归一化只在配置边界发生（`boundary-discipline`）：URL 提取 host、IDNA、去尾点、小写、严格 IPv4、CIDR 网络位归一化、拒绝通配域名和 URL 用户信息。域名与 IP 类型判别一致，不允许 UI 和核心各推断一次。规则显示原始备注，但系统写入只接受归一化数据。精确相同前缀不同出口为冲突；不同长度按最长前缀工作，预览说明。两个域名解析到同一个 IP 而要求相反出口时，IP 路由无法实现区分，阻止该次应用并定位规则；不假装按 HTTP host 分流。

```js
export async function openManager({ dataDir, platform }) { throw Error('not implemented'); }
// manager 的句柄方法：所有写操作排入同一队列；自动同步不修改用户配置。
async function inspect() { throw Error('not implemented'); }
async function saveConfig(input, { expectedRevision }) { throw Error('not implemented'); }
async function preview(revision) { throw Error('not implemented'); }
async function apply({ planId }) { throw Error('not implemented'); }
async function reconcile({ reason }) { throw Error('not implemented'); }
async function reset() { throw Error('not implemented'); }

// windows.mjs：transport 私有，调用者不传 PowerShell 参数字符串。
async function inspectWindows() { throw Error('not implemented'); }
async function resolveWindows({ host, dnsServers, nicGuid }) { throw Error('not implemented'); }
async function transactWindows({ desired, observedFingerprint }) { throw Error('not implemented'); }
```

### 所有权、持久性与默认出口

Windows 路由没有可靠自定义 owner 字段。所有权不能靠一个特定 metric 猜测，必须以安装 ID、完整资源 tuple 和写前快照组成清单。预先已存在且恰好满足需求的路由作为借用资源，永不取得所有权、永不删除。相同目的前缀存在其他资源时展示，只有确认可以共存才添加；默认不修改第三方静态路由。工具写过的资源若被用户改动，恢复做 compare-and-swap：报告漂移，不覆盖新值。

外网默认路由使用选定接口、网关和明确 metric；接口自动跃点关闭并保存原值，再设置外网低、内网高的接口跃点，使默认外网优先。不删除 DHCP 默认路由。预览检查系统中更低的其他默认路由以及更具体路由；若不能保证目标出口，拒绝“应用成功”，展示冲突，不自动管理未选网卡。系统默认路由表上的多个出口以及 VPN 要作为现实约束显示。

不把每个变化都交给 `route -p`。用 `New-NetRoute` / `Remove-NetRoute` 的完整键和值精确管理，并明确区分 ActiveStore、PersistentStore，探测 Windows 创建持久项对活动项的副作用，避免重复计数。域名派生路由默认只进 ActiveStore，避免重启后陈旧地址继续生效；静态 IP/CIDR 可持久化。DHCP 换网关和 ifIndex 变化通过 GUID 重新绑定并重新计划；失去网卡时保持已有资源记录，暂停新增并报告，不把其他网卡当替代。

配置由 Node 单独写 `config.json`，临时文件 + 同卷替换；事务与所有权由 PowerShell 单独写受管理员 ACL 保护的 `state/`。两者不得互相改写。Node 单实例锁加执行器系统 mutex，使手工应用、启动恢复、定时同步最多一个写者（`single source of truth`）。配置可被 UI 保存，但已应用 revision 单独记录，明确“未应用更改”。

### 事务、回滚与崩溃恢复

1. 执行器取得 mutex，先恢复未完成 journal，再完整探测。对 stale fingerprint 返回错误，不写入。
2. 所有拟修改资源记录 `before/after`；写入 prepared journal 并落盘，再开始执行。添加替代路由优先于清理旧路由；NRPT 在 DNS bootstrap 与业务地址路由就绪后写入。
3. 每步先读实际值：已等于 after 即幂等完成；等于 before 才执行；均不等于表示外部漂移。执行后重新读取验证，然后记录步骤完成。进程死在系统写入与日志标记之间仍可用实际状态辨别。
4. 任意失败按逆序回滚；只在现值仍等于该步骤 after 时恢复 before。回滚失败留下 journal 和 `needsAttention`，不丢弃原快照、不显示“已恢复”。
5. 最后持久提交新的所有权清单，标记 committed。启动时 prepared/applying 一律恢复到上个提交状态；committed 只验证清单。日志与所有权提交的先后必须约定：committed journal 内包含完整新清单，启动可据其补写清单，防止两文件提交窗口。
6. reset 同样是一次事务：只删除拥有且未漂移的资源，恢复原接口属性。重复 reset 无变化。恢复记录保留至所有移除经系统验证完成。

这是补偿事务，不声称 Windows 路由、NRPT 和接口设置具备数据库级原子提交。UI 展示最后一次结果与未完成恢复项。

### 系统 DNS、NRPT 与 bootstrap

仅在后端解析域名是不够的：浏览器等应用还须拿到相同 DNS 答案。对配置中精确域名创建精确 namespace NRPT 规则，NameServers 使用所选出口适配器 DNS 或手动 DNS。永不覆盖现有 NRPT；若已有规则（含企业策略或更宽覆盖规则）可能改变该域名解析语义，预览报告冲突并阻止该域名启用。以工具 comment 加系统生成的规则 Name 记录所有权。IPv4 范围明确，检测 AAAA 结果并提示 IPv6 可能绕过 IPv4 分流，不能声称已实现双栈。

指定 DNS 的查询本身也要走正确网卡。对 off-link DNS 服务器先准备 `/32` bootstrap 路由；on-link DNS 无需网关路由。预览阶段若 DNS 服务器经现有路径不可达，不能为了“预览”偷偷写系统：显示待应用解析；首次应用使用事务内两阶段：写 bootstrap → 查询 → 生成并校验业务路由与 NRPT → 继续提交。后续 DNS 失败整体回滚 bootstrap。此时预览计划允许明确标记待解析部分，用户看到它不能提前知道全部目标 IP。

查询使用指定服务器，返回 A 记录、TTL 和完整 CNAME 解析结果，清晰记录哪些地址来自哪个域名；CNAME 不自动扩展成新的 NRPT namespace。域名变化遵循先加新 `/32`、验证、后删不再被任何规则引用的旧地址；短暂失败保留 last-good 并告警，首次解析失败不应用该配置。以用户 N 分钟为上限轮询并尊重较短 TTL，设置最短间隔避免忙循环。状态记录每个 host 的最后成功时间与失败原因。配置中共享 IP 合并引用计数从规则派生，不手工维护另一套计数。

NRPT 变更后清理 DNS 缓存是可观察副作用，恢复不能还原历史缓存；提前说明一次即可。启用 DNS-over-HTTPS 的应用、代理、VPN 和自带解析器可能忽略系统 DNS，界面提供准确限制，不修改浏览器策略或 hosts。

### HTTP 与自启边界

只监听 127.0.0.1 随机端口；启动 token 放 URL fragment，由页面换取严格同站 HttpOnly 会话，再立即清除 fragment。所有修改接口要求会话、精确 Host 与 Origin、JSON Content-Type；无 CORS，拒绝跨站写入，不将 token 放日志。只暴露配置、探测、预览、应用、恢复、状态，不提供文件系统或任意进程 API。UI 用 textContent 呈现规则，避免高权限页面注入。

自启由用户在 UI 显式选择，创建当前用户登录时最高权限的独立计划任务，仅运行固定入口并启用后台同步；无浏览器弹窗。任务名称含 installationId，保存拥有关系，关闭自启仅移除本工具任务。计划任务首次创建需要当前已提升进程；不开自启时不注册后台服务。自动同步通过事件或短周期网络指纹检查触发，同一调度入口去抖；初版采用几秒一次只读指纹轮询，网络恢复后重试，不绑定一个始终运行的自定义 Windows 服务。

## Synthesis decision

交由主代理比较两个独立候选后填写；本文件不预选综合结果。

## Tradeoffs accepted

- 接受一次启动 UAC 和管理员本地进程，换取无常驻服务、无单独 IPC 的可维护实现；取消提权仍可只读规划。
- 接受域名首次应用预览不完整，换取绝不在预览中偷偷写 bootstrap 路由。
- 接受 DNS 故障时保留旧地址并显式告警，换取暂时解析失败不会立即断掉现有业务。
- 接受明确只保证 IPv4 与系统 DNS 使用者，换取不暗中禁用 IPv6、改浏览器或污染 hosts。
- 接受较完整的 PowerShell 事务实现，换取 Node 业务门面足够小、恢复逻辑只有一个所有者。

## Alternatives considered

- 每个路由动作分别申请 UAC：入口表面简单，却把步骤排序、所有权和回滚暴露给 Node 调用者，且自动同步反复弹窗，因此不选。
- 管理员后台服务 + 命名管道 + 非提升 UI：权限隔离更好，但安装卸载、服务生命周期与 IPC 身份验证显著增加交付成本；适合后续正式安装包，不作为本次零构建原型基础。
- 只为域名解析 IP 加路由、使用 hosts：前者不能保证应用拿到内网答案；后者丢失 TTL 和系统解析语义，还产生文件并发修改问题，均不选。

## Open questions and risks

- 当前机器若已有企业 NRPT/VPN 策略，是否接受将对应域名标记为冲突而不自动覆盖？默认采取该行为，可无需等待用户答复继续实现。
- IPv6、DoH 或代理流量是否属于后续范围？当前界面明确 IPv4 能力，避免交付超出实现保证的承诺。
- Windows 不同版本 PersistentStore 的活动项行为是否一致？实现应使用真实只读探测加假平台故障测试，真实写入仅在用户显式应用时验证并回读。

## Next implementation step

先实现纯配置归一化与期望资源规划、假 Windows 平台和 journal 故障注入测试，再接只读系统探测，最后接受 UI 显式应用。

## Red-flags 自检

没有按“读取/转换/保存”拆成空转模块；manager 隐藏业务操作，Windows 边界隐藏整笔系统事务。只有 PowerShell 写系统与所有权，只有 manager 写配置。HTTP 不重导出 PowerShell 传输类型。不同时保留 route 命令和 NetTCPIP 两条写入路径。共享 IP 引用与差异均由资源集合推导。主要剩余风险是管理员 HTTP 面的攻击面和 Windows 补偿事务的实现难度，应由后续审查集中核对，而不是分散到 UI。
