先说总判断：你的方向没问题，架构是正路。你现在的仓库确实是在做一个标准的 remote rich client：浏览器走 HTTP/SSE，本地 daemon 走 stdio JSON-RPC，后面接 codex app-server。这和 OpenAI 公开的 App Server 模型一致：App Server 是长生命周期进程，一个客户端请求会展开成多条事件，审批会暂停 turn，线程历史应支持重连和一致时间线。

但从“收发消息时序、状态流转、断线恢复、审批/diff 一致性”来看，现在还有几处会在真实使用里出问题的点。下面我按优先级给你一份可以直接执行的修复清单：每一项都写“改哪里、为什么、怎么改、改完预期、验收标准”。

这次结论基于仓库静态审查，不是跑过你本机真实 codex app-server 的动态 trace；所以我会把“确定 bug”和“高概率风险”分开写。

优先级总览

P0，建议先修，不然会直接影响可用性

turn/completed 的 threadId 取值和完成清理逻辑
SSE 重连补发和去重
把全局 isSending 改成按 thread/turn 绑定的 pendingSend
Abort/timeout 的“未知是否已提交”状态收敛

P1，建议尽快修，不然会出现边角状态错乱
5. 活跃 turn 的单一真相
6. 重连后的完整恢复流程
7. 审批 resolved 事件，以及 mock 里的 acceptForSession 语义
8. turn/diff/updated 到 latestDiffByTurn 的闭环
9. fileChange 输出是否展示，前后端语义统一

P2，质量/安全加固
10. 静态文件路径检查硬化
11. 线程列表刷新节流和跨客户端一致性补强

1. 修 turn/completed 的 threadId 来源和“解锁发送”的匹配条件

改哪里：public/app.js 的 handleJsonRpc -> case 'turn/completed'。

为什么：你前端这里现在写的是 const threadId = msg.params?.threadId，但你自己的后端 mock 在 _finishTurn() 和 interruptTurn() 发出的 turn/completed 都是 params.turn.threadId 这个形状；真实 bridge 在处理 turn/completed 时，也是按 message.params.turn.threadId 去删 activeTurns。这会导致前端在收到 completed 时，有机会把发送态恢复了，但没清掉正确线程的 active turn，也没更新到正确 thread 上。

怎么改：
把这段逻辑改成：

const turn = msg.params?.turn;
const threadId = turn?.threadId ?? msg.params?.threadId;
if (!turn || !threadId) {
  // 保守做法：记录异常并触发 refreshThreadFromServer(activeThreadId)
  return;
}

然后把下面三件事都绑定到这个 threadId + turn.id 上：

更新 threadMap 里的 turn 状态
更新 currentThread 里的 turn 状态
清除这个 thread 的 active turn / pending send

同时，不要再写“只要 state.isSending 就恢复输入框”；改成“只有当前 pending send 命中的 turn 完成，或者当前 thread 上已经没有活跃 turn 了，才恢复输入框”。

改完预期：
turn/completed 到来时，前端会稳定完成 4 件事：

turn 状态从 inProgress 变成 completed / interrupted
活跃 turn 被清掉
输入框和发送按钮恢复
不会留下“UI 看起来恢复了，但内部还认为 turn 在跑”的半完成状态

验收标准：

mock 下跑一条新 turn，完成后 deriveActiveTurnId(currentThread) === null。
点 interrupt 后，turn 状态变成 interrupted，输入框恢复。
不会出现按钮已恢复、但顶部/侧边还显示该 turn 在 inProgress。
连续发两次消息时，第二次不会因为第一次的 completed 晚到而误解锁或误清理。
2. 修 SSE 重连补发：必须支持 Last-Event-ID 或客户端 seq 去重

改哪里：server.js 的 /api/events、sendSse()、recentEvents replay 逻辑，以及前端的 SSE 消费逻辑。

为什么：后端已经给 SSE 事件写了 id: ${event.seq}，也维护了 recentEvents；但新连接进来时，目前是无条件回放最近 40 条事件。与此同时，前端的 appendDeltaToItem() 是直接字符串拼接，没有基于 seq 做幂等处理。这样一旦浏览器断线重连，最近几十条 delta 很容易被重复应用，最典型的表现就是 assistant 流式文本和命令输出重复。OpenAI 官方对 App Server 的模型也明确强调：线程历史应该允许客户端重连并恢复一致时间线，而不是让客户端靠重复拼增量去“猜”状态。

怎么改：
后端和前端两层都补。

