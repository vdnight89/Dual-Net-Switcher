# 候选 B：原生 PowerShell 5.1 + WinForms 桌面应用

## 问题

Windows 已有 PowerShell、WinForms、NetTCPIP 和 DnsClient；当前目录参考工具证明原生界面可行，却缺少精确所有权、错误反馈和回滚。候选 B 把应用做成一个无需安装运行时的原生桌面程序，以 Windows 网络对象作为最终事实来源，以小型持久化事务日志保护每次修改。不会默认导入参考项目里的全私网分流或 129.0/16 规则；这些属于用户策略，不属于产品默认行为。

## 使用方式（先于类型）

用户双击 `启动.cmd`，打开中文 WinForms 窗口。普通权限即可查看真实网卡、维护规则、保存配置和预览差异；“应用规则”会先保存配置，再通过 UAC 启动同一个程序的管理员模式。管理员实例重新探测并重新规划，界面展示该次具体变更后由用户执行。普通实例退出，避免两个界面同时写配置。取消 UAC 保留原窗口和配置。

窗口依次提供出口选择、内外网 DNS 配置、规则表、预览与操作结果。禁用规则仍保留在配置；域名支持精确 Host 和 URL 自动提取，不支持通配符；IPv6 明确显示为不在本版本分流范围，不能承诺 IPv6 流量遵循 IPv4 规则。修改配置不会立刻改网络。自动同步只对最近成功应用的配置运行；未应用的编辑不会被定时器悄悄执行。

调用方只使用一个协调器，界面不接触路由命令：

```powershell
# 页面加载：返回可直接绑定的状态和配置草稿。
$manager = [RouteManager]::new($dataDirectory, $windowsPlatform)
$view = $manager.Inspect()

# 用户预览：解析、冲突检测、差异规划统一在 callee 内完成。
$preview = $manager.Preview($draft)
# UI 展示 preview 的新增、撤销、阻塞原因和 DNS 结果。

# 已获得管理员权限并明确点击应用；协调器重验快照，不信任旧预览。
$result = $manager.Apply($draft)
# 重置只撤销仍能证明由本工具创建、且未被他人修改的资源。
$result = $manager.Reset()
```

后台轮询不经过 UI 按钮处理器，提交 `ReconcileAppliedConfig` 意图给同一个协调器；UI 从结果事件更新显示。用户关闭窗口结束守护，后台任务不会常驻。开机自启是可选计划任务，使用固定任务名称和任务定义指纹登记所有权；创建和删除走同一事务入口。

## 结构与类型草图

```text
启动.cmd                     只选择 Windows PowerShell、STA、入口路径
app.ps1                      WinForms 布局、事件、绑定、UAC 重启
core.psm1                    配置领域、纯规划、事务日志、唯一协调器
windows.psm1                 唯一 Windows 适配：读取、DNS、资源增删与核验
tests/core.Tests.ps1         使用假的 Windows 适配器、故障注入和断言
config.json                  用户草稿，原子替换写入
state/applied.json           最近成功应用的规范化配置与资源所有权
state/transaction.json       当前未完成事务；不存在表示无待恢复事务
```

`core.psm1` 只导出 `New-RouteManager`，领域类不作为自由修改对象交给 UI；UI 得到只读视图和表格输入 DTO。PowerShell 类的封装强度有限，私有实现函数不导出，以测试和模块边界约束补充语言限制。`windows.psm1` 只服务协调器，不允许 UI 自行调用。正常动作跨越不超过三个源码文件。

```powershell
enum RuleKind { Cidr; SingleIp; Domain }
enum ExitRole { Internal; External }
enum ResourceKind { Route; Nrpt; Task }
enum TransactionPhase { Prepared; Applying; Committed; RollingBack; RecoveryRequired }

class NicIdentity {
  [guid] $InterfaceGuid # 配置持久身份；不持久依赖名称或易变化的索引
}
class NicSnapshot {
  [NicIdentity] $Identity
  [int] $InterfaceIndex # 每次执行前由 GUID 重新获取
  [string[]] $Ipv4Addresses
  [string[]] $Gateways
  [string[]] $DnsServers
  [bool] $Up
}
class Rule {
  [string] $Id
  [RuleKind] $Kind
  [string] $CanonicalTarget # 边界验证后：规范 CIDR、IPv4 或小写 IDNA Host
  [ExitRole] $Exit
  [string] $Remark
  [bool] $Enabled
}
class Configuration {
  [NicIdentity] $External
  [NicIdentity] $Internal
  [string] $ExternalGateway
  [string] $InternalGateway
  [string[]] $InternalDns
  [int] $RefreshMinutes
  [Rule[]] $Rules
}
class RouteSpec {
  [string] $DestinationPrefix
  [guid] $InterfaceGuid
  [string] $NextHop
  [int] $RouteMetric
  [string] $PolicyStore # ActiveStore 或 PersistentStore 均被显式建模
}
class OwnedResource {
  [ResourceKind] $Kind
  [string] $ExactIdentity
  [string] $ExpectedFingerprint
  [object] $CanonicalSpec
  [string[]] $RuleIds # 同向相同目标归并，保留来源；删一规则不误撤共享路由
}
class Mutation {
  [string] $Id
  [object] $Before # 精确系统快照，空值表示原本不存在
  [object] $After
}
class Transaction {
  [guid] $Id
  [TransactionPhase] $Phase
  [Mutation[]] $Operations
  [string[]] $VerifiedCompletedIds
}
class RouteManager {
  [object] Inspect() { throw 'not implemented' }
  [object] Preview([object] $draft) { throw 'not implemented' }
  [object] Apply([object] $draft) { throw 'not implemented' }
  [object] Reset() { throw 'not implemented' }
  hidden [object] ReconcileAppliedConfig() { throw 'not implemented' }
  hidden [object] Recover() { throw 'not implemented' }
}
```

