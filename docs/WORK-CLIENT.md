# Windows 豆包工作客户端版

复用已安装客户端的登录，提供 OpenAI Chat Completions / Responses 和 Claude Messages 接口。需要 Windows、已登录的豆包工作客户端、Node.js 22.13 或更新版本。

在项目目录运行：

```powershell
npm run start:work-client
```

也可以双击 `start-work-client.cmd`。首次启动自动导入本机账号，终端只显示接入数量。

遇到明确的人机验证要求时，客户端版会把后台或最小化的豆包工作恢复到前台；未运行时启动已安装的客户端。HTTP 请求和流式回复中的验证拒绝均可触发，模型、额度查询、账号检测和探活也适用。多个同时发生的提醒共用正在进行的唤起；之后再次收到验证要求时，会重新恢复窗口。

请在豆包工作中切换到需要验证的账号并人工完成验证，然后在管理台点击“验证完成后探活”。探活通过后该账号恢复可用，再由请求客户端重试原请求。若 Windows 只允许恢复窗口而阻止抢占前台，会闪烁任务栏；点击豆包工作即可。自动唤起失败时，管理台和 API 错误会提示手动打开客户端。

验证提醒不会自动解题、自动重发原请求或关闭日常客户端。会话仍按隐秘方式发送，完成、取消或超时后删除本次上游会话。

同账号的对话和后台查询统一串行，上游请求开始时间默认至少间隔 1 秒。回复结束后优先删除本次会话，再开始排队的回复。模型目录缓存 5 分钟，额度缓存 30 秒，多个相同查询共用一次上游请求。收到限流后按 `Retry-After` 冷却，未提供该响应头时等待 60 秒；冷却期间不会自动重发请求。排队时间计入原来的请求超时。需要调整时，在 `.env.work-client` 配置 `DW_UPSTREAM_MIN_INTERVAL_MS`、`DW_UPSTREAM_QUEUE_LIMIT`、`DW_RATE_LIMIT_COOLDOWN_MS` 和 `DW_USAGE_CACHE_TTL_MS`。

| 配置 | 客户端版 |
| --- | --- |
| 账号管理台 | `http://127.0.0.1:8788` |
| OpenAI Base URL | `http://127.0.0.1:8789/v1` |
| Claude Base URL | `http://127.0.0.1:8789` |
| API Key | `npm run key:work-client` 查看 |
| 配置文件 | `.env.work-client`，可从 `.env.work-client.example` 复制 |
| 私有账号目录 | `data-work-client/` |

更新客户端登录后重新导入：

```powershell
npm run import:work-client
```

登录库被占用时，完全退出豆包工作客户端后再导入。默认读取当前 Windows 用户的 `%LOCALAPPDATA%\DoubaoWork\User Data`，只读 Cookie 数据库，通过当前用户的 DPAPI 解密并核验账号，然后保存到网关私有目录。

客户端安装位置自动从安装目录、开始菜单或桌面快捷方式及本机正在运行的客户端发现。自定义位置可在 `.env.work-client` 设置 `DW_DOUBAO_WORK_BIN`（真正的 `app\DoubaoWork.exe`）和 `DW_DOUBAO_WORK_PROFILE`（客户端用户目录）。版本和设备标识从本机客户端读取。

需要单独登录时：

```powershell
npm run login:work-client
```

会用已安装的豆包工作内置浏览器打开独立登录窗口。若管道不兼容，可加 `-- --loopback`。

两种版本都默认隐秘发送，回复完成后删除本次上游会话；异常清理失败会记录在管理台。普通版使用 `.env`、`data/` 和 8787 / 8786；客户端版可同时运行。
