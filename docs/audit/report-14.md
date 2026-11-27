# 批次 14 角色审核

审核范围：`docs/audit/chunk-14.json` 的 10 个角色。
核对文件：`engine.cjs`（48KB）、`agents.cjs`、`server.cjs`、`public/app.js`、`data/nightorder.json`、`data/roles.json`、`data/scripts/*.json`、`data/wiki/pages/*.md`。
核对方式：先 grep 定位再用 read 读局部；关键函数逐行读过（dealRoles / bracketSpec / checkWin / execute / kill / voteWeight / secretBallot / nomPropose / nightOrderFor / buildStorytellerNightPrompt / runStoryteller / createGame）。

**前置事实（影响下面所有判断，不是缺陷本身）**：这 10 个角色在现有三本剧本 `data/scripts/暗流涌动.json`、`data/scripts/梦殒春宵.json`、`data/scripts/黯月初升.json` 里**一次都没有出现**（grep 全表 0 命中），只能通过自定义剧本入场。所以下列问题在自带剧本里不会暴露，一旦自定义剧本收录这些角色就会立刻踩到。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
|---|---|---|---|
| 无神论者 | 镇民 | 高 | 能力标签 `[无邪恶角色在场]` 被 `dealRoles` 的 `usable()` 直接踢出牌池（`engine.cjs:444-448`），永远发不到手；「处决说书人 → 善良胜」没有可指认的座位，`checkWin` 也不认这种胜利 |
| 暴乱 | 恶魔 | 高 | 第三天机制完全不存在：`checkWin` 只按 `roles.json` 的静态 `faction==='demon'` 判负（`engine.cjs:253-269`）；「被提名立即死亡且必须再提名」与 `nomPropose` 的死亡禁令（`engine.cjs:750`）直接冲突；爪牙变暴乱无阵营同步 |
| 暴风捕手 | 奇遇角色 | 高 | 「只能死于处决」无免死通道：`execute`/`kill` 无条件写 `s.alive[seat]=false`（`engine.cjs:178,231`）；首夜告知所有邪恶玩家无回包字段；且 `dealRoles` 只在 4 个阵营池里抽牌（`engine.cjs:452`），奇遇角色永不进场 |
| 杂技演员 | 镇民 | 中 | other 表有序、能力可由说书人判定，但「当晚他醉酒或中毒」只能靠读 `markers` 猜；`roles.json:1910-1920` 的 `first_night:true / other_nights:false` 与「除首夜外每夜」正好写反 |
| 村夫 | 镇民 | 中 | `[+0~2村夫，复数村夫中有一人醉酒]` 的「有一人醉酒」没有设置阶段钩子，只能靠说书人手工打 `markers`；范围写法依赖 `Math.floor(Math.random()*3)` 硬编码 0~2（`engine.cjs:497`），恰好对得上但机制脆弱 |
| 气球驾驶员 | 镇民 | 中 | `[+0~1外来者]` 被 `bracketSpec` 解析成 `rangeRoles:[{name:'外来者'}]`（`engine.cjs:413-414`），「外来者」不是角色名、不在 `scriptRoleNames` 里，被静默丢弃 → 设置调整永不生效；「上个夜晚得知的玩家」无持久字段，只能从 `info` 历史里捞 |
| 渔夫 | 镇民 | 低 | 白天私聊说书人这条通道是通的，建议可通过 `giveInfo` 下发；「每局一次」无机械约束，只靠 markers 约定，漏做也无人报错 |
| 灵言师 | 爪牙 | 高 | 无「关键词」存储字段、无检测玩家是否说出关键词的钩子（`say` 不扫描文本）、无换阵营 API（阵营来自静态 `roles.json`），三步全部无法执行 |
| 炸弹人 | 爪牙 | 高 | 处决触发无回调：`execute` 只把被处决者本人置死且**不通知说书人**（`engine.cjs:176-182`）；「除三名外全死」要一次 `deaths` 批量（可行）但「十秒公共点数」没有通道，`openVote/castVote` 只有 yes/no 二元票 |
| 炼金术士 | 镇民 | 高 | 获得爪牙能力后，所有按**角色名**硬编码的爪牙机制一律失效：`voteWeight` 读的是 `abilityOfSeat`（`engine.cjs:687-696`，炼金术士的能力文本是「你拥有一个爪牙角色的能力」，正则永不命中）、`secretBallot` 判 `r!=='街头风琴手'`（`engine.cjs:702-709`）、`butlerMaster` 只认 `markers` 但投票流程按角色名走、军团 `votes=0` 同理；「说书人可能要求更换选择」也无回包字段 |

