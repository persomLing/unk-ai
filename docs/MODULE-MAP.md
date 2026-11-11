# UNK AI 模块地图

本文按当前生产代码定位职责。P1 已把普通会话提交、队列、重试、主回复执行和模型请求移到 `src/app/`；`src/sidepanel/sidepanel.js` 仍持有共享状态和状态投影，处理 UI 事件、渲染、页面/截图与存储 adapter，并不是完全无状态的轻量入口。Agent 决策循环仍位于 feature 模块，在侧栏文档中运行。

面向使用者的安装、设置及操作步骤见 [操作手册](USER-GUIDE.md)（[HTML 阅读版](USER-GUIDE.html)）。当前容量面板的“立即整理”按钮尚无点击处理，自动整理通过 ChatService 调用 ContextService；不能把服务提供的手动参数等同于 UI 已接入。

稳定内核、工具/MCP、Skill 和记忆的目标边界、分阶段迁移及验收标准见 [AI 扩展架构设计](2026-11-02-ai-architecture.md)；开发约束见 [AGENTS.md](../AGENTS.md)。P2 的统一工具执行和 P3 的 MCP/Skill/Memory 尚未实现；下面列出的 P1 接口不代表这些能力已经可用。

## 组合层与侧栏入口

| 文件 | 当前职责 |
| --- | --- |
| `src/sidepanel/sidepanel.js` | 共享状态与状态投影、UI 事件/渲染、页面开关和焦点同步、浏览器/读取/截图/存储 adapter；发送、停止、重试转交应用服务 |
| `src/sidepanel/composition/application-root.js` | 装配会话仓储、TurnRunner、ChatService、ContextService、ContextAssembler 和共享 ModelGateway；把应用事件提供给 UI |
| `src/sidepanel/composition/composition-root.js` | 通过 CapabilityHost 初始化 `reading`、`visual`、`agent`，向封存注册表提供稳定代理；单项初始化失败不阻断其他能力 |
| `src/sidepanel/composition/slots.js` | 方法契约检查、重复注册拒绝、装配阶段显式替换及封存；声明的名称不代表全部已注册 |
| `src/sidepanel/features/web-research/research-answer-loop.js` | 普通主回答的模型工具循环：最多 4 工具轮/6 次不同操作/3 次不同搜索、并发 2、累计工具等待 45 秒；按执行器参数指纹去重，每轮告知剩余额度；完整校验后执行额度内调用，为超额或时间预算用尽后未派发的调用补配对拒绝结果，下一轮无工具收尾；保留原生工具/思考上下文、预算内裁剪资料并返回同一回复，不提交终态 |
| `src/sidepanel/features/web-research/research-tools.js` | 每回合受控的 web_search/read_webpage，只接受本轮 sourceId；来源/参数校验、去重、正文复用、单工具 12 秒、结果大小和取消约束 |
| `src/sidepanel/features/web-research/public-research-transport.js` | 确认服务端点缺失后的单次公开搜索/抓取；省略凭据、禁止跟随重定向、128 KiB 响应预算，不执行脚本 |
| `src/sidepanel/features/web-research/web-research.js` | 保留旧策略/研究函数及其测试；普通主回复已不调用旧 createWebResearcher，公开适配仍复用其 parseSearchResults |
| `src/sidepanel/features/web-research/research-decision.js` | 保留旧联网判断提示、元数据和解析测试；普通回答生产链路不再请求 research-decision |
| `src/sidepanel/core/dom.js` | DOM 查询、转义、Toast |
| `src/sidepanel/core/format.js` | 文本、时间、字节、URL 格式化 |
| `src/sidepanel/icons.js` | 内联 SVG 图标；`sidebar` 用于打开历史对话侧栏 |
| `src/styles/scrollbars.css` | 由侧栏与设置页入口 CSS 共用的原生滚动条外观；统一明暗颜色，默认透明，按区域悬停或键盘聚焦显现，触屏/高对比度保留提示；保留 overflow:auto 与恒定尺寸，仅场景宽度可覆盖，不监听滚动、不改变业务或导出纸张 |

侧栏顶栏提供历史侧栏、全局模型选择、主题切换、下载菜单和新对话，普通问答与页面操作共用模型入口。下载菜单包含图片/PDF、整段 Markdown 和本对话今日诊断。当前对话标题由入口渲染在固定的 app-header 中、工具栏上方，超长单行省略并保留完整 tooltip；新对话隐藏额外标题行，document.title 恢复默认名称。Chrome 原生侧栏头仍使用扩展名称，sidePanel API 没有动态 title 字段，会话标题显示在它正下方。输入框底部集中显示页面操作、阅读强度和接口开关；页面开关仍控制这些页面能力的可用范围。右侧“会话整理”为 32px 叠层图标，悬停显示估算容量，75%/90% 预警点和点击后的容量/摘要/立即整理面板沿用既有状态。附件菜单只保留上传图片和文档，粘贴图片继续可用。历史区在页面宽度达到 960px 时自动并排常驻，360px 历史区为主区保留至少 600px；收窄恢复覆盖抽屉。宽屏可手动收起并由顶部历史按钮恢复，切换/新建对话不关闭常驻区，首次自动展开不抢输入焦点。品牌与搜索固定在顶部、设置固定在底部，只有历史列表滚动。桌面与扩展侧栏共用 `src/sidepanel/index.html`。浏览器 API 并未全部收敛到组合层，入口和部分功能模块仍直接访问 `chrome`。修改时应沿调用链确认状态和执行环境，不能假设所有功能都已完全依赖注入。

## P1 应用层：已接入生产路径

| 文件 | 当前职责 |
| --- | --- |
| `src/app/conversation-service.js` | 普通发送/排队、准备、停止、重试及模式分流；固定提交归属、模型配置和目标页面，调用读取/保存 adapter；仍接收共享 `state`，尚未成为独立于侧栏状态的数据层 |
| `src/app/turn-runner.js` | 普通问答的执行所有者、取消与总截止时间、阶段、事件序号校验和唯一终态提交；重复 command 不重复执行，不接管后台 Agent 动作许可 |
| `src/app/conversation-repository.js` | 按 conversation/turn/run/assistant 身份条件更新消息、去重终态、替换重试、重新加载校正和显式归属保存；只允许成功回合附加建议问题 |
| `src/app/chat-service.js` | 准备完成后的普通主回复：压缩、补充上下文、预留工具预算；开启联网时委托 research-answer-loop，关闭时原流式直答；消费同一助手流并累计思考时间，成功后独立生成建议问题，不操作 DOM |
| `src/app/model-gateway.js` | run 私有冻结模型配置与完整载荷 requestId 去重；仅 answer/agent-decision 可声明工具，辅助用途无主回答回调；显式 answer tools 使用流式工具传输，搜索/抓取映射配置路径并保留安全 HTTP 状态；独立取消/超时受 run 截止约束，诊断无正文密钥 |
| `src/app/context-service.js` | 手动/自动历史压缩的分块、摘要合并、取消和状态通知；通过 Gateway 的 `compression` 用途请求；失败时按现有容量限制保留近期消息 |
| `src/app/context-assembler.js` | 按显式 descriptor 收集 ContextBlock，克隆输入、校验来源、去重、排序和字符/块预算；可选失败形成问题记录，必要能力失败阻断本轮，取消不降级 |
| `src/app/capability-host.js` | 能力实例初始化期限、就绪/失败/停用状态、生命周期信号、`onCleanup` 与有界释放；支持部分初始化失败和迟到结果清理，不是脚本沙箱 |

普通发送链路为：`sidepanel` UI → `ConversationService` → `TurnRunner` / `ConversationRepository` → `ChatService` → `ModelGateway` → `llm-client`。页面资料准备通过组合层的 `reading`/`visual` 代理。消息和阶段经应用事件投影回 UI，保存继续使用原有会话保存队列及 outbox。

