// SPDX-License-Identifier: AGPL-3.0-only
import { runCli } from "./gateway/cli.mjs";
try { await runCli(); }
catch (error) {
  console.error(error?.status ? error.message
    : error.code === "EADDRINUSE" ? "端口已被占用，请修改 DW_PORT / DW_ADMIN_PORT 或停止占用该端口的进程。已有网关可使用 npm run admin 单独启动管理台。"
    : error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? "未知命令选项，请运行 node server.mjs --help。"
    : error.message);
  process.exitCode = 1;
}
