# 浏览器扩展的跨页阅读：静态样本对比

日期：2026-10-30。问题：为什么侧栏助手可能继续阅读目录中的章节，以及 UNK AI 应补什么能力。

结论是：**读取当前页正文、识别章节链接、访问下一页、选择阅读顺序和生成总结是不同环节。** 本地扩展包只能证明它包含哪些页面桥接和浏览器执行能力，不能据此复原远端模型如何选择链接、搜索或组织上下文。

## 1. 样本和证据边界

仅检查以下已安装扩展目录中的发布文件；没有操作真实 Chrome、调用模型、访问远程 iframe、读取 Cookie/登录会话或修改扩展。

| 样本 | ID / 版本 | REA 主证据 |
| --- | --- | --- |
| 名称为 DeepSeek AI 的样本，不能仅凭名称认定为 DeepSeek 官方产品 | `fgbieegonkgdlkmeaapmkejdlfalonkb` / `3.1.0` | `ev_53e461178640e4d7a0b0ee8a54587d6ffad28f6cf53550e746aa0f47596af952` |
| ChatGPT | `hehggadaopoacecdllhhajmbjkdcmajg` / `1.26.1020.11845` | `ev_da0446607fea7d9ebbee451dd7e7d312fe393b113a795870668262e64109743d` |

样本目录结构为 `<Chrome 用户数据目录>/<配置目录>/Extensions/<ID>/<版本>_0`；个人用户目录和浏览器配置目录名称已省略。

DeepSeek AI 根摘要为 `daaacca9dd042b296c6a7b6b522033aed66b011f48284e7788240388239ab79d`；ChatGPT 根摘要为 `e8ead3dc8254c3579b2bf407fa75dc077848550c4c3cf9be572c8bbdab60f33e`。

本机 REA CLI 未提供 `detail: summary` 参数，因此完整记录先保存到 `output/*-extension-evidence.json`，再用 `inspect-analysis-view` 查看摘要和指定模块，未执行 bundle。DeepSeek AI 复用已有记录：64 个相关文件、6 个 JS 文件、0 个解析错误；应用图完整，语义关系仍有未知。ChatGPT：30 个相关文件、19 个 JS 文件、0 个解析错误；**应用图及语义图均为 partial**，`background.js`、`chunks/js-kernel-host-B4ilWFF8.js` 的语义分析耗尽 worker heap，另四个文件的语义图受总结果预算限制。没有把“未进入语义图”当成“功能不存在”。

摘要视图：DeepSeek AI `output/deepseek-extension-summary.json`；ChatGPT `output/chatgpt-extension-summary.json`（视图 ID `ev_a514aaa68f7dc46d7041951e7de8d85ae9faab34f0d0885690c7a81872771f68`）。下述细节以发布文件的有界原始代码片段佐证，和 REA 的图观察分开说明。字符偏移为 JS 字符串的零基 UTF-16 偏移，便于核对压缩文件。

## 2. DeepSeek AI：远端界面 + 当前活动页文字桥

已核实的发布代码：

| 观察 | 位置 | 含义 |
| --- | --- | --- |
| 侧栏从 `iframeUrls.sidepanelPage` 创建 iframe，配置指向 `https://deepseek-ai.easytool.dev/en/new-chat?ref=ext&sidepanel=true` | `chunks/sidepanel-DVjYdWiO.js`；`chunks/iframe-service-ESG9jlZp.js` 第 1 行 | 对话界面来自远端页面，本地包并未包含这张网页的完整实现 |
| `handleMessage` 检查 `event.origin === trustedOrigin`，将 `pageContentRequest` 分派给 `handlePageContentRequest` | iframe service 第 549 行，偏移 30184 | 远端页面可以请求本地页面内容；这里没有看到对 `event.source` 的同一检查，不能据此宣称整套消息权限已被验证 |
| `handlePageContentRequest` 检查 all_urls/scripting 权限，再给 background 发同名消息，结果通过 `pageContentResponse` 返回 iframe | iframe service 第 549 行，约偏移 32400–33300 | 本地侧栏是请求和响应的桥 |
| background 查询 `{active:true,currentWindow:true}`，向主 frame 注入读取函数 | `background.js` 第 1 行，偏移 1574 附近 | 目标是处理请求时的活动标签页，没有由此证明请求发出时已固定页面身份 |
| 克隆 body，移除脚本、导航、侧栏、表单等节点，用 TreeWalker 收集文本 | `background.js` 第 1 行，偏移 2208 起的 `function D()` | 抽取正文的启发式规则较简单，可能连同导航中的章节目录一起移除 |
| 返回 `{url,faviconUrl,status,title,pageText}` | `background.js` 第 1–5 行，`const G=D()` 后 | 该结果是文字和页面元数据，**没有返回独立的 anchor href 列表**；普通锚文本不会自动携带目标 URL |

