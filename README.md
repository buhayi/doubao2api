<div align="center">
  <img src="avatar.png" width="76" alt="豆包工作" />
  <h1>豆包工作 · 通用 API 网关</h1>
  <p>独立浏览器登录 · OpenAI 兼容接口 · API Key 鉴权 · 动态模型 · 流式对话</p>
</div>

非原创，改的别人的项目

### AI写的说明不像人类，打开powershell输入npm start启动，打开 `http://127.0.0.1:8786` 进入网页端账号池管理台。输入npm run start:work-client启动客户端版，打开 `http://127.0.0.1:8788` 进入网页端账号池管理台，缺点是需要后台挂着豆包工作客户端，优点是可以需要人机验证时叫能工智人来验证。

文本默认**隐秘发送**，收到完整回复后**删除本次豆包会话**。取消、超时也清理；删除失败可在接入配置查看“删除未完成”。

已安装 Windows **豆包工作客户端**的用户，还可以运行 `npm run start:work-client`，或双击 `start-work-client.cmd`。客户端版自动导入本机登录，管理台 `http://127.0.0.1:8788`，API `http://127.0.0.1:8789/v1`；使用说明见 [客户端版](docs/WORK-CLIENT.md)。

管理台支持单账号 **探活** 和 **全部探活**：发送一次 `hi` 简短对话，确认账号实际可用，可能消耗少量额度。全部探活包含失效和手动停用的账号，并显示完成进度。

探活、会话检测或正常 API 调用返回上游错误时，账号自动归入 **失效账号**，保存错误原因并退出可用账号池；默认账号失效后切换到其他可用账号。失效状态重启后仍保留，探活通过或重新登录后恢复，手动停用状态保留。客户端参数错误、网关并发限制和主动取消不会归入账号失效。

支持自定义地址的 OpenAI **Chat Completions / Responses** 和 **Claude Messages** 文本协议，适用于相应模式下的 Cherry Studio、Chatbox、Open WebUI、OpenAI SDK、Anthropic SDK 等。客户端应允许填写自定义模型 ID，或通过模型列表加载。具体第三方客户端尚未逐个实机验收。

运行时无 npm 依赖，需 Node.js **22 或更新版本**。网关运行无需 Python 环境或图片识别模型。

源码目录保留代码、测试、文档、许可证和 `.env.example`。实际运行请使用独立目录，账号、API Key、`.env`、本地 Python 环境及备份都留在运行目录；源码与运行目录的整理方式见 [发布与本机运行](docs/PUBLISHING.md)。

## 1. 在网关机器上登录一次

Windows PowerShell：

```powershell
npm run login
```

- 自动打开独立 Chrome / Edge 登录窗口；按豆包官网流程扫码、输入手机验证码，并完成官网自身要求的验证。
- 在浏览器打开终端给出的 `http://127.0.0.1:随机端口/随机路径/` 确认页面，点击 **接入网关**，完成身份核验后保存账号。
- 不是日常浏览器资料，不会替换日常登录；不需要把 Cookie 或验证码粘贴到客户端。
- 确认页面和临时浏览器只在登录期间存在，结束或取消后关闭；登录流程最多持续 10 分钟。

指定浏览器或兼容模式：

```powershell
npm run login -- --browser edge
npm run login -- --browser chrome
npm run login -- --loopback
```

## 人机验证处理

遇到官网人机验证时，网关返回 `verification_required` 错误，本次请求停止。Windows 客户端版会同时将已安装的豆包工作恢复到前台；客户端未运行时正常启动。请在对应账号中人工完成验证，然后在管理台点击“验证完成后探活”，通过后重试请求。并发提醒会合并；之后再次收到验证要求时，会重新将豆包工作弹到前台。普通网关版仍直接返回验证错误。

HTTP 拒绝和流式响应中的验证拒绝使用相同的处理方式。网关保留隐秘发送与回复后删除会话的行为；不会自动识别验证码或重发被拒绝的原请求。Windows 阻止窗口置前时会恢复窗口并闪烁任务栏，提示用户点击客户端。

