# UNK AI 开发约定

适用于本目录及子目录。目标是让新增能力沿明确的扩展边界接入，同时保持基础问答、停止、重试、页面来源和保存行为稳定。日常开发按已有任务授权推进；以下约定是实现与验证要求，不要求每次修改都向用户重新申请权限。

## 先确认真实生产路径

- 技术栈是 Chrome Manifest V3、原生 JavaScript、HTML/CSS、Vite；不是 React 项目，没有独立业务后端。
- `src/sidepanel/sidepanel.js` 仍持有共享状态、UI 渲染和浏览器/存储适配；发送、队列、停止、重试已委托 `src/app/conversation-service.js`。普通生成由 `ChatService`、`TurnRunner`、`ConversationRepository` 执行，经 `application-root.js` 装配。不能把入口描述为完全无状态，也不要恢复第二套旧流程。
- `src/sidepanel/composition/composition-root.js` 实际注册 `reading`、`visual`、`agent`，通过 `src/sidepanel/composition/slots.js` 检查契约并封存。`attachments`、`context` 目前主要作为辅助模块使用。
- 主回答、Agent 决策、视觉判断、压缩和建议问题通过 `src/app/model-gateway.js`；底层传输仍在 `src/utils/llm-client.js`。Agent 决策循环仍在 `src/sidepanel/features/agent/agent-slot.js`，尚未迁入 TurnRunner。
- `CapabilityHost` 隔离工厂初始化/释放；`ContextAssembler` 已接入普通问答，但生产默认 provider 列表为空。页面/附件仍沿现有准备路径，MCP、Skill、长期记忆与 ToolExecutor 尚未实现。
- Agent 消息回调通过 `src/sidepanel/features/agent/agent-turn-callbacks.js` 固定任务/会话/消息归属；延迟与即时保存通过 `src/sidepanel/features/storage/conversation-save.js`，不要重新引入读取全局当前会话的旧定时保存。
- `src/background/agent-service.js`、`src/utils/agent-runtime.js` 仲裁页面动作、任务许可与幂等记录；`src/content/agent-scanner.js` 执行 DOM 观察和动作校验。侧栏关闭后的无人值守持续运行不是已实现能力。
- 阅读调用经过 `src/sidepanel/features/page-reading/page-reader-slot.js`、`src/sidepanel/features/page-reading/site-research-slot.js`，后台消息入口是 `src/background/service-worker.js`。页面正文提取位于 `src/content/extractor.js`。
- 浏览器 API 尚未完全依赖注入，新增代码应收窄依赖；不要借架构调整顺便替换所有旧实现。
- 开工时阅读 `README.md`、`docs/MODULE-MAP.md` 和相关测试；设计文档的未来目录、接口不等于已经接入的生产能力。

## 不可破坏的行为

### 基础问答与唯一主回复

- 普通聊天、明确的页面读取、页面操作各有自己的执行范围。一次提交只能进入一个主回复路径；不能让 Agent 和普通生成同时回答同一回合。
- 同一回合的重复点击、重试回调、重复完成事件不能新增第二条主回答或重复提交终态。重试要遵循已有回合替换规则，不能追加一份相同用户问题作为补救。
- 视觉判断、推荐问题、摘要压缩等辅助模型请求不拥有主回答；它们不能追加、覆盖或结束主回复。
- 已经收到部分输出时，不自动重放整次生成。空正文、仅思考、错误或未正常结束的响应不能伪装成成功；必须保留明确的可见状态。
- 不用增加提示词中的“不要重复回答”替代请求幂等、回合归属或流式协议修复。

### 回合归属、取消和超时

- 每项异步工作固定提交时的会话、消息、执行所有者和取消信号；依照现有标识核验归属，不能在回调到达时随意取“当前会话”写入。
- `await` 返回后的修改和下一次副作用执行前，都应核验仍属于有效执行。旧任务的回调、`finally`、保存结果不能清除新任务的运行状态。
- 停止应及时结束本地等待，阻止后续请求和动作；所有网络、浏览器消息、读取、准备与存储等待都要有合理的时间上限。
- `src/utils/abortable.js` 解决取消等待，不会撤销已经执行的页面动作或已经排入存储队列的写入。不能把停止等待解释为操作从未发生。
- 页面动作超时且结果不明时，报告不确定状态并等待重新核对；不要自动重试可能重复提交的动作。

### 页面目标与上下文

- 页面、截图、队列项与重试固定 `tabId`、完整 URL 和可获取的 `documentId`；遵循 `src/utils/page-target.js` 的校验。不得因用户切换标签而自动改读新标签。
- 页面开关约束自动读取。用户明确请求的必要页面资料读取失败时，明确报错；不能静默使用旧正文，也不能把只有目录的来源声称为已读正文。
- `src/utils/turn-source.js` 保存每轮来源小元数据，会话 `pageContext` 保存当前完整正文；这不是历史全文快照库。
- 新增上下文必须有来源、大小预算和截断说明。页面、工具、Skill、记忆的内容不能直接提升为系统权限或执行指令。
- 可选截图、推荐问题及未来可选记忆检索失败应有界降级；用户指定的必要能力、取消和权限拒绝不能被通用 `catch` 吞掉。

