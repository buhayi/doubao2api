# 来源与许可

本项目在 magpie-doubaowork-auth 的基础上增加独立 OpenAI Chat Completions HTTP 网关，同时保留 Magpie / OpenCode v1 提供商插件入口。网关直接复用豆包工作协议与独立浏览器登录，不调用旧版豆包工作账号管家、Agent2API 或云服务器。

直接参考来源：

- 项目：https://github.com/245678000000/magpie-doubaowork-auth
- 参考提交：1cd9a7e8ea0c0917c9f34b015d08ac2cc5386e9d（v0.1.6）
- 保留原作者 245678000000、社区贡献者及上游的许可与致谢。
- 新增 gateway/、server.mjs、网关测试和独立使用说明；修改登录门户以支持独立网关文案。新增适配代码继续使用 AGPL-3.0-only。

豆包工作协议适配参考本机检出的 Agent2Providers 开源实现：

- 项目：https://github.com/ProvidersPlugin/Agent2Providers
- 参考提交：3055f416841c1393ec04294a702603fd41e840aa
- 参考目录：crates/providers/src/providers/doubaowork
- 许可：AGPL-3.0。本包相应适配代码以 AGPL-3.0-only 交付，完整文本见 LICENSE。
- 上游豆包工作适配标注基于 EchoBird MIT 实现；保留 Copyright (c) 2026 edison7009 and EchoBird contributors，完整 MIT 声明见 licenses/EchoBird-MIT.txt。

独立浏览器桥复用用户项目中的匿名管道登录实现；该实现不操纵日常浏览器资料。

Magpie 插件接口依据：https://usemagpie.ai/docs/plugins 。Magpie 与豆包工作品牌、图标及产品权益归各自权利人。avatar.png 为用户提供的识别素材。本包不是豆包或 Magpie 的官方插件，未使用社区官方命名空间。

感谢 LINUX DO 社区的交流与分享。
