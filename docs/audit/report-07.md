# 角色审核报告 · 第 07 批（10 个镇民）

> 审核对象：`docs/audit/chunk-07.json`（10 个镇民）
> 对照：`docs/audit-flow.md` 描述的已实现流程 + `engine.cjs` / `agents.cjs` / `public/app.js` / `data/nightorder.json` 实际代码

## 总表

| 角色 | 阵营 | 能力摘要（≤40字） | 是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 数学家 | 镇民 | 每夜得知有多少玩家能力未正常生效 | 是 | 结算通道够（info 给一个数字），但"能力因他人而未正常生效"这件事程序里没有任何事件记录，全靠说书人自己追记；且 `toggleMarker`（engine.cjs:287）是"切换"语义，重复给同一座位打"中毒"会把它清掉，跨夜维持的中毒/醉酒状态容易反过来丢。 | 中 |
| 卖花女孩 | 镇民 | 每夜得知白天恶魔是否投过票 | 是 | 白天投票的**投票人身份**在入夜时已被清空：提名举手记录只存在 `s.nom.cur.hands` / `cur.locked`，`runNomination` 收尾时 `s2.nom = null`（agents.cjs:1299）；`s.nom.results` 只有票数没有投票人。夜里说书人根本查不到"恶魔是否投过票"。 | 高 |
| 城镇公告员 | 镇民 | 每夜得知白天是否有爪牙发起提名 | 是 | 提名记录同样丢失：真实提名走 `nomPropose`（engine.cjs:744），只 push 到 `s.nom.queue`，**不写** `s.nominations`；而 `s.nom` 入夜即被置 null。说书人提示词里的 `nominations: s.nominations`（agents.cjs:266）因此长期为空数组。 | 高 |
| 神谕者 | 镇民 | 每夜得知死亡玩家里有多少是邪恶 | 否 | 说书人视角（viewForStoryteller）同时有 `alive` 与 `role`，阵营可由 roleFaction 推出，数一下就得到答案；不需要玩家选择，不需要额外通道。 | 无 |
| 博学者 | 镇民 | 每白天私下问说书人，得一对一错两条信息 | 是 | 交互通道有（玩家私聊→`buildStoryChatPrompt`→`say(private)` 私回），但回复只走 say，**不落 `E.giveInfo`**、也不记"今天已问过"，同一白天可被无限追问，跨天也无法追溯给过什么。 | 中 |
| 女裁缝 | 镇民 | 限一次，夜里选两人，得知是否同阵营 | 是 | 顺序表 first/other 都有该角色，私聊选人 + info 公布结果都可行；问题在"每局限一次"没有任何使用记录（无 usedOnce 字段），只能靠说书人从"已告知"里猜，重复触发风险高。 | 中 |
| 哲学家 | 镇民 | 限一次，夜里选一善良角色并获得其能力 | 是 | 获得能力后，**机械层仍然按"哲学家"这个名字判定**：`voteWeight`（engine.cjs:687）经 `abilityOfSeat`→`roleOfSeat` 只读 `s.roles[seat]`；`secretBallot`（702）写死 `r !== "街头风琴手"`；管家判定（731/794）写死 `roleOfSeat(s,i) === '管家'`；狂热者（799）写死能力正则。复制到官员/管家/窃贼/街头风琴手/狂热者时票权完全错算；且 `s.roles` 不能改（改了就影响发牌与 checkWin 胜负判定）。另外 `nightOrderFor`（agents.cjs:434）按角色名裁剪，复制来的每夜能力不会被排进当夜顺序。 | 高 |
| 艺术家 | 镇民 | 限一次，白天私下问说书人一个是非问题 | 是 | 通道与博学者相同、够用；同样缺"每局限一次"的记录，且私聊答复不落 info，说书人无法确认是否已经用过。 | 中 |
| 杂耍艺人 | 镇民 | 首个白天公开猜最多五人身份，当晚得知猜对数 | 是 | 流程本身走得通（白天公聊猜、当晚 info 报数量，`other` 顺序表里也有它），但"首个白天的猜测"只能靠对话记录跨阶段传递，而说书人视角只取最后 40 条消息（`MAX_MSGS_IN_PROMPT = 40`，agents.cjs:29）——白天聊天一多，猜测就被截断，当晚无从结算。 | 中 |
| 贤者 | 镇民 | 若被恶魔杀死，当晚得知两名玩家之一即凶手 | 是 | 死因不可查：agents.cjs:1003 调 `E.kill(id, i, '夜间死亡')` 时 reason 是**硬编码字符串**，无论被恶魔杀、被爪牙杀还是连带效果死亡，落库都是同一句话；也没有 deathLog 记录"谁因何而死"。说书人下一轮只能凭自己上一轮的 think 记忆，跨轮即失。 | 中 |

**本批统计：10 个角色：高 3 / 中 6 / 低 0 / 无 1**

---

## 需要改动的地方

按"一处改动支撑多个角色"归并，共 6 组。

### 1. 把「白天提名 / 投票实录」持久化，入夜后仍可查
**影响的角色：卖花女孩、城镇公告员（高）**

- **engine.cjs**：`nomPropose`（约 744 行）在 push 到 `s.nom.queue` 的同时，追加一条持久提名记录：
  `s.nominations.push({day:s.day, from, target, reason, t})`（现在只有老的 `nominate()` 在 166 行写这个数组，真实流程根本不走它）。