后端：

读取 Last-Event-ID 请求头。
如果带了，就只补发 seq > lastEventId 的事件。
如果客户端落后太多、seq 已经不在 recentEvents 里，不要硬 replay 半截历史；直接返回“需要全量刷新”的信号，或者让客户端主动走 thread/read + approvals/pending 的快照恢复。

前端：

维护 state.lastEventSeq。
收到事件后，if (seq <= lastEventSeq) return;。
如果发现 seq > lastEventSeq + 1，说明中间丢了事件，不要继续盲拼 delta，而是触发一次完整恢复：
loadHealth()
loadThreads()
loadPendingApprovals()
refreshThreadFromServer(activeThreadId)

改完预期：
断线重连后：

文本不会重复
命令输出不会重复
审批和 diff 不会“回放出两份”
当前线程能回到和服务端一致的快照

验收标准：

在 mock 模式里，命令输出流过程中手动断开 SSE，再重连；最终 aggregatedOutput 不能重复行。
assistant message 流中途重连，最终文本与“不断线跑完”的文本完全一致。
如果手工把客户端 Last-Event-ID 改小，重复到达的旧事件不会再次落 UI。
如果故意让客户端落后超过 recentEvents 窗口，客户端会走全量恢复，而不是拼出半错乱状态。
3. 把全局 isSending 升级成按 thread/turn 绑定的 pendingSend

改哪里：public/app.js 的 state、sendComposerMessage()、turn/started、turn/completed、cleanupSendState()。

为什么：现在的发送态核心仍然是一个全局布尔值 state.isSending。它能挡住最简单的重复发送，但挡不住这些真实场景：

线程 A 的 completed 晚到，误把线程 B 的发送状态解掉
超时后 pending send 还没收敛，但全局锁已经释放
两个标签页/两个客户端同时写入时，没有“这次发送到底对应哪个 thread/turn”的归属关系
你自己的 sendComposerMessage() 里已经有“当前 active turn + isSending 状态一致性”的防御逻辑，说明你已经意识到这件事了；但全局布尔值本身还是不够。

怎么改：
把：

state.isSending = boolean

升级成：

state.pendingSend = null | {
  threadId,
  mode: 'start' | 'steer',
  tempTurnId,
  realTurnId,
  tempMessageId,
  startedAt,
  status: 'awaitingAck' | 'streaming' | 'uncertain'
}

规则建议这样定：

发消息前创建 pendingSend
turn/start HTTP 成功后，如果拿到真实 turn id，填入 realTurnId
turn/started 事件到来时，如果存在对应 tempTurnId，做 temp->real 替换
turn/completed 到来时，只有它命中了 pendingSend.threadId + (realTurnId 或 tempTurn 对应 turn)，才允许 cleanupSendState()
UI 上的“发送中”可以继续保留，但它应该从 Boolean(state.pendingSend) 派生，而不是独立真相

改完预期：
发送态会从“全局锁”变成“有归属的在途请求”，时序更稳定，也更容易 debug。

验收标准：

线程 A 正在跑时，切到线程 B，不会因为 A 的状态变化误解锁/误锁 B。
旧 turn 的 completed 晚到，不会清掉新一轮发送。
interruptCurrentTurn() 永远不会打到 temp-turn-* 这类假 ID。
控制台日志里能清楚看到 pendingSend 从 awaitingAck -> streaming -> completed/cleared。
4. 处理 Abort/timeout：不要“既不清也不认”，要进入“待确认”并主动对账

改哪里：public/app.js 的 sendComposerMessage() catch 分支，特别是 AbortError；以及 5 分钟兜底超时逻辑。

为什么：现在普通 error 会清乐观更新，但 AbortError 分支只是报一个 banner，然后恢复发送状态；临时 turn / 临时消息会留在界面里。问题在于：Abort 不等于服务端没收到。有可能是浏览器侧 60 秒超时了，但服务端其实已经创建了 turn，后续事件还会继续来；也有可能请求真的失败了。现在这条分支相当于把 UI 留在一个“未知是否已提交，但也不主动收敛”的中间态。

怎么改：
不要把 Abort 当作普通失败，也不要什么都不做。建议引入“未知是否已提交”状态：

pendingSend.status = 'uncertain'

然后立刻启动对账流程：

refreshThreadFromServer(thread.id)
loadPendingApprovals()
必要时重试 2-5 次，做指数退避
如果在服务端快照里找到了对应真实 turn，就把 temp 状态对齐过去
如果连续几次都找不到，再 cleanup 乐观 turn/message