Gateway 的去重范围是同一个 run，重复 requestId 必须对应相同有效载荷，沿用首次调用的信号和回调；它不按问题文本去重，也不自动重试业务生成。辅助用途不能注册主回答流回调。Token 裁剪由 ChatService/Agent/ContextService 保留现有预算规则；Gateway 的独立请求上限不是累计 token 或费用配额。

普通回答、视觉判断和自动压缩共享本轮冻结配置；建议问题在主回复终结后独立运行，不能改写终态。Agent 每个任务在首次启动时固定模型配置，当前侧栏内暂停/继续沿用该配置；从旧 checkpoint 恢复到新侧栏时，在首次明确继续时固定当时配置，checkpoint 不保存 API Key。

建议问题使用 ChatService 的 `suggest` 后处理：固定原 `ref` 的问题、已完成回答及来源，全部封为 user 参考 JSON，不读取当前页面状态。问题最多 1400 字符，回答最多 6500 字符，超长保留头 4200 与尾 2200 字符并说明省略；来源最多 6 项，标题/URL/数量截断有标记。模型输出具体问题及可核验的讨论对象，持久数据仍是原 `suggestions: string[]`，不升级历史格式。等待返回后再次核验服务未释放、原回合仍完成且正文一致，才能装饰并排队保存；失败或无效推荐不阻止主答。此次最小修改仅在后处理，旧接口不足在于无语义对象检查且会将散文当问题；先用 `tests/model-suggestions.test.js`、`tests/chat-service.test.js` 与 `tests/suggestion-content-view.test.js` 复现，再修正。显示层复用校验隐藏旧坏建议，不重写历史文件。

普通联网回答从第一个主模型请求开始获得受控工具，无独立分类请求。模型根据已有页面/附件决定是否补充公开资料，收到工具结果后继续同一回复。工具等待显示 web-research，模型等待显示 waiting-model；checking-research 仅保留旧记录兼容，researching 仍指站内相关文章。页面准备、视觉判断、Agent 动作权限未迁入普通工具循环。原生工具分片由 llm-client 的新 streamChatToolCompletion 处理，旧 streamChatCompletion 字符串接口不变。实现、限制与验证见[模型驱动检索](2026-11-09-model-driven-research.md)。

预算拒绝结果使用 `kind: budget`、`executed: false`，不附带伪造来源，仍与原 `tool_call_id` 配对。收尾继续原回合的流式输出、取消信号和唯一终态，不重放整次生成；正在执行的必要工具失败、权限拒绝、超时或取消不转为成功。来源 UI 仅在所有来源明确标为正文时显示“已读取”，混合或旧未知记录显示中性来源数量，展开后保留摘要/正文及截断说明。对应回归为 `tests/research-answer-loop.test.js`、`tests/application-root.test.js` 与 `tests/source-evidence-view.test.js`。

ContextAssembler 已进入普通问答链路，但生产默认 `contextProviders` 仍为空。页面读取保留现有显式路径；尚未把所有内建资料改造成 ContextProvider。未来能力可以在 `application-root.js` 显式注册，不应从 provider 修改全局消息或主回复状态。

## 侧栏功能

