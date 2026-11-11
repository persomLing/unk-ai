# 浏览器操作边界修复

本次修复来自[浏览器操作经验方案的现状审查](2026-11-06-browser-operation-memory-plan.md)。没有接入长期记忆，也没有改变普通问答的发送、重试或流式协议。

## 本次行为变化

### 停止与授权

- 停止先撤销后台执行代次，并立即向页面投递该代次的取消，不再等 session 存储写完才撤销页面 guard。暂停记录和页面清理的外部等待各有 2 秒上限，写入仍按原顺序完成。
- 暂停记录超时返回明确的未确认状态。已经发给浏览器的动作仍可能发生，停止不能解释成撤销动作；原动作串行队列和执行意图记录继续保留。
- 导航和 DOM 动作在最后派发前重新核对全局控制、主站、目标 iframe 与跳转目的站授权，并使用当前严格模式重新判断是否需要确认。新增权限读取最多等待 3 秒，超时不执行动作。
- 全局关闭、严格模式收紧、相关站点撤权会使当前执行代次失效；新增无关站点授权不暂停任务。权限事件固定原任务和代次，迟到事件不能暂停新恢复的执行。
- 观察必须取得真实主框架，并在发布前核对当前完整 URL、主/子文档身份与授权；导航或关闭页面时取消尚未完成的读取，防止迟到结果重新发布。

实现位于 `src/background/agent-service.js` 与 `src/utils/agent-runtime.js`。授权收紧后的任务需要重新核对授权并明确继续，不能直接沿用旧快照执行。

### 控件覆盖

- 保持一次最多返回 80 个元素。后台按已授权 frame 轮转取候选，避免主框架占满后 iframe 控件完全无法进入观察。
- scanner 与后台分别记录本层已经识别但未返回的候选；模型输入经白名单保留 `candidateTruncated`、`omittedCount`、`returnedCount`。
- `scanTruncated` 表示扫描工作或候选返回不完整；`omittedCount` 只是已知遗漏，不包含未扫描区域的未知数量。模型不能把未返回的控件认定为不存在。
- 本次未新增区域补扫工具、无限候选列表或跨访问语义定位。

实现位于 `src/content/agent-scanner.js`、`src/background/agent-service.js` 和 `src/utils/agent-schema.js`。

### Shadow DOM

scanner 版本升为 12。命中检测从 document 开始，只沿实际命中的开放 shadow host 逐层向内核验，支持开放及嵌套 Shadow DOM 的可见按钮、输入框和关联原生标签。交互 host 自身包含装饰性 shadow 内容时也保留正确命中。

真正遮罩、缺失/空命中、语义改变、取消任务以及标签关联改变仍拒绝操作。透明上传区仍要求实际命中原输入框，不因位于 shadow 内放宽限制；关闭的 Shadow DOM 未新增支持。

## 回归测试

正式 Node 行为回归先验证修复前失败，再修改实现，覆盖：

- 最后一次 tab 读取期间关闭控制、撤销主站/iframe/目的站授权，动作不得发出。
- 观察期间撤权、当前主/子文档替换、缺少主框架，结果不得发布。
- 停止时挂起 session 写入，页面 guard 仍及时失效；旧 epoch 中断、迟到持久化错误不得修改新执行。
- 严格模式收紧、新增无关授权、重复启动及作用域保持。
- 90 个按钮、调用者较小上限、滚动候选配额和跨 frame 合并，准确报告已知遗漏。
- Shadow DOM 单层/嵌套按钮、输入、透明选择标签、交互 host、真实外部/内部遮罩及上传覆盖区。
- 覆盖字段进入模型时过滤未知内容，并计入消息自身的元素裁剪。

相关入口：`tests/agent-service.test.js`、`tests/agent-runtime.test.js`、`tests/agent-scanner-coverage.test.js`、`tests/agent-schema.test.js`。

实际浏览器回归为 `tests/browser/agent-boundaries-native-extension.js`，通过 Playwright CLI 在新建隔离 Chromium profile 加载当前 `dist`，使用原生侧栏作为消息发送方，执行真实 worker 和 content scanner。HTML/iframe 在测试中本地提供，没有调用模型或真实业务站点。重新构建后使用新测试 profile 或明确重新加载扩展，避免持久 profile 的旧 worker 缓存混入。

旧版实测：主框架占满 80 后 iframe 候选为 0，未标记截断；单层和嵌套 shadow 按钮均误报遮挡。修复版的相同场景包含 iframe 控件并报告裁剪，shadow 按钮可点击且真实遮罩仍阻断。另验证真实 shadow 输入/透明 checkbox、实际 storage 撤权后 iframe 不点击、取消后旧任务不能继续观察。

浏览器回归命令示例（配置须指向本机 Chromium、新建 profile 与项目 dist）：

```powershell
playwright-cli -s=agent-boundaries open about:blank --config=output/playwright/agent-boundaries.config.json
playwright-cli -s=agent-boundaries run-code --filename tests/browser/agent-boundaries-native-extension.js
playwright-cli -s=agent-boundaries close
```

## 验证边界

最终 `npm run check`：**1716 项测试全部通过，0 失败、0 跳过；Vite 构建通过**。日志为 [fixes-npm-check.log](../output/browser-memory-review-2026-11-06/fixes-npm-check.log)。构建保留原有的大 chunk 与 theme-boot 脚本提示。

最终构建在全新隔离 profile 中通过 **8 个原生扩展场景**：跨框架覆盖、单层 shadow 点击、嵌套 shadow 点击、真实遮罩拒绝、shadow 输入、透明 checkbox 标签、实际授权撤销、取消后拒绝旧任务观察。该页面 96 个候选最终返回 80 个，包含 1 个 iframe 控件，明确报告已知遗漏 16 个。

全量回归曾发现新增说明挤占 8K 模型重试预算，现已合并到原说明并保留原预算测试，未提高测试模型窗口或削减必要任务/工具字段。最终日志对应修正后的源码。

浏览器夹具验证不等于所有网站、关闭的 Shadow DOM、全部 MV3 生命周期或模型服务都已实测；挂起存储与精确竞态由 Node 可控调度回归验证。

浏览器证据保存在 `output/playwright/agent-boundaries-before.log`、`agent-boundaries-after.log` 与 `agent-boundaries-native-extension.png`。这些输出不属于 npm test 自动发现范围；正式源码测试仍只运行 `tests/*.test.js`。

后续独立工作包括记忆 MVP、定向区域补扫及旧 checkpoint/迟到接管消息的完整恢复协议，本次未宣称实现。

## 重新打包

2026-11-06 17:53（北京时间）重新构建并更新根目录 [unk-ai-v0.18.1.zip](../unk-ai-v0.18.1.zip)，保留版本号 0.18.1。ZIP 根目录直接包含 manifest.json，277 个文件逐项 SHA-256 与此次 dist 一致，大小 3,773,135 字节。

包 SHA-256：`e8bc2463faafde8b13d8d40167b342591961fcf807c65bf7f63274553e41fa6d`。逐文件记录见[重打包校验](../output/package-v0.18.1-browser-boundary-validation.json)。旧包已备份到 `output/unk-ai-v0.18.1-before-browser-boundary-fixes-20261106-175355.zip`。