检查了该样本全部 6 个 JS 文件，并具体阅读两个消息分发 switch。所见 bridge 分支是侧栏开关、全屏切换、页面内容和存储；`tabs.create` 的可见用途是欢迎页、全屏本地页面等。**在这条本地桥接协议中未发现任意 URL 读取、章节链接展开或递归抓取分支。** 这是对已检查本地协议的结论，不是对远端服务能力的否定。

因此，如果实际产品在没有本地导航的情况下输出了后续章节总结，可能由远端网页/服务拿 URL 继续获取、搜索服务补充、已有知识或其他未观察路径完成。静态包无法在这些解释中作出选择，也不能保证内容确实来自后续章节。

## 3. ChatGPT：远端界面 + 通用浏览器工具执行端

ChatGPT 样本也使用远端 iframe：`chunks/codex-work-sidepanel-CCrbBg1a.js` 第 1 行偏移 4438 附近，默认 URL 为 `https://chatgpt.com/?surface=browser_side_chat`；偏移 15536 的 `function D` 创建 iframe 并设置 `src`。

它另外包含以下本地代码：

| 观察 | 位置 | 可以支持的判断 |
| --- | --- | --- |
| 注册 MCP `tools/list`、`tools/call` 和名为 `js` 的工具；schema 要求 `code`、`instance_id` | `background.js` 第 32 行，偏移 174300–175600、188520 | 扩展提供通用脚本工具入口，远端调用不局限于“给我当前页一段文本” |
| `handleJsCall` 检查实例/任务上下文及浏览器控制许可，随后调用 scoped kernel 的 `executeJs(e.code, ...)` | `background.js` 第 32 行，偏移 191000–193700 | 存在将请求交给本地 kernel 的路径；许可检查的完整运行时效果未验证 |
| Manifest 声明 `js-kernel.html` 为 sandbox page，并包含 offscreen / host / kernel 文件；sandbox `connect-src 'none'` | `manifest.json`；`js-kernel*.html` | 脚本执行端被拆为专用组件；不能因此声称任意 JS 获得任意网络或页面访问权 |
| 本地 API 定义包含 `goto(url)`、`domSnapshot()`、只读 `evaluate(...)`、locator `getByRole(...)` 与 `get_visible_dom()` | `chunks/js-kernel-host-B4ilWFF8.js` 第 65–66 行，偏移 217897、287345、295222、296165、296923 | 发布包明确携带导航、DOM 阅读和定位交互的工具接口；具体可用性依浏览器 provider 和权限而异 |
| `browser_user_get_tab_context` 路径先获取用户标签页当前 URL，再调用 `observeContent(...).assert()` 和 `getTabContext` | kernel host 第 60 行，偏移 133353 附近 | 页面上下文读取是一个有 URL/权限检查的独立能力 |
| `getTabContext` 先尝试 PDF 上传路径，否则通过 `executeTabRead({tabId,expectedUrl,read})` 读取 | kernel host 第 4398 行，偏移 1086929 | PDF 和网页上下文有不同分支，普通网页读取携带 expectedUrl |
| 子标签创建路径验证 HTTP(S)，创建 about:blank，claim child tab 后再 `tabs.update(...,{url:i.href})` | `background.js` 第 38 行，偏移 372353 附近 | 本地具备以任务归属方式打开后续网页的执行基础，并非只有文本抽取 |

