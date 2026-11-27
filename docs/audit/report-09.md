# 批次 09 角色审核

审核范围：chunk-09.json 全部 10 个角色（梦殒春宵旅行者 5 人 + 诺-达鲺/涡流 + 事务官/亡魂/传教士）。
核对文件：engine.cjs、agents.cjs、public/app.js、server.cjs、data/nightorder.json、data/roles.json、data/scripts/梦殒春宵.json、data/wiki/pages/*.md。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
| --- | --- | --- | --- |
| 涡流 | 恶魔 | 高 | ability 在 roles.json 被截断，丢掉「镇民能力产生错误信息」和「白天无人被处决则邪恶胜」两句；且说书人回包无 win 字段，自定义胜负无法落地，只能靠玩家手点「宣布终局」。 |
| 诺-达鲺 | 恶魔 | 中 | 每夜杀人可正常跑（在 other 表里），但 ability 截断丢「与你邻近的两名镇民中毒」，且全局无中毒状态机与邻座目标计算，中毒结果只能靠说书人自己记。 |
| 怪咖 | 旅行者 | 高 | 全程序无旅行者进场与流放（exile）流程，「当天不能被流放」既无判定点也无被违背后果；组合里写了额外角色标签还会被 dealRoles 当镇民塞进 good 池（engine.cjs:487-492 只分 outsider / 其他）。 |
| 集骨者 | 旅行者 | 高 | 「让死亡玩家重新获得能力」需要复活 = 撤销死亡，而 execute/kill 只单向置 alive=false，全仓无复活代码；且它 first_night:true 却在 first/other 两表都没有，夜序入口都没有。 |
| 咖啡师 | 旅行者 | 高 | 需要「二选一到下个黄昏」的持续状态（解除并免疫中毒/醉酒，或能力生效两次），markers 是 toggle 语义、无到期作用域；还需要「该玩家得知是哪个效果」的定向告知通道；两标志均 false 且不在任何夜序表。 |
| 流莺 | 旅行者 | 高 | 需要向目标玩家发起「是否同意」的交互（现有 API 只有说书人提问通道，没有玩家→玩家同意的回包字段），且「你们两个可能同时死亡」要一次杀两人；other_nights:true 但 other 表里没有它。 |
| 屠夫 | 旅行者 | 高 | 「首次处决后可再次发起提名」被三重硬编码挡住：nom.usedNom（engine.cjs:751）、nom.usedTarget（:752）、votes>prev 且 majority 才能上处决台（:866）；且状态里根本没有 executedToday 字段来判断「今天的首次处决」。 |
| 事务官 | 镇民 | 中 | 首夜「得知一名善良玩家」用 giveInfo 可跑，但角色不在任何剧本 groups（roles.json:1322 scripts:[]，data/scripts 三个文件零命中），程序发牌永不进场；玩家侧看不到「得知」提示标记语义。 |
| 亡魂 | 爪牙 | 中 | 「可夜晚睁眼、其他邪恶被唤醒时一同被唤醒」已被夜序表近似实现（first 第 4 位、other 第 2 位），但缺「死亡或中毒/醉酒时当晚不能睁眼」的判定，且夜序裁剪只看是否在场、不看存活（agents.cjs:434-445），死人照样会被唤醒。 |
| 传教士 | 镇民 | 高 | ability 截断丢第二段「所有被你选中的爪牙失去能力」；该效果是持续到解除的「失去能力」状态，engine 没有能力屏蔽位，且说书人无从得知谁被布道；同时不在任何剧本里，发牌永不进场。 |

合计：高 7 / 中 3 / 低 0 / 无 0。

## 需要改动的地方

### 一、涡流（恶魔，高）

1. `data/roles.json:1226` —— ability 补全为三段：「每个夜晚*，你要选择一名玩家：他死亡。」「镇民玩家的能力都会产生错误信息。」「如果白天没有人被处决，邪恶阵营获胜。」。现在是只有第一句，说书人 Agent 的 roleDetail 虽能从 wiki 拿全文，但玩家侧 roleBrief（agents.cjs:109-111 用 `r.ability`）看到的是残缺版，玩家不知道自己有胜负能力。为什么：这是所有恶魔里唯一改胜负的，残缺等于玩家无法据此决策。
2. `agents.cjs:512-517 / 547-549` —— 说书人回包 schema 增加 `win` 字段（`win: '' | 'good' | 'evil'`），parseReply（:633）解析后在 apply 段调用 `E.endGame(id, rp.win, '涡流能力')`。为什么：:1008-1012 是唯一读 win 的地方，且只读 resolveVote 的副作用；涡流的胜负与投票无关（是「白天结束没有处决」这个事件），当前只有人类手动点「宣布终局」（public/app.js:1086）。
3. `engine.cjs:899-911 nomFinish` —— 在「无人被处决」分支（`say(id,'storyteller','今天没有人被处决。','town')` 之前）调用一个可插拔钩子 `roleHooks.onNoExecution(s)`，若涡流在场且存活则置 evil 胜。为什么：白天处决的唯一出口在这个函数里，没有任何回调，涡流能力没有触发点。

### 二、诺-达鲺（恶魔，中）

1. `data/roles.json:1211` —— ability 补全第二段「与你邻近的两名镇民中毒。」（wiki 页有完整版）。为什么：同涡流，玩家侧看到的是截断版，不知道自己会让人中毒。
2. `engine.cjs:287-292 toggleMarker` —— 新增 `addTimedMarker(seat, marker, until)` 或在 marker 字符串里约定「中毒(至黄昏)」。为什么：诺-达鲺的中毒是「直到诺-达鲺死亡或失去能力」，是持续状态；toggle 语义重发即删除，说书人重复播报反而会解毒。
3. `agents.cjs:446-520` 夜间提示词 —— 给恶魔的提示里补「邻近两名镇民」的座位计算规则（wiki 已写：顺时针/逆时针最近的镇民，跳过非镇民）。为什么：让说书人不必每局自己推邻座，减少错判。

### 三、怪咖（旅行者，高）

1. 新增旅行者子系统：`engine.cjs` 增加 `s.travelers` 数组与 `exile(seat)` 函数（剔除出局但不置 evil、不进 nightDeaths），`server.cjs` 增加 `exilePlayer` 动作，`public/app.js` 在座位卡加「流放」按钮。为什么：全仓 grep「旅行者|流放|exile|Traveler」在 server.cjs / engine.cjs / public/app.js / agents.cjs 里只有 agents.cjs:185 一处（解析自称），即流放机制完全不存在，怪咖的能力文本无从执行。
2. `engine.cjs:487-492` —— 阵营判定补 traveler 分支：`if (f === 'traveler'){ reqTraveler.push(x); return; }`，并在 :451-454 的 pool 里加 traveler 键，:483 之后单独发 1 名旅行者。为什么：现在 traveler 落 else 进 reqTown，会被当镇民发出去（玩家被告知角色=怪咖但按镇民计数），组合与人数全错。
3. `engine.cjs:444 usable` —— 加 `sp.traveler` 的排除逻辑，或反过来只在显式额外角色标签时允许。为什么：旅行者不能进随机牌池。
4. 流放判定点：在 `exile()` 内检查 `roleOfSeat(seat)==='怪咖'` 且说书人标记含「有趣」则拒绝并 `say` 提示。为什么：能力是「当天不能被流放」，需要一个执行处；否则只能靠说书人自己记得。

### 四、集骨者（旅行者，高）

1. `engine.cjs:176-180 execute` / `:227-234 kill` —— 增加 `revive(seat)`：`s.alive[seat]=true`、从 markers 中移除「死亡」、从 `s.nightDeaths` 中剔除；`server.cjs` 暴露 `revivePlayer`。为什么：现在死亡是单向的（全仓 grep `复活|revive` 只命中 engine.cjs:662 一行注释），「重新获得能力直到下个黄昏」根本无从落地。
2. `data/nightorder.json` —— 把「集骨者」加入 other 表（夜间可自愿使用），并按实际改 roles.json:1257 的 first_night。为什么：它 first_night:true 但 first/other 两表都没有，说书人的夜序里根本不会看到这个角色，能力等于不存在。
3. `agents.cjs` 夜间提示词加「每局一次」的计数器约定（用 markers 名「集骨者已用」），并明确「复活不重置死亡票」。为什么：`nomFinalizeSeat`（engine.cjs:828）用 `deadVoteUsed` 控制死亡票，复活后语义要一致。

### 五、咖啡师（旅行者，高）

1. `engine.cjs:287-292` 标记系统 —— 需要带生命周期的标记：把 `markers[seat]` 从字符串数组升级为 `{name, until:'dusk'|'game'}`，或增加旁路 `s.timedMarks`，在 `setPhase('dawn')` 时统一清除 `until:'dusk'` 的。为什么：咖啡师效果明确「每个夜晚，直至下个黄昏」，toggle 语义完全无法表达到期；现在重发即删除，说书人连播报两晚就会把效果撤掉。
2. `engine.cjs:708` 附近 —— 新增 `isAbilitySuppressed(seat)` / `isDoubleActing(seat)` 两个查询函数，供夜间提示词和 secretBallot 之类硬编码点使用。为什么：效果 1 是「解除并免受醉酒和中毒影响」（等于强制 `isSober=true`），效果 2 是「能力生效两次」，都需要一个被代码认的状态，否则只有玩家能看见、程序不认。
3. `agents.cjs` 夜间提示词加「二选一」通道：让说书人在回包里用 `markers: [{seat, marker:'咖啡师:免疫'}]` / `'咖啡师:双发'` 表达，并由程序在 dawn 统一处理；「该玩家会得知是哪个效果」用 `giveInfo` 定向发送。为什么：现在只能靠 markers 里塞中文，没有结构化选择与定向告知。
4. `data/nightorder.json` —— 加入 other 表（roles.json:1272-1273 的两个标志都是 false，也要改）。为什么：每夜都要行动的旅行者不进夜序，说书人不会被提醒。

### 六、流莺（旅行者，高）

1. `agents.cjs` 需要「玩家→玩家的同意」通道：现有 WAIT_ANSWER_MS（:946）/runRound（:1022-1042）只支持说书人向玩家提问并等回答，回包 schema 没有 consent 字段。建议加 `offers: [{from, to, kind:'流莺', prompt}]`，由 server 落库成待答问题，玩家回答写回 `s.offers`。为什么：「如果他同意」是能力的前提，没有通道则说书人只能替玩家做决定——而夜间提示词 :456 明确「绝不允许替当事人做选择」。
2. `engine.cjs` kill —— 支持一次杀多人并原子结算（先收集再统一 `checkWin`）。为什么：`agents.cjs:1003` 的 `deaths.forEach(x=>E.kill(x,i,'夜间死亡'))` 连续调用时，杀两名玩家会在中间态就触发 `aliveSeats.length<=2` 的胜负判定，「你们两个可能同时死亡」会被判错。
3. `data/nightorder.json` other 表加入「流莺」（roles.json:1285 other_nights:true，但表里没有）。

### 七、屠夫（旅行者，高）

1. `engine.cjs:712` nom 状态加字段 `executedToday: 0`（白天 `execute` 成功时 +1，`nomFinish` 处决成功后 +1）。为什么：现在没有任何字段记录「今天是否已经处决过」，屠夫能力的触发条件无法判定。
2. `engine.cjs:751` —— 允许屠夫在 `executedToday>=1` 且 `s.alive[from]` 时绕过 `usedNom`：`if (s.nom.usedNom[from] && !(roleOfSeat(from)==='屠夫' && s.nom.executedToday>=1)) return {...}`。为什么：wiki 明确「屠夫不论当天是否已经发起过提名，都可以在此时再次发起提名」。
3. `engine.cjs:752` —— 同上，允许屠夫提名今天已被提名过的人。为什么：wiki 明确「屠夫可以提名一名当天已经被提名过的玩家」。
4. `engine.cjs:864-871` —— 屠夫的追加提名放宽 `votes>prev`：在 `executedToday>=1` 且提名者是屠夫时改为 `votes>=1 && majority` 即可上处决台。为什么：wiki 明确「这次的票数不需要超过前一次提名统计后的票数」。
5. 用 `s.nom.butcherUsed` 保证屠夫的追加提名只产生一次额外处决机会。为什么：否则会无限连提。

### 八、事务官（镇民，中）

1. `data/scripts/梦殒春宵.json` 的 groups —— 把「事务官」加入镇民组，或明确它是实验角色并建实验剧本。为什么：roles.json:1322 `"scripts": []` 且 data/scripts 下三个剧本都零命中，dealRoles 的 pool 里永远没有它，写额外角色标签也会在 engine.cjs:480 被当「剧本里没有」忽略。
2. `data/roles.json:1316` 的 `experimental: true` 与 scripts 不一致 —— 需确认是遗漏还是有意。为什么：同批的传教士/事务官/亡魂都是 scripts:[]，需统一。
3. 首夜得知通道已可用（giveInfo + agents.cjs:986-999），只需在夜间提示词里说明「事务官得知的是玩家而不是角色，且该玩家本人不知情」。为什么：wiki 明确「得知玩家不知具体角色」「有『得知』提示标记」，说书人现在没有细则可依。

### 九、亡魂（爪牙，中）

1. `agents.cjs:434-445 nightOrderFor` —— 加存活过滤：`if (!s.alive[num]) return;`。为什么：现在的 present 表只看 roles、不看 alive，死人照样被唤醒，亡魂「死亡时不能睁眼」永远判断不了——这是亡魂能力里唯一的硬性限制。
2. 亡魂的「其他邪恶玩家被唤醒时一同被唤醒」已由夜序表近似实现（first 第 4 位、other 第 2 位，都排在爪牙/恶魔行动之前），不需要额外代码；但应在提示词里说明「亡魂每夜醒来是无信息的旁观，不应获得任何私密信息」。为什么：否则说书人可能给亡魂发不该看的信息。
3. `data/scripts` 同上，亡魂也不在任何剧本里（roles.json:1335 scripts:[]），需要与事务官一并决定是否加入剧本。

### 十、传教士（镇民，高）

1. `data/roles.json:1342` —— ability 补全第二段「所有被你选中的爪牙失去能力。」（wiki 页有完整版）。为什么：这是能力的实质部分，截断后玩家只知道「他会得知被选中」，完全不知道有屏蔽效果。
2. `engine.cjs:708` 附近 —— 新增 `abilityBlocked(seat)` 查询，读 markers 里的「被布道」；并在 `voteWeight`（:687）、`secretBallot`（:702）、夜间提示词的「能否行动」判定里统一使用。为什么：现在没有任何「失去能力」的状态位，说书人最多在 markers 里记一笔，程序侧完全不认。
3. `data/scripts` —— 把传教士加入剧本，否则发牌永不进场（同事务官）。
4. `agents.cjs` 夜间提示词 —— 明确「传教士可以选择死亡玩家」「醉酒或中毒时选中无效」，并让说书人在选中爪牙后用 giveInfo 私聊该爪牙「你被布道了」。为什么：wiki 有细则，但提示词没给，说书人可能漏发或发给错误对象。

## 附：跨角色共性问题（本批集中暴露）

1. **旅行者整套机制缺失**：5 名旅行者（怪咖/集骨者/咖啡师/流莺/屠夫）全部无法以正确方式进场，也全部没有流放流程。这不是角色数据问题，是引擎缺一整块子系统（进场、流放票、旅行者死亡规则、isEvilSeat 对旅行者的判定——engine.cjs:697 只认 minion/demon）。建议单独立项，先补 `exile()` 与 dealRoles 的 traveler 分支，再逐个角色接。
2. **ability 截断三例**：涡流、诺-达鲺、传教士的 roles.json ability 都比 wiki 少一整句，且三处都恰好丢掉最关键的机制句。建议做一次 roles.json 与 data/wiki/pages 的比对（仅报告，不自动改）。
3. **说书人回包 schema 无 win / 无改角色 / 无结构化状态**：agents.cjs:512-517 的字段（think/say/info/markers/deaths/nextPhase/voteTarget/resolveVote）覆盖不了「改胜负」「复活」「失去能力」「持续到黄昏」，report-08 已提过，本批 3 个角色（涡流/集骨者/传教士）再次撞同一面墙。
4. **markers 无生命周期**：toggle 语义 + 无 until 字段，导致「直到下个黄昏」（集骨者/咖啡师）与「直到解除」（诺-达鲺/传教士）两类状态都无法正确表达，是最值得优先修的基础设施。
