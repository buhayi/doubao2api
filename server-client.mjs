// SPDX-License-Identifier: AGPL-3.0-only
import { runCli } from "./gateway/cli.mjs";

try {
  await runCli({ clientMode: true });
} catch (error) {
  console.error(error?.status ? error.message : "客户端版网关启动失败，请检查配置、端口和数据目录。");
  process.exitCode = 1;
}