上述原始片段保存于 `output/chatgpt-extension-static-excerpts.json`。REA 模块身份视图为 `ev_5290cb7667ea3432c60c888cde21c3a690dafa438cdbdcba1d1c6480f8278f7a`；background / kernel-host 单项视图为 `ev_82e2cd0fb29bcf04d7546ec7fba379b9b7aa7620363f9f7b0118af5d8da8a4e7`、`ev_934d659960aded65c4446b22db72f123b8e88e79bd964cb0bb137a6017b15823`。后两者保留模块身份和部分静态验证候选，不含完整语义调用链；表中的细节不能冒充 REA 已完成的动态追踪结果。

这些机制使“读当前 DOM → 识别链接 → 导航/点击 → 读取下一页”成为可实现的工具工作流。**本次没有观察一次真实的跨章节总结会话，不能证明某次回答采用了这条流程。** `web_search` / `search_query` 字面量没有在重点本地入口中出现；这个有界搜索既不能排除远端搜索，也不能证明使用了搜索。已看到的 `search_browser_tab_mentions` 是标签页提及搜索，不能当成互联网搜索。

## 4. 对 UNK AI 的意义

| 环节 | DeepSeek AI 样本已证实 | ChatGPT 样本已证实 | UNK AI 的设计选择 |
| --- | --- | --- | --- |
| 当前页正文 | 页面请求桥返回纯文本 | 独立上下文读取及 DOM 工具接口 | 保留稳定的页面身份，并让正文读取成为明确的只读工具 |
| 章节目标发现 | 上述正文返回值不含链接地址表 | DOM/locator/导航接口可供调用 | 从观测中保留真实 href/元素证据，避免让模型猜 URL |
| 继续阅读 | 本地桥未证实 | 有导航/点击和子标签执行基础 | 先以已授权的当前主文档读取配合已有动作；跨页后重新观测、重新核对授权 |
| 选择阅读范围 | 远端未知 | 远端规划未知 | 由模型提出下一步，运行时核对 task、snapshot、URL 和文档身份 |
| 最终总结 | 远端未知 | 远端未知 | 总结直接使用已成功读取的正文及来源，不能把动作次数当成读到内容 |

建议按第二种探索方向补“观测—动作—正文阅读—总结”闭环，而不是只在固定 DOM 位置寻找“下一章”。最小新增能力是 `read_page(query?)`：query 用于选取当前页相关段落；它不是 selector、JS 或任意 URL 执行入口。正文预算、超时、取消、页面身份核对都应由后台控制。前台应清楚显示实际读过的页面，读取为空、跨文档变化或授权失效应作为失败处理。

这是结合 UNK AI 现有约束作出的方案，不是对任一样本远端系统的复制。网站特定目录解析、跨域链接授权、搜索与长期资料库属于后续独立能力；本次静态调查没有替它们给出已验证的竞品实现。

## 5. 本轮实际交付的两条路径

0.17.5 在上述静态调查之后新增显式“阅读研究”，与“页面操作”互斥。研究通过页面真实目录和可解释的 Docsify 配置读取少量公开同站资料，不接管用户标签；本次覆盖截图站点运行时翻译插件追加的单通配 alias，而不执行页面提供的任意正则或脚本。静态包所见竞品行为没有被当作本项目远端搜索能力的证明。

页面操作保留原授权、暂停、接管与取消机制，新增受页面身份保护的 `read_page` 正文工具、动作后观察反馈、来源信息及模型上下文预算。直接显示已生成的完成总结；失败任务的重新开始保持任务类型并生成新任务标识。

研究只在用户主动选择能力并发送时获取资料。GET 限当前站点公开地址，拒绝 IP、localhost、常见内部域名、凭据、非默认端口与动作地址，且不带 Cookie。浏览器端不能在 fetch 前可靠验证域名最终解析到的 IP；这些约束不构成通用网络隔离器。研究与 Agent 都不实现通用全网搜索、长期知识库或竞品的远端调度系统。