5 分钟兜底也一样：先 refresh 对账，再决定清理，不要一上来就只把 UI 放回 idle。

改完预期：
网络抖动时不会长期留下幽灵 temp turn；同时也不会把服务端其实已成功受理的 turn 误删掉。

验收标准：

模拟“服务端已受理，但客户端 HTTP 超时”：UI 最终能对齐到真实 turn，不出现重复用户消息。
模拟“请求根本没到服务端”：临时 turn/message 会在对账失败后消失。
5 分钟兜底触发时，如果服务端已有结果，页面能回收到真实状态，而不是只剩一个 banner。
5. 活跃 turn 只保留一个真相：以 deriveActiveTurnId(thread) 为准

改哪里：public/app.js 里所有同时读写 activeTurnIdByThread 和 thread.turns 的地方。

为什么：你仓库里自己的 STATE_FLOW_ANALYSIS.md 已经把这件事点出来了：临时 ID、真实 ID、turn/completed 删除、thread refresh，这几条路径会让 activeTurnIdByThread 和 turns 数组脱节。既然你已经有 deriveActiveTurnId(thread)，就没必要再维护第二份“谁是活跃 turn”的平行真相。

怎么改：
建议策略二选一：

推荐做法：deriveActiveTurnId(thread) 作为唯一真相，activeTurnIdByThread 直接删掉。
保守做法：保留 activeTurnIdByThread，但只把它当缓存；任何时刻只从 thread.turns 派生写入，不允许独立更新。

所有这些入口都要统一：

refreshThreadFromServer
turn/started
turn/completed
sendComposerMessage
interruptCurrentTurn

改完预期：
不会再出现“map 说有活跃 turn，但 turns 里没有”或者“turn 已完成，但 map 里还没删”的双真相问题。

验收标准：

新 turn 从 temp ID 替换成真实 ID 后，interrupt 仍然命中真实 turn。
thread refresh 后，active turn 判断与服务端快照一致。
任意时刻打印状态，active turn 只会从 thread.turns 推出来，不会出现两份矛盾结果。
6. 重连恢复要补全：不只是 health 和 thread list，还要恢复当前线程、审批和不确定发送

改哪里：前端 reconnect/bootstrap 流程。

为什么：官方的 Web 模型本来就是“服务端持有 source of truth，浏览器掉线后再通过 SSE/HTTP 追上来”。你自己的分析文档也已经把 SSE 重连单列为问题。现在前端已经有完整的恢复工具：loadHealth()、loadThreads()、loadPendingApprovals()、refreshThreadFromServer()；但需要把它们拼成一个明确的 reconnect 收敛流程。

怎么改：
在 SSE open/reconnect 成功后，执行：

await Promise.all([
  loadHealth(),
  loadThreads(),
  loadPendingApprovals(),
]);

if (state.activeThreadId) {
  await refreshThreadFromServer(state.activeThreadId);
}

if (state.pendingSend?.status === 'uncertain') {
  await reconcilePendingSend(state.pendingSend);
}

另外，如果你发现 seq 有 gap，也应该走这套恢复，而不是继续吃增量。

改完预期：
标签页刷新、网络抖动、浏览器休眠恢复后，页面能回到一致状态：

当前线程内容正确
审批卡正确
diff 正确
发送状态正确

验收标准：

正在流式输出时刷新页面，重开后 1-2 秒内当前线程恢复。
等审批时刷新页面，审批卡仍在。
重连后 diff 预览和当前 turn 状态与 /api/threads/:id 返回一致。
7. 审批这块要补两件事：serverRequest/resolved 前端收敛，以及 mock 里的 acceptForSession 语义别假装支持

改哪里：

前端 handleJsonRpc() 的审批状态管理
server.js 的 mock respondToServerRequest() / approval continuation

为什么：
第一，前端当前可见逻辑会在收到 server-initiated request 时把审批塞进 state.pendingApprovals，但我没在当前 app.js 里定位到 serverRequest/resolved 的前端处理。后端 mock 是会发 serverRequest/resolved 的，真实 bridge 也会在后端内部删除 pending request；如果前端不收这个 resolved，审批卡在跨客户端处理、或者本地状态漂移时会变陈旧。第二，UI 暴露了 acceptForSession 按钮，mock 也把它列在 availableDecisions 里，但 mock continuation 里实际上只对 decline/cancel 特殊处理，其它基本都等价于 accept；这会让 mock 测试对“本会话都接受”的真实语义产生假信心。

