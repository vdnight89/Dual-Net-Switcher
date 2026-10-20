# 最终衔接审查与结案

只读复查 model、manager、server、启动脚本及 Windows 执行器，结合生产事务函数的假资源测试。以下发现均已修复；未执行真实路由、NRPT、管理员重启或计划任务注册。

| 发现 | 修复与证据 | 状态 |
| --- | --- | --- |
| P1：删除旧 PersistentStore 项时，Windows 隐式删除仍需保留的 ActiveStore 项，阻止持久到动态转换。 | 执行器将保留活动项的重建排到相关持久项删除之后；测试覆盖转换成功、中途失败恢复双存储和转换后 reset。模型同时区分借用 DHCP 默认项与工具拥有的持久默认项，保留后者持久性。 | 已修复 |
| P1：reset 系统成功而 runtime 未落盘时崩溃，下次自启可能重新施加已恢复的旧规则。 | manager 在系统操作前持久写入 maintenanceSuspended 意图，UI 状态、调度和单次维护入口均遵守暂停状态。 | 已修复 |
| P2：管理员重启或停止入口仅凭 server.mjs 名称、PID、端口，可能误认其他项目进程。 | launch-admin 与 session 在停止前使用会话 token 查询 /api/identity，并核对项目完整根目录及 PID；服务端该接口位于 token 认证之后。 | 已修复 |
| P1：计划任务 principal 使用 SID 创建，Windows CIM 对象却返回账户名称，写后校验会失败并回滚。 | 只构造真实 New-ScheduledTaskPrincipal 对象即复现用户名返回值；生产快照函数现将 principal/trigger 账户统一翻译为 SID，真实 CIM 对象加模拟注册读取测试通过。 | 已修复 |
| P2：任务 Settings.Hidden 只隐藏计划任务条目，Node 直接作为动作可能显示控制台。 | 固定系统 powershell.exe 以 -WindowStyle Hidden 运行 maintenance.ps1；包装只接受有效 NodePath，同步运行本项目 --sync-once --no-browser 并返回退出码。保持调度器 IgnoreNew 和进程生命周期一致。 | 已修复，真实任务视觉行为未执行验证 |

Windows 专项测试 **10/10 通过**，包含所有权、借用、重连重建、幂等、故障补偿、崩溃恢复、持久路由副作用、NRPT 有效策略冲突、DNS 缓存失效、双触发器间隔及账户规范化、隐藏维护脚本语法与调用边界。

网卡探测已将每张网卡分别查询改为各 CIM 表一次批量读取后按 interface index 关联；保留物理网卡及当前活动虚拟网卡，输出字段与 fingerprint 计算结构不变。两次真实只读 inspect 用时 **4.11 / 4.86 秒**（此前测量约 8.1 秒），返回 5 张相关网卡、28 条 IPv4 路由、0 条 NRPT，当前进程非管理员、无待恢复事务。没有通过修改当前机器网络来测试实际写入。

未发现额外未处理的衔接阻塞。真实管理员应用、完整计划任务注册与登录触发仍需用户显式执行后验证；此项未用模拟测试替代宣称完成。
