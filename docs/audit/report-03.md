# chunk-03 角色审核报告

> 审核对象：`docs/audit/chunk-03.json` 的 10 个角色（男爵 / 小恶魔 / 官员 / 乞丐 / 枪手 / 窃贼 / 替罪羊 / 祖母 / 水手 / 侍女）
> 对照：`docs/audit-flow.md`、`data/nightorder.json`、`engine.cjs`、`agents.cjs`、`server.cjs`、`public/app.js`、`data/roles.json`、`data/scripts/暗流涌动.json`
> 说明：代码里的硬编码事实均已逐段读过原文，行号见「需要改动的地方」各条。

## 总表

| 角色 | 阵营 | 能力摘要（≤40字） | 与现状是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 男爵 | 爪牙 | 会有额外的外来者在场。[+2 外来者] | 否（池不足时有瑕疵） | `bracketSpec` 的 `/[+＋]\s*(\d+)\s*外来者/`（engine.cjs:417-418）能命中 `[+2 外来者]`，`dealRoles` 在 engine.cjs:477/484 把它加进外来者名额、502 行反算镇民数，配比与 wiki 范例一致（7 人局 5 镇 0 外 → 3 镇 2 外）。唯一瑕疵：14~15 人局外来者名额 = 3+2 = 5，而《暗流涌动》外来者池只有 4 个（管家/酒鬼/陌客/圣徒），engine.cjs:508 的 `while` 循环会拿现有善良角色复制补位，出现重复镇民且外来者实际不满额 | 低 |
| 小恶魔 | 恶魔 | 每夜选一人杀死；若以此自杀，一名爪牙变成小恶魔 | 是 | 每夜杀人在 `other` 顺序表里有（nightorder.json other 含「小恶魔」），`kill()` 能落地。但**自杀后变恶魔这条路完全走不通**：①`kill()`（engine.cjs:227-238）末尾立刻 `checkWin()`，恶魔一死即写 `phase='ended'`「恶魔已出局，善良胜」，对局当场结束，没有让爪牙接棒的窗口；②没有角色变形通道，`assignRole()`（engine.cjs:125-131）只写 `s.roles[seat]`，不清旧标记/旧信息、不重发角色卡；③`agents.cjs:992-995` 在 roleMode='program' 时**主动拦截**说书人任何「你的角色是【X】」的下发；④新恶魔当夜不得行动，顺序表已过，也没有「本夜不再行动」的记录位 | 高 |
| 官员 | 旅行者 | 每夜选一人：明天白天他的投票算作三票 | 是 | 双重断链。①**旅行者根本进不了局**：`compositionFor` 只有 [镇民/外来者/爪牙/恶魔]，`dealRoles` 只从这四个池抽（engine.cjs:451-471），`createGame` 建局时座位数即固定（engine.cjs:33-60），全库无 `addSeat/addTraveler`（grep `seats.push|addSeat|createSeat` 零命中）。②即便有人在，票权也不生效：`voteWeight()`（engine.cjs:687-696）只读**本座位自己的能力文本**，不读他人施加的权重；而白天处决投票 `resolveVote()`（engine.cjs:208-224）直接用 `s.vote.yes.length` 数人头，**连 voteWeight 都不调用**。`agents.cjs:226` 的 VOTE_ROLE_RULES 写着「程序已自动按三票计」，与实现不符，会误导说书人 | 高 |
| 乞丐 | 旅行者 | 你只能使用投票标记才能投票 | 是 | ①旅行者进不了局（同上）。②**投票标记体系不存在**：`nomHand()`（engine.cjs:786-806）的拒绝条件只有「无提名 / 不在 vote 阶段 / 座位越界 / 死者票已用 / 管家主人未举手 / 狂信者必投」，没有任何「该玩家是否持有投票标记」的校验；`castVote()`（engine.cjs:197-207）只查 `s.alive[seat]`。③死者把票转交（`giveVoteToken`）没有接口，`s.deadVoteUsed` 只有 0/1 布尔语义，撑不起「乞丐可持有 N 张」「死者交票后失去投票权」 | 高 |
| 枪手 | 旅行者 | 每白天首次投票统计后，可射杀一名刚投票者 | 是 | ①旅行者进不了局。②**白天没有任何触发通道**：`buildStorytellerDayPrompt`（agents.cjs:525-551）的输出只有 `think/say/info/markers/deaths/nextPhase/voteTarget/resolveVote`，没有「首次投票统计后」这个时点；提名驱动（agents.cjs:1255-1299）在 `nomResolve` → `nomClose` 之间是程序自动跑的，**不会插入说书人轮次**，说书人拿不到「现在是首次投票计票完成」的信号。③即使说书人靠 day prompt 的 `deaths` 杀人，落库（agents.cjs:1003）写死 `E.kill(id,i,'夜间死亡')`，死亡会进 `nightDeaths`，下个天亮被播报成「昨夜死亡」，时机与措辞全错 | 高 |
| 窃贼 | 旅行者 | 每夜选一人：明天白天他的投票算作负数 | 是 | 与官员同源：旅行者进不了局；`voteWeight()` 只认「本座位能力文本里有『投票会被算作负数』」，被窃贼选中的普通镇民文本里没这句，永远返回 1；`resolveVote()` 又不看权重。此外「明天白天」的时效（当天有效、次日恢复）在 `s.markers` 自由文本里没有到期机制，重复下发还会被 `toggleMarker`（engine.cjs:287-292）的翻转语义互相抵消 | 高 |
| 替罪羊 | 旅行者 | 若你阵营的一名玩家被处决，你可能代替他 | 是 | ①旅行者进不了局。②**处决链路没有替代钩子**：`nomFinish()`（engine.cjs:899-912）拿到 `s.nom.onBlock` 后直接 `execute(id, ob.target)`；`execute()`（engine.cjs:176-182）无条件 `alive[seat]=false` + `checkWin`；`resolveVote()` 通过时同样直接 `execute`。说书人只能事后补一条 `deaths`，但那已被算成「夜间死亡」，而且原处决者已死，规则上是错的（替罪羊替死后当天不应再有额外处决） | 高 |
| 祖母 | 镇民 | 首个夜晚得知一名善良玩家和他的角色 | 是 | 首夜信息本身可做：`first` 顺序表含「祖母」，`info` 通道能把「N 号是 X（角色）」私聊发出，`giveInfo` 会同时落一条 private 消息。问题在**附加死亡链**：wiki `data/wiki/pages/祖母.md:13`「如果恶魔杀死了他，你也会死亡」——`kill()`（engine.cjs:227-238）**把传入的 reason 参数直接丢弃**，没有死亡原因分类，也没有 on-death 回调，说书人无法可靠区分「孙子被恶魔刀死」与「孙子被处决/其他原因死亡」；一旦判错，祖母该活却死了或该死却没死。另：`other` 顺序表也含「祖母」，每夜都列进本夜流程，靠「已告知里已有针对该座位的信息」判为已结算才跳过，容易被误读成每夜重发一次信息 | 中 |
| 水手 | 镇民 | 每夜选一名存活玩家：你或他之一醉酒直到下个黄昏 | 是 | `first`/`other` 顺序表都含水手，每夜可被唤醒，`markers` 自由文本能承载「醉酒」。但：①**没有到期机制**——「直到下个黄昏」全靠说书人自觉清 `醉酒` 标记，`setPhase`（engine.cjs:95-124）不清理 markers，漏清就是永久醉酒；②`toggleMarker`（engine.cjs:287-292）是**翻转语义**，连续两夜给同一人发「醉酒」会把它抵消掉；③wiki 能力段（`data/wiki/pages/水手.md:13`）的「你不会死亡」在 `roles.json` 的 ability 原文里被截掉，说书人若只看 ability 字段会漏掉免死；`kill()` 本身也没有保护判断 | 中 |
| 侍女 | 镇民 | 每夜选两名存活玩家：得知几人在当晚因自身能力被唤醒 | 是 | 顺序表 `first`/`other` 都有侍女，她自己的选人与信息都能走 `info` 通道。真正的缺口是**「当晚因自身能力被唤醒」的名单没有任何结构化记录**：说书人是一个夜晚分多轮 LLM 逐项处理的，`viewForStoryteller`（agents.cjs:254-268）只给 seats/messages/nominations/votes，没有「本夜已唤醒角色」列表；而 wiki 明确要求排除三类唤醒（程序自动的爪牙/恶魔信息、被他人能力唤醒、误唤醒），这几类恰恰散落在提示词与程序里，只能靠模型记忆拼，极易数错 | 中 |

