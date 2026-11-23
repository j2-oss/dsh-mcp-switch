# MCP 工具开关 (dsh-mcp-switch)

给 DeepSeek Harness 加一个开关面板：**MCP 服务默认全部关闭，只把你在意的服务工具发给模型**，把每轮请求里那几万 token 的工具定义省下来。

## 它解决什么问题

DSH 里每接一个 MCP 服务，它的全部工具定义都会随**每一次**请求重发一遍。
接 5 个服务、157 个工具时，光工具定义就约 4.7 万 token／轮——不管你这一轮用不用得上。

装上这个插件后：

- 默认全部关闭，请求里只剩 DSH 自带的基础工具
- 需要哪个服务，在设置里点亮，或者直接对模型说「打开 serena」
- 关闭只影响可见性：不发送工具定义、不消耗 token；连接保留，打开立即可用

实测（真实请求记录）：

| 状态 | 工具数 | 工具定义 token |
|---|---|---|
| 全部打开 | 157 | 约 47,000 |
| 只开 io-draw | 63 | 约 19,500 |
| 全部关闭 | 59 | 约 15,800 |

## 安装

本插件是 DSH bundle，需要本地安装：

1. 把本目录放到任意位置（例如 `C:\Users\<你>\.dsh\bot\workspace\mcp-switch`）
2. 打开 DSH → 插件 → 添加插件 → 选择这个目录
3. **重启 DSH**（Host 代码与新界面模块需要重新加载）

安装后：

- 设置 → 侧栏出现「MCP 工具开关」
- 模型多了一个 `mcp_switch` 工具

## 使用

### 界面

设置 →「MCP 工具开关」：每个服务一行，右侧是开关，行内显示工具数和状态；上方有「全部开启」「全部关闭」和当前统计。

### 对话

- 「把 serena 关掉」
- 「打开 io-draw」
- 「现在哪些 MCP 在吃 token？」

模型会调用 `mcp_switch`：

| action | 参数 | 结果 |
|---|---|---|
| `list` | — | 每个 MCP 服务的工具数与开关状态 |
| `enable` | `server` | 恢复该服务的工具 |
| `disable` | `server` | 从下一步起隐藏该服务的工具 |

服务键就是工具名中间那一段：`mcp__github__create_issue` 属于 `github`。

## 实现

- **界面部分**：`client.js` 注册 `settings.section` 与 `settings.section.icon`，用 React 渲染开关；通过同源 `fetch` 调用 Host 接口。
- **Host 部分**：`index.js` 注册 `mcp_switch` 工具、两个 JSON 接口，并按 agent 应用 `ctx.tools.restrict({ deny })`：被关闭服务的工具名进入 deny 列表，请求组装时就不会出现。
- **状态**：`<DSH_HOME>/mcp-switch.json` 的 `enabled` 数组（默认空 = 全关）。每次创建 agent 时重新应用，重启后保留。
- **零外部依赖**：本地链接安装的 bundle 解析不到 `@deepseek-ai/*`，因此插件没有 import 任何 DSH 包，工具定义用原生 JSON Schema 书写。

接口：

```text
GET  /mcp-switch/state   → { servers: [{ server, tools, enabled }], enabled: [string] }
POST /mcp-switch/set     ← { server: string, enabled: boolean } → 同 state
```

## 限制

- 只控制 **MCP 工具**。DSH 自带的基础工具（文件、终端、web 等，约 1.5 万 token）不在范围内。
- 控制可见性，不卸载服务、不断连接。
- 完全没连接的服务（未注册任何工具）不会出现在列表里。
- 仅覆盖全局注册的 MCP 工具；agent 作用域内注册的工具不受影响。
- 依赖 DSH 的 `ctx.tools.restrict()` 与 `webServer` 服务名，升级 DSH 大版本后可能需要跟着调整。

## License

MIT
