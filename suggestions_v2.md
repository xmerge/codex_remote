# TODO: codex_remote 稳定性修复清单

> 目标：先修最容易误导用户和最容易出现状态错乱的问题，再补最小测试集，确保后续重构不回归。  
> 要求：每完成一项，都输出：
> - 改动文件
> - 改动函数
> - 关键实现说明
> - 风险点
> - 对应测试
> - 验收结果

---

## 0. 先做代码阅读和定位

- [ ] 通读以下文件，整理核心状态流和调用链
  - [ ] `server.js`
  - [ ] `public/app.js`
  - [ ] `README.md`
  - [ ] 测试目录（如果已有）
- [ ] 输出一份简短说明：
  - [ ] 真实 bridge 启动流程
  - [ ] mock bridge 启动流程
  - [ ] `/api/health` 的状态来源
  - [ ] thread 打开 / 刷新 / SSE 恢复 / send / reconcile 的调用链
- [ ] 不要先大改；先定位以下函数和状态变量
  - [ ] bridge 初始化与 fallback 逻辑
  - [ ] pick-directory 逻辑
  - [ ] `openThread(...)`
  - [ ] `refreshThreadFromServer(...)`
  - [ ] `recoverClientState(...)`
  - [ ] `reconcilePendingSend(...)`
  - [ ] `upsertTurnInState(...)`
  - [ ] `mergeTurnItems(...)`
  - [ ] `state.pendingSend`
  - [ ] 各种 timeout / seq / banner / currentThread 更新点

---

# P0：必须先修

## 1. 禁止真实模式启动失败后默认静默 fallback 到 mock

### 目标
真实模式下，如果 `codex app-server` 启动失败，默认不要自动进入 mock。  
只有显式开启 `ALLOW_MOCK_FALLBACK=1` 时，才允许 fallback。

### 要改什么
- [ ] 找到 `server.js` 中真实 bridge 启动失败后的 fallback 分支
- [ ] 移除“默认自动 fallback 到 mock”的行为
- [ ] 新增环境变量：
  - [ ] `ALLOW_MOCK_FALLBACK=1`
- [ ] 只有该变量为 `1` 时才允许 fallback
- [ ] fallback 后 health 状态必须明确标记为 degraded，而不是普通 ready
- [ ] 前端必须显示明显常驻警告，提示当前不是 Codex 真连接

### 实现要求
- [ ] 默认真实模式失败时：
  - [ ] `mode` 保持为真实模式语义，不要伪装成可用 mock
  - [ ] `status` 设为 `error` 或 `degraded`
  - [ ] `initialized = false`
  - [ ] `lastError` 包含真实启动失败原因
- [ ] 显式 fallback 时：
  - [ ] `mode = "mock-fallback"`
  - [ ] `status = "degraded"`
  - [ ] `fallbackReason` 必填
- [ ] 前端根据 health 明确显示警告 banner
- [ ] 不允许 fallback 状态被普通刷新静默隐藏

### 需要改的地方
- [ ] `server.js`：bridge 初始化、health 组装、启动失败处理
- [ ] `public/app.js`：health 拉取后 banner 显示逻辑

### 验收
- [ ] 在本机没有 `codex` 命令时运行真实模式
  - [ ] 默认启动不进入 mock
  - [ ] `/api/health` 显示 error/degraded
  - [ ] 前端明确报错
- [ ] 设置 `ALLOW_MOCK_FALLBACK=1` 后再启动
  - [ ] 才允许进入 mock-fallback
  - [ ] `/api/health` 明确显示 `mock-fallback + degraded`
  - [ ] 前端显示常驻警告

### 测试
- [ ] 增加测试：真实模式启动失败时默认不 fallback
- [ ] 增加测试：`ALLOW_MOCK_FALLBACK=1` 时允许 fallback
- [ ] 增加测试：health 字段和值符合预期

---

## 2. 修复 Linux 下目录选择对 `zenity` 的硬依赖

### 目标
在没有 `zenity` 的 Linux 环境里，目录选择功能不能直接爆 raw error。  
要优雅降级成结构化错误，并引导用户手动输入目录。

### 要改什么
- [ ] 找到 `server.js` 中 `/api/system/pick-directory` 或相关目录选择逻辑
- [ ] 在 Linux 分支执行 `zenity` 之前先做可执行探测
- [ ] 可选支持 `kdialog`
- [ ] 如果系统不支持 picker，返回结构化错误而不是原始 `ENOENT`
- [ ] 前端收到这个错误后，提示用户手动输入目录