| 文件 | 当前职责 |
| --- | --- |
| `src/sidepanel/features/attachments/attachments-slot.js` | 附件渲染、去重、限制与添加；作为辅助模块使用，当前附件菜单只提供图片和文档上传，粘贴图片由原入口处理 |
| `src/sidepanel/features/history/history-layout.js` | 历史区的宽窄布局与手动开合：页面宽度至少 960px 时 360px 历史区与至少 600px 主区并排，收窄恢复抽屉；宽屏可收起/恢复，切换或新建会话不关闭常驻区，复用列表 DOM，首次自动展开不抢焦点；只管理 UI 布局，不读写会话 |
| `src/sidepanel/features/history/history-sidebar.js`、`history-sidebar.css` | 历史侧栏的分组/全部视图、搜索、多选、右键/“⋯”菜单、原位改名、组内新建、移动与删除确认/撤销；通过注入回调复用入口的新建、打开和存储流程 |
| `src/sidepanel/features/history/history-model.js` | 分组和自定义名称的只读投影、搜索、折叠可见性、选择范围及隐藏选择计数；全部视图保持平铺 |
| `src/sidepanel/features/history/history-press-drag.js` | 长按触发的 Pointer 拖动、稳定根节点捕获、滚动手势区分、取消与点击抑制；分组目标、悬停展开和边缘滚动由侧栏控制器处理 |
| `src/sidepanel/features/history/history-navigation.js` | 历史打开/新建的执行归属、读取和排队等待超时、提交前身份校验；临时会话单槽写入一旦开始，等待超时仍保留操作锁直到实际保存完成，防止重复新建与迟到写入冲突 |
| `src/sidepanel/features/history/history-feedback.js` | 3 秒提示、手动关闭、悬停/聚焦暂停与旧计时器隔离；提示展示和可撤销删除 token 分别保留，计时结束只刷新提示区 |
| `src/sidepanel/features/page-reading/page-reader-slot.js` | 网页/PDF/仓库读取、深度读取、目标校验；接收固定 `tabId`、`expectedUrl`、可用 `documentId`、刷新标志和取消信号 |
| `src/sidepanel/features/page-reading/adaptive-reading.js` | 普通页面问答的资料缺口检查、同页相关纠错核验、本地规则与 Gateway 灰色判断；最多一次不滚动的结构补读，返回有界评估与资料缺口，不创建主回复 |
| `src/sidepanel/features/page-reading/supplemental-reading.js` | 已读正文之后的补充资料 adapter，组合智能结构补读与可选接口读取；按固定会话与页面管理有界内存接口缓存，复用前重新核对授权；区分明确必要请求和可选失败，不控制主回复 |
| `src/sidepanel/features/page-reading/network-reading-cache.js` | 当前侧栏实例的接口资料缓存；最多 4 项、5 分钟固定有效期，严格会话/页面/语义内容与主题匹配，观察代次隔离旧任务，不从持久会话恢复 |
| `src/sidepanel/features/page-reading/network-reading-client.js` | 侧栏网络读取会话，端口绑定任务与取消标识，3 秒采集窗口与有界消息等待；退出或释放时断开端口清理 |
| `src/sidepanel/features/page-reading/reading-controls.js` | 自动/基础/深入自定义菜单与本站接口单击开关的 UI 生命周期；键盘导航、悬停说明、注入设置读写、固定站点、限制等待、拒绝迟到回调，不绑定发送或停止入口 |
| `src/sidepanel/features/page-reading/page-source.js` | URL 归一化与来源比较，区分文章锚点和 hash 路由，支持强制刷新 |
| `src/sidepanel/features/page-reading/page-control-state.js` | 当前页标题、可读性、图标和来源提示；导航只改变目标与可用性，保持本次侧栏会话内手动选择 |
| `src/sidepanel/features/page-reading/page-question-choice.js` | 关闭页面模式时的来源选择；只建议开启，选择前不提交/读取；固定草稿与会话/页面归属，失效选择不能发送，复用原提交入口 |
| `src/sidepanel/features/page-reading/page-read-state.js` | 固定本次读取的展示状态；取消及时结束本地等待，超时显示失败，迟到结果不能覆盖新读取；文档刷新失效旧状态 |
| `src/sidepanel/features/visual-context/auto-visual-slot.js` | 通过 Gateway 判断是否需要图片；复用传入 run 的冻结模型配置；异步决策和截图沿用同一个来源页面；释放实例取消自身工作，不释放借用的 run |
| `src/sidepanel/features/visual-context/visual-capture-service.js` | 截图桥接、回退和附件整形；供现有视觉路径复用，附件菜单精简不移除底层截图能力 |
| `src/sidepanel/features/context/context-slot.js` | 压缩来源、分块、请求体、摘要元数据等纯辅助规则；生产压缩请求由 `src/app/context-service.js` 发起 |
| `src/sidepanel/features/messages/message-view.js` | 消息渲染、Markdown、公式和代码高亮；流式阶段原地更新思考与正文，不替换折叠按钮节点；用户气泡下方的回退/复制图标通过悬停、键盘聚焦或触屏显示，沿用入口的操作事件；`style.css` 中的操作区横跨气泡下方预留空间，保持移向按钮时的悬停命中 |
| `src/sidepanel/features/messages/selection-chat-sessions.js` | 当前主对话的追问窗口跟踪：后续有效 V1 选区复用首次分支，拒绝时不另建窗口；主会话 ID 变化先解除归属再提示，关闭回调只清匹配实例，返回旧主会话不复活；只持有内存跟踪，不负责模型、保存或关闭所有视图 |
| `src/sidepanel/features/messages/floating-chat-dock.js` | 浮窗与右侧对话图标间的 260ms 收起/展开过渡；标题按钮或向右拖动至少 24px 且距右边缘 24px 内触发，减少动态效果偏好下即时完成；保存几何、焦点及可用图标位置，过渡归属阻止迟到回调改新状态；收起保留 runtime，不停止、不保存、不重建对话 |
| `src/sidepanel/features/messages/floating-chat-activity.js` | 订阅既有 Runner 事件的浮窗展示状态；固定会话/run/助手消息，区分准备、思考、回答及成功完成未读；停止、失败、迟到和重复事件不点亮完成提示，不持有主回复或保存入口；view 在展开且页面可见时确认已读，dock 忙碌时优先隐藏小点 |
| `src/sidepanel/features/messages/source-popover.js` | 单个正文展示区的来源列表开合；同步 hidden、aria-expanded、is-open，外部 pointerdown、Esc、正文滚动、resize/blur 与重绘失效时关闭；来源内部滚动和默认链接可用，Esc 优先只关来源列表，释放监听与旧引用 |
| `src/sidepanel/features/messages/message-copy.js`、`copy-text.js` | 回答复制菜单和 Markdown 到纯文本转换；固定打开时的正文，保留仅思考消息的明确提示；独立取消、超时和焦点管理，不参与主回复提交 |
| `src/sidepanel/features/messages/message-rewind.js` | 原提问文字、图片/文档、选区和来源意图的独立草稿恢复；深克隆保留截图目标，移除当前提问及后续分支；忙碌阻止、固定原会话保存、10 秒等待上限和迟到界面归属，草稿不新增持久化协议 |
| `src/sidepanel/features/export/export-controller.js`、`export-model.js` | 按问答回合选择、仅回答开关、预览和导出会话生命周期；白名单冻结可见内容、按所选范围预算，切换会话/关闭/释放时取消，旧结果不能触发新下载 |
| `src/sidepanel/features/export/export-renderer.js`、`pagination.js` | 动态加载本地图片/PDF渲染依赖，复用 Markdown/公式显示，独立浅色文档和有界画布；保留错误状态、限制外链资源、连续分页并清理临时文档 |
| `src/sidepanel/features/export/download-export.js` | 浏览器下载适配与 Blob URL 释放；固定文件名、有界等待，不写入会话存储；取消等待不撤销已发起的浏览器保存 |
| `src/sidepanel/features/export/export-menu.js` | 顶栏下载菜单提供图片/PDF、整段 Markdown 与本对话今日诊断；日志生成中可用，Markdown 沿用忙碌禁用并有私有重复锁、固定内容/会话、取消与 60 秒保存等待，迟到结果不改新操作；切会话/外点/Esc 关闭，两个日志入口共用导出器 |
| `src/sidepanel/features/messages/dom-reconcile.js` | 将新渲染的 Markdown DOM 与现有节点增量协调，复用稳定段落并替换结构变化的节点 |
| `src/sidepanel/features/messages/thinking-view.js` | 由消息状态推导思考标签、用时、活动态和用户折叠选择 |
| `src/sidepanel/features/messages/reply-progress.js` | 空输出时按真实阶段显示进度；等待模型输出达到 15 秒补充“尚未收到正文或思考内容”，收到正文或思考后隐藏，不推断服务端思考或排队状态 |
| `src/sidepanel/features/messages/turn-navigator.js` | 按用户提问推导轮次、渲染右侧刻度与悬停预览，并负责跳转；预览不含收藏或复制按钮；`style.css` 让导航透明容器和刻度展开装饰不拦截复制，真实刻度仍可聚焦、预览和跳转 |
| `src/sidepanel/features/messages/agent-message-view.js` | Agent 任务卡片与进度呈现 |
| `src/sidepanel/features/messages/reply-state.js` | 回复阶段与思考状态 |
| `src/sidepanel/features/messages/retry-flow.js` | 重试流程辅助逻辑 |
| `src/sidepanel/features/messages/send-guard.js` | 提交和发送状态保护 |
| `src/sidepanel/features/messages/scroll-position.js` | 流式更新时保持阅读位置、识别是否应跟随底部 |
| `src/sidepanel/features/models/model-switcher.js` | 全局顶栏的模型和思考强度选择，普通问答和页面操作共用 |
| `src/sidepanel/features/messages/model-suggestions.js` | 本轮语义追问的提示词、有界问题/回答头尾/来源状态参考和严格结果解析；生产要求 `{question, focus}`，核验具体对象同时出现在原问题/回答及追问中，返回最多 3 条字符串；陈述、泛指、摘录和无依据输出丢弃；旧字符串仅按有效问句过滤显示 |
| `src/sidepanel/features/agent/agent-slot.js` | Agent 观察、Gateway 决策、确认、执行循环、接管与停止；持有任务配置快照与取消所有者；工厂部分失败/释放时清理 DOM、Chrome 和确认监听；循环仍运行在侧栏 |
| `src/sidepanel/features/agent/agent-turn-callbacks.js` | 任务与原会话/消息绑定、回调更新与唯一终态、同会话重新加载后的结果校正 |
| `src/sidepanel/features/agent/agent-task-restart.js` | 失败/停止任务重启的单次准备与取消边界；非忙碌按钮可点显示原因，页面偏好关闭仍须开启；返回仍在原完整 URL 的原标签并重新捕获目标，携带原附件复用既有提交路径；原标签关闭/变址/旧来源缺失不自动改绑或新开 |
| `src/sidepanel/features/visual-context/manual-visual-capture.js` | 图片准备所有权、取消与有界等待；文件还保留固定页面截图和裁剪辅助，当前附件菜单不装配截图/框选入口 |
| `src/sidepanel/features/visual-context/screenshot-region-picker.js`、`region-selection.js` | 保留的冻结截图矩形选择与坐标转换辅助，当前附件菜单不装配；其历史测试不代表现有菜单提供框选能力 |
| `src/sidepanel/features/storage/conversation-save.js` | 显式会话归属的延迟保存和写入队列；Agent 跨会话结果只合并原任务消息 |
| `src/sidepanel/features/storage/storage-state.js` | 存储和同步状态文案 |
| `src/sidepanel/features/welcome/welcome-prompts.js` | 按页面类型生成主/次级入口和四个可编辑话题；点击时生成日期，只用标题/URL 元数据，不预读正文 |
| `src/sidepanel/features/welcome/draft-source.js` | 四类独立话题的来源描述符白名单；与编辑文本分离，随提交/队列/重试保存，避免继承当前网页或 Agent 模式 |