- **engine.cjs**：`nomFinalizeSeat`（约 814 行）把每条 `cur.locked` 的 `{seat, hand, counted, weight}` 落到 `s.dayVoteLog`（按 `day` 分组）；`nomResolve` 结算后保留，**不要**随 `s.nom` 一起清空。
- **engine.cjs**：`createState` 初始化补 `nominations: []`、`dayVoteLog: []`。
- **agents.cjs**：`runNomination` 收尾处（约 1295–1300 行）在 `s2.nom = null` 之前，先把 `s.nom.results` 快照进 `s.lastNomDay = {day, items}`，作为兜底。
- **agents.cjs**：`viewForStoryteller`（254–268 行）把 `nominations` / `dayVoteLog` / `lastNomDay` 放进返回值；`buildStorytellerNightPrompt` 在【全场座位与真相】之后新增一段【今天白天的提名与投票实录（谁提名了谁、谁举了手、票权）】，`buildStorytellerDayPrompt` 同步加。

### 2. 增加「能力克隆 / 角色名与能力分离」层
**影响的角色：哲学家（高）**

- **engine.cjs**：state 增加 `abilityClone: {seat: 角色名}`。新增 `effectiveRoleOfSeat(s, seat)`：有克隆时返回克隆的角色名，否则返回 `s.roles[seat]`；`abilityOfSeat`（671 行）改为用它。
- **engine.cjs**：把 `voteWeight`（687）、`secretBallot`（702）、管家判定（731、794、820）、狂热者判定（799）全部改为基于 `effectiveRoleOfSeat / abilityOfSeat`，**不能**再直接读 `roleOfSeat`。`s.roles` 本身绝对不改（`checkWin` 和发牌都依赖它）。
- **agents.cjs**：`nightOrderFor`（434 行）除了收集 `s.roles` 里的角色名，还要把 `s.abilityClone` 的目标角色一起并入顺序，并在提示词里标注「X 号（哲学家复制的<角色>）」，否则复制来的每夜能力不会被排进当夜流程。
- **agents.cjs**：`buildStorytellerNightPrompt` 增加【能力克隆】段落，写明"该座位已永久拥有<角色>的能力，机械层（票权/秘密计票/免除）已按该角色生效"。

### 3. markers 从「toggle」改成「显式 set/clear」，并补 usedOnce
**影响的角色：数学家、女裁缝、哲学家、艺术家（中）**

- **engine.cjs**：`toggleMarker`（287 行）语义危险。新增 `setMarker(id, seat, marker, on)`，或让 markers 回包支持 `{"seat":n,"marker":"中毒","on":true}`。
- **agents.cjs**：应用循环（1002 行）改为读 `x.on !== false`，默认 set 而非 toggle，避免"每夜重申一次中毒"反而把中毒清掉。
- **engine.cjs**：state 增加 `usedOnce: {}`；agents.cjs 的 JSON 契约新增 `"usedOnce":[{"seat":n,"key":"女裁缝"}]` 字段并在 apply 时落库。这直接支撑「每局限一次」的女裁缝 / 哲学家 / 艺术家。

### 4. 白天主动能力的通道补全
**影响的角色：博学者、艺术家（中）**

- **agents.cjs**：`buildStoryChatPrompt` / `replyStoryChat`（1314–1366 行）在私聊答复涉及白天角色能力时，除了 `E.say(private)`，还要同时 `E.giveInfo(seat, 答复)`，让内容进入"已告知"，可追溯。
- **agents.cjs**：`buildStorytellerDayPrompt` 增加【本白天仍可使用的白天能力】清单（列出博学者、艺术家等未用过的座位），并从 `usedOnce` 排除已用过的。

### 5. 死亡原因结构化
**影响的角色：贤者（中）**

- **agents.cjs**：1003 行 `E.kill(id, i, '夜间死亡')` 的硬编码 reason 改为可传：`rp.deaths` 支持 `{"seat":n,"reason":"被恶魔杀死"}` 形态（同时兼容纯数字），把 reason 透传给 `E.kill`。
- **engine.cjs**：`kill`（227 行）追加 `s.deathLog.push({seat, night: s.night, reason, t})`。
- **agents.cjs**：`viewForStoryteller` 注入 `deathLog`，夜间提示词里跟着【全场座位与真相】一并渲染，说书人才能在后续轮次知道"这个人是不是被恶魔杀的"。

### 6. 说书人消息窗口对"白天宣告、当晚结算"太窄
**影响的角色：杂耍艺人（中）**

- **agents.cjs**：`MAX_MSGS_IN_PROMPT = 40`（29 行）。对说书人视角单独放宽到 120 条左右，或在 `viewForStoryteller` 里额外保留"本白天全部公聊"（至少保留到 `s.dayStarted` 之后的全部 town 消息），保证首个白天的公开猜测不会在入夜后被截掉。
- 也可考虑在白天提示词里要求说书人把玩家公开猜测原样记进 markers（如 `猜测:3号=占卜师`），作为跨阶段兜底。

### nightorder.json
本批 10 个角色**不需要**改 `data/nightorder.json`：数学家、女裁缝、哲学家在 `first` 与 `other` 均在表内；卖花女孩、城镇公告员、神谕者、杂耍艺人、贤者在 `other` 表内（首夜不该行动，正确缺席）；博学者、艺术家是白天能力，本就不该进夜间表。唯一建议：给「每局限一次」的角色在表里加 `(限一次)` 注记，提示说书人先查 `usedOnce`。
