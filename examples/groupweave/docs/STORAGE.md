# 应用存储、保留与维护

这里描述 GroupWeave 外部应用自己的 Node SQLite 存储，不是 Workflow-to-Skill 的运行层，也不替代 DSH 的会话、工具或任务生命周期。数据库只保存本应用的群配置、观察到的成员关系、提案、结果与重复保护元数据。真实环境验收、版本与总测试数以 [ACCEPTANCE.md](ACCEPTANCE.md) 为准。

## 单一数据库持有者与版本

文件为 `DATA_DIR/groupweave.sqlite`；没有 `dataDir` 时仅为内存演示。每个文件只能由一个 Store 持有。连接先设置 SQLite `locking_mode=EXCLUSIVE`，取得锁后才迁移、播种和恢复，随后使用 WAL。第二个连接或第二个 Node 进程的 Store 会得到 SQLite BUSY 并停止；构造失败关闭自己的句柄，不能把第一个实例的在途任务标记为未知。关闭连接后新实例才可以成为持有者。这是当前单进程应用的原生数据库约束，不提供多副本、共享网络文件系统或跨数据库一致性承诺。[SQLite 的锁模式与 WAL 规则](https://www.sqlite.org/pragma.html#pragma_locking_mode)

当前普通应用 schema 为 `user_version=4`，`application_id=0x47575031`。此前未标版本的预览库在一个 SQLite 事务中增补列、表和索引，原配置、提案及重复键保留；结构不兼容、其他应用标识和未来版本拒绝打开，不猜测转换。迁移和备份检查固定表与列、JSON 可解析性、索引与对象的身份/作用域/操作者/受众一致性、外键、`integrity_check`。这些是应用自己的数据版本，不是跨 Harness 协议。[SQLite 的应用版本与完整性检查](https://www.sqlite.org/pragma.html#pragma_user_version)

v3 新增 `private_scopes(id,actor_id,version,json)`。`tg-dm:<正用户ID>` 只归对应
`tg-user:<用户ID>`，不插入 `groups` 或 `memberships`，不出现在群列表。私人
任务复用现有任务表和 `group_id` 作用域字段，受众强制 private，权限与投递均
核验本人。现有任务容量、正文保留上限、取消与备份覆盖私人任务。首批配置固定，
不能通过群规则接口编辑。

v4 在现有库新增有界 conversations 表，按群/私聊、本人及受众保存最多12条/24KB
上下文与可信模型 ID；重置/受众变化增加 revision，迟到旧任务不能写回旧历史。
数据库只保存固定 AI 文件的元数据；可领取文件是短期内存对象，重启后不可恢复。

旧库启动时原地事务升级，不丢弃既有群、任务和重复键。恢复兼容旧备份时先复制到
临时库，在临时库上迁移和验证，再导入目标；来源备份保持原样。旧应用不能打开
升级后的 v4 库。不能自动把旧代码与新库混用，也不能为了回滚代码而自动恢复
升级前快照、丢掉升级后的任务与投递记录；先保留当前数据并核对兼容性与外部副作用。

## 真实身份与预览身份

| 入口 | 签名与语义 |
| --- | --- |
| 操作者标识 | `telegramActorId(userId: string \| number): string`，只接受正的规范安全整数，返回 `tg-user:{userId}`。 |
| 群标识 | `telegramGroupId(chatId: string \| number): string`，只接受负的规范安全整数，返回 `tg:{chatId}`。 |
| 保存可信身份 | `upsertTelegramActor(userId, name?): string`，只写已验证的身份和有限长度展示名，返回操作者 ID；不赋予成员或平台权限。 |
| 登记群 | `registerTelegramGroup({chatId,title,userId,name?}): {groupId,actorId,created}`，登记群和默认配置，不自动添加成员。默认仅命令触发、中文、链接整理、去重、不排序、最多 20 条。 |
| 同步观察 | `syncTelegramMember(chatId,userId,role: 'admin' \| 'member' \| undefined,displayName?): void`，只由可信 TG 适配器提交本次真实观察；`undefined` 撤销已缓存关系。 |
| 查询 | `persona`、`role`、`group`、`groups` 同时支持预览和已登记的真实身份；两个命名范围不能互相获得关系。 |
| 群迁移 | `migrateTelegramGroup(oldChatId,newChatId): void`，只供可信 Telegram 迁移事件调用；目标已存在则拒绝，不能合并两群。 |

预览身份是 `admin-a`、`admin-b`、`member`、`platform`，群仅为 `group-a`、`group-b`。平台演示身份没有默认群成员关系。真实身份的 `persona.platformAdmin` 永远为 false；真实平台维护身份由部署 allowlist 独立计算，不能从 SQLite 旧值、客户端字段或 Telegram 群管理角色推导。

SQLite 的 role/verified_at 只保存可信观察，不能代替当次 Telegram 权限验证。真实面板和 TG 动作必须在每次群访问/管理/执行及迟到结果交付前核实 Telegram 当前成员资格；查询失败关闭访问。`memberCount` 是本库登记的成员数，不是 Telegram 实际群人数。

迁移会一次修改群 ID、成员关系、提案和任务的列与 JSON、投递与审计归属，不留下可读的旧群别名。在途任务固化为新群范围的 blocked/结果未知。`finishTask(task): boolean` 只允许仍在 pending、身份/群/受众相符的记录终结；旧群任务对象迟到时返回 false，调用方必须清空输出并如实拒绝交付，不能覆写新群记录、重跑或发送。

## 有界正文与重复保护

`new Store(dataDir?, {retention?: Partial<RetentionLimits>})` 接受可信启动配置，HTTP 请求不能修改保留策略。默认上限：

| 保存内容 | 默认 | 满额行为 |
| --- | --- | --- |
| 每群已完成任务正文 | 100 | 按提交行的新旧清理更早正文；在途 reservation 不清理。 |
| 每群提案正文 | 50 | 删除更早提案；已删除提案不能再启用。 |
| 审计记录总数 | 1,000 | 删除更早事件元数据。 |
| 有键任务/重复保护记录 | 10,000 | 拒绝新的有键任务；不删旧键腾出执行机会。 |
| 投递重复保护记录 | 10,000 | 不再取得新的投递 claim；不能重新发送。 |
| SQLite 主库页数 | 32,768 | 使用原生 `max_page_count` 限制增长；默认 4KiB 页约为 128MiB。 |
| 本应用备份 | 最多 5 份、共 256MiB | 拒绝新增，不覆盖或自动删除已有文件。 |

`prune(): {taskBodiesRemoved, proposalsRemoved, auditRemoved}` 只做普通数据维护。无重复键的过期完成任务删除；有键任务删除输入/输出/草稿正文，保留 ID、群、操作者、受众、键与请求摘要，并标记 expired。`reservation(...).expired === true` 后，API 返回 410，不执行、不返回虚构旧结果。`tasks()` 不列出已过期正文。重启仍保留 tombstone，不能因清理或 TG update 重放重新执行业务。

主库页上限是 SQLite 的增长限制，不能当成磁盘、WAL、备份或进程内存的总体额度；已比配置大的旧库不能靠设置更小页数自动缩小。SQLite FULL、重复保护容量不足都必须在调用真实执行端前关闭请求。没有后台队列或自动扩容/删除恢复路径。正文清理不承诺抹除旧 WAL、文件系统快照或已保存备份中的历史内容；运维需要把这些文件当作含群私有数据的材料处理。[SQLite 页上限与删除规则](https://www.sqlite.org/pragma.html#pragma_max_page_count)

## 审计与投递

`audit({actorId,groupId?,action,targetId?,outcome})` 只接受固定事件名/结果与标识，不接受原始规则、任务输入/输出、异常、密钥或 token。任务正文可以按上述策略保存；审计表不复制它们。

`auditRecords({actorId,groupId?,platformAdmin?})` 的授权规则独立：有 groupId 时必须是该群管理员，platformAdmin 不能越过此检查；没有 groupId 时要求可信平台权限，且只返回 `group_id IS NULL` 的全局维护事件。普通成员不能读群审计，平台默认不能读群审计。这里的 platformAdmin 仅由服务端可信部署/会话验证传入，不能公开给客户端选择。

`claimTelegramDelivery(taskId,groupId,actorId): boolean` 在一个事务中检查真实任务属于本群、本操作者、group 受众、正文未过期，并且没有先前 claim。成功任务可以领取结果投递；固定 link-cleaner 的 failed 任务只有 `modelCalls=0`、output 为空时可以领取一次固定安全反馈，由 TG 适配器使用本地固定文字，不能发送 task.error、部分输出或原始异常。blocked、撤权、迁移未知、带输出或模型/Agent 失败都不能走此反馈路径。只有首次返回 true，才可在再次确认真实 TG 权限后发送。任何已有 claimed/sent/unknown/withheld 都返回 false。

`recordTelegramDelivery(taskId,groupId,actorId,status: 'sent' | 'unknown' | 'withheld'): void` 只写投递元数据。已有 claim 可以终结；终态不能重开。同一终态可重复记录。未发送就撤权时可基于实际任务归属记录 withheld，不授予读取或执行权限。进程恢复把 claimed 变为 unknown，停止自动投递。发送后连接断开可能已经送达；unknown 不能当作“未发送”重试。此约束保障拒绝重复尝试，不宣称外部 Telegram 与本地 SQLite 有原子提交或 exactly-once 交付。

## 能力事实

`setPluginAvailability(id, available)` 只供可信启动绑定报告真实能力，更新 available 和固定描述，不修改 enabled。HTTP 平台开关只能改 enabled。每次启动必须根据真实 DSH/模型绑定重新设置 availability，不能让数据库上次保存的 true 授予这次不存在的能力。默认 digest 关闭且不可用；平台启用能力也不自动把它加入任何群配置。

## 原生备份与停机恢复

`backupTo(destination): Promise<{path,pages,schemaVersion,integrity:'ok',sha256}>` 使用 Node 自带的 `sqlite.backup`，不是简单复制活动中的主库文件。仅允许自身 `DATA_DIR/backups` 下的可信路径，使用独占创建先保留目标，拒绝覆盖；目录 0700、新文件 0600。备份前检查数量与预计总大小，之后再检查实际大小。失败不保留此次文件，既有备份不删除。返回前只读验证 schema/身份/完整性并计算 SHA-256。平台 HTTP 入口自己生成随机文件名，只返回版本、完整性和摘要，不能接受路径或下载整个库。[Node v26.5.0 原生备份 API](https://nodejs.org/download/release/v26.5.0/docs/api/sqlite.html#sqlitebackupsourceDb-path-options)

`waitForMaintenance(): Promise<void>` 等待当前原生备份完成或失败，仅供关闭时 drain；原请求负责报告错误。之后才 `close()`。`close()` 不会在仍进行备份时强行释放它所使用的数据库。

`Store.restoreBackup(sourcePath,dataDir): Promise<同一报告>` 是停机维护接口，没有 HTTP 恢复路由。来源必须是可信、兼容、已验证的 GroupWeave 备份。先只读验证并建立临时快照，再取得目标 Store 的原生独占锁；已有活动实例会 BUSY 拒绝，不执行它的 recovery，也不能修改在途记录。使用 SQLite ATTACH 和同一持有锁的连接内事务替换已知应用表数据，避免文件 rename 绕开原数据库 inode 的锁。完成后 pending/claimed 按未知状态恢复，校验并 checkpoint，关闭目标和清理临时文件；无自动模型、任务或投递重放。

备份是某个时点的应用状态。**备份之后发生的 TG update 重复键、任务和投递记录不在这个快照里**。恢复旧备份无法凭空恢复它们。CLI 的确认选项只明确运维者理解此限制，不是对外部重复或投递状态的证明。

固定运维入口只支持以下两条命令，不是通用 shell/CLI 执行器：

```sh
npm run maintenance -- backup --data-dir /trusted/groupweave-data --output-name manual-snapshot.sqlite
npm run maintenance -- restore --source /trusted/groupweave-data/backups/manual-snapshot.sqlite --data-dir /trusted/groupweave-data --acknowledge-point-in-time
```

output-name 只允许安全的 `.sqlite` 文件名；不能传路径、未知选项、重复选项。backup 不会创建空库冒充已有数据库。CLI 输出只含成功标志、完整性、版本、页数和摘要，失败用固定安全消息，不打印数据库内容、路径或原始异常。

恢复步骤：

1. 停止面板提交、TG 接收和发送，并确认旧应用进程已退出。阻断 Telegram 更新进入待恢复实例；保留恢复时点与快照后的事件/投递证据。
2. 在旧实例关闭后，通过固定 backup 入口保留当前数据库的可核验快照。容量满先由明确的运维维护处理，不能让应用自动删掉重复保护或备份。
3. 确认可信 source、schema、摘要和目标 DATA_DIR，明确哪些更新/发送发生在 source 时点之后。无法核对时保持隔离，不能只因 SQLite 恢复成功就恢复 TG 消费。
4. 在停机状态运行带 point-in-time 声明的 restore。活动锁、校验或容量拒绝时停止，不删除锁、不强改文件、不自动重试业务。
5. 在 TG 输入输出仍隔离时检查配置、成员、过期键和 unknown 投递，并核实真实 TG 当前权限。再通过受控运维决定后续 update 边界与人工核对方案；当前程序不实现或证明这一外部恢复边界。
6. 只有核对完成并明确授权后才恢复服务。先前 unknown 任务/投递仍不自动执行；不要把启动成功或摘要一致当成业务已交付。

备份路径、目录与来源都属于可信服务器运维范围。同一 OS 用户、文件系统管理员和明文备份访问者具有更高的操作能力；这份实现不把本地文件权限当作面向不可信插件或公网上租户的安全沙箱。

## 当前本地证据

只使用新建临时库、合成 TG 数字标识和模拟观察，没有访问用户真实数据或执行真实 TG 恢复。存储测试覆盖：

- 当前单进程和独立 Node 进程都拒绝第二持有者；失败构造释放句柄且不污染首实例 pending。
- 旧 preview 库原子迁移、未来/不兼容版本拒绝；preview/live 范围、平台/群权限分离和撤销持久化。
- 正文清理后的摘要 tombstone、pending 保留、键满额拒绝、提案与审计上限及审计受众。
- 群迁移的所有归属变更、拒绝合并、旧对象迟到 finish 拒绝；投递 claim 与未知/已发终态不可重开；固定失败反馈只领取一次，blocked/部分输出/模型或 Agent 失败拒绝。
- 原生 WAL 备份、校验/文件权限/禁止覆盖、备份配额/drain、原生页数满额不落半行。
- 临时库的离线恢复、活动目标持有者拒绝且 pending 不变、损坏/未来/索引与对象归属不一致的备份拒绝、固定维护 CLI 参数与安全输出。

复现存储范围的测试命令：

```sh
node --import tsx --test tests/store.test.ts tests/store-storage.test.ts tests/store-maintenance.test.ts
```

这些测试不证明真实 Telegram 当前角色核验、生产数据备份保密、磁盘耗尽/断电恢复、快照后的 update 边界、真实公网登录或远端部署。必须按真实环境验收分别记录，不能由本地测试推导 PASS。