历史导航作为 UI feature 装配，不注册新的能力插槽，也不建立第二套发送、停止或重试流程。普通列表可长按拖动，右键与“⋯”共用操作菜单；分组和对话原位改名，组内新建复用原有会话保存队列。“全部对话”不常驻分组标签，仅拖动时显示目标分组。复选框和批量栏只在“选择多个”后出现；搜索或折叠不丢失已选 ID，确认删除会提示隐藏选择。

顶部和组内新建都只创建临时会话；组内新建写入独立的分组映射，不提前晋升空会话到正式 outbox/文件夹记录。未发送问题时，切换历史或再次新建不会增加空历史记录；已有消息的临时会话仍沿原流程晋升，保留原分组。相关行为回归位于 `tests/history-navigation.test.js`、`tests/conversation-save.test.js`。

入口在生成、提交准备、压缩或 Agent 执行期间阻止删除；所选会话还有排队问题时也拒绝删除。删除先等待已有会话保存队列，再复核条件并调用统一存储入口，每批最多 200 条。删除分组只清理分组归属，对话进入“未分组”，不删除正文；删除对话和恢复的文件语义见下方存储边界。

## 读取、来源和请求

| 文件 | 当前职责 |
| --- | --- |
| `src/background/service-worker.js` | 扩展消息路由、固定目标页面提取、深度读取和截图，校验执行前后页面身份 |
| `src/background/network-reading-service.js` | 普通问答的有界同源 Fetch/XHR JSON 监听；可信发送方、站点授权、任务与页面身份校验，取消与结果限额；不主动请求接口或重放动作 |
| `src/utils/network-reading.js` | 版本化站点接口授权、响应裁剪与字段过滤等网络读取辅助规则；默认不允许，原始网络日志不持久化 |
| `src/utils/network-reading-context.js` | 接口结果归一化、来源校验、小元数据与模型预算序列化；只保留裁剪过滤后的资料及真实覆盖状态 |
| `src/utils/reading-options.js`、`src/utils/reading-assessment.js` | 固定每轮强度/接口选项与有界历史；读取评估字段白名单、缺口说明与版本兼容，旧回合默认基础且不允许接口 |
| `src/content/content.js` | 页面读取消息桥接 |
| `src/content/extractor.js` | 正文、标题、表格、链接、表单标签和原生/ARIA 已选状态及可访问框架内容提取；排除输入值和编辑草稿，不猜 CSS 自绘选择状态 |
| `src/content/aria-snapshot-bundle.js` | 仍随扩展加载的第三方 bundle；正文提取不再调用其会读取输入值的路径 |
| `src/content/page-selection.js`、`src/content/figure-picker.js` | 用户显式选择文字和图表 |
| `src/utils/page-target.js` | 整理页面目标字段，检查标签页、URL 和文档身份 |
| `src/utils/reading-context.js` | 页面上下文归一化与序列化，保留来源标识、有界已选状态、未知与截断说明；兼容旧表单记录 |
| `src/utils/turn-source.js` | 每轮来源元数据、来源匹配、按消息 ID 找回异步保存后的回合 |
| `src/utils/context.js` | Token 估算、消息顺序、每轮来源说明、当前正文放置与请求预算 |
| `src/utils/deep-reading.js` | AX Tree / DOMSnapshot 压缩与合并，过滤可编辑节点及其后代 |
| `src/utils/pdf-reader.js` | PDF 字节读取、逐页文本重排、页目录与预算截断 |
| `src/utils/repository-reader.js`、`src/utils/github-repo.js` | 仓库识别和 GitHub 源码读取 |
| `src/sidepanel/features/page-reading/site-research-slot.js`、`src/utils/research-context.js` | 同站目录与章节补读、研究范围、来源和正文预算；作为当前读取路径使用 |
| `src/utils/visual-intent.js`、`src/utils/page-capture.js`、`src/utils/image-crop.js` | 视觉意图、截图结果和裁剪辅助 |
| `src/utils/llm-client.js` | Gateway 底层的 OpenAI 兼容传输、SSE 解析、非流式文本和 Agent 决策解析、错误/完成判定及既有供应商兼容回退；主业务不再各自直发模型请求 |
| `src/utils/abortable.js` | 有界等待与取消等待；不能撤销已执行的页面动作或已排入存储队列的写入 |
| `src/utils/profiles.js` | 模型库和请求配置 |
| `src/options/options.js`、`index.html`、`style.css` | 六个设置分区、主题与固定保存栏；模型发现与正在编辑的模型独立，固定请求凭据并拒绝迟到结果；连接测试不保存配置，显式保存提交模型设置；本地目录、浏览器控制和站点授权立即生效 |
| `src/options/model-selection.js`、`model-validation.js` | 按模型保存编辑草稿，切换前保留原始数值；保存前验证所有模型的参数，错误附带模型和字段身份 |
| `src/options/settings-navigation.js` | 分区锚点和滚动位置同步，不卸载表单；移动端沿用横向导航 |

普通发送路径直接按照页面开关和固定目标读取当前页。`adaptive-reading.js` 在已取得当前正文后判断是否需要一次补读，灰色情况使用 ModelGateway 的 `reading-decision` 用途；模型只选择有界读取方式，不决定是否绕过页面开关或改读其他标签。旧 `src/utils/reading-decision.js` 的存在不代表生产每次发送都由它选择当前页、旧页或仓库。

阅读强度与接口使用选项随提交、队列和原位重试固定；缺少新字段的历史回合保留基础读取且不自动启用接口。自动补读可选失败保留资料缺口，用户明确指定的必要补读失败、权限拒绝、取消和页面身份变化不能吞掉。补读发生在主回复输出前，不自动重放已经有部分正文的模型生成。

普通问答仅在本轮需要且站点已经允许时短暂监听未来同源 JSON；开启本站设置不会启动监听。相关追问可复用同会话、同标签、完整 URL、文档和基础页面语义内容一致的接口结果，内存缓存最多 4 项、5 分钟，命中不续期；正文仍每轮重新读取，深度结构不在此缓存中。复用前经后台重新确认授权，保留原采集时间并标明未重新监听；变化、截断、明确新鲜度要求、失败或取消不会用旧缓存掩盖。缓存不从持久会话恢复。当前未把网络工具加入 Agent，也没有自动翻页、刷新或接口重放。接口资料按来源与预算归一化后进入当前 `pageContext`，回合保留小元数据。具体范围和验证见[智能补读与接口读取](2026-11-05-adaptive-reading.md)。

`reading-plan.js` 的新页面问答策略在 version 1 内记录可选 `requireCurrentPage: true`：开启必读本页，语言/标题匹配只决定是否补读站内章节。`site-research-slot.js` 在必读本页失败时阻断，不用相关文章掩盖；旧记录缺少此字段时保留原重试语义。关闭页面模式的来源选择位于 UI feature，只在有效选择后进入同一个 ConversationService；不绑定第二套发送、停止或重试流程。页面开关与阅读强度偏好留在当前侧栏，独立的接口站点授权按 version 1 保存在扩展本地存储。

独立话题在 ConversationService 同步固定 requestSource、关闭该回合页面/Agent 范围，不再依赖草稿正文字符串相等。页面提取优先读取固定主文档，附加框架只有 1.5 秒预算；标题或当前小节已匹配的普通主题优先本章，明确站内请求仍可补读。正文不足不能仅凭目录命中完成解释请求。

每轮只存来源元数据。完整正文位于会话的单个 `pageContext` 中，不是完整历史快照库。Token 数是估算，不是精确 tokenizer 结果。