需要更新账号时，可在管理台主动点击“添加账号”重新登录，或运行 `npm run login`，完成官网正常登录流程后再发起新请求。详情见 [人机验证说明](docs/CAPTCHA.md)。

## 2. 启动网关，获取客户端密钥

```powershell
npm start
```

保持这个终端运行。在另一个终端查看密钥和模型：

```powershell
# 切换到启动网关时使用的同一个目录
npm run key
npm run models
```

首次运行 `npm start` 或 `npm run key` 会自动生成随机密钥，保存在 `data/config.json`；重启不会换密钥。启动日志不输出密钥。也可通过 `.env` 设置自己的密钥。

## 3. 客户端只需填这些内容

| 配置项 | 内容 |
| --- | --- |
| 提供商 / 接口类型 | **OpenAI Chat Completions / Responses，或 Claude Messages** |
| OpenAI Base URL | **`http://127.0.0.1:8787/v1`** |
| Claude SDK Base URL | **`http://127.0.0.1:8787`**（SDK 自动追加 `/v1/messages`） |
| API Key | `npm run key` 输出的 `sk-dw-…`，或你配置的 `DW_API_KEY` |
| 模型 | 从客户端“获取模型”加载，或填写 `npm run models` 返回的 **id** |

### DeepSeek Harness

DSH 使用 OpenAI Chat Completions 并开启流式输出。携带工具时，普通回答和思考逐段流出，工具 JSON 等完整校验后发送。

“Deep diving” 和首 token 的时间包含客户端超时重试。需要直接观察首次失败时，在该 provider 的 `retryPolicy` 中设置 `mode: normal`、`maxRetries: 0`。网关没有提供真实 token 用量，DSH 的 `0 tok/s` 无法用于测速。

## 可选配置

无需 `.env` 即可运行。需要定制时：

```powershell
Copy-Item .env.example .env
# 编辑 .env 后重新启动网关
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DW_HOST` | `127.0.0.1` | 默认仅本机监听 |
| `DW_PORT` | `8787` | HTTP 端口 |
| `DW_ADMIN_PORT` | `8786` | 本机账号池管理台端口；设为 `0` 可在 `npm start` 时禁用 |
| `DW_API_KEY` | 空 | 空时自动生成；自定义可填非空字符串，如 `123`、`abc`，不要求长度或前缀 |
| `DW_DATA_DIR` | `./data` | 独立私有数据目录；所有管理命令应使用同一目录 |
| `DW_ACCOUNT_ID` | 空 | 可固定账号 UID，优先于默认账号 |
| `DW_CORS_ORIGINS` | 空 | 默认不允许网页跨域；逗号分隔来源，如 `http://localhost:3000,https://chat.example.com`，不含路径和末尾 `/` |
| `DW_PROMPT_TOOLS` | `true` | 实验性提示词工具桥，设为 `false` 可关闭 |
| `DW_DELETE_HISTORY` | `true` | 回复完成、取消或超时后，删除本次上游会话；设为 `false` 保留会话 |
| `DW_TIMEOUT_MS` | `120000` | 每次 HTTP 请求最长时间，范围 1000–600000 ms |
| `DW_MAX_CONCURRENCY` | `3` | 每个账号最多同时进行的对话数，三种协议共享，范围 1–16 |
| `DW_UPSTREAM_MIN_INTERVAL_MS` | `1000` | 同账号上游请求开始时间的最小间隔，范围 0–60000 ms；流式回复结束后才处理下一个上游请求 |
| `DW_UPSTREAM_QUEUE_LIMIT` | `16` | 同账号最多等待的普通上游请求数，范围 0–128；另预留一个历史删除位置，排队取消不会发送请求 |
| `DW_RATE_LIMIT_COOLDOWN_MS` | `60000` | 上游限流未提供 `Retry-After` 时的冷却时间，范围 1000–900000 ms |
| `DW_USAGE_CACHE_TTL_MS` | `30000` | 额度查询缓存有效时间，范围 0–300000 ms；设为 0 仍合并正在进行的相同查询 |