怎么改：
前端：

增加 case 'serverRequest/resolved'
收到后 pendingApprovals.delete(requestId)，然后 renderApprovals()
如果 resolved 的 thread 是当前 thread，可以顺手 refreshThreadFromServer(threadId)

审批点击本身：

发 POST 前先把对应按钮 disabled
成功后删卡片
失败再回滚 UI

mock：

如果你暂时不实现 acceptForSession 的 session 级策略，就不要在 mock UI 里暴露这个按钮
如果保留，就必须在 mock bridge 里把该 decision 记到 session policy，下一个匹配审批要自动通过

改完预期：
审批 UI 和后端语义会一致，尤其在多客户端和 mock 合约测试里不会误导你。

验收标准：

客户端 A 出现审批卡，客户端 B 处理后，A 的审批卡会自动消失。
mock 下如果保留“本会话都接受”，第二个同类审批会自动通过；如果不做，就把这个按钮隐藏掉。
审批点击失败时，卡片和按钮状态能回滚。
8. turn/diff/updated 到 latestDiffByTurn 这条链要补齐

改哪里：public/app.js 的事件处理。

为什么：README 明确写了 diff 预览“优先展示 turn/diff/updated”，后端 mock 也确实会发 turn/diff/updated；前端 renderDiffPreview() 也会先读 state.latestDiffByTurn。但我在当前可见的 app.js 里没有定位到 turn/diff/updated 的 handler，也没看到 latestDiffByTurn.set(...)。这意味着 diff 面板很可能主要还是靠 fileChange.changes[].diff 回退，而不是你 README 说的优先路径。

怎么改：
在 handleJsonRpc() 里补：

case 'turn/diff/updated': {
  const { threadId, turnId, diff } = msg.params || {};
  if (turnId && typeof diff === 'string') {
    state.latestDiffByTurn.set(turnId, diff);
    if (state.currentThread?.id === threadId) renderDiffPreview();
  }
  break;
}

再补一个清理策略：

thread 被从内存里裁掉时，删对应 diff
如果你担心内存涨，可以只保留每个 thread 最近 N 个 turn 的 diff

改完预期：
diff 一旦到达，就能立刻显示，不必等 fileChange 完成或整线程 refresh。

验收标准：

mock 下 file approval 前发出 turn/diff/updated 时，右侧 diff 面板立刻更新。
即使 fileChange item 还没 completed，diff 也能先看。
refresh 当前线程后，diff 不会无故丢失或显示旧 turn。
9. fileChange 的 outputDelta 要么展示出来，要么删掉这条状态

改哪里：public/app.js 的 renderItem(fileChange) 和对应 delta 处理。

为什么：README 说“文件改动输出通过 item/fileChange/outputDelta 累加”，后端 mock 也确实会发一条 Applied patch ... 的 item/fileChange/outputDelta；但前端 renderItem(fileChange) 当前可见部分只渲染 changes[].diff，没有展示 file-change 的 output 文本。这样会出现一种“状态被维护了，但用户看不到”的半截设计。

怎么改：
二选一：

方案 A：给 fileChange 卡片加一个 output/details 区，显示 patch apply log
方案 B：干脆不单独维护 fileChange.outputDelta，只保留 diff + completed 状态

我更推荐 A，因为“补丁已应用”是用户很关心的一条反馈。

改完预期：
文件改动这块的前后端语义统一，用户不会觉得“明明做了事情，但页面没反应”。

验收标准：

接受文件改动审批后，UI 能看到“Applied patch to ...”之类的反馈。
如果你决定不展示，那状态里也不要再保留一个永远没人读的字段。
10. serveStatic() 的路径检查要换成 path.resolve + 边界检查

改哪里：server.js -> serveStatic()。

为什么：你现在是 path.join(PUBLIC_DIR, ...) 后再 startsWith(PUBLIC_DIR) 判断。这个写法在很多场景下能挡住大部分 traversal，但不算最稳妥的边界检查，尤其是后面如果你真要外放服务，建议直接按“resolved path 必须落在 PUBLIC_DIR 内”的模式写。

怎么改：
用：

const resolved = path.resolve(PUBLIC_DIR, '.' + pathname);
if (!(resolved === path.join(PUBLIC_DIR, 'index.html') ||
      resolved.startsWith(PUBLIC_DIR + path.sep))) {
  ...
}

同时注意：