图片预览由 `src/sidepanel/features/messages/image-preview.js` 的 `createImagePreview` 独立控制，委托消息和附件的 `img[data-image-preview]` 点击及 Enter/空格事件。`open` 固定安全的本地图片与名称，原生模态框提供缩放按钮、比例及原始尺寸/适应宽度切换；关闭按钮、遮罩及 Esc 关闭，Esc 阻止底层历史抽屉同时响应。`renderConversation` 调用 `sync`，保留同会话的预览、缩放与位置，关闭跨会话预览；`pagehide` 释放监听和图片引用。用户关闭恢复有效图片节点或输入框焦点，切换与释放不主动抢焦点。预览不访问浏览器页面、模型或保存入口，不改变附件数据和来源。

`features/messages/pasted-text-draft.js` 只管理长粘贴在草稿中的折叠片段及其可见字符锚点。主区和独立追问通过 `getValue/setValue` 对接原 `state.draft` 与应用草稿事件，发送、排队、重试、失败恢复及回退继续使用完整用户字符串；不新增附件、持久字段或主回复入口。纯文本达到 1000 字符或 15 行后形成卡片，最多 6 段、粘贴内容合计 20 万字符，超限明确拒绝而不截断；图片粘贴仍优先使用原附件入口。点击预览只读，编辑展开到 textarea 时按原生控件规则归一换行。

`features/messages/text-preview.js` 提供整页共享的纯文本模态预览，供粘贴卡片和长提问使用。`message-view.js` 仅标记长文本候选，`refresh` 与 ResizeObserver 按实际五行高度决定是否折叠，保留 DOM 全文；主区与浮窗绘制后刷新测量。全文按固定快照显示，选中文字和原复制/回退按钮不触发展开，Esc 优先关闭文本弹窗；同会话重绘保留预览，切主会话关闭，释放后旧观察结果无效。行为测试为 `tests/pasted-text-draft.test.js`、`tests/pasted-text-lifecycle.test.js`、`tests/text-preview.test.js`；独立 DOM 与构建后扩展验证位于 `tests/browser/text-preview.js` 和 `tests/browser/long-text-extension.js`。

`src/sidepanel/features/messages/image-preview-viewport.js` 管理当前预览的平移缩放：默认适应宽度，短图居中、长图从顶部显示；滚轮以鼠标所在图片点为锚，缩放范围为 `min(10%, 适应宽度比例)` 至 800%。左键或单指拖动与方向键平移均受图片边界约束，图片较小的轴保持居中；图片区不使用原生滚动条，滚轮只负责缩放。双击切换适应宽度和 100%，聚焦预览区可用＋/－缩放及 0 复位。指针释放、取消、捕获丢失、窗口失焦和预览关闭均结束拖动；尺寸变化重新核对布局，释放后忽略迟到事件。行为回归为 `tests/image-preview.test.js`；真实 HTML/CSS 交互回归使用 `tests/browser/image-preview.html` 与 `tests/browser/image-preview.js`，浏览器回归不由 `npm test` 运行。

回答选区与单独追问由 `features/messages/article-selection.js`（同一助手正文 Range 捕获）、`article-selection-menu.js`（引用/单独追问工具栏）、`selection-chat-view.js`（独立可关闭的小窗口）、`floating-window.js`（拖动、双向拉伸及视口约束）和 `floating-chat-dock.js`（收起图标及展开）实现；样式位于 `selection-chat.css`。收起仅改变显示，保留回答、输入草稿、滚动位置及执行中的 runtime。`selection-chat-sessions.js` 只跟踪当前主对话的首个追问窗口，后续选区调用其 `acceptSelection` 复用同一分支；关闭后可新建。主会话 ID 因新建、切换或接管发生变化时永久解除跟踪并显示持续提示，旧窗口仍独立可用，返回旧主对话不重新附着。跟踪与图标状态只在当前侧栏内存中，不改变已有历史或存储格式。

`selection-chat-runtime.js` 为每个窗口装配独立状态的现有应用服务与保存队列，首次发送经 conversation-store/outbox 保存为未分组历史，空窗口不提交历史，不使用全局临时会话单槽。新选区沿原来源核验，独立保存为下一问引用；准备与回答中的既有快照不变，旧完成、停止或重试不能消费后来选择的引用，也不因选择追加模型请求。接管确认保存及外部归属后释放旧应用，主区接收独立副本；原对话保留。`source-popover.js` 管理浮窗来源的外点、Esc、滚动、缩放、失焦及重绘关闭，不拦截来源链接。`utils/selection.js` 兼容版本化 conversation 引用，UI 主发送 adapter 使用既有 directModelRequest 选项，网页轮询不能覆盖显式引用；未修改主回复内核或流式解析。行为回归为 `tests/article-selection.test.js`、`tests/article-selection-menu.test.js`、`tests/article-selection-entry.test.js`、`tests/floating-window.test.js`、`tests/selection-chat-runtime.test.js`、`tests/selection-chat-sessions.test.js`、`tests/floating-chat-dock.test.js`、`tests/source-popover.test.js` 与 `tests/selection.test.js`，浏览器范围见[回答选区与单独追问](2026-11-11-article-selection-chat.md)。

当前对话的多处引用由 `features/messages/article-quote-draft.js` 在既有 selection 中创建版本 2 注释包，所有增删改均返回独立副本；`article-quote-view.js` 展示输入框计数、可编辑清单、CSS Highlight 原文及独立编号，不改变 Markdown DOM。`article-selection.js` 固定文本偏移，重绘后仅在同来源消息原文匹配时恢复定位；无法定位仍保留引用资料。菜单确认后才加入草稿，模型/保存继续使用既有 ConversationService 与 outbox 路径。准备阶段阻止引用修改，导航后清理原草稿，迟到完成比较完整注释包；旧单引用与网页选区兼容。新增回归为 `tests/article-quote-draft.test.js`、`tests/article-quote-view.test.js`、`tests/article-quote-lifecycle.test.js` 及更新的菜单/入口/选区测试，实际浏览器范围见上述回答选区说明。

`features/messages/source-icons.js` 的 `createSourceIconFallback` 只管理来源图标：文档捕获 load/error，初次及新插入节点核对缓存自然尺寸，图标缺失/等待/失败时显示默认 globe，成功后显示 favicon；来源按钮与弹出列表共用标记，忽略附件图片，pagehide 释放观察器与监听。回归为 `tests/source-icon-fallback.test.js`、`tests/source-evidence-view.test.js`；真实 HTML/CSS、坏地址及缓存重绘回归为 `tests/browser/source-icon-fallback.html`、`.js`，未更改读取状态或模型请求。

## Agent 执行边界

