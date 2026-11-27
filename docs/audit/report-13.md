# 批次 13 角色审核

审核范围：docs/audit/chunk-13.json 的 10 个角色。
核对依据：docs/audit-flow.md 所述机制 + engine.cjs / agents.cjs / server.cjs / public/app.js / data/nightorder.json 实际代码。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
|---|---|---|---|
| 异教领袖 | 镇民 | 中 | nightorder 两表都有（first:82 / other:209）。阵营无代码载体：roleFaction 是 roles.json 静态查表，全局无 alignment 或阵营覆盖字段，「每夜转为邻近玩家阵营」只能写进 markers，checkWin 读不到 |
| 异术士 | 奇遇角色 | 低 | nightorder 无（不需夜间行动，可接受）。发目标与达成给信息可由 marker + giveInfo 承载；但 loric 不在任何剧本 groups，程序发牌永不抽到 |
| 异端分子 | 外来者 | 高 | 胜负对调无任何钩子。execute/kill/resolveVote 都直接调 checkWin，命中即写 side、播报「对局结束」并让 /api/game 公开全部角色，说书人事后 endGame 也无法撤回前一次播报与角色公开 |
| 恐惧之灵 | 爪牙 | 高 | nightorder 两表都有（first:46 / other:127），位置合理。能力要「他的阵营落败」，checkWin 只认「恶魔出局／存活≤2」，没有按被处决者阵营判负的通道；判定所需的提名记录（s.nom.results）也没注入说书人白天提示词 |
| 戏法师 | 镇民 | 低 | 白天能力，nightorder 无（正确）。猜对后可由说书人 endGame 手动落终局，机制可行；缺「每天限一次」的机械约束，且与自动 checkWin 同夜触发时会抢跑 |
| 报丧女妖 | 镇民 | 高 | 「每天两次提名」被 nomPropose 的 usedNom 挡死（engine.cjs:751），无豁免分支；voteWeight 的「每次投票时可以投两票」分支是无条件生效，未觉醒时就已经 ×2 |
| 提线木偶 | 爪牙 | 高 | 无「假角色」层：dealRoles 直接把「你的角色是【提线木偶】」发给本人，且 evilInfoFor 把木偶计入 minionSeats，木偶会收到「你的同伴是：恶魔」；座位约束只在 evilN>1 且写死「最后一个邪恶=木偶」 |
| 摆渡人 | 传奇角色 | 高 | 「重新获得投票标记」＝清空 s.deadVoteUsed，但唯一标记接口 toggleMarker 只动 markers。agents.cjs:230 明写「用 toggleMarker 处理」——按此操作完全无效 |
| 政客 | 外来者 | 中 | 终局只能靠 endGame 改整体 side；s.winner 只是 good/evil 字符串，没有胜者名单，「政客个人额外获胜」这种粒度无法表达；自动 checkWin 同样会先播报 |
| 教皇 | 奇遇角色 | 中 | 程序发牌不重复取角色（仅人数不足的兜底会随机重复），无法指定重复；bluffRoles 明确排除在场角色，与「重复角色可作恶魔伪装」直接矛盾 |

## 需要改动的地方

### 异端分子（高）

- 文件/函数：engine.cjs 的 checkWin（253-277）与 endGame（279-286）。
- 改成什么：在 checkWin 落终局之前加一个说书人可设置的开关注（如 s.flags.heretic），命中时先算出结果再对调 side，并在 reason 里标明「异端分子对调」。
- 为什么：265-269 行写死 side 为 good 或 evil，271-273 行立刻 s.phase 置 ended 并 log 到公聊；server.cjs:77-81 在 win.over 后公开全部角色。一旦自动路径触发，说书人只剩事后 endGame 覆盖，先前那句「善良阵营胜利」和角色公开都撤不回。

### 恐惧之灵（高）

- 文件/函数：engine.cjs 的 checkWin（253-277）、nomFinish（899-912）；agents.cjs 的 buildStorytellerDayPrompt（525-551）。
- 改成什么：①新增按「被处决者阵营」判负的分支——nomFinish 处决前检查该座位 markers 是否含「恐惧」且当次提名的 from 就是该爪牙座位，命中则按被处决者阵营直接落终局；②s.win 增加 loser 字段（现在只有 side 单值），用来表达「X 阵营落败」；③把 s.nom.results 最近若干条（from/target/votes/passed）注入白天提示词。
- 为什么：能力直接改胜负，而 265-269 只有 demonAlive 与存活人数两个判据，没有「提名者本人 + 恐惧标记」的判定链；说书人看不到提名记录，只能靠公聊复述猜。

### 报丧女妖（高）

- 文件/函数：engine.cjs 的 nomPropose（744-761）、nomCanNominate（740-743）、voteWeight（687-696）。
- 改成什么：①751 行的 usedNom 判据改成带配额：quota = 已觉醒 ? 2 : 1，再比较 (s.nom.usedNom[from]||0) >= quota；usedNom 目前存布尔（754 行 s.nom.usedNom[from] = true），要改成计数。②voteWeight 691 行的 /每次投票时可以投两票/ 加前置条件：该座位必须已觉醒（markers 含「具有能力」或「报丧女妖觉醒」），否则返回 1。
- 为什么：能力原文（data/roles.json:1810）就是「每次投票时可以投两票」，正常玩家带这句话就会在未觉醒时享受 ×2；而「两次提名」被 751 行硬拒，能力核心部分完全跑不起来。

### 提线木偶（高）