两种版本的同账号上游请求统一串行，覆盖对话、模型、额度、身份核验和历史删除。多个已受理的对话会排队，HTTP 请求总超时仍包含排队时间。回复结束后优先删除本次会话，再处理排队请求，删除同样遵守请求间隔和冷却。模型目录缓存 5 分钟，额度缓存 30 秒；并行读取共用一次查询，单个调用方取消不会取消其他调用方需要的结果。

上游返回限流时遵守 `Retry-After`（秒数或 HTTP 日期，最长 24 小时），缺少该响应头时冷却 60 秒，并返回可供客户端读取的 `Retry-After`。冷却期间不继续向该账号发送请求，也不自动重试。验证或限流拒绝会停止当时已排队的请求；需要人工验证的账号继续按原流程处理。限流期间的历史删除可能因清理超时失败，管理台会保留删除失败状态。

这些调整参考 [lza6/doubao-2api](https://github.com/lza6/doubao-2api) 的状态复用思路，以减少重复查询和请求峰值。该项目使用普通豆包接口，当前网关保留豆包工作协议、完整角色历史、隐秘发送和回复后删除。验证发生概率由上游决定，节流效果需在相同请求量下观察。

人工验证弹窗与请求恢复功能已移除。旧的 `DW_AUTO_CAPTCHA` 和 `DW_CAPTCHA_*` 启动配置不再生效，也不会启动识别进程。

旧配置 `DW_HIDE_HISTORY` 继续作为删除开关的别名；同时配置时以 `DW_DELETE_HISTORY` 为准。隐秘发送指上游用户消息不可见，客户端收到的回复正常显示。

## 账号池管理台（8786）

运行 `npm start` 后，在网关机器打开 **http://127.0.0.1:8786**。API 地址仍为 `http://127.0.0.1:8787/v1`。已有 API 网关正在运行时，可用 `npm run admin` 单独启动管理台。

- **账号池**：查看真实账号，按名称 / UID 搜索，筛选启用状态，修改名称、启停账号、切换默认账号和移除本地账号。
- **添加账号**：选择浏览器打开独立登录窗口，完成官网登录与验证后，在管理台点击“确认接入”。同一账号重登会更新会话；关闭弹窗后可继续后台登录，也可取消流程。
- **刷新状态**：核验已启用账号的登录会话并查询实际额度；列表每 15 秒仅同步本地账号状态，不会自动请求上游或消耗对话额度。
- **模型目录**：按账号查询实际可用模型并复制模型 ID。
- **接入配置**：查看 Base URL、按需显示 / 复制 API Key，以及当前端口、超时、并发和数据目录。

## 多账号管理

```powershell
npm run login                         # 再登录一个账号；同一账号重登会更新，不重复添加
npm run accounts                      # 列出 UID、名称和默认账号，不展示 Cookie
node server.mjs use "账号UID"         # 切换默认账号
node server.mjs remove "账号UID"      # 仅移除本地保存的账号
node server.mjs enable "账号UID"      # 启用账号
node server.mjs disable "账号UID"     # 停用账号
npm run usage                         # 查询当前账号额度
```

第一个账号默认为服务账号。最多保存 64 个账号，凭据文件最多 2 MiB，超过限制会拒绝写入而不损坏已有数据。每个请求只使用一个账号，不自动重发被人机验证拒绝的请求。会话过期返回 `session_expired`，请运行 `npm run login` 更新账号。并发超过上限返回 429。

账号管理写入有进程锁，重复执行时返回冲突，不覆盖其他进程的结果。若异常退出遗留 `accounts.lock` 或 `config.lock`，确认相关管理/初始化进程已停止后，才移除对应锁文件并重试。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查，无需密钥；不代表账号已登录或上游可用 |
| GET | `/v1/models` | 当前账号可用模型，标准 OpenAI 列表格式 |
| GET | `/v1/models/{id}` | 单个模型详情 |
| POST | `/v1/chat/completions` | 文本对话；默认 JSON，`stream: true` 时为 SSE |
| POST | `/v1/responses` | Responses 文本、历史、函数工具及原生 SSE 事件 |
| GET / DELETE | `/v1/responses/{id}` | 读取 / 删除本机内存中的 Responses 响应 |
| POST | `/v1/messages` | Claude Messages 文本、`tool_use` / `tool_result` 及原生 SSE |
| POST | `/v1/messages/count_tokens` | 本地估算输入 token，不发起模型生成 |
| GET | `/v1/usage` | 扩展接口：豆包工作账号额度，不是 OpenAI 的 token 计量接口 |

除 `/health` 和跨域预检外都要求 `Authorization: Bearer <API Key>`；也接受 `X-API-Key`。**客户端密钥不会发送到豆包上游**，账号 Cookie 也不会返回给客户端。

PowerShell 示例：

```powershell
# 换成 npm run key 输出的密钥
$headers = @{ Authorization = 'Bearer sk-dw-你的密钥' }
$models = Invoke-RestMethod 'http://127.0.0.1:8787/v1/models' -Headers $headers
$model = $models.data[0].id
$body = @{
  model = $model
  messages = @(@{ role = 'user'; content = '你好，请介绍一下你自己。' })
  stream = $false
} | ConvertTo-Json -Depth 8
Invoke-RestMethod 'http://127.0.0.1:8787/v1/chat/completions' `
  -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

OpenAI Python SDK 示例（SDK 属于客户端，网关本身不依赖它）：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-dw-你的密钥")
model = client.models.list().data[0].id
result = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "你好"}],
)
print(result.choices[0].message.content)