| 文件 | 当前职责 |
| --- | --- |
| `src/background/agent-service.js` | 观察/动作路由、站点权限、安全强制、快照校验、导航与截图；内部只读 AGENT_VERIFY_UPLOAD 仅核对本任务已交付但 FileList 不匹配的上传，3 秒内重新检查原动作/参考图、许可、同源目标及主/子文档，不改原动作缓存 |
| `src/utils/agent-runtime.js` | 后台任务许可、暂停/取消失效、执行代次、动作串行化与幂等记录；重启后需明确恢复 |
| `src/content/agent-scanner.js` | 元素快照与节点引用、坐标/遮挡/身份校验、DOM 动作和页面接管；正确关联的透明 checkbox/radio 使用可见 label，原生透明文件覆盖区须具名、有界且命中有效；上传消费 FileList 后以局部旧预览基线和原图字节核对新 data:/同源 blob: 预览，读取合计最多 8 MiB，不请求网络图片 |
| `src/utils/agent-schema.js` | 工具 schema、动作校验、决策提示词与结果解析 |
| `src/utils/agent-safety.js` | 密码、支付、删除、提交、跨站等动作风险分级 |
| `src/utils/agent-permissions.js` | 全局开关、站点授权、任务范围授权与撤销；授权读改写使用跨扩展文档共享 Web Lock（无锁环境只保证同模块串行） |
| `src/utils/agent-conversation.js`、`src/utils/agent-evidence.js` | 任务回合、完成摘要与证据整理 |
| `src/utils/agent-reference-images.js` | Agent 图片数量/大小/类型、视觉能力与截图来源校验；为 Gateway 构造不可信参考图片消息 |
| `src/sidepanel/features/agent/task-progress.js` | version 1 子目标/证据、跨读取失败累计、一次重规划和检查点兼容；写任务连续 4 轮无执行进展触发恢复，再 3 轮仍无进展停止；普通读取、计划修改和滚动不续写任务预算，纯阅读保留原扩步规则；状态进展只关联当前 task/tab/完整 URL/document 的成功写操作 |
| `src/sidepanel/features/agent/action-verification.js` | 控件效果、已有状态和文档归属核验，多步写任务识别及当前模型的有界思考升级；仅完整匹配原动作/参考图/代次/新快照/文档的上传预览回执可消除该上传的不确定状态，结果不明不重传 |
| `src/sidepanel/features/agent/decision-context.js` | 按完整页面/文档与实际正文去重；写任务正文节选合计 3000 字符、每份最多 1500，区域摘要另限 3000 字符，保留来源与覆盖/省略说明，完整任务资料及纯阅读规则不改；诊断仅记录输入规模和资料数量 |
| `src/sidepanel/features/agent/visual-observation.js` | 当前主文档 DOM 元素附近的只读局部裁剪；泛计划回退原目标，支持提示词/GIF和紧凑相关控件组，缺失或同类歧义返回明确原因；固定 task/tab/完整 URL/document/snapshot，每任务最多 3 次，同稳定目标一次，JPEG 最长边 960 像素、512 KiB、3 秒内可取消；不调用模型、不执行坐标动作 |
| `src/utils/agent-upload.js` | 本任务参考图的内存登记/撤销、执行代次和原站点绑定、图片预算/类型/文件头校验 |
| `src/utils/agent-diagnostic-fields.js` | 无值差异字段白名单、执行状态/策略与匿名目标/参数关联指纹 |
| `src/utils/agent-region-data.js` | 独立于正文滑动窗口的有界区域行数据、来源、缺失/冲突说明与同字段同单位本地排序 |

后台仲裁动作是否还能执行；侧栏的 Agent feature 负责通过 Gateway 向模型询问下一步。Agent 循环没有迁入 TurnRunner，也没有替换成通用 ToolExecutor。状态持久化不代表 Agent 循环能在侧栏关闭后继续运行。旧 checkpoint 缺少完整会话/消息归属，跨侧栏恢复协议仍需后续完善。

Agent 图片随原用户消息保存，提交模型和参考图片固定后传给 Agent；没有新建第二条主回复路径。`read_region` 只接受当前观察中标记为可读的真实区域 ID，由后台复核任务许可、完整 URL、快照和主/子文档身份，读取限定子树；只读区域不能变成点击或输入目标。观察的样式/矩形缓存只在单次扫描内有效，动作前重新校验。图片与区域记录留在当前任务内；跨侧栏恢复缺少它们时要求从原消息重新开始，不沿用残缺证据继续执行。详见[图片与区域读取交付范围](2026-11-02-agent-visual-region.md)。

`agent-slot.js` 把显式 `inspect_visual` 和一次无进展恢复接到局部视觉服务：显式请求重新观察并唯一匹配稳定目标，自动恢复在新观察中选择当前控件或紧凑相关组，受控捕获后裁剪，图片及不可信来源元数据进入下一次已有 `agent-decision` 请求。没有目标时保留恢复机会，跳过/失败原因进入可见记录、下一轮反馈和诊断；仍受原有三轮恢复预算约束。候选元素 ID 仅帮助定位，点击、输入、上传仍经过后台权限、页面身份、任务许可和幂等检查。当前只支持可见主页面控件；iframe、无候选或无效来源不能降级为任意坐标点击。停止后迟到截图/裁剪不影响新任务。写任务 `executionRequired` 与证据相关性是进度规则，不能替代真实动作或状态核验。验证范围见[透明控件修复](2026-11-06-agent-transparent-controls.md)及[页面感知与复制修复](2026-11-06-agent-perception-and-copy.md)。

自动局部截图无法装入模型上下文时，仅省略该可选图并重新检查完整 DOM 请求预算；显式局部图和原参考图保留必要资料的失败语义。控制、来源、页面或任务许可失效时直接暂停，不继续请求下一步模型。

文件输入框在 change 后清空时，仍保留原上传 uncertain 记录；本次新匹配预览可以通过独立只读核对形成已接受证据，继续现有 Agent 决策与确认。旧预览、计数和文件名不能单独消除 uncertain；核对成功仍不代表服务器处理成功。最新日志定位、图片文件格式与实际验证见[上传接收核对与图片存储](2026-11-06-upload-receipt-and-image-files.md)。

页面操作的入口与执行都要求开启“基于当前页”：侧栏组合向 `agent-slot.js` 注入 `getPageModeEnabled`，Agent 在模式切换、启动、继续以及任务等待前后核验；关闭后沿现有取消流程撤销执行许可，迟到结果不能启动下一步。该条件不替代后台站点授权、目标校验和动作安全规则。侧栏保持 Agent 模式中的页面开关可见且开启，手动关闭先同步取消当前任务并退出操作模式，异步清理固定原任务。普通提问与不可读页隐藏操作行及无效提示，保留独立话题的必要来源说明。UI 状态回归见 `tests/composer-page-controls.test.js`，执行回归见 `tests/agent-slot-timeouts.test.js`。

浏览器操作边界的后续修复见[停止、撤权与观察覆盖修复](2026-11-06-agent-boundary-fixes.md)：后台在派发/发布前复核授权，权限收紧按原执行代次撤销；页面 guard 取消不再等待暂停记录写入，迟到读取受页面变化约束。观察按 frame 轮转分配最多 80 个元素，scanner/后台/模型保留已知遗漏与截断元数据；开放 Shadow DOM 使用逐层命中且保留真实遮罩拒绝。相关回归新增 `tests/agent-scanner-coverage.test.js`，实际扩展验证为 `tests/browser/agent-boundaries-native-extension.js`；未接入长期记忆。

## 存储

诊断不走会话保存队列，也不拥有回合执行权。`diagnostic-observer.js` 在应用装配时观察 Runner 与读取/存储/联网端口；所有归属在调用前固定，忽略逐 token 消息。共享 ModelGateway 的全局观察器记录传输阶段；Agent 从 `agent-turn-callbacks.getDiagnosticContext(taskId)` 的既有所有者索引获取会话身份，后台动作和 scanner 只返回无值的控件校验证据。异常和 Promise 拒绝均不能向主流程传播。

| 文件 | 当前职责 |
| --- | --- |
| `src/utils/diagnostic-log.js`、`diagnostic-store.js` | 独立 IndexedDB 缓冲、7 天保留、匿名关联、目录绑定、状态和按日导出；有界异步 I/O，不修改会话记录 |
| `src/utils/diagnostic-schema.js`、`diagnostic-directory.js` | 事件/字段白名单、加盐标识、不可变分片写入与核验、仅清理可确认属于本安装的过期日志 |
| `src/utils/diagnostic-observer.js`、`agent-diagnostics.js` | 应用/模型和 Agent 观察适配；固定归属、错误分类、无正文证据，隔离日志观察器失败 |
| `src/sidepanel/features/diagnostics/diagnostic-export.js` | 固定日期和对话范围的 JSON 导出，阻止重复点击、取消迟到导出，说明空/不完整日志；侧栏与设置共用 |

详见[诊断日志设计与排查方法](2026-11-06-diagnostics.md)。相关验证为 `tests/diagnostic-*.test.js`、`tests/agent-diagnostics.test.js`、模型传输/Agent/应用组合测试。Node 测试不能替代真实目录权限和 MV3 生命周期验证。