- 文件/函数：engine.cjs 的 dealRoles（434-544，重点 503-509、518-526）、evilInfoFor（550-560）、dealEvilInfo（572-591）。
- 改成什么：①引入「认知角色」概念：dealRoles 给木偶座位发一个随机善良镇民的假角色（真身另存 s.trueRoles[seat]），roleFaction 统一改读 s.trueRoles；否则 578-581 行给木偶发「你的同伴是：恶魔」直接把爪牙身份送给本人。②evilInfoFor 555-558 用阵营分类时要把「认知为善良的木偶」排除出发爪牙信息的名单，同时保证恶魔那份（583-587）仍能看到木偶。③518-526 的邻座编排把 picked[puppetSeat] = evil[evilN-1] 换成按名字定位（在 evil 里 indexOf 提线木偶 再放到 demonSeat+1），现在是拿打乱后数组的最后一个，木偶未必在那个位置。
- 为什么：能力第一句「你以为你是一个善良角色」是核心，当前 539 行 giveInfo 直接报真身，能力等于不存在。

### 摆渡人（高）

- 文件/函数：engine.cjs 新增 resetDeadVotes；server.cjs:119 附近加 api 条目；改正 agents.cjs:230 的错误指引。
- 改成什么：新增 function resetDeadVotes(id)，读状态后 s.deadVoteUsed = {} 再 saveState，返回 ok；server.cjs 的 buildApi 里加 resetDeadVotes: (b) => E.resetDeadVotes(b.id)；agents.cjs:230 的文案从「用 toggleMarker 处理」改成「调用 resetDeadVotes 清空死亡票」。
- 为什么：engine.cjs:792 与 :828 都只读 s.deadVoteUsed，toggleMarker（287-292）只改 s.markers，摘掉「死亡」标记既不会让 s.alive 变 true、也不会清 deadVoteUsed。现有指引是错的，能力完全执行不了。

### 异教领袖（中）

- 文件/函数：engine.cjs 的 roleFaction（242-251）、checkWin（253-277）、isEvilSeat（697-700）；state 初始化（41-49）。
- 改成什么：新建 s.alignment（座位到 good/evil 的映射），roleFaction 改成「若 s.alignment 有值优先用它，否则查表」；checkWin 的 anyDemon 与 demonAlive（258、263）以及 isEvilSeat 都走这个统一入口；说书人侧除现有 marker 接口外再加一个 setAlignment（或让 toggleMarker 支持「阵营:evil」前缀解析）。
- 为什么：现在阵营是 roles.json 的静态查表结果，转阵营没有任何数据落点；异教领袖变成邪恶后，若恶魔出局 checkWin 仍判善良胜（他反而输），能力与胜负判定直接相反。
- 附带（低）：data/roles.json:1745 的能力原文只保留夜间转阵营，wiki 里「白天提议所有玩家加入教派、全善良同意则获胜」那半句没入库，若是有意裁剪可忽略。

### 政客（中）

- 文件/函数：engine.cjs 的 checkWin（253-277）、endGame（279-286）；agents.cjs 的 storyRecap 路径（1405-1427）。
- 改成什么：给终局结果加「个人胜负」层：s.win 增加 extraWinners 与 loser，endGame(id, side, reason, extra) 接受第四个参数；白天提示词里给出「终局时可为某座位附加获胜」的出口。
- 为什么：现在 s.winner 只是 good/evil，无法表达「善良落败但政客随邪恶获胜」；政客的判定权本来就是说书人裁量，缺的只是结果表达。

### 教皇（中）

- 文件/函数：engine.cjs 的 dealRoles（503-509）、bluffRoles（563-570）。
- 改成什么：①dealRoles 支持重复角色：给取样加可替换分支，允许同一个镇民名被取多次（教皇在场时按说书人指定或随机 1-2 个重复）；②bluffRoles 568 行的 inPlay.indexOf(x) < 0 过滤在教皇局要放开，允许在场角色作伪装，但要与 dealEvilInfo 的 3 个伪装位数不冲突。
- 为什么：503-509 的 shuffle().slice() 天然不重复，唯一会重复的是 508 行人数不足时的兜底随机 push，那不是说书人能控制的；568 行则把在场角色整类排除，与教皇能力第二句直接矛盾。

### 异术士（低）

- 文件/函数：data/scripts/*.json 的 groups、engine.cjs 的 dealRoles（451-454）。
- 改成什么：若要奇遇角色真正进场，需在 scripts 的 groups 里加可用分组，或在 dealRoles 里对 loric 单独处理；否则只能靠 roleMode=storyteller 手动 assignRole。
- 为什么：451-454 只从镇民/外来者/爪牙/恶魔四组取池，loric 一个都进不去；这不影响能力执行（目标用 marker、信息用 giveInfo 都够），只影响可玩性。

### 戏法师（低）

- 文件/函数：agents.cjs 的 buildStorytellerDayPrompt（525-551）、engine.cjs 的 endGame（279-286）。
- 改成什么：白天提示词补一句「若某角色白天有公开触发能力（如戏法师的猜测），玩家公开宣称并给出猜测后由你判定，可用 endGame 落终局」；若要机械约束「每天一次」，需在 state 里加 dailyUsed。
- 为什么：548 行的输出 schema 只有 info/markers/deaths/nextPhase/voteTarget/resolveVote，没有「宣布某阵营胜利」的字段，说书人只能靠 endGame 接口，而提示词从未告诉它可以这么做。