签名中的 `object` 仅表示这里省略展开的封闭视图类型；实现时须定义 `ManagerView`、`PreviewResult`、`ApplyResult` 和配置输入类型，不能靠任意键值绕过领域校验。外部 JSON、表格字符串和 PowerShell CIM 对象在边界转换，核心规划不依赖 JSON 字段或 WinForms 控件。纯函数 `BuildPlan(config, nicSnapshot, dnsAnswers, systemResources, ownedResources)` 产出不可修改的计划、阻塞项与说明，内部不会执行系统命令。这样符合 `boundary-discipline` 与 `single-source-of-truth`。

公开接口隐藏 DNS 解析、系统快照、路由共享、事务、核验与恢复，调用方不需要按时间顺序协调多个浅层方法。执行适配器按资源知识归属，避免为“读取、转换、存储”分别增加模块，符合深接口和减少阅读负担的原则。

## 关键不变量与数据路径

1. 网卡使用 GUID 定位，索引在本次快照派生；失联或缺少所需网关使计划阻塞，不静默选择其他网卡。IPv4、CIDR、DNS、网关均先验证为结构化数据；不拼接用户输入进命令字符串。
2. 单个协调器拥有全部系统写入和状态文件。进程级命名互斥体防止重复实例；工作队列串行接受应用、重置、恢复和自动同步，后台定时器只提交合并后的意图。界面线程只读快照，无第二写入者。
3. 用户已有完全匹配路由被标记为“借用”，永不登记为可删除的所有权资源。目标相同但下一跳、接口或存储不同的已有路由需要报告冲突，不能按目标删除。
4. 精确资源身份包括前缀、接口、下一跳、存储；撤销前须再次比对指纹。外部修改过的资源保留并报告，不能“恢复”成工具记忆里的旧状态。
5. 规则同向归并；同一精确 IP 被域名或其他规则要求走不同出口时阻塞整个应用。重叠 CIDR 按最长前缀匹配展示实际含义；禁止自定义 `0.0.0.0/0` 与默认出口争夺。

### 默认出口

不清除系统既有默认路由，不把“恢复自动跃点”当原状态。优先增加属于工具、指向外网出口且有效 Metric 足够低的默认路由；计划基于接口 Metric 与路由 Metric 的和计算竞争关系。若现有更低/相同竞争路由使本方案无法保证唯一胜出，则预览阻塞或显式提出对精确接口 Metric 的修改，并记录修改前值。重置仅在当前值仍等于工具写入值时恢复原值。接口 Metric 修改应作为明确资源类型补入事务模型，不能塞进未记录副作用。

### DNS 与 NRPT

指定 DNS 使用 `Resolve-DnsName -Server` 查询 A 记录，限定超时和失败处理；所有地址归一化、去重，不信任 CNAME 字符串直接生成路由。DNS 服务器自身必须经所选出口可达，必要时把其 `/32` 路由作为依赖资源纳入计划。只读预览不为了解析而改路由：路径尚未建立时，把域名结果标记为待解析，并明确展示 DNS 路径建立后才可完成最终计划。用户应用后先持久化并执行 DNS 路径子阶段，完成查询与冲突检查，再把具体路由/NRPT 步骤写入同一事务并刷新落盘，才执行下一步。解析或规划失败时补偿已建立的 DNS 路径。不得把“预览中 DNS 查询碰巧成功”当作选择正确出口的证据。

