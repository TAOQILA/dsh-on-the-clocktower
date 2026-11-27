# chunk-05 角色审核报告

> 审核对象：chunk-05.json 的 10 个角色
> 对照：docs/audit-flow.md（已实现流程）、data/nightorder.json、engine.cjs、agents.cjs、public/app.js

## 总表

| 角色 | 阵营 | 能力摘要（≤40字） | 与现状是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 修补匠 | 外来者 | 你随时可能死亡。 | 是 | 夜间 deaths 通道可用；但白天用它会被 `kill()` 塞进 `nightDeaths`，下一个天亮自动播报成「昨夜死亡」，措辞与结算时机错位 | 中 |
| 月之子 | 外来者 | 得知自己死亡时公开选一人，若他善良则当晚死亡 | 是 | 触发时机是「得知自己死亡」而非固定夜序，nightorder 只有 other 一项；「公开选择」要走 town 发言，但死者的能力触发没有任何提示通道；需要跨夜记「已触发/已选」 | 中 |
| 莽夫 | 外来者 | 每夜首个用能力选中你的人醉酒到下个黄昏，你转为他的阵营 | 是 | 「转为他的阵营」无承载：阵营来自 data/roles.json 的静态 faction，`isEvilSeat`/`checkWin` 都不读标记，转阵营对胜负完全无效；「直到下个黄昏」也无到期机制 | 高 |
| 疯子 | 外来者 | 你以为你是一个恶魔，但其实你不是。 | 是 | 程序发牌会直接私聊「你的角色是【疯子】」，当场戳破；`dealEvilInfo` 只给真邪恶下发假信息/伪装身份，疯子拿不到；也没有「每夜假唤醒+假行动」通道 | 高 |
| 教父 | 爪牙 | 首个夜晚得知场上有哪些外来者角色 | 是 | 首夜爪牙信息由程序自动下发，说书人按提示词的「已告知里有没有该座位的信息」判定，会把教父判成「已结算」而跳过一次外来者情报 | 中 |
| 魔鬼代言人 | 爪牙 | 每夜选一人（与昨夜不同），他明天被处决则不死 | 是 | `nomFinish()` 直接 `execute()`，`execute()` 无条件 `alive=false`，处决保护被硬编码覆盖；「与上个夜晚不同」也没有记录槽位 | 高 |
| 刺客 | 爪牙 | 每局限一次，夜晚选一人：他死亡，无法被阻止 | 是 | `kill()` 本来就无视一切保护，效果反而「能实现」；但缺「每局限一次」计数器，且 `first_night=true`+`other_nights=true` 会让顺序表每夜都提醒醒来，容易变成每夜一杀 | 中 |
| 主谋 | 爪牙 | 恶魔死于处决致游戏结束时，再加一夜一白天，该白天处决者阵营落败 | 是 | `checkWin()` 在恶魔出局瞬间就写 `phase='ended'` 并锁死终局，没有「延迟结束/续一轮」钩子，无法再进一夜一白天 | 高 |
| 僵怖 | 恶魔 | 每夜若今天白天无人死亡，则醒来选一人杀死 | 是 | `other` 列表有它，每夜都会进顺序表；但说书人提示词里没有「今天白天是否有人死亡」的汇总字段，只能凭对话记录推断；白天被保护未死者算不算也没口径 | 中 |
| 普卡 | 恶魔 | 每个夜晚选一名玩家：他中毒 | 是 | 「中毒」只能用 `toggleMarker` 自由文本承载，且每夜要手动解掉上一位的中毒（不会自动到期）；除 `voteWeight`/`secretBallot` 读「中毒」外，中毒没有任何机械效果 | 中 |

**本批 10 个角色：高 4 / 中 6 / 低 0 / 无 0**

---

## 需要改动的地方

### 一、engine.cjs：死亡与保护（魔鬼代言人、刺客、修补匠、莽夫）

1. **新增结构化免死字段**。当前 `kill()`（engine.cjs:227）与 `execute()`（engine.cjs:176）都是无条件的 `s.alive[seat]=false; s.markers[seat].push('死亡')`。建议新增 `s.deathShield = { [seat]: day }`，表示「该座位在本 `day` 被处决不会死亡」。
2. **`execute()` 检查 deathShield**：若 `s.deathShield[seat] === s.day`，不设 alive=false、不 push 死亡，改写 `log(id,'说书人',名字+' 被处决但没有任何事发生')`，并在白天公聊 `say` 一条「X 被处决，但没有死」。这是魔鬼代言人的核心，必须在机械层做，否则说书人怎么想都会被覆盖。
3. **`kill()` 增加 `opts.ignoreShield`**：刺客的「即使因为任何原因让他不会死亡」需要穿透 deathShield 和「被保护」标记；普通夜间死亡（恶魔刀）则应被保护类标记阻挡。目前 `kill()` 一律穿透，等于刺客效果天然成立但保护类能力全废。
4. **`execute()` 增加「今天白天死亡」计数** `s.dayDeaths`（push 座位号），并在进入夜晚时清空。`kill()` 在夜间不写这个数组。这是僵怖「今天白天没有人死亡」的唯一可靠依据。
5. **白天死亡不要进 nightDeaths**：`kill()` 无条件 `s.nightDeaths.push(seat)`。修补匠在白天被杀时，会让下一个 `setPhase('day')` 的天亮播报把这次死亡说成「昨夜死亡」。建议 `kill(id, seat, reason, {daytime:true})` 时只记 `dayDeaths`，不写 `nightDeaths`。