### 实现要求
- [ ] 新增可执行探测函数，例如：
  - [ ] `hasCommand("zenity")`
  - [ ] `hasCommand("kdialog")`
- [ ] Linux 上优先尝试：
  - [ ] `zenity`
  - [ ] 否则 `kdialog`
  - [ ] 否则返回结构化错误
- [ ] 结构化错误格式建议：
  - [ ] `code: "DIRECTORY_PICKER_UNAVAILABLE"`
  - [ ] `message: "Directory picker is unavailable on this host"`
- [ ] 用户取消和能力缺失必须区分：
  - [ ] 取消：正常返回 `{ cancelled: true }`
  - [ ] 缺失：返回结构化错误
- [ ] 前端收到 `DIRECTORY_PICKER_UNAVAILABLE` 时：
  - [ ] 显示可理解提示
  - [ ] 聚焦或提示使用手动输入 cwd

### 需要改的地方
- [ ] `server.js`：pick-directory 实现
- [ ] `public/app.js`：目录选择错误处理和 UI 提示

### 验收
- [ ] 有 `zenity` 的 Linux：目录选择正常
- [ ] 没有 `zenity` 的 Linux：
  - [ ] 不再出现 `spawn zenity ENOENT`
  - [ ] 前端提示“当前环境不支持目录选择，请手动输入路径”
- [ ] macOS / Windows 原有逻辑不回归

### 测试
- [ ] mock 掉 `zenity` 缺失，断言返回结构化错误
- [ ] mock 用户取消，断言返回 cancelled
- [ ] 测试前端对该错误码的提示逻辑

---

# P1：高优先级状态修复

## 3. 给 `openThread` / `refreshThreadFromServer` 加过期响应保护

### 目标
快速切换线程时，只允许最后一次用户操作生效。  
旧请求返回时不能覆盖当前线程状态、banner、滚动和细节面板。

### 要改什么
- [ ] 找到 `public/app.js` 中：
  - [ ] `openThread(...)`
  - [ ] `refreshThreadFromServer(...)`
  - [ ] 所有会更新 `state.currentThread`、banner、scroll 的地方
- [ ] 给线程打开和线程刷新加 request sequence / token guard
- [ ] 所有副作用在提交前都检查“当前线程是否仍匹配”

### 实现要求
- [ ] 新增线程打开序号，例如：
  - [ ] `state.openThreadRequestSeq`
- [ ] 每次 `openThread(threadId)`：
  - [ ] `seq++`
  - [ ] 保存本次 `seq`
  - [ ] 发起异步刷新
- [ ] 异步返回后必须检查：
  - [ ] 当前 `seq` 是否仍是最新
  - [ ] `state.activeThreadId === threadId`
- [ ] 不满足则丢弃结果，不做任何 UI 副作用
- [ ] 以下操作都必须加 guard：
  - [ ] `state.currentThread = ...`
  - [ ] banner 更新
  - [ ] scroll 到底部
  - [ ] thread details/diff 渲染
  - [ ] 输入框相关状态联动

### 需要改的地方
- [ ] `public/app.js`：线程切换和刷新相关逻辑

### 验收
- [ ] 快速连续点击 A/B/C 三个线程
  - [ ] 最终只显示 C
  - [ ] banner、详情、滚动、输入状态一致
- [ ] 模拟 A 请求比 B/C 更晚返回
  - [ ] A 不会覆盖 C

### 测试
- [ ] 增加测试：多线程切换乱序返回时，只保留最后一次结果

---

## 4. 给 `recoverClientState(...)` 增加 generation guard，避免与用户操作互抢状态

### 目标
SSE 重连恢复时，不能把用户新点击的线程、新发的消息、当前 UI 状态拉回旧值。

### 要改什么
- [ ] 找到 `recoverClientState(...)`
- [ ] 给恢复流程增加 generation / epoch 标识
- [ ] 恢复过程拆成“全局恢复”和“当前线程恢复”两个阶段
- [ ] 恢复过程中如果用户触发新操作，旧恢复流程应失效

### 实现要求
- [ ] 新增：
  - [ ] `state.recoveryGeneration`
- [ ] 每次恢复开始：
  - [ ] `generation++`
  - [ ] 保存本次 generation