对 URL decode 后再判断
Windows 下路径分隔符也要兼容

改完预期：
静态文件路由更稳，不会因为路径边界判断不严被绕过。

验收标准：

/../server.js、/%2e%2e/server.js、多层 traversal 都不能读到服务端文件。
正常 /app.js、/styles.css、/ 仍能工作。
11. 线程列表刷新建议做节流，不然会有不必要抖动

改哪里：public/app.js 里 thread/started 和 thread/status/changed 对 loadThreads() 的调用。

为什么：现在两个事件都会直接触发 loadThreads()。逻辑上没错，但如果状态事件频繁，左侧列表会有不必要的重复拉取和重排。你当前事件驱动 UI 的方向是对的，但线程列表这种低频摘要数据，最好做一下合并刷新。

怎么改：
给 loadThreads() 包一层 debounce，例如 100-250ms。

同一批事件只刷新一次列表
当前 thread 的主会话区仍然走实时 patch，不受影响

改完预期：
左侧列表更稳，网络和渲染负担更小。

验收标准：

mock 一次完整运行过程中，左侧列表不会每个小状态变化都抖。
网络面板里 /api/threads 请求数量明显下降。
我建议你保留的设计

这几块我建议继续保留，不要推翻：

1. Browser -> daemon -> stdio JSON-RPC -> app-server
这是对的，比直接让浏览器碰 app-server 稳得多，也更符合官方公开的集成模型。

2. withAutoResume() 这层兜底
当 thread not found 时自动 resumeThread 再 retry，这个非常实用。

3. readThread() 对 includeTurns not materialized 的 fallback
这能很好处理“线程存在但还没 materialize 完整 turns”的情况。

4. turn/steer 带 expectedTurnId
这是个好习惯，能减少 stale turn 被误 steer 的概率。

建议的测试与验收方案

下面这部分是我建议你补的测试矩阵。不是必须全自动，但至少这些场景要过。

A. 单元测试

前端状态机

turn/completed 使用 params.turn.threadId 时，能正确完成：
更新 turn.status
清 active turn
清 pendingSend
恢复输入框
appendDeltaToItem 在重复 seq 下不会二次追加。
pendingSend 的状态迁移：
awaitingAck -> streaming -> cleared
awaitingAck -> uncertain -> reconciled
awaitingAck -> failed -> cleanup
deriveActiveTurnId(thread) 在 temp turn / real turn / completed / interrupted 下都正确。
serverRequest/resolved 会删除 pendingApprovals。
turn/diff/updated 会写入 latestDiffByTurn 并刷新 diff 面板。
B. 集成测试（建议 mock bridge）

消息流

新建 thread -> 发消息 -> 流式 assistant -> command approval -> command output -> file approval -> diff -> completed。
在 active turn 上 steer，不会新建第二个 turn。
interrupt 后 turn 变 interrupted，UI idle。

审批
4. accept / decline / cancel 三条都能正确影响后续流程。
5. 如果保留 acceptForSession，第二次同类审批自动通过；如果不实现，就确保按钮不存在。

重连
6. SSE 断线重连后，文本和命令输出不重复。
7. 页面刷新后，能恢复当前线程、审批、diff。
8. seq gap 时触发全量恢复，不继续盲拼 delta。

异常
9. HTTP abort 但服务端实际已启动 turn，最终会收敛到真实 turn。
10. HTTP 真失败，临时 turn/message 会清掉。

C. 手工验收
两个浏览器标签页打开同一个 thread。
A 页出现审批，B 页处理后，A 页自动消失。
A 页跑命令输出流时断网，恢复后不重复。
thread A 结束时，不会误影响 thread B 的发送态。
patch apply 后，用户能明确看到 diff 和应用结果。
D. 安全验收
../、URL 编码 traversal、目录请求都不能读到 public 外文件。
SSE 长连断开后，服务端能把 client 从集合里正确清理。
大 body 会被正常拒绝，错误路径不会把进程拖挂。
我会建议的落地顺序

如果你只想最快把项目从“能演示”推到“能稳定用”，我建议顺序是：

先修 第 1 条 turn/completed
再修 第 2 条 SSE replay / dedupe
接着做 第 3 条 pendingSend
然后做 第 4 条 abort/timeout reconciliation
再补 第 6、7、8 条，把恢复、审批、diff 收平
最后做安全和性能边角

这样修完之后，这个仓库就会从“结构是对的，但真实运行里会偶发乱状态”，进入“可以长时间挂着用”的阶段。