**本批 10 个角色：高 6 / 中 3 / 低 1 / 无 0**

---

## 需要改动的地方

### 一、engine.cjs：旅行者（官员 / 乞丐 / 枪手 / 窃贼 / 替罪羊 —— 这 5 个角色的共同前提）

1. **支持旅行者入场**。当前 `createGame`（engine.cjs:33-60）建局时 `seats` 即固定，`compositionFor` 只返回 4 元组，`dealRoles`（engine.cjs:451-471）只从四个池抽。需新增 `addTraveler(id, { name, role, faction })`：追加 `s.seats` / `s.alive` / `s.markers` / `s.info`，写 `s.roles[seat]=role`，并置 `s.traveler[seat]=true` 与 `s.travelerFaction[seat]='good'|'evil'`（旅行者阵营由说书人当场指定，不能沿用 `roleFaction()` 的静态 faction）。
2. **胜负判定排除旅行者**。`checkWin()`（engine.cjs:253-277）的 `aliveSeats.length <= 2` 必须只数非旅行者（wiki `data/wiki/pages/旅行者.md:45`：5 人存活其中 3 个旅行者时邪恶胜）。否则一加旅行者，邪恶方几乎永远赢不了。
3. **新增流放流程** `exile(id, seat)`：成功票数按**全体玩家**（含死者，且死者不消耗投票标记）的一半计算，不受任何角色能力影响；流放不死则当天仍可处决。至少要有一条与 `execute()` 分开的死亡路径，否则旅行者只能被处决——而规则明确禁止处决旅行者。
4. **server.cjs** 增加 `POST /api/traveler`（addTraveler）、`POST /api/exile`（exile），并在 `/api/game`（server.cjs:67-84）非说书人视角保留 `s.traveler` 与旅行者阵营（规则要求全员皆知谁是旅行者）。