统计：高 6 / 中 3 / 低 1 / 无 0。

## 需要改动的地方

### 无神论者（高）

1. `engine.cjs:444-450` `dealRoles` 内的 `usable()`：
   现在 `if (sp.noEvil) { notes.push(...); return false; }` 把无神论者永久踢出牌池。改法：把 `noEvil` 从「不可用」改成「强制进场 + 清空邪恶」——当剧本里出现带 `[无邪恶角色在场]` 的角色时，`comp[2]=comp[3]=0`，多余的爪牙/恶魔名额按外来者→镇民补足（wiki 运作方式：移除所有邪恶标记，用镇民/外来者补到人数）。
   理由：这是角色能力的**设置阶段**部分，不实现就等于这个角色不存在。
2. `engine.cjs:253-269` `checkWin`：
   现在 `if (!anyDemon) return {over:false}`——无神论者局本来就没有恶魔，永远判不出胜负。改法：加一条前置分支，若场上存在无神论者（按 `s.roles` 里有该角色名）则跳过恶魔条件，并改为「仅剩 2 名玩家存活 → 邪恶胜、说书人被处决 → 善良胜」。
3. 新增「说书人可被提名/处决」的通道：`engine.cjs:744` `nomPropose` 的 `target` 现在必须落在 `0..seats.length-1`，需要一个虚拟座位（例如 `target = -1` 代表说书人）贯穿 `nomFinalizeSeat/nomResolve/nomFinish`，并且 `nomFinish` 命中该目标时调 `endGame(id,'good')` 而不是 `execute`。
   理由：`server.cjs` 的 `nominate/nomPropose` 与 `public/app.js:979` 的座位下拉都只列真实座位，没有座位号就无法发起这项提名。

### 暴乱（高）

1. `engine.cjs:253-269` `checkWin`：现在只看 `roleFaction(role)==='demon'`。第三个夜晚「所有爪牙变成暴乱」需要改写 `s.roles`（`assignRole`，`engine.cjs:125` 可用）——但 `assignRole` 只改角色名，阵营由 `data/roles.json` 静态给出，改完立刻变成「场上有 3 个恶魔」，`!demonAlive` 与 `aliveSeats.length<=2` 的组合会给出错误胜负。改法：`checkWin` 增加「暴乱局」分支——只要 `s.roles` 里存在暴乱，胜负改为「所有暴乱死亡 → 善良胜；最后一个暴乱死亡且存活恰好 2 人 → 善良胜（且该玩家不能提名）；否则按存活数常规判定」。
2. `engine.cjs:744-760` `nomPropose`：`if (!s.alive[from]) return {ok:false,error:'已死亡的玩家不能发起提名'}` 必须为暴乱链开例外——暴乱链中被提名致死的玩家仍须再次提名。改法：加一个 `s.nom.riotChain` 标记，处于链上的座位允许 `alive===false` 提名，且不受 `usedNom` 限制（wiki：能力取代「每天只能提名一次」，但「每天只能被提名一次」仍适用）。
3. `engine.cjs:851-899` `nomResolve/nomFinish`：暴乱当天「被提名立即死亡」应在 `nomFinalizeSeat` 之后、投票之前就 `kill` 掉被提名者并自动为其开下一个提名，而不是等 `nomFinish` 统一 `execute`。现在一顿流程一天只处决一个人，且处决的是 `onBlock.target`。
4. `agents.cjs:525` `buildStorytellerDayPrompt`：需要注入「今天是第几个白天 / 是否已进入暴乱日」以及「提名链倒计时 3-2-1、超时由说书人代提名」的口径，否则说书人 agent 根本不知道要触发这套流程（现在白天 prompt 只有常规的 `voteTarget/resolveVote`）。
5. `data/roles.json:1884-1894`：`other_nights:true` 让暴乱进 `nightorder.json` 的 other 表（位置在 `黎明` 之前，尾部），它本身夜间没有行动，这一条是冗余；真正的第三夜「唤醒爪牙换角色」是爪牙侧的动作。建议保留但不必依赖。

### 暴风捕手（高）

