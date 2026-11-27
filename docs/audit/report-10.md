# 批次 10 角色审核

审核对象：chunk-10.json 的 10 个角色。依据 docs/audit-flow.md 的现状流程，代码核对范围 engine.cjs / agents.cjs / public/app.js / data/nightorder.json / data/roles.json（全部先 grep 再局部 read）。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
|---|---|---|---|
| 侏儒 | 旅行者 | 中 | 无旅行者入局通道（createGame 固定座位，无 addSeat）；提名者被杀无自动钩子 |
| 修行者 | 镇民 | 低 | nightorder.first 有位置（第 78 位），但说书人提示词无「座位环方向」几何，需自算顺/逆时针 |
| 公主 | 镇民 | 高 | 「当晚恶魔不造成死亡」无状态位；说书人上下文不含「白天提名/处决记录」，判不出来；execute() 不播报处决，死因要靠 LLM 转述 |
| 军团 | 恶魔 | 中 | 票数无效已硬编码（nomResolve:858-862），但 checkWin 用 roleFaction 判恶魔，「被当作爪牙」在阵营/胜负/爪牙信息上是假的；bracketSpec 直接把它踢出牌池 |
| 农夫 | 镇民 | 中 | 「死亡瞬间角色转换」只能靠 assignRole 手动改 roles，无自动触发、无目标挑选通道；assignRole 会 clearKnowledge |
| 利维坦 | 恶魔 | 高 | 「>1 名善良玩家被处决→邪恶胜」在 checkWin 里完全没有；checkWin 只查「恶魔死=善良胜 / 存活≤2=邪恶胜」，会把利维坦局判成别的结果 |
| 半兽人 | 镇民 | 中 | 需「先问目标再结算+当夜免恶魔刀」：顺序表把它排在外来者/爪牙段（第 138），提问通道只有一条私聊，免刀无状态位 |
| 卡扎力 | 恶魔 | 中 | [+/-任意数量外来者] 两个标签都会被 bracketSpec 误判成「外来者数量任意」（engine.cjs:412 正则过宽）；「由你决定谁是什么爪牙」无给爪牙换人的通道；首夜（first:6）就要选人+被 dealEvilInfo 抢先 |
| 印度教教徒 | loric（奇遇角色） | 中 | 「复活转世」无 API：alive 只能 createGame 置 true；旅行者阵营不在 compositionFor 里；首死四人计数无状态 |
| 召唤师 | 爪牙 | 中 | 能力标注 [无恶魔在场]，但 usable() 会把它踢出牌池（engine.cjs:447）；「把玩家变成恶魔」会撞死 checkWin 的「恶魔出局=善良胜」 |

计数：高 2 / 中 6 / 低 1 / 无 0（共 10）。

## 需要改动的地方

### 公主（高）
- engine.cjs `setPhase`（105-122 行）与夜间结算：新增 state 字段如 `princessBlock = {night: N}`，由说书人在结算公主能力时写入；**没有**这个字段之前，任何"恶魔不造成死亡"都只能靠 LLM 自觉，无法被程序记住。改成：说书人回包 markers 里给出 `今夜恶魔不造成死亡`，setPhase 进入 night 时清空。
- agents.cjs `storyContext`（约 440-490 行）：在【全场座位与真相】之外补一节「今日已发生的提名与处决」，来源 s.nom.results / s.nom.onBlock。原因：公主的触发条件依赖「今天我提名了谁、谁被处决」，当前上下文只有 `公开对话记录`，处决是日志不是消息，LLM 无法可靠回溯。
- engine.cjs `execute`（176-182 行）/ `nomFinish`（899-912 行）：处决成功时补一条 `say(id,'storyteller','X 被处决','town')`（目前只有 log，town 频道收不到）。原因：公主、利维坦都按"被处决"计数，必须先有一条可信的公开事实。
- 严重度依据：能力直接改动「当晚死亡」，属于流程 §7-③ 的类型，且触发条件所需信息根本不在提示词里。