### 二、engine.cjs：阵营覆盖（莽夫）

1. **新增 `s.alignment = { [seat]: 'good'|'evil' }`**，并改造 `roleFaction(name)` 的调用点：`isEvilSeat(s, seat)`（engine.cjs:697）与 `checkWin(id)`（engine.cjs:253）改为「先看 `s.alignment[seat]`，没有再用 roles.json 的静态 faction」。
2. **新增 API `setAlignment(id, seat, side)`** 到 `module.exports`（engine.cjs:952 附近）与 server.cjs:118 附近，供说书人在 marker 通道之外落一个真状态。仅靠 `markers:["阵营:邪恶"]` 无法影响 `checkWin`，因为胜负判定不读 markers。
3. 注意 `dealEvilInfo`/`evilInfoFor`（engine.cjs:550/572）也是按静态阵营筛 minion/demon，莽夫转阵营后不应影响首夜信息（首夜已过），但重查时要留意。

### 三、engine.cjs：终局延迟（主谋）

1. **`checkWin()` 增加主谋钩子**：在 `if (!demonAlive)` 分支里，先判断「本次恶魔死亡是否因为处决」（可由 `execute()` 传入 `reason:'execution'`）且场上存在存活主谋且 `s.extendedRound` 未使用过；条件成立时**不要**写 `phase='ended'`，改为 `s.extendedRound = { by:'主谋', ready:true }` 并返回 `{over:false, extended:true}`。
2. **新增 `s.extendedRound.verdictPending`**：进入额外那一夜/白天期间，`nomFinish()`（engine.cjs:899）在该白天处决某人后，若 `s.extendedRound.verdictPending`，则不走正常 `checkWin`，而是直接 `endGame(id, 被处决者阵营 === 'evil' ? 'good' : 'evil', '主谋：该白天被处决者阵营落败')`。
3. `setPhase`（engine.cjs:95）需要允许在 `phase==='ended'` 时因 `s.extendedRound` 而回到 `night`（当前 ended 是终态，前端与 `checkWin` 都假设它不可逆）。

### 四、engine.cjs / agents.cjs：疯子（外来者伪装恶魔）

1. **`dealRoles`（engine.cjs:434）**：疯子按 outsider 正常进配比即可，但发牌后需要单独建 `s.fakeDemon[seat] = { minions:[...], bluffs:[...] }`（虚拟爪牙与 3 个伪装身份），供说书人每夜给他假的「爪牙名单」。
2. **`dealEvilInfo`（engine.cjs:572）**：疯子**不是** minion/demon，当前不会收到任何邪恶信息，必须额外给疯子下发一条「你的爪牙是：…（假）；可以伪装成：…（假）」。
3. **角色私聊必须改写**：`assignRole`/`giveInfo` 给疯子的身份文本不能是「你的角色是【疯子】」。建议 `assignRole` 对疯子写 `s.roles[seat]='疯子'`（用于胜负与顺序），但 `giveInfo` 的文本改为「你的角色是【<随机恶魔名>】」。注意 agents.cjs:992 那段「roleMode=program 时忽略说书人重复分配角色」的正则会把这条也拦掉，需要放行疯子这一种。
4. **每夜假唤醒**：nightorder.json 的 `first`/`other` 里疯子已有槽位，但说书人不知道要给他「假选择 + 假结果」。需要在 agents.cjs 加一条角色细则（见第五节）。

### 五、agents.cjs：提示词层（10 个角色全部）