for chunk in client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "写一段简短的中文介绍"}],
    stream=True,
):
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

Responses 也使用上面的 OpenAI 客户端：

```python
reply = client.responses.create(
    model=model,
    instructions="请用中文回答。",
    input="你好",
)
print(reply.output_text)

followup = client.responses.create(
    model=model,
    previous_response_id=reply.id,
    input="用一句话总结刚才的回答。",
)
print(followup.output_text)

for event in client.responses.create(model=model, input="写一段简介", stream=True):
    if event.type == "response.output_text.delta":
        print(event.delta, end="", flush=True)
```

Claude / Anthropic Python SDK 示例（`model` 使用 `/v1/models` 返回的真实 ID）：

```python
from anthropic import Anthropic

claude = Anthropic(base_url="http://127.0.0.1:8787", api_key="sk-dw-你的密钥")
with claude.messages.stream(
    model=model,
    max_tokens=1024,
    messages=[{"role": "user", "content": "写一段中文简介"}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

## 开发与验证

```powershell
npm test
npm run check
npm run check:admin
npm run check:captcha
npm run captcha:test                 # 可选：历史本地识别工具测试；网关运行不调用它
npm pack --ignore-scripts --dry-run
npm run smoke:browser                # 可选：真实浏览器、无界面空白页、不登录账号
```

## 来源与许可

参考仓库版本 **v0.1.6**，提交 `1cd9a7e8ea0c0917c9f34b015d08ac2cc5386e9d`。保留原作者 245678000000、社区贡献者，以及 Agent2Providers / EchoBird 的来源、许可和致谢。详见 [NOTICE.md](NOTICE.md)。

本项目采用 **AGPL-3.0-only**，完整许可见 [LICENSE](LICENSE)，保留 [EchoBird MIT 声明](licenses/EchoBird-MIT.txt)。修改后提供网络服务时请遵守 AGPL 的相应源码提供义务。豆包、Magpie 及相关图标的权益属于各自权利人。本项目不代表任何品牌的官方 API 或官方客户端。