### 二、engine.cjs：票权打通（官员 / 窃贼 / 乞丐）

5. **新增外部施加的票权**。`voteWeight()`（engine.cjs:687-696）目前只读「本座位自己的能力文本」，必须改为优先读外部状态：`s.voteMod[seat] = { weight: 3|-1, day: N, by: seat }`，且 `s.voteMod[seat].day === s.day` 才生效（「明天白天」= 打标记那天 +1，白天结束即失效）。
6. **修 `resolveVote()` 不走权重的问题**（engine.cjs:208-224）。现在 `const yes = s.vote.yes.length; const pass = (yes > no) && (yes * 2 >= alive);` 直接数人头，官员/窃贼在白天处决投票里永远无效。应改为按 `voteWeight(s, seat)`（或 nomResolve 的 `cur.weights`）累加，票数为负时参与合计。**这是本批 6 个「高」里最核心的一处修改。**
7. **新增投票标记** `s.voteTokens[seat]: number`（正常玩家默认 1 张，乞丐默认 0）。在 `nomHand()`（engine.cjs:786-806）与 `castVote()`（engine.cjs:197-207）各加一条「`voteTokens[seat] <= 0` → 拒绝并返回『你没有投票标记』」；`nomFinalizeSeat()`（engine.cjs:814-835）投票成功时扣 1。
8. **新增 `giveVoteToken(id, fromSeat, toSeat)`**：死者把标记交给乞丐，`s.deadVoteUsed[fromSeat]=true`、`s.voteTokens[toSeat]++`，并私聊乞丐「N 号把投票标记给了你，他是善良/邪恶阵营」。现有 `deadVoteUsed` 只有布尔语义，撑不起「持有多张」。
9. **server 路由**：`setVoteMod` / `giveVoteToken`，并在 `nomState()` 里回传 `voteTokens` 与 `voteMod` 供前端显示。

### 三、engine.cjs：死亡与处决替代（替罪羊 / 小恶魔 / 祖母）

10. **保留死亡原因**。`kill(id, seat, reason)`（engine.cjs:227-238）的 `reason` 参数被完全丢弃，必须写进 `s.deathLog.push({ seat, reason, night, day })`。这是祖母「孙子被**恶魔**杀死」唯一的可靠判据。
11. **新增处决替代**。给 `execute()`（engine.cjs:176-182）加 `opts.replaceWith`：若说书人指定替罪羊替死，则置 `alive[替罪羊]=false`、原目标存活，写 `log('X 被处决，但 Y 代替他死亡')`；同时标记 `s.dayExecuted = true`，防止「替死后当天还能再处决一次」（规则明文）。`nomFinish()`（engine.cjs:899-912）与 `resolveVote()` 两处 `execute` 调用都要能接这个目标。
12. **新增 `setMarker(id, seat, marker, on)`**（设置语义）。`toggleMarker()`（engine.cjs:287-292）是翻转语义，中毒/醉酒/被保护这类持续状态被重复下发就会互相抵消。至少把「醉酒/中毒/被保护」三类改走设置语义，并在进入 `day`（即「下个黄昏」到期点）时统一清理水手的醉酒标记。
13. **小恶魔自杀换人**：新增 `changeDemon(id, seat)`，内部调 `assignRole` 但必须（a）清空该座位旧 `markers`/`info`；（b）`kill()` 加 `opts.deferWin`，把「恶魔出局 → 善良胜」延到本夜全部结算完（`setPhase('day')` 时）再判，否则对局在爪牙接棒前就结束了。

