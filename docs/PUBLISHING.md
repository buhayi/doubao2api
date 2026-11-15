# 发布与本机运行

源码目录与运行目录使用同一份公共源码，账号和本机环境单独保存在运行目录。

| 内容 | 源码目录 | 运行目录 |
| --- | --- | --- |
| JavaScript / Python 源码、管理台静态文件、测试、文档、CI、许可证和 `.env.example` | 保留，可提交 GitHub | 同步相同版本 |
| `.env`、`data/` 中的账号、Cookie 和 API Key | 不保留 | 保留 |
| `.captcha-venv/`、安装依赖、模型、缓存、日志和 `.backups/` | 不保留 | 保留 |

这次本机整理使用 `E:\doubao2api` 保存可公开源码，使用 `E:\doubao-gateway` 运行网关。在运行目录执行命令，账号与密钥会继续使用同一个 `data/`：

```powershell
Set-Location E:\doubao-gateway
npm start
```

其他机器可以使用任意独立的运行目录。网关运行仅需 Node.js 22 或更新版本；保留的 Python 识别源码是历史实验工具，网关与浏览器登录不调用它。

更新时先停止网关，按源码目录中的公共文件清单同步代码。保留运行目录的 `.env`、`data/`、环境和备份；账号文件或 API Key 出现冲突时，先备份两份原文件，再确定使用的配置。不要用双向目录镜像把私有文件复制回源码目录。

提交前查看文件清单，确认只包含源码与示例配置：

```powershell
npm test
npm run check
npm run check:admin
npm run check:captcha
npm pack --ignore-scripts --dry-run
git status --short --untracked-files=all
```

`.gitignore` 保护 Git 提交，`.npmignore` 与 `package.json` 的 `files` 清单保护 npm 打包。提交文件应保留 `LICENSE`、`NOTICE.md` 和 `licenses/` 中的来源与许可声明。仓库截图、错误信息及新添的示例也应使用虚构账号和密钥。