### 利维坦（高）
- engine.cjs `checkWin`（253-277 行）：新增处决计数（如 state.executedGood），在 `execute` 里按 roleFaction 判善良阵营累加；`checkWin` 里如果本局恶魔是利维坦且 executedGood>1，直接返回 `{over:true, side:'evil', reason:'超过一名善良玩家被处决'}`。原因：现在这条胜负玩家完全不存在，利维坦局只能等存活≤2 或手动 endGame，规则被硬编码覆盖。
- engine.cjs `nomFinish`（899-912 行）：同上，处决后立即调用 checkWin（现在 execute 内部会调，但 nomFinish 只把 win 透传，需要确认返回值一路带到前端）。原因：胜利判定发生在处决瞬间，不能等到下一次 kill。
- 无 nightorder 问题（first:91 / other:218 都在，作为「黎明/利维坦」段收尾，位置正确）。

### 军团（中）
- engine.cjs `checkWin`（253-277 行）+ `isEvilSeat`（697-700 行）：军团在场时把它同时当作 minion——`roleFaction('军团')` 返回 demon，导致「恶魔出局=善良胜」和「存活≤2=邪恶胜」都按纯恶魔算。改成：新增 `isDemonSeat(s,seat)`，军团只在「本局没有其它恶魔」时算恶魔，其余场合按爪牙处理（胜负、爪牙信息、伪装都跟着走）。
- engine.cjs `dealEvilInfo`（572-591 行）：军团在场时，其它爪牙的「你的同伴是：<恶魔>」应当把军团算进去或不发；现在 evilInfoFor 把军团扔进 demonSeats，军团局会变成「爪牙的同伴是军团」的错误信息。原因：能力原文「你也会被当作是爪牙」。
- engine.cjs `usable`（444-450 行）：[多数玩家为军团] 直接 return false，军团永远抽不到。至少应在 notes 里明确「需要说书人手动开局」，而不是静默排除——现在整局根本进不来。
- 票数无效部分实现正确（nomResolve:858-862，votes=0），无需改。

### 卡扎力（中）
- engine.cjs `bracketSpec`（412 行）：`/外来者数量任意|任意数量外来者/` 对「-或+任意数量外来者」也会命中，导致 anyOutsider=true 且 plusOutsider/minusOutsider 全为 0；同时 419 行的 `[-−]\s*(\d+)\s*外来者` 对「任意数量」不匹配。改成：先匹配「任意数量外来者」，命中后显式区分「+任意 / -任意 / ±任意」，不要把「±任意」当成 anyOutsider 的唯一来源；另 `anyOutsider` 在 dealRoles 里读到了却从未使用（473/478 行只赋值），应接到外来者数量的上限放开上。
- agents.cjs `storyContext`：卡扎力首夜要「决定每个爪牙是谁」，需要在提示词里给出未上场的爪牙池（现在只给在场角色）。改成：program 模式下额外附「本剧本未使用爪牙：…」，并明确「可在 nextPhase 前用 assignRole 改爪牙」。原因：目前说书人没有任何"换爪牙"的合法入口，只能改 roles 且没有提示。
- engine.cjs `setPhase`（109-111 行）：首夜自动 dealEvilInfo 会在卡扎力还没决定爪牙时就发「你的爪牙是…」，与「由你决定谁是什么爪牙」直接冲突。改成：恶魔能力带「由你决定」标记时，把 dealEvilInfo 延后到说书人确认。

### 半兽人（中）
- data/nightorder.json `other`（138 行）：半兽人被排在外来者段（在 135「疯子」、137「道士」之间），但它是镇民且是「每个夜晚*」的主动选人角色，应在爪牙段之后、恶魔段之前（例如 140「军团」附近）。原因：顺序表错位会让首夜「先问恶魔」再问半兽人，免刀结算顺序反了。
- agents.cjs `storyContext` 的提交流程（504 行规则 3）：现在是「一次只发一条私聊提问」，若同一夜有两个需要选人的角色会互相阻塞；半兽人+恶魔同夜都需要选人，需要支持「同一轮发多条提问并分别等回复」。原因：半兽人几乎总是和恶魔同夜行动。
- engine.cjs：需要「当夜恶魔不造成死亡」的状态位（同公主方案），目前只能靠说书人自己在 deaths 里漏填，属于隐性依赖。