1. `engine.cjs:176-182` `execute` 与 `engine.cjs:227-238` `kill`：都没有免死判定，一律置死。改法：在置死前加一层 `canDie(s, seat, cause)`——`cause==='execution'` 放行；否则若 `s.markers[seat]` 含「不会死亡」则返回 `{ok:false, blocked:true}` 并记一条 log。暴风捕手的目标角色在开局时由说书人打上该标记。
   理由：能力原文「他只能死于处决」，而现在没有任何免死钩子，`deaths` 数组一写就死。
2. `agents.cjs:572` `dealEvilInfo` / `evilInfoFor`：首夜要「分别依次唤醒每个邪恶玩家，告知被点名的善良角色是哪一名玩家（不在场则告知这些角色不在场）」。现在 `dealEvilInfo` 只机械下发「爪牙→恶魔 / 恶魔→爪牙+3 伪装」，没有承载「暴风捕手点名了谁」的字段。改法：`evilInfoFor` 增加 `stormcatcher:{role,seat|null}`，`dealEvilInfo` 拼进信息文本；同时保留 `markers` 写「不会死亡」。
3. `data/nightorder.json` first 表：缺「暴风捕手」。它首夜需要一次设置/宣布动作（wiki 运作方式：为首夜做准备时放标记、然后逐个唤醒邪恶玩家）。改法：在 first 表 `恶魔信息` 之前插入「暴风捕手」。
4. `engine.cjs:452` `dealRoles` 的 `pool` 只从 `['镇民','外来者','爪牙','恶魔']` 四组取牌，`faction:'loric'` 的奇遇角色不在任何一组 → 永远发不到。改法：`pool` 增加「奇遇角色」组，并按人数从镇民名额里等量扣除。

### 杂技演员（中）

1. `data/roles.json:1910-1920`：`first_night:true` / `other_nights:false` 与能力原文「每个夜晚*」（除首夜外）相反。改成 `first_night:false, other_nights:true`。
   注意：真正决定夜间顺序的是 `data/nightorder.json`（`agents.cjs:437` 按 `s.night<=1` 选 first/other），这两个 flag 目前没有任何 .cjs 读取，所以只影响元数据与前端展示，属"应该改但不改变行为"。
2. `data/nightorder.json`：other 表已有「杂技演员」（第 24/124 位，在 `赌徒` 之后、`舞蛇人` 之前），与规则顺序一致，无需改；first 表（89 项）不含它也是对的（首夜不行动）。
3. `engine.cjs:287` `toggleMarker`：`markers` 目前只能在「有/无」之间翻转，无法记录「被选择的玩家」。改法：允许 `标记=被选择:3`（复用 `butlerMaster` 的 `主人:N` 解析风格，`engine.cjs:678-685` 是现成范式），并在 `setPhase('dawn')` 里清理「被选择」类标记（wiki：移除时机为黎明）。
4. 「当晚醉酒或中毒」判定：不需要新代码，但 `agents.cjs:474-481` 给说书人的座位表已经把 `markers` 与 `已告知` 都列出来了，建议在该行补一句提示「若目标标记含中毒/醉酒则杂技演员死亡」，否则说书人 agent 容易漏判。

### 村夫（中）

1. `data/nightorder.json`：first 与 other 两表都有「村夫」（first 第 73/89 位、other 第 108/124 位，均在信息类角色区），位置合理，无需改。
2. `engine.cjs:399-424` `bracketSpec`：`+0~2村夫` 走 `rangeRoles` 分支（`engine.cjs:413`），`min:0,max:2`。但 `engine.cjs:495-500` 的落地用的是 `Math.floor(Math.random()*3)`，**完全不读 min/max**。改法：`const k = min + Math.floor(Math.random()*(max-min+1))`。
   理由：本角色 min 恰好是 0、max 恰好是 2，侥幸对得上；换成 `+1~3` 就会算出 0，属于同一处隐患。
3. 「复数村夫中有一人醉酒」：设置阶段无钩子。改法：`dealRoles` 发完牌后（`engine.cjs:535` 之后）统计 `picked` 里村夫数量 `k`，若 `k>=2` 随机挑一个 `s.markers[i].push('醉酒')`，并 log 私密一条。
   理由：这是能力的**设置调整**部分，且 `voteWeight`/`secretBallot` 那套机制已经在读 `markers` 里的 `中毒|醉酒`（`engine.cjs:708`），标记打上就能被后续判定复用。

