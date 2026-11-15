# 人机验证弹窗与请求恢复

检测到官网人机验证后，立即弹出当前账号的独立浏览器窗口，要求本人完成验证。滑块、旋转、文字或图形点选等验证码均由本人操作。官网确认成功后，网关核验身份并继续原请求。

## 运行要求

需要本机可用的 Chrome、Edge、豆包内置浏览器或 Chromium，以及可显示浏览器窗口的桌面会话。当前人工验证功能无需 Python、OpenCV、OCR 模型或外部识别 API。

```powershell
npm start
```

管理台“接入配置”显示“人机验证：检测到后立即弹窗 · 人工完成”和人工等待期限。

## 触发与恢复

登录窗口检测到验证码控件时直接提示人工验证。窗口最小化时会先恢复，再将窗口置前；同一个待完成的验证码只提示一次，完成后再次出现验证码会重新提示。登录流程等待验证码完成后再核验账号。

运行中的网关请求只有收到上游明确的 `decision.type=verify` 才尝试恢复。它为当前账号打开独立验证窗口，恢复网关已保存的会话，等待官网 SDK 确认成功，再向官网核验账号身份。同一账号会话的并发请求共用一次恢复；不同账号分别处理。会话写回时核对旧凭据，保留账号名称、启停与默认选择，并拒绝覆盖并发重新登录。

原请求只有在未收到任何回答或会话确认时，才使用同一请求标识和同一账号重试一次。普通 429、会话失效、已开始输出的回复均不触发重发。

`DW_CAPTCHA_BROWSER` 和 `DW_CAPTCHA_TRANSPORT` 用于选择验证窗口的浏览器与通信方式。运行时不启动图片识别进程，也不自动截图、拖动滑块或点击验证码。

独立网关支持请求中的人工验证和恢复。Magpie 插件入口的浏览器登录也直接提示人工验证，运行中的插件 API 请求仍使用其现有登录流程。

## 人工等待与取消

检测到人机验证后立即进入人工等待，页面底部显示“需要人工验证”。提示不拦截鼠标操作。管理台显示对应账号的人工验证横幅，管理台与独立登录门户均显示“等待人工验证”。

请求中的人工等待使用独立期限，默认 5 分钟。进入人工接管时，HTTP 请求的计时切换到该期限，SSE 继续发送心跳；重复状态通知不会延长期限。官网成功回调确认后重新启用普通请求超时，核验账号并保存会话，再恢复原请求。同一会话的新等待者使用已有窗口和同一截止时间。

关闭官网验证码、取消原请求或人工等待超时，会结束恢复并清理窗口。人工验证未完成时保留原 `verification_required` 错误，迟到结果不会更新会话。一个并发请求取消后，其余等待者仍可继续；全部等待者取消后结束这次验证。

登录窗口的人工接管沿用登录流程的有效期；完成后按管理台流程确认接入。请求恢复中的人工验证通过后自动继续原请求。

```dotenv
# 检测到验证码后立即弹出人工验证窗口
DW_CAPTCHA_MANUAL_FALLBACK=true
DW_CAPTCHA_TIMEOUT_MS=60000
DW_CAPTCHA_MANUAL_TIMEOUT_MS=300000
```

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `DW_CAPTCHA_MANUAL_FALLBACK` | `true` | 检测到人机验证后立即弹窗要求人工完成；关闭后不启动请求验证恢复 |
| `DW_CAPTCHA_TIMEOUT_MS` | `60000` | 官网确认成功后的身份核验期限，允许 10000–180000 ms |
| `DW_CAPTCHA_MANUAL_TIMEOUT_MS` | `300000` | 请求中人工阶段的独立期限，允许 10000–600000 ms |

修改 `.env` 后重启网关生效。历史配置 `DW_AUTO_CAPTCHA`、`DW_CAPTCHA_MAX_ATTEMPTS` 和 `DW_CAPTCHA_PYTHON` 不会启用自动识别；即使旧配置中 `DW_AUTO_CAPTCHA=true`，也仍直接要求人工验证。

历史识别脚本和已安装的 `.captcha-venv` 可以保留用于独立实验，人工验证流程不会调用它们。

## 参考仓库的处理方式

以下结论来自固定提交的源码：

