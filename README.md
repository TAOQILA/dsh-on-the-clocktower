# DSH on the Clocktower（血染钟鱼）

在 DeepSeek Harness 里与 AI Agent 们一起游玩「血染钟鱼」（类似“血染钟楼”的身份推理游戏）的插件项目。

- 中文名：血染钟鱼
- 英文名：DSH on the Clocktower
- 最新版本：0.6.5
- 仓库：https://github.com/TAOQILA/dsh-on-the-clocktower
- 许可证：GNU AGPL-3.0（AGPL-3.0-only）

## 项目结构

- data/wiki/pages/：知识库文档，每页一个 .md（规则 50 / 剧本 3 / 角色 169，另有实验性角色合集 1）。
- data/wiki/INDEX.md：主阅读引导，阅读规则置顶，规定所有 Agent 的阅读顺序与 READ_ACK 回执。
- data/roles.json：169 个角色（基础 + 实验性），阵营/能力原文/夜晚标记/所属剧本。
- data/scripts/*.json：剧本 JSON（暗流涌动 27 / 黯月初升 30 / 梦殒春宵 30），支持快速导入。
- engine.cjs：权威状态机（建局、回执、阶段、角色、私有信息、发言、提名、投票、处决、标记）。
- server.cjs：本地服务（默认 6325）：魔典 UI + /api/* + Agent 适配器（AGENT_ENDPOINT 接真实模型）。
- public/：围坐圈魔典界面（圆环座位、说书人面板、日志、知识库阅读）。

## 侧栏插件

client.js + index.js 为 DSH client-plugin：左侧栏粗体「染」按钮 → 魔典面板（面板内点「在浏览器中打开魔典」进入本地服务）。
仅使用 DSH 内核自带的 @deepseek-ai/dsh-client-ui-slots 与 React，零第三方插件依赖。

## 运行

    node server.cjs
    浏览器打开 http://127.0.0.1:6325

AGENT_ENDPOINT 指向 HTTP 服务，接收 {game,seat,prompt,nonce,role,phase,info}，返回 {text,think?}。
说书人阅读包为 data/wiki/INDEX.md，所有 Agent 开局须返回带 nonce 的 READ_ACK。

## 对局归档

每局写入 data/games/<时间_剧本_人数>/：game.json、meta.json、state/current.json 与 turn-*.json、
agents/seat-NN/{think,speech,actions}.jsonl、transcript-entries.jsonl。

## 开源许可 / License

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0-only）** 发布，全文见 [LICENSE](LICENSE)。

- 你可以自由使用、修改、分发本项目，包括商业使用；分发修改版或以网络服务形式提供修改版时，
  必须同样以 AGPL-3.0 开放**完整对应源代码**（第 13 条：远程网络交互同样需要提供源码）。
- 本项目不提供任何担保，详见许可证第 15、16 条。
- 角色名称、规则文本等第三方内容不在本许可证授权范围内，见下方免责声明。

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
See [LICENSE](LICENSE) for the full text. If you run a modified version as a network service,
section 13 requires you to offer its complete corresponding source to remote users.

## 免责声明 / Disclaimer

- **源代码**依 AGPL-3.0 授权，允许包括商业使用在内的任何用途；下述限制**仅针对项目内收录的第三方资料**（角色能力、规则文本、设定等），这些资料不得用于售卖、商业化分发或牟利。
- 项目内的角色能力、规则文本、设定资料等内容，其著作权及相关权利归**各自原权利人**所有；本项目不主张任何权利。
- 本项目与任何官方游戏、发行方或社区组织均无关联。
- 使用者须自行确保使用行为符合所在地区的法律法规；因使用本项目产生的任何责任由使用者自行承担。
- 若权利方认为项目内容存在不当之处，请联系维护者，我们将及时删除或处理相关内容。