### 气球驾驶员（中）

1. `engine.cjs:413-414` `bracketSpec`：`+0~1外来者` 被 `rangeRoles` 的通用正则先吃掉（`([^\s,，]+)` 匹配到「外来者」），于是 `plusOutsider` 分支（`engine.cjs:417`）永远轮不到，产出一个 `{name:'外来者',min:0,max:1}`。改法：在 `rangeRoles` 正则前先判断尾部是否为阵营名（镇民/外来者/爪牙/恶魔），是则并入 `plusOutsider/plusMinion`。
2. `engine.cjs:466-482` `dealRoles`：`rangeExtra` 只收录 `allNames.indexOf(x)>=0` 的名字，而 `scriptRoleNames`（`engine.cjs:427-432`）只收集 `groups` 里的**角色名**，「外来者」是分组 key 不是角色名 → 静默丢弃（连 notes 都没有）。改法：丢弃时至少 `notes.push` 一条，并配合上一条把它变成真正的 `bonusOutsider`。
3. 「与上个夜晚得知的玩家角色类型不同」：无持久字段。改法：在 `engine.cjs` 的 state 里加 `s.lastBalloonistSeat`（或复用 markers 存 `得知:N`），并在 `giveInfo` 里当文本匹配到该角色时更新。也可暂不改，靠 `agents.cjs:480` 已经输出的「已告知」历史让说书人自述，但这是**模型记忆**而非状态，跨夜多轮后会漂。

### 渔夫（低）

1. 无需改引擎。白天私聊说书人的通道存在（`engine.cjs:298-303` 的私聊限制只针对夜间），建议通过 `giveInfo` 下发，无技术阻塞。
2. 建议（可选）：`data/roles.json:1949-1959` 已是 `first_night:false/other_nights:false`，正确；`nightorder.json` 两表都不含它，也正确（白天能力）。
3. 唯一问题：「每局游戏限一次」无机械约束。若想说书人 agent 不漏，可在 `agents.cjs:525` 的白天 prompt 里加一句「渔夫/其他拜访型角色若尚未使用能力，其座位标记里应有『已用能力』，用了就必须打标记」。

### 灵言师（高）

1. `engine.cjs:41-49` `createGame` 的 state 没有关键词字段。改法：`s.secrets = { mezeKeyword:'' }`，并在首夜由说书人写入（`runStoryteller` 的 info 之外需要一个新字段，见下条）。
2. `agents.cjs:512-517` 说书人回包 schema 只有 `think/say/info/markers/deaths/nextPhase`。要下发关键词，要么走 `info`（文本即可，说书人私聊告知「你的关键词是 XX」，无需新字段），要么新增 `keyword` 字段。建议走 `info` + 正则落库：在 `engine.cjs:132-148` `giveInfo` 里补一条 `/关键词[：:]\s*(\S+)/` → `s.secrets.mezeKeyword`。
3. 检测「首个说出该关键词的善良玩家」：**没有任何钩子**。改法：`engine.cjs:298` `say`（以及 `speak`，`engine.cjs:157`）在落库前对 `text` 做一次 `indexOf(s.secrets.mezeKeyword)`，命中且该座位为善良且尚未转化 → `s.markers[seat].push('转为邪恶')` + 私密 log。
   理由：能力原文明确「说书人需要实际听到那名玩家确切地说出了这个关键词」，玩家发言是唯一入口。
4. 换阵营：`engine.cjs:242-251` `roleFaction` 完全由 `data/roles.json` 静态决定，没有 per-seat 覆盖。改法：在 `isEvilSeat`（`engine.cjs:697-700`）、`checkWin`（`engine.cjs:253-269`）、`nomResolve` 的军团分支（`engine.cjs:859-862`）统一改为先查 `s.factionOverride`（新字段，`{seat:'evil'|'good'}`），再回退到 `roleFaction`。
   理由：现在**任何**换阵营类能力（灵言师、赏金猎人、政客）都无法落地。
5. `agents.cjs:176` `viewFor` 返回的 `faction` 也取自 `roleFaction`，转化后玩家自己的面板会显示错误阵营，需同步读 override。
6. `data/nightorder.json`：first 表有灵言师（第 45/89 位，在 `鹰身女妖` 与 `狐媚娘` 之间），位置可接受；other 表也有（第 35/124 位），但灵言师只在首夜行动，属冗余（无害，说书人 prompt 的「已告知即算结算」会跳过）。