### Agent、工具与权限

- 保留后台确定性权限检查、页面目标校验、任务许可失效和动作串行化。模型提示词或前端按钮状态不能替代这些检查。
- 新增工具须声明参数结构、执行范围、读写性质、超时、结果大小、取消语义和重试是否安全；执行结果须能追溯到原任务。
- 不把任意 MCP 工具塞进已有浏览器动作枚举并绕过安全层。MCP 适配器必须进入统一的受控执行边界；浏览器扩展直接运行本机 stdio 进程不是现有能力。
- Skill 不能任意调用全局对象、执行远端脚本或绕过工具权限；记忆不能当作未经核验的已执行动作记录。
- 不承诺注册表冻结或工厂超时就是插件沙箱。工厂通过 `onCleanup` 回收监听，Agent 已有实例释放；生产不支持运行时热替换。

### 存储与辅助能力

- 会话保存通过 `src/utils/conversation-store.js`，本地待写记录通过 `src/utils/conversation-outbox.js`。保留按会话串行、目录绑定和版本确认；不要直接从新功能另写同一会话文件。
- 文件夹同步失败后保留浏览器中的待同步记录，不把已有写入重定向到新目录，不用旧回调覆盖新版本。
- 推荐问题、日志及未来可选记忆写入不能阻止主回复展示和结束。必要的持久化失败必须按已有规则报告，不能声称已经保存。
- 新增持久数据需要版本与旧记录兼容策略；不要在功能开发中静默删除或重置历史会话。

## 新增能力的常规落点

1. 在 `src/sidepanel/features/<能力>/` 放功能实现；不反向导入 `sidepanel.js` 获取共享状态，不绑定第二套全局发送、停止或重试事件。
2. 需要独立运行时插槽时，在 `src/sidepanel/composition/slots.js` 声明真实方法契约，在 `src/sidepanel/composition/composition-root.js` 显式装配依赖。仅工具函数不必强行增加插槽。
3. 新插槽须明确输入、输出、状态所有者、目标身份、取消信号、超时和失败策略。向编排层返回结构化结果，不通过全局状态自行生成主回复。
4. 注册不能无声覆盖；`replace` 只允许封存前的显式装配调整。真正的实现选择优先发生在工厂调用之前，避免创建后废弃一个已绑定监听的实例。
5. 添加对应行为测试，并更新 `docs/MODULE-MAP.md` 与有关用户行为说明。不要为尚未实现的 MCP、Skill、Memory 添加空实现后宣称支持。

补充上下文优先使用 `application-root.js` 的 `contextProviders` 描述符，声明必需性、来源与预算。所有业务模型调用走 ModelGateway，固定 run 配置；requestId 只对同一用途/载荷复用。建议问题等后处理不能持有主回复提交入口。释放后的服务不得接受迟到命令。

不要借新增功能随意修改 `ConversationService` 的发送/队列/重试、`ChatService` 与 `TurnRunner` 的主回复核心，或 `llm-client.js` 的流式解析。确需修改时，应说明既有接口为什么不足、哪些原行为必须保持，并先构造能暴露问题的行为回归，再实现最小改动。这是代码评审和验证要求，不是额外的用户审批流程。

## 验证与交付

- `npm test` 只运行 `tests/*.test.js`，排除 `output` 中的历史备份；不要用无范围测试发现误跑旧副本。
- `npm run build` 构建扩展；`npm run check` 连续执行全部项目测试和构建。
- 修改发送、队列、重试、取消时，覆盖重复提交、停止后重发、迟到回调、切换会话、挂起等待和终态唯一性。可参考 `tests/submission-lifecycle.test.js`、`tests/retry-flow.test.js`、`tests/queue-page-scope.test.js`。
- 修改插槽时，运行 `tests/slots.test.js`、`tests/composition-root.test.js` 和受影响的功能测试。修改模型协议时，使用可控流响应验证 `tests/llm-client.test.js`，包括空回复、截断、错误、重复事件及供应商兼容分支。
- 修改应用装配时，运行真实组合的 `tests/application-root.test.js`、`tests/chat-service.test.js`；直接导入服务测试，不从侧栏源码截取已迁出的业务函数。
- 修改页面/Agent/存储时，分别补充目标变化、许可撤销/结果不明、写入版本/目录绑定的行为验证；测试不能只检查源码包含某段字符串。
- 与本次工作相关的检查通过后，不无理由重复扩大测试。发布或整体交付前运行 `npm run check`；浏览器专属行为需要实际扩展验证时，明确验证范围。
- 在交付说明中分清本次已落地、设计待迁移和实际验证范围。Node 测试或构建通过不等于所有站点、模型服务和 MV3 生命周期已实测。