1. **新增 `ST_ROLE_RULES` 常量**（仿照 engine.cjs 上方 `VOTE_ROLE_RULES`，agents.cjs:224），在 `buildStorytellerNightPrompt` 与 `buildStorytellerDayPrompt` 里像 `voteRolesBrief(id)` 那样注入，逐条写死这 10 个角色的执行口径：
   - 修补匠：随时可以死，白天死就写 `deaths`，但要说清「这是白天死的」。
   - 月之子：**没有固定夜序**；他死亡后必须私聊告知「你已经死亡」，并公开请他选人（town 发言），记录「月之子已选：N 号」，当晚用 `deaths` 结算。
   - 莽夫：记录本夜第一个选中莽夫的玩家 → 给莽夫 `markers` 加「醉酒」（下个黄昏前必须移除）+ 用 `setAlignment` 转阵营。
   - 疯子：每夜按「假恶魔」唤醒，给假爪牙名单与假选择结果，绝不能说破。
   - 教父：首夜要额外发一条「场上的外来者角色有：…」，**不要**因为该座位已有程序下发的爪牙信息就跳过。
   - 魔鬼代言人：每夜必问（与昨夜不同），收到答复后**必须**用 `markers` 或新 API 记录到 `deathShield`；天亮时如果该人被处决，机械层会自动不杀，别说「他死了」。
   - 刺客：**每局只有一次**，用过之后不再唤醒；用 `markers:["刺客已用"]` 记录。
   - 主谋：恶魔死于处决时不要直接宣布游戏结束，先看主谋。
   - 僵怖：判断「今天白天是否有人死亡」看 `dayDeaths`，为 0 才唤醒。
   - 普卡：每夜选人中毒 → `markers` 加「中毒」；**必须**同时把上一位的「中毒」移除（说书人要显式给一条 marker 切换）。
2. **修 `buildStorytellerNightPrompt` 的「已结算」判定**（agents.cjs:502 附近，原文「判断依据：看上面『已告知』里有没有针对该座位的信息」）：必须排除程序自动下发的「你的同伴是：…」「你的爪牙是：…」这两条，否则教父这类「首夜要额外拿信息」的爪牙会被误判为已完成。
3. **补充「今天白天死亡人数」字段**到夜晚 prompt 的座位表上方（配合 `s.dayDeaths`），这是僵怖唯一可靠的判断依据。
4. **白天 prompt 要说明 `deaths` 语义**（agents.cjs:548）：白天用 `deaths` 表示「当场死亡」，不是夜间死亡，避免修补匠被杀后又被天亮播报重复一遍。

### 六、nightorder.json：触发式角色不该当每夜必做

1. **修补匠、月之子**在 `other` 列表里，会让说书人每夜都以为要处理它们，但二者都是触发式（修补匠「随时」、月之子「得知死亡时」）。建议移到新增的 `"reactive"` 数组，或从两张表里移除，改在提示词的 `ST_ROLE_RULES` 里说明触发条件。
2. **刺客、疯子**在 `first` 与 `other` 都有槽位，容易让说书人每夜都主动唤醒。建议给这两个加注释字段（如 `"oncePerGame": true` / `"fakeOnly": true`），并在 `nightOrderFor`（agents.cjs:434）里读出来，在顺序表上直接标「（仅一次）」「（疯子：发假信息）」。

### 七、public/app.js + server.cjs：说书人操作台

1. **server.cjs**（118 行附近）新增 `setAlignment` / `setDeathShield` / `clearDeathShield` / `revive` 四个 API 直通 `E.*`；`revive` 目前完全不存在（`alive` 一旦 false 无法恢复），月之子/传教士类效果都会碰到。
2. **public/app.js**（1100、1188 行附近的 marker 面板）增加「阵营覆盖（善/恶）」与「处决免死（本日）」两个按钮，并在座位卡片（471–477 行）上把 `deathShield`、`alignment` 与普通 markers 分开显示，避免说书人把「阵营:邪恶」当成普通文本标记加了却毫无作用。
3. **天亮播报文案**（engine.cjs:110 附近的 `setPhase`）建议区分「昨夜死亡」与「今天白天死亡」，否则修补匠/月之子造成的白天死亡会在下一个天亮被重复播报。

---

## 附：判定依据摘要

- **通道**：说书人只有 `think / say / info / markers / deaths / nextPhase / voteTarget / resolveVote` 八个字段（agents.cjs:511-520、548）。没有「设置阵营」「设置免死」「复活」「每局一次计数」的通道，这是 4 个高严重度角色的共同根因。
- **硬编码覆盖点**：`execute()`（engine.cjs:176）无条件杀死 → 覆盖魔鬼代言人；`checkWin()`（engine.cjs:253）恶魔出局即刻终局 → 覆盖主谋；`roleFaction`（engine.cjs:242）静态阵营 → 覆盖莽夫；`assignRole`+`dealEvilInfo` 的真身份私聊 → 覆盖疯子。
- **顺序表**：`nightOrderFor`（agents.cjs:434）只按 `s.roles` 与 nightorder.json 的 `first`/`other` 求交，不读 roles.json 的 `first_night`/`other_nights`，所以「这个角色该不该在今晚醒」完全由那张顺序表决定。