| 文件 | 当前职责 |
| --- | --- |
| `src/utils/storage.js` | 模型配置、临时会话与旧格式记录 |
| `src/utils/local-directory.js` | File System Access 授权、目录句柄和会话文件读写；先完成同根目录图片文件写入，再替换会话 JSON |
| `src/utils/conversation-images.js` | 版本化图片外置与单会话读回；按 SHA-256 共用图片，路径只允许根目录 images/，图片读取 5 秒/单图 8 MiB，内容摘要核验与可见 loadError；不修改浏览器待同步像素 |
| `src/utils/conversation-organization.js` | 当前浏览器中的版本化分组索引、自定义名称、会话归属与列表偏好；按 revision 发布更新，以本地队列/Web Lock 串行读改写，不修改会话文件布局 |
| `src/utils/conversation-outbox.js` | IndexedDB 待写记录和会话目录绑定、版本确认、本地队列与 Web Locks 协调；删除备份/标记与 outbox 移除原子提交，恢复创建新版本并阻止旧快照重写 |
| `src/utils/conversation-store.js` | 临时/本地会话统一入口；先提交 outbox，再写目录；打开单个会话时以此次捕获的目录读回路径图片，历史列表不读全量图片；合并待同步数据并提供重试；历史批量删除、按批撤销和最近恢复记录查询，保留原目录及结果未确认状态 |
| `src/utils/exporter.js` | 用户触发的会话导出 |

写盘失败后保留待同步记录；目录切换不重定向已经绑定的会话。当前没有 `.tmp` 重命名保存协议。

当前会话、模型请求及待同步缓存保留用户消息 `attachments[].dataUrl`；正式磁盘格式以 `imageStorageVersion: 1`、`imagePath: images/<SHA-256>.<格式>` 引用同根目录图片，JSON 不内嵌 Base64。旧内嵌记录仍可打开，下次普通保存时转换。图片写完后才替换 JSON，写入失败继续保留 outbox 像素、原目录和原文件；只读 hydrate 不改磁盘、删除 fingerprint 仍用原始记录。缺图、损坏、版本或路径异常形成附件 loadError，需要该图的发送/重启/导出明确阻断；估算和历史展示仍可用。删除仅移除会话文件，暂不清理共享图片，保留其它引用与撤销。

临时会话仍在 `chrome.storage.local.temporaryConversation`。较大的上传图片可能已经缩放或压缩；这些像素不等同于原磁盘文件的逐字节副本。回退恢复的是当前侧栏内存中的草稿附件，未新增草稿持久化；发送后的会话保存与草稿恢复应分别说明。

分组索引使用扩展本地存储中的 `conversationOrganization`，schema version 为 1；缺少旧记录时按空索引读取，历史对话显示在“未分组”，不会重写正文。损坏或较新版本明确报错，不静默重置。分组、自定义名称和偏好不随磁盘文件夹迁移；删除分组保留对话及名称索引。没有 Web Locks 的环境只保证同模块实例内串行。

会话同步 IndexedDB 升为 version 2，以增量建表保留旧 outbox/目录绑定，新增 `trash` 恢复记录。`trashSavedConversations` 按会话复用写盘锁，先提交完整备份、删除标记和原目录绑定，再调用真实文件删除；删除标记同时阻止旧保存或同步重建对话。等待和读取超时可以在修改前失败，已提交或已发起的操作超时则返回 `pending`，不宣称文件已删。每批区分已删除、待核验和失败，最近尚未撤销的批次可在侧栏重开后恢复。

`restoreTrashedConversations` 可处理已删除及结果待核验的批次，复用原目录，不覆盖内容不同的新文件；恢复先创建带新 generation 的 outbox 版本，避免迟到旧保存覆盖恢复内容，再按原有同步路径写盘。浏览器内恢复成功与文件夹同步成功分开表示；同步失败仍保留待同步正文，恢复等待超时也不等于磁盘操作已经取消。索引和恢复记录均位于当前浏览器，未实现跨浏览器共享分组或云端回收站。

## 修改时的验证入口