### 农夫（中）
- engine.cjs `kill`（227-238 行）：需要在死亡结算后给一个显式的「可改角色」回执/入口——现在只能由说书人在 info 里写「你现在是农夫」，但 `state.roles` 不会变，身份面板、夜间顺序、胜负判定全部继续按旧角色走。改成：`kill` 返回 `canChangeRole:true`，说书人回包新增 `roleChanges:[{seat,role}]`，applyReply 里调 `E.assignRole`。
- engine.cjs `assignRole`（125-131 行）+ server.cjs:90：改角色会 `A.clearKnowledge(b.id)` 清空该座位知识库。农夫转换时这是副作用（玩家被清记忆），应加参数 `keepKnowledge`。
- 严重度：能力本身不需要新交互（说书人可自选），但需要「角色可变」的通道，否则永远是纸面效果。

### 召唤师（中）
- engine.cjs `usable`（444-450 行）：召唤师能力里带 [无恶魔在场]，被 `sp.noDemon` 直接踢出牌池，永远抽不到。改成：`noDemon` 的角色不排除，而是记 notes「需无恶魔开局，本局若抽中需手动清空恶魔」；或在 dealRoles 后允许说书人 assignRole 覆盖。原因：这是唯一能把召唤师放进局的路径。
- engine.cjs `checkWin`（265-266 行）：召唤师在第三夜把玩家变成恶魔后，原恶魔如果已死，checkWin 会在同一提交里判「善良胜利」。改成：`checkWin` 先跑「是否有任何存活恶魔」，再判负；或给 `execute/kill` 加「本回合有恶魔替换」的抑制标记。
- engine.cjs `dealEvilInfo`：召唤师首夜「得知三个伪装」，现在 bluffRoles 只给恶魔发，爪牙只拿同伴信息；需要给召唤师单独发一份 3 个伪装身份。

### 侏儒（中）
- engine.cjs `createGame`（33-60 行）：座位在开局固定，没有 `addSeat`/`joinGame`（server.cjs 也无）。旅行者「加入游戏时」无对应 API。改成：新增 `addTraveler(id, name, seat)`，push seats / alive / markers 并 `giveInfo(id, seat, '你的角色是【侏儒】')`。
- engine.cjs `nomPropose`（744-761 行）：侏儒「每当他被提名时，你可以杀死提名者」需要「被提名后、投票前」的钩子；现在提名是原子操作，没有中途插入点。改成：nomPropose 里检测被提名者能力含「被提名时…可以杀死提名者」，返回 `pendingTravelerKill` 并暂停。
- 能力里的「所有玩家知道一名同阵营玩家」可以靠 giveInfo 全员下发，无需改代码。
- public/app.js：座位渲染只按 `seats[]` 数组顺序（grep 到的只有 `wintitle` 处区分阵营），没有「中途加入的旅行者」区块。若做 addTraveler，前端座位列表/身份卡需要跟着刷新，否则新座位不显示。

### 印度教教徒（中）
- engine.cjs：无复活 API（全仓只有 createGame:51 会 `alive[i]=true`，grep `alive[x]=true` 只此一处）。「以相同阵营的旅行者转世重生」需要 `reviveAsTraveler(id, seat, role)`：alive 置 true、清「死亡」标记、roles 改为旅行者、补发身份信息。
- engine.cjs `compositionFor`（380-387 行）：旅行者不在配比表里，转世后会多出一个人（good+evil 总数 ≠ 座位数），`checkWin` 的存活计数会把旅行者算进「存活≤2」。需要在 checkWin 里排除 faction==='traveler'。
- 首死四人计数需要状态（state.deathOrder）；现在 kill/execute 都不记先后。

### 修行者（低）
- data/nightorder.json `first`：第 78 位（在「方士」与「钦天监」之间），首夜信息类角色，位置正确，无需改。
- agents.cjs `storyContext`：全场座位表按座位号顺序排列，没有「座位是环形、顺时针=座位号递增」的说明；修行者的答案依赖这个几何。建议在【全场座位与真相】标题下加一句「座位围成一圈，顺时针为座位号递增（N 号与 1 号相邻）」。原因：否则每个说书人实例对「顺时针」的解读可能不同。

### 无严重度问题
- 无。（本批没有「完全不需要改动」的角色；小队里唯一位置和实现都正确的只有修行者的一半。）