- [ ] 每个异步阶段结束后检查 generation 是否仍有效
- [ ] 建议拆分为：
  - [ ] 阶段 1：恢复 `health / threads / approvals`
  - [ ] 阶段 2：恢复当前线程内容 + 对账 pending send
- [ ] 如果恢复期间 `activeThreadId` 变化：
  - [ ] 阶段 2 中止或重启
- [ ] 如果用户发送消息或主动切线程：
  - [ ] 让旧 recovery 失效

### 需要改的地方
- [ ] `public/app.js`：reconnect / recover 流程

### 验收
- [ ] 模拟 SSE 断线后恢复：
  - [ ] 全局资源能恢复
  - [ ] 当前线程能恢复
- [ ] 在恢复期间切线程：
  - [ ] 最终状态以用户最后点击为准
- [ ] 在恢复期间发送消息：
  - [ ] 不会被旧恢复覆盖

### 测试
- [ ] 增加测试：reconnect + 切线程时，恢复不覆盖用户最新选择
- [ ] 增加测试：reconnect + send 时，恢复不清掉新 pending

---

## 5. 把 `state.pendingSend` 从全局单例改为按线程管理

### 目标
一个线程发送中，不应该锁死整个应用。  
pending send、超时回滚、reconcile 都应只影响对应线程。

### 要改什么
- [ ] 找到 `state.pendingSend` 及相关 helper
- [ ] 改成 `pendingSendByThreadId`
- [ ] 把单个 timeout 改成按线程管理
- [ ] 所有依赖 pending 的逻辑只处理对应 threadId

### 实现要求
- [ ] 状态结构改为：
  - [ ] `state.pendingSendByThreadId = new Map()`
  - [ ] `state.pendingSendTimeoutsByThreadId = new Map()`
- [ ] 重写 helper：
  - [ ] `getPendingSendForThread(threadId)`
  - [ ] `getPendingSend()` -> 只取当前线程
  - [ ] `setPendingSend(...)` -> 按 threadId 写入
  - [ ] `clearPendingSend(threadId)` -> 只清对应线程
- [ ] 所有 timeout 逻辑也按 threadId 存储和清理
- [ ] `reconcilePendingSend(snapshot)`：
  - [ ] 不再假设全局只有一个 pending
  - [ ] 只对 `snapshot.threadId` 生效

### 需要改的地方
- [ ] `public/app.js`：所有 pendingSend / fallbackTimeout 相关逻辑

### 验收
- [ ] 线程 A 正在发送时，线程 B 仍能切换和发送
- [ ] A 的 timeout 或失败不会影响 B
- [ ] reconnect 后各线程的 pending 状态不会串台

### 测试
- [ ] 增加测试：A 线程 pending 时，B 线程仍可发送
- [ ] 增加测试：A 的 timeout 不影响 B
- [ ] 增加测试：按线程 reconcile 生效

---

## 6. 收敛 optimistic turn / item 与服务端 turn / item 的合并规则

### 目标
彻底理清 temp turn / temp user message / real turn / SSE patch / thread full snapshot 的关系，避免重复、残留和互相覆盖。

### 要改什么
- [ ] 找到所有和合并相关的函数：
  - [ ] `findOptimisticUserMessage(...)`
  - [ ] `mergeTurnItems(...)`
  - [ ] `upsertTurnInState(...)`
  - [ ] `findTurnForUpdate(...)`
  - [ ] `reconcilePendingSend(...)`
  - [ ] `cleanupOptimisticTurn(...)`
  - [ ] `cleanupOptimisticMessage(...)`
- [ ] 把散落在多个函数里的替换规则收敛到少数核心函数
- [ ] 明确 authoritative snapshot 和 patch 的优先级

### 实现要求
- [ ] 明确规则并落到代码中：
  - [ ] `thread/read` 的返回 = authoritative snapshot
  - [ ] SSE = 增量 patch，不负责重建完整结构
  - [ ] optimistic 只允许存在于本地临时占位层
- [ ] 明确 temp -> real 的迁移规则：
  - [ ] temp turn 被 real turn 替换时，只保留 real
  - [ ] temp user message 被 real item 替换时，只保留 real
  - [ ] 替换完成后清理所有 temp id 引用
- [ ] 避免浅合并把旧字段留在真实对象上
- [ ] 尽量把规则收敛到 2~3 个核心函数
- [ ] 写清楚哪些字段允许 patch，哪些字段必须以 snapshot 覆盖为准