### 炸弹人（高）

1. `engine.cjs:176-182` `execute`：处决后**不通知说书人**，而炸弹人能力必须在处决发生的同一时刻触发。改法：`execute` 增加返回值 `{onDeathRole:'炸弹人'}` 之类的钩子，或在 `server.cjs` 的 `execute` API（`server.cjs:117`）下游调用一个新的 `E.onExecute(id,seat)`，把「炸弹人爆炸」写进 state 事件队列供下一轮 `buildStorytellerDayPrompt` 读到。
   理由：说书人 agent 是轮询式工作（`agents.cjs:915 runStoryteller`），没有事件队列就必然漏触发。
2. 群体死亡：「除三名玩家以外全部死亡」可以一次性塞进 `deaths` 数组（`engine.cjs:1003` 逐个 `E.kill`），这条**链路是通的**，不用改——但 `kill` 遇到已死者会返回 `{ok:false,error:'该座位已经死亡'}`（`engine.cjs:230`），批量时不要包含已死座位。
3. 「十秒公共点数」完全没有通道：`openVote/castVote/resolveVote`（`engine.cjs:187-224`）是二元投票，落库结构是 `{target,open,yes[],no[]}`。改法：新增 `s.point = {open:true, targets:{seat:targetSeat}, t0}` 与 `point` API（`public/app.js` 需要对应的指向 UI），或退一步——允许说书人用 `say` 公开宣布「请所有人指向一人」+ 一条新 API 提交指向，然后 `engine` 统计众数、平局则直接 `setPhase('night')`。
4. `data/roles.json:1975-1985`：`on_death:false` 错误，应为 `on_death:true`（能力由处决触发）。目前没有任何 .cjs 读这个 flag，属元数据准确性。
5. `data/nightorder.json` 两表都不含炸弹人，这是**正确**的（无夜间行动），不要加。

### 炼金术士（高）

1. `engine.cjs:687-696` `voteWeight` / `engine.cjs:702-709` `secretBallot` / `engine.cjs:678-685` `butlerMaster` / `engine.cjs:859-862` 军团分支：全部以**角色名**为键。炼金术士若获得「官员（一票算三票）」「窃贼（一票负数）」「街头风琴手（闭眼投票）」「管家（跟主人投票）」「军团（全邪恶投票无效）」的能力，这些机制全部静默失效。
   改法：在 `createGame` 增加 `s.abilityOverride = {seat: '爪牙角色名'}`；`abilityOfSeat`（`engine.cjs:671-676`）优先返回 `abilityOverride` 对应角色的 ability 文本，`secretBallot`/`butlerMaster`/军团分支改为查 `abilityOverride` 命中，而不是硬比较 `r === '街头风琴手'`。
   理由：这是「能力被硬编码覆盖」的典型——不改这里，炼金术士拿到的 5 个以上爪牙能力都是空转。
2. 「首个夜晚得知自己获得了哪项爪牙能力」：可走 `info`（文本），无需新字段；但 `agents.cjs:986-1001` 的 info 去重会把重复文本吞掉（`engine.cjs:135`），注意措辞里带上角色名。
3. 「说书人可能会要求你更换选择」：回包 schema 无「选择无效、请重选」语义。改法：允许说书人在 `info` 里对同一座位再发一条「请重新选择」，并依赖现有的 `WAIT_ANSWER_MS=45000` + `ST_SAFETY_CAP=24` 兜底；若要加强，在 `agents.cjs:512` 的 schema 里新增 `"retrySeat": 座位号`，由 `runStoryteller` 直接再问一次。
4. `data/nightorder.json`：first 表有炼金术士（第 8/89 位，在 `哲学家` 之后、`罂粟种植者` 之前），位置合理；**other 表缺炼金术士**（124 项全表 0 命中）。它获得爪牙能力后要按该爪牙的时点每夜行动，other 表没有它，说书人的「本夜行动顺序」里就不出现，容易整局漏结算。改法：在 other 表插入「炼金术士」（位置放在 `信息类角色行动开始` 之前、或按常见爪牙时点放）。
5. `agents.cjs:176` `viewFor` 给玩家的 `ability` 字段来自 `roles.json`，炼金术士会看到自己「拥有一个爪牙角色的能力」却看不到具体是哪项——建议把 `abilityOverride` 的内容拼进 `ability` 或 `secretInfo`。