### 四、agents.cjs：说书人通道与提示词

14. **扩展夜间输出协议**（`buildStorytellerNightPrompt` 的 JSON 模板，agents.cjs:512-517）。现在只有 `think/say/info/markers/deaths/nextPhase`，需补：`voteMod:[{seat,weight}]`、`changeRole:[{seat,role}]`、`execReplace:[{from,to}]`、`giveVoteToken:[{from,to}]`，并让 `deaths` 支持对象形式 `{seat,reason}`。同时在「可用动作」段逐条说明用途，否则说书人 LLM 根本不知道该输出这些字段（`docs/audit/report-06.md:111` 已有同类建议）。
15. **扩展白天输出协议**（`buildStorytellerDayPrompt`，agents.cjs:547-549）加 `dayKill:[{seat,reason}]`、`exile:座位号`、`voteMod`。
16. **修落库写死 reason 的问题**（agents.cjs:1003）：`const r = E.kill(id, i, '夜间死亡');` 无论白天黑夜都写「夜间死亡」，白天被枪手或处决替代杀的人会进 `nightDeaths`，下个天亮播报成「昨夜死亡」。应按 `rp` 给的 reason 传，并在白天不写 `nightDeaths`。
17. **放开程序发牌下的角色重发**（agents.cjs:992-995）：现在 roleMode='program' 时任何含「你的角色是【X】」的 info 都被拦截，导致小恶魔接棒的爪牙永远收不到新角色卡。应改为「仅当本夜有 `changeRole` 记录时放行对应座位」。
18. **修正 `VOTE_ROLE_RULES`**（agents.cjs:224-239）：其中官员「程序已自动按三票计」、窃贼「程序已自动按 −1 计」目前**是假的**（resolveVote 不读权重），会直接误导说书人；等第 6 条改完才成立。
19. **新增旅行者行动段**：`viewForStoryteller`（agents.cjs:254-268）加 `travelers` / `voteTokens` / `voteMod` / `nominatedVoters`；`buildStorytellerNightPrompt` 在顺序表之后加一段「旅行者每夜能力」（官员、窃贼），因为 `data/nightorder.json` 里**五个旅行者一个都不在**（已实测 `first`/`other` 均不含）。
20. **枪手触发通道**：在提名驱动（agents.cjs:1279-1283，`nomResolve` 之后 `nomClose` 之前）判断「本白天首次投票已统计 且 场上有清醒枪手」，插入一次说书人轮次（复用 day prompt 并注入「现在是本白天首次投票统计之后，票投给了 N 号，本项投票者为：…」），等其回复后再 `nomClose`。
21. **侍女可判定性**：在夜间循环里维护 `applied.wokenTonight = []`（本夜真正因自身能力被唤醒的座位），并在处理到侍女时把该列表与排除项说明注入她那一段提示词；否则 LLM 只能凭记忆数。

### 五、public/app.js 与数据

22. **data/nightorder.json**：五个旅行者都不在 `first`/`other`（实测：官员/乞丐/枪手/窃贼/替罪羊 全为 false）。把官员、窃贼写进 `other`（旅行者没有首夜能力），否则说书人永远不会被提醒去唤醒他们。小恶魔已在 `other`，无需改动。
23. **public/app.js:471** 只渲染 `markers`：需增加旅行者标识（谁是旅行者、阵营颜色）、投票标记数量、票权修正（`meta.weights` 已在 app.js:1006 用于提名计票，白天处决投票也要显示）以及流放按钮。

### 六、提示词与数据口径（不改代码也能减少出错）

24. 在 `ST_RULES` / `BALANCE_RULES`（agents.cjs:135-159）旁边补一段「旅行者规则摘要」（流放而非处决、不计入邪恶胜利阈值、能力不影响流放表决），否则说书人即使有了通道也会按普通角色处理他们。
25. `data/roles.json` 里 `祖母` 的 ability 缺了 wiki 的第二句（`data/wiki/pages/祖母.md:13`「如果恶魔杀死了他，你也会死亡」），`水手` 缺「你不会死亡」（`data/wiki/pages/水手.md:13`）。建议补进 `ability` 字段，否则说书人只读 ability 就会漏掉最关键的死亡/免死判定。