### 建议做法
- [ ] 先定义数据层级和 merge policy 注释
  - [ ] thread 级
  - [ ] turn 级
  - [ ] item 级
- [ ] 再逐个替换原来 scattered merge 的调用点
- [ ] 保持行为可读，避免继续增加“特殊 case 补丁”

### 需要改的地方
- [ ] `public/app.js`：turn/item 状态合并和 optimistic 清理逻辑

### 验收
- [ ] 发送消息后本地先出现 temp 占位
- [ ] 服务端真实 turn 到来后：
  - [ ] temp 被完整替换
  - [ ] 不重复
  - [ ] 不残留 temp 项
- [ ] SSE 中断后用 `thread/read` 恢复：
  - [ ] 不会重复插入 userMessage
  - [ ] 不会把较新的真实状态覆盖回旧状态
- [ ] refresh / reconnect 后 thread 数据干净一致

### 测试
- [ ] 增加测试：optimistic temp turn 被 real turn 正确替换
- [ ] 增加测试：temp message 被 real item 正确替换
- [ ] 增加测试：thread/read + SSE patch 不产生重复项

---

# P2：整理和收尾

## 7. 标准化 health 状态枚举

### 目标
health 状态不要再靠前后端各自猜。  
统一成固定状态枚举，前端展示逻辑基于统一状态机。

### 要改什么
- [ ] 统一 health status 枚举
- [ ] 前端 banner 逻辑只根据统一状态和字段判断
- [ ] mock fallback 必须与真实 ready 明确区分

### 建议枚举
- [ ] `starting`
- [ ] `spawned`
- [ ] `ready`
- [ ] `degraded`
- [ ] `error`
- [ ] `stopped`

### 实现要求
- [ ] 真实 bridge 初始化成功才允许 `ready`
- [ ] mock fallback 一律 `degraded`
- [ ] 启动失败一律 `error`
- [ ] 前端不要再用散乱 if/else 猜状态含义

### 验收
- [ ] `/api/health` 每种状态都有明确语义
- [ ] 前端 banner 与状态一一对应
- [ ] mock 与 real 一眼区分

### 测试
- [ ] 增加测试：health 状态枚举和值符合定义

---

## 8. 补最小关键测试集

### 目标
给最容易回归的场景加防线，先不追求全覆盖。

### 至少补这几组
- [ ] 真实模式启动失败默认不 fallback
- [ ] `ALLOW_MOCK_FALLBACK=1` 时允许 fallback
- [ ] `zenity` 缺失时 pick-directory 优雅降级
- [ ] 快速切线程乱序返回时只保留最后一次结果
- [ ] send + reconnect + reconcile 时 temp/real 状态正确迁移
- [ ] 多线程 pendingSend 互不干扰

### 要求
- [ ] 测试命名要清晰，直接反映场景
- [ ] 尽量 mock 外部依赖，不依赖真实 `codex`
- [ ] 关键断言要覆盖：
  - [ ] health 字段
  - [ ] banner 触发条件
  - [ ] currentThread 最终值
  - [ ] pending 状态
  - [ ] temp/real 替换结果

### 验收
- [ ] 所有新增测试通过
- [ ] 修复过程中没有破坏已有测试

---

# 最后交付要求

## 9. 输出总结

全部改完后，输出一份总结，格式如下：

- [ ] 改动总览
- [ ] 改动文件列表
- [ ] 每项问题对应的修复说明
- [ ] 每项问题对应的测试说明
- [ ] 仍然存在的已知风险
- [ ] 后续可选优化项

## 10. 不要做的事

- [ ] 不要顺手大改 UI 风格
- [ ] 不要顺手改接口协议，除非修复所必需
- [ ] 不要引入重量级状态管理库，先在现有结构上修
- [ ] 不要把多个目标混成一次不可审查的大重构
- [ ] 不要删掉现有 fallback/reconcile 逻辑后不补测试

---

# 建议提交顺序

- [ ] Commit 1：禁止默认 mock fallback + health 状态修复
- [ ] Commit 2：pick-directory Linux 降级
- [ ] Commit 3：openThread / refreshThreadFromServer seq guard
- [ ] Commit 4：recoverClientState generation guard
- [ ] Commit 5：pendingSend 按线程管理
- [ ] Commit 6：optimistic merge 规则收敛
- [ ] Commit 7：补测试和收尾整理