| 改动范围 | 相关测试 |
| --- | --- |
| 普通执行所有权、重复命令、取消、唯一终态及迟到事件 | `tests/turn-runner.test.js`、`tests/chat-service.test.js`、`tests/application-root.test.js` |
| 侧栏/设置滚动条按区域显隐、主题同色、横纵滚动、拖条与键盘/触屏 | `tests/browser/scrollbar-appearance.html` 与 `.js` 直接加载生产 CSS，覆盖长短内容、嵌套区域、恒定几何和原生拖条；运行时须取消 Chromium 的 `--hide-scrollbars` 默认参数。2026-11-11 浏览器回归及 `npm run check`（1993 项测试和构建）通过，未调用模型或存储 |
| 浮窗准备/思考/回答动效、成功未读与展开确认、旧事件隔离及减少动态效果 | `tests/floating-chat-activity.test.js`、`tests/floating-chat-dock.test.js`；真实运行时与布局为 `tests/browser/followup-session-dock.js`，构建后扩展为 `tests/browser/article-selection-chat-extension.js`，两者均使用本地模型替身 |
| 消息条件更新、终态、替换重试、跨会话保存和版本校正 | `tests/conversation-repository.test.js`、`tests/conversation-save.test.js` |
| 同主对话追问复用、忙碌时下一问引用快照、主会话切换解除/迟到关闭、浮窗收起展开与来源列表关闭 | `tests/selection-chat-sessions.test.js`、`tests/selection-chat-runtime.test.js`、`tests/floating-chat-dock.test.js`、`tests/source-popover.test.js`；真实 DOM 与应用组合入口为 `tests/browser/followup-session-dock.html`，实际执行范围见[回答选区与单独追问](2026-11-11-article-selection-chat.md) |
| 回退附件/选区深克隆、忙碌阻止、固定会话保存、超时与迟到界面隔离 | `tests/message-rewind.test.js`；实际扩展界面验证范围见[任务重启与附件回退](2026-11-06-message-restart-rewind.md) |
| 原任务标签/完整 URL 固定、fresh capture、原图重启、缺失来源提示、重复点击与取消 | `tests/agent-task-restart.test.js`、`tests/composer-page-controls.test.js`；原生 Chrome 侧栏带图重启/回退重发回归为 `tests/browser/message-restart-rewind-native-extension.js`，真实后台与本地模型替身的验证范围见任务重启与附件回退说明 |
| 模型冻结配置、请求去重、各用途独立失败/取消、截止与底层传输兼容 | `tests/model-gateway.test.js`、`tests/llm-client.test.js` |
| 能力工厂失败/超时/释放、实际 Agent 监听清理 | `tests/capability-host.test.js`、`tests/agent-capability-lifecycle.test.js`、`tests/composition-root.test.js` |
| 上下文 provider 必需/可选策略、隔离、来源去重与预算 | `tests/context-assembler.test.js`、`tests/chat-service.test.js` |
| 历史压缩的可选失败、取消、迟到结果及保存语义 | `tests/context-service.test.js` |
| 历史分组版本兼容、并发/超时、名称与归属、平铺/搜索和隐藏选择、导航与保存锁 | `tests/conversation-organization.test.js`、`tests/history-model.test.js`、`tests/history-navigation.test.js`；长按拖动、菜单、原位改名与多选焦点需浏览器交互验证 |
| 历史真实删除与撤销、目录绑定、待核验/待同步、旧写入与恢复版本 | `tests/conversation-trash.test.js`、`tests/conversation-sync.test.js`；文件授权和侧栏重开恢复需实际扩展验证 |
| 历史提示计时、关闭、暂停、过期与撤销恢复记录分离 | `tests/history-feedback.test.js`；提示消失不影响改名输入与菜单恢复入口需浏览器验证 |
| 设置页多模型草稿、发现与编辑分离、所有模型数值校验和错误定位 | `tests/options-model-selection.test.js`、`tests/options-model-validation.test.js`；保存/测试语义、请求失效、权限反馈、导航与响应式布局需浏览器验证 |
| 主题降级、关键启动等待及跨回合界面绘制 | `tests/sidepanel-boot.test.js` |
| 独立快捷话题、编辑/队列/重试的来源范围 | `tests/welcome-topic-scope.test.js` |
| 当前章优先、完整主题匹配及目录/正文边界 | `tests/reading-scope-regression.test.js`、`tests/reading-plan.test.js`、`tests/default-reading.test.js` |
| 页面模式必读、读取失败/停止、来源选择去重与切页偏好 | `tests/page-mode-submission.test.js`、`tests/page-question-choice.test.js`、`tests/page-read-state.test.js`、`tests/page-control-state.test.js`、`tests/welcome-topic-scope.test.js` |
| 普通发送/停止/队列/重试接入应用服务 | `tests/submission-lifecycle.test.js`、`tests/queue-page-scope.test.js`、`tests/retry-flow.test.js`、`tests/submission-mode.test.js`、`tests/default-reading.test.js` |
| 页面刷新、来源和请求顺序 | `tests/page-source.test.js`、`tests/page-reader-slot.test.js`、`tests/turn-context.test.js`、`tests/context.test.js` |
| 模型驱动检索、原生工具分片与思考续接、来源/公开回退、并发/预算、停止与唯一终态 | `tests/chat-tool-transport.test.js`、`tests/research-answer-loop.test.js`、`tests/research-tools.test.js`、`tests/public-research-transport.test.js`、`tests/model-gateway.test.js`、`tests/chat-service.test.js`、`tests/application-root.test.js`；旧策略测试不代表现有生产编排 |
| 公开网页搜索与模型等待阶段文案、旧联网判断状态兼容，以及 15 秒空输出说明 | `tests/reply-progress.test.js` |
| 页面资料缺口、同页纠错、一次补读、目标变化、必要/可选失败，以及强度/站点设置的迟到与超时 | `tests/adaptive-reading.test.js`、`tests/adaptive-reading-integration.test.js`、`tests/reading-controls.test.js` |
| 会话整理图标、容量提示、预警阈值与详情开关 | `tests/context-control.test.js`；真实 HTML/CSS 预览验证范围见[智能补读交付说明](2026-11-05-adaptive-reading.md) |
| 接口读取的站点授权、任务/文档身份、取消、会话释放、响应过滤和预算 | `tests/network-reading.test.js`、`tests/network-reading-service.test.js`、`tests/network-reading-client.test.js`；真实网络与 MV3 验证边界见智能补读交付说明 |
| 同会话同页接口资料复用、固定到期、语义内容/主题匹配、授权撤销、缓存代次和迟到隔离 | `tests/network-reading-cache.test.js`、`tests/supplemental-reading.test.js`、`tests/adaptive-reading-integration.test.js` |
| 提取隐私和目标竞态 | `tests/extractor.test.js`、`tests/deep-reading.test.js`、`tests/page-target.test.js`、`tests/reading-target-runtime.test.js`、`tests/auto-visual-target.test.js` |
| Agent 生命周期、固定模型、决策失败与权限 | `tests/agent-slot-timeouts.test.js`、`tests/agent-runtime.test.js`、`tests/agent-service.test.js`、`tests/agent-lifecycle.test.js`、`tests/agent-permissions.test.js`、`tests/agent-safety.test.js` |
| 写任务无进展恢复、读取去重/节选预算、局部视觉来源与取消、唯一主终态 | `tests/agent-task-progress.test.js`、`tests/agent-decision-context.test.js`、`tests/agent-visual-observation.test.js`、`tests/agent-decision-loop.test.js`；真实 Canvas/JPEG 裁剪回归为 `tests/browser/agent-visual-crop.js`，普通/2 倍 DPI 共 8 例；原站点和供应商验证范围见页面感知与复制修复说明 |
| 存储重试和目录绑定 | `tests/conversation-sync.test.js`、`tests/conversation-store.test.js`、`tests/local-directory.test.js`、`tests/conversation-images.test.js` |
| 流式响应、取消和滚动 | `tests/llm-client.test.js`、`tests/send-guard.test.js`、`tests/scroll-position.test.js`、`tests/scroll-latest-ui.test.js` |
| 复制格式、导出快照/预算/顺序、下载等待及分页覆盖 | `tests/copy-text.test.js`、`tests/message-copy.test.js`、`tests/export-model.test.js`、`tests/export-download.test.js`、`tests/export-pagination.test.js`、`tests/conversation-export-menu.test.js`；浏览器/PDF验证范围见[复制与导出说明](2026-11-04-copy-export.md) |
| 提问气泡到回退/复制按钮的连续悬停命中、导航遮挡、点击归属、布局稳定、键盘与触屏入口 | Vite 预览使用 `tests/browser/user-message-actions.html` 与 `tests/browser/user-message-actions.js`；实际 `dist` 原生剪贴板回归为 `tests/browser/user-message-copy-extension.js`，已验证 320/544/650px、刻度对齐与展开、原始鼠标点击和剪贴板回读；这些浏览器回归不由 `npm test` 运行 |
| 插槽契约与实例一致性 | `tests/slots.test.js`、`tests/composition-root.test.js` |
| Agent 跨会话回调、重复任务、终态与延迟保存 | `tests/agent-callback-ownership.test.js`、`tests/agent-turn-idempotency.test.js`、`tests/conversation-save.test.js` |
| Agent 图片提交、保留的截图辅助、区域行数据与排名覆盖 | `tests/agent-image-submission.test.js`、`tests/agent-reference-images.test.js`、`tests/manual-visual-capture.test.js`、`tests/agent-region-data.test.js`；后台与真实 scanner 行为另见 `tests/agent-service.test.js`，附件菜单不再提供截图/框选入口 |
| 模块文档与入口导航 | `tests/module-map.test.js` |

新增功能时优先明确数据归属、目标身份、取消与保存边界，再决定是否提取插槽。同步更新本地图；不要仅因为文件已经存在，就把尚未接入的设计描述为生产路径。

统一验证入口为 `npm test`（项目测试）和 `npm run check`（项目测试及构建）。以上矩阵是相关回归入口，不能把 Node 替身测试和构建成功当作所有模型供应商、真实网页与 MV3 生命周期已经实测。

## 操作手册与发布工具

`docs/USER-GUIDE.md` 是操作手册原文，`docs/images/` 保存配图，`docs/user-guide-reader.css` 定义阅读版布局。`npm run docs:build` 执行 `scripts/render-user-guide.mjs`，核对版本并生成带目录、图解索引和内嵌图片的离线 `docs/USER-GUIDE.html`；滚动条外观复用生产样式。新增配图须保留唯一编号与图注，HTML 与 Markdown 一起提交。

`tests/browser/user-guide.js` 对未经开发服务器注入脚本的阅读版做浏览器检查：从内存提供文档并断网加载资源，验证图注、目录、内嵌图片、六种视口宽度和宽图键盘滚动。它不由 `npm test` 自动运行，不需要扩展配置或模型服务。

`scripts/package-release.ps1` 在最终测试、构建与代码提交后运行，要求 PowerShell 7 和干净工作区。它校验源文件、锁文件、构建版本与扩展入口，再生成 ZIP 并逐文件核对 SHA-256，校验记录写入忽略目录 `output/`。`dist/`、安装包及本地验证记录不进入源码提交；脚本不推送提交或创建标签。