| 仓库 | 实际处理方式 | 关键源码 |
| --- | --- | --- |
| [wangchuxiaoji-oss/doubao2api · 95beb078](https://github.com/wangchuxiaoji-oss/doubao2api/tree/95beb0788338ba268e13ca4c80890ceeae6ff055) | 自动启动本地验证服务器、打开页面、通过 SSE 传递 challenge，再等待本人完成验证码。`AutoCaptchaHandler` 负责自动打开与等待，图片识别由人工完成。 | [captcha_handler.py](https://github.com/wangchuxiaoji-oss/doubao2api/blob/95beb0788338ba268e13ca4c80890ceeae6ff055/doubao2api/captcha_handler.py#L7-L12)、[captcha_server.py](https://github.com/wangchuxiaoji-oss/doubao2api/blob/95beb0788338ba268e13ca4c80890ceeae6ff055/doubao2api/captcha_server.py#L99) |
| [SeiShonagon520/doubao2api · a33787d5](https://github.com/SeiShonagon520/doubao2api/tree/a33787d5421ec8bf4b9c6cab0be24e95e4433486) | 先用本地 Pillow 边缘分析估算滑块缺口，生成轨迹并用 Playwright 拖动。失败后标记账号需要验证；允许时尝试切账号，否则将已有验证码窗口弹出供人工处理。 | [captcha_solver.py](https://github.com/SeiShonagon520/doubao2api/blob/a33787d5421ec8bf4b9c6cab0be24e95e4433486/doubao2api/captcha_solver.py#L95-L141)、[恢复流程](https://github.com/SeiShonagon520/doubao2api/blob/a33787d5421ec8bf4b9c6cab0be24e95e4433486/doubao2api/unified_server.py#L1051-L1103) |

第二个仓库的滑块算法寻找中央区域中边缘强度最大的列，`piece_bytes` 参数未参与匹配。拖动距离使用 [固定 340px 缩放，识别失败后随机猜测 140–190px](https://github.com/SeiShonagon520/doubao2api/blob/a33787d5421ec8bf4b9c6cab0be24e95e4433486/doubao2api/captcha_solver.py#L259-L266)，并用 [容器消失判断成功](https://github.com/SeiShonagon520/doubao2api/blob/a33787d5421ec8bf4b9c6cab0be24e95e4433486/doubao2api/captcha_solver.py#L297-L305)。该实现只提供滑块识别，未提供旋转或文字、图形顺序点选算法；源码与模拟测试没有给出真实验证码的成功率。

这两个项目还通过网页内 `fetch` 利用官网 hook 附加签名参数，使请求使用网页自身的上下文，见 [浏览器请求实现](https://github.com/wangchuxiaoji-oss/doubao2api/blob/95beb0788338ba268e13ca4c80890ceeae6ff055/doubao2api/browser_client.py#L552)。验证码是否触发仍由官网决定。

本项目参考其人工接管与恢复边界，使用当前官网 `TTGCaptcha.render({ verify_data, captchaOptions, secondVerifyWebOptions })` 及成功回调确认结果；恢复始终使用原账号，并在人工等待后核验身份。

## 验证范围

- 2026-11-15 当前人工模式验证：206 项 Node 测试全部通过，语法检查通过。独立 Edge / Playwright 1.62.1 模拟测试确认检测后立即弹窗、恢复最小化窗口、管理台横幅与登录门户提示、独立人工期限、SSE 心跳、身份核验及原请求只继续一次；截图与识别调用均为 0。桌面 1280×820 与移动 390×844 页面正常，控制台无相关错误。
- `npm test`：无需 Python，覆盖检测后直接弹窗、三类验证码的登录提示、再次出现验证码重新提示、运行时不截图或调用识别、并发共用窗口、独立期限、身份核验、会话写回、关闭与取消后的清理以及 SSE 重试边界。
- `npm run captcha:test`：历史识别工具的独立测试，人工验证功能不依赖它。
- 2026-11-15 模拟人工回退实测：使用独立 Edge、Playwright 1.62.1、虚拟账号，将测试页 URL 拦截为本地模拟 HTML。实测最小化窗口恢复、置前提示、人工期间停止识别、官网成功回调移除提示、核验并写回会话、原 SSE 请求保持心跳并重试一次，以及验证窗口与临时目录清理。管理台桌面 1280×820 与移动 390×844 均验证提示正常显示、完成后自动移除，控制台无相关错误。本次 Browser 插件不可用，采用内置 Playwright。
- 2026-11-15 本机 Edge 已登录豆包网页测试：发送“本机网页测试：请只回复 OK。”，网站正常返回 `OK`，未弹出真实验证码。该结果确认网页请求可用；真实验证码触发后的人工验证流程仍需在实际弹窗出现时验证。