仅在应用程序内指定 DNS 不足以让浏览器访问内网域名。因此为精确域名创建可追踪的 NRPT 规则，把系统 DNS 请求送至对应 DNS；不得添加前导点把精确域名意外扩成后缀。现有同名、后缀或组策略 NRPT 的优先级冲突必须检测并阻塞受影响规则，不能覆盖企业策略。NRPT 名称/标记和完整指纹进入所有权日志，删除时精确定位。DNS 缓存清理属于可重试的非持久副作用，不能声称可恢复缓存内容。域名共享 IP 意味着系统路由按 IP 分流，同 IP 其他域名也会受影响，界面须提前说明。DoH、应用私有 DNS 和 IPv6 不受本版 NRPT/IPv4 计划保证。

定时器默认十分钟，同时考虑解析答案 TTL 提前刷新。一次域名解析失败保留其最近成功的已应用 IP 路由并显示过期，不能因瞬时 DNS 故障删除可用路由。新地址先建立并验证，旧地址最后撤销。拔插事件或轮询发现 GUID/地址/网关变化时重新计划；没有可用目标出口便暂停并显示原因。

## 事务、崩溃和恢复

应用前持久化所有已确定步骤及 before/after，并标记是否存在待解析的第二阶段，以同目录临时文件写入、刷新并原子替换。第二阶段必须先扩展日志、刷新落盘，再执行新增步骤；恢复遇到未完成解析阶段默认补偿已完成的前置步骤。每步执行前后重读系统，只有等于预期后态才记完成。所有写命令设 `-ErrorAction Stop`，不吞错误。

进程在“系统修改已完成但日志未更新”之间崩溃时，恢复不能单纯依赖 completed 列表：对每一计划步骤比较当前值与 before/after，等于 after 表示可补记或逆向撤销，等于 before 表示尚未执行，其他状态则标记外部干预，停止该项并报告。持久化日志不确定或损坏时禁止新的系统修改，提供诊断，不猜测归属。

失败默认按相反顺序补偿；补偿失败保留日志并进入 `RecoveryRequired`，窗口始终提供可读明细。重试操作以系统事实重建差异，避免第二次增加重复资源。提交先原子写入 applied 状态，再将事务标为 committed；提交崩溃后依据事务 ID 识别已提交，不回滚成功结果。状态目录限制当前用户和管理员访问，避免普通本地进程替换管理员将读取的事务文件。

## 接受的权衡

- 接受 WinForms 在视觉表现上的限制，换取无安装依赖和原生 Windows 网络操作能力。
- 接受管理员窗口在本次会话维持提权，换取无需另建 HTTP 服务、IPC 协议和令牌管理；明确的用户操作才触发修改。
- 接受 IPv4 与精确域名首版范围，换取可解释、可回滚的结果；界面必须准确呈现范围。
- 接受企业策略冲突时阻塞，换取不破坏已有 DNS 策略和用户路由。
- 接受相较单文件更多的三个源码模块，换取核心可独立测试且系统修改仅有一个入口。

## 考虑过的其他结构

- Python + PySide6：UI 和异步更好组织，但机器目前无 Python，安装和打包链显著增加；依然需要 Windows 适配和提权设计，未隐藏更多网络复杂度。
- 单个巨大 PowerShell 脚本：部署最短，但界面事件可绕过规划直接修改系统，所有权不变量难以集中约束，公共接口实际上变成整个脚本。
- 常驻 Windows 服务 + UI IPC：能独立于窗口守护，但引入服务生命周期、IPC 身份和多用户配置归属；当前单用户工具收益不足。

## 红旗筛查与测试

已避免 UI、定时器双写状态；同一规则只有规范化存储表示；Windows 路由对象不泄漏至 UI；无按阶段分层的转发模块。需在实现时特别防止 PowerShell 动态类型削弱封装，不能把计划对象直接从界面传进执行器。

测试使用假系统适配器，不运行参考项目测试，不修改当前机器路由或注册表。覆盖：IPv4/CIDR/URL/IDNA 边界、GUID 映射变化、有效 Metric 竞争、已有路由借用、共享 IP 冲突、规则禁用、DNS 失败保留、NRPT 冲突、应用两次幂等、逐步执行前后崩溃、补偿失败、提交崩溃和外部修改。另做真实网卡与 NRPT 只读探测；真实增删验证只能在隔离虚拟机或用户显式应用时进行。UI 验证包括缩放、表格编辑、预览、阻塞解释、UAC 取消和长时间 DNS 查询不冻结窗口。

## 尚待综合的风险

如何平衡零安装与现代界面？原生桌面版本可通过布局与排版提升，但视觉上限存在。是否需要脱离窗口常驻？若后续需要，必须把唯一协调器迁入单一守护进程，不能再加一个并行脚本写同份状态。

## 综合决策

留给主代理在阅读两个独立候选后填写。本候选是继承模型下的独立设计，不声称多模型评审。

## 下一实现步骤

先实现纯规范化与 `BuildPlan`，用假系统资源证明所有权、冲突和重复应用行为，再接 Windows 适配及 WinForms。
