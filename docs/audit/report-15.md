# 批次 15 角色审核

审核对象：docs/audit/chunk-15.json（2 恶魔 / 2 外来者 / 3 爪牙 / 1 镇民 / 1 旅行者 / 1 奇遇角色），共 10 个角色。
审核基准：docs/audit-flow.md + 实读 engine.cjs / agents.cjs / server.cjs / public/app.js / data/nightorder.json / data/roles.json / data/wiki/pages/*.md。
判定口径：高＝能力无法执行，或被已有硬编码直接覆盖；中＝能勉强跑但结果可能错、需要说书人手工兜底；低＝措辞/数据/体验层面；无＝与现状兼容。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
|---|---|---|---|
| 牙噶巴卜 | 恶魔 | 中 | 夜序在表内（first:51 / other:155）。「首个夜晚得知秘密短语」可用 info 做；但「白天公开说出短语后当天可能有玩家死亡」缺白天即时死亡通道：回包 deaths[] 在 agents.cjs:1003 恒走 E.kill(id,i,'夜间死亡')，会被记进 nightDeaths，等到天亮才在「昨夜死亡」里播报，且与玩家白天公开说出的时点脱节。 |
| 狂热者 | 外来者 | 无 | 无需夜序（白天角色）。程序已硬实现：nomHand（engine.cjs:798-802）在存活≥5 时拒绝弃权，错误文案「狂信者在存活≥5 时必须在所有提名中投票」；VOTE_ROLE_RULES（agents.cjs:228）也向说书人声明「程序会强制」。与 roles.json:2018 能力原文正则一致，完全兼容。 |
| 痢蛭 | 恶魔 | 中 | 夜序在表内（first:31 / other:153），杀人可做、首夜选中毒可做（markers 中毒）。缺「被选中的中毒者处于死亡状态时你立即死亡」的被动连锁：execute（engine.cjs:176）与 kill（:227）死亡后不通知说书人，没有死亡钩子，说书人只能在下次被唤起时补 kill，且天亮播报与「立即」不符。另 roles.json:2033 写 other_nights:false 与能力「每个夜晚*」不符（数据不一致，低）。 |
| 瘟疫医生 | 外来者 | 高 | 「说书人会获得一个爪牙能力」在代码里没有任何承载结构：无 abilityOverride 表、无 giveAbility API（全仓 grep giveAbility/abilityOverride/override 均为 0），nightOrderFor（agents.cjs:434-445）只按 s.roles 生成夜序，说书人不会因为获得能力而多出一项夜间行动； storytellerSystem（agents.cjs:154-159）注入的知识里也没有「说书人拥有角色能力」这个概念。能力只能停留在 think 里靠 LLM 记忆。 |
| 私货商人 | 奇遇角色（loric） | 无 | faction 为 loric，roleFaction 返回 'loric'，既不算 minion/demon 也不算镇民/外来者；dealRoles 的 pool 只取剧本的 镇民/外来者/爪牙/恶魔 四组（engine.cjs:452-454），不会被抽到。其能力本身是「本剧本含自制角色或自制规则」的元信息，不产生游戏效果，故与现状无冲突。备注：若被手动 assignRole 进场，它不参与任何胜负判定。 |
| 科学怪人 | 爪牙 | 高 | 夜序在表内（first:8，早于「恶魔信息」:21，即赋予的能力当晚即可用，顺序方向正确）。但「恶魔拥有一个不在场的善良角色的能力」无承载：夜序表由 s.roles 生成，恶魔不会多出对应夜间行动项；无能力覆盖/赋予机制（同瘟疫医生）；「不在场的善良角色」也无程序通道挑选，只能写 info。「即使醉酒或中毒」因无能力生效判定代码而天然成立，但反过来说所有能力的醉/毒失效也全靠 LLM。 |
| 笑匠 | 旅行者 | 高 | 夜序无（白天角色）。核心是「一名其他玩家会在当晚改变角色」＝改角色通道缺失：agents.cjs:992-995 在 roleMode==='program' 时硬拦截任何含「你的角色是【X】」的 info 并记日志「已忽略说书人重复分配角色的尝试」；giveInfo（engine.cjs:144）的 `if (m && m[1] && !s.roles[seat])` 只在角色为空时写入。且旅行者机制整体不存在：engine.cjs 中 grep「旅行者」=0、grep「exile/流放」=0，既无加入/离场也无流放流程。 |
| 精神病患者 | 爪牙 | 高 | 夜序无（白天角色）。①「每个白天提名开始前公开选一名玩家：他死亡」缺白天即时处决通道：白天回包 deaths[] 同样走 E.kill 被记为夜间死亡，天亮才播报，且不占当天处决名额，导致 nomFinish（engine.cjs:899-912）会再处决一次，一天两次处决。②wiki 第二段「如果你被处决，提名你的玩家需要和你猜拳，只有你输了你才会死亡」根本没进 roles.json（:2096 只存第一句），引擎也无猜拳/免死判定，被处决必然死亡。 |
| 维齐尔 | 爪牙 | 高 | 夜序 first:92（段末，黎明之后）。①「所有玩家都知道你是维齐尔」无广播通道：/api/game（server.cjs:67-84）非说书人视角只下发自己那张角色，前端身份卡（app.js:837-847）只显示自己；只能靠说书人公聊说一句，而夜间提示词（agents.cjs:455）禁止公聊透露身份，易漏。②「你在白天时不会死亡」被硬编码覆盖：execute（engine.cjs:176-182）、kill（:227-238）、nomFinish（:899-912）全部直接 s.alive[seat]=false 并 push '死亡'，无任何免疫判定。③「提名中有善良玩家投票即可让被提名者立即处决」无通道：白天只有 openVote/resolveVote，且必须 yes 严格过半才 execute。④roles.json:2109 的 ability 只存了第一句，后两句丢失。 |
| 罂粟种植者 | 镇民 | 高 | 夜序在表内（first:12 / other:100）。「爪牙和恶魔互相不认识」被硬编码覆盖：setPhase（engine.cjs:109-111）首夜自动 try{dealEvilInfo(id)}，dealRoles 末尾（:541）也调用一次，而 dealEvilInfo（:572-591）无条件给每个爪牙发「你的同伴是：<恶魔>」、给每个恶魔发「你的爪牙是：…」，全程不看任何角色条件 → 互认必然发生。「如果你死亡当晚互认」也缺死亡触发回调（roles.json:2125 on_death:true，但 engine.cjs 与 agents.cjs 中 grep on_death 均为 0 次，该字段从未被读取）。 |

计数：高 6（瘟疫医生、科学怪人、笑匠、精神病患者、维齐尔、罂粟种植者）／中 2（牙噶巴卜、痢蛭）／低 0／无 2（狂热者、私货商人）。

## 需要改动的地方

### 共同根因（先修这三条，后面角色大半一起解决）

**1. 夜间/白天死亡没有区分，也没有即时公开死亡通道**（牙噶巴卜、精神病患者、痢蛭共用）
- 文件/函数：agents.cjs `runStoryteller` apply 段，第 1003 行 `if (rp && Array.isArray(rp.deaths)) rp.deaths.forEach(... E.kill(id, i, '夜间死亡') ...)`。
- 改成：回包 deaths[] 支持两种写法——纯座位号（保持现状＝夜间死亡）与对象 `{seat, reason, public:true}`。白天阶段（isNight===false）一律用新函数 `E.killPublic(id, seat, reason)`：直接 s.alive=false、push '死亡'、**不写入 nightDeaths**、立即 say(id,'storyteller','X 号 N 死亡','town')，并同时记账 `s.dayDeaths`，供 nomFinish 判断「今天已处决一次」。
- 为什么：现在白天死的人被塞进 nightDeaths，天亮播报成「昨夜死亡」，时间线是错的；同时不占当天处决名额，会一天处决两人。

**2. 角色变更（改角色）通道全缺**（笑匠；同批之外理发师/麻脸巫婆/方古同样受益）
- 文件/函数：engine.cjs `assignRole`（:125-131）只在 setup 用；`giveInfo`（:132-148）第 144 行 `if (m && m[1] && !s.roles[seat])` 是「仅在无角色时落角色」的守卫。
- 改成：新增 `forceRole(id, seat, role, reason)`——无条件写 s.roles[seat]，写一条 priv 日志「角色变更：N 号 A → B」，并立即私聊该座位「你的角色变为【B】」。同时把 agents.cjs:992-995 的硬拦截拆开：**info 里含角色声明仍然拦截**（防止一份角色发两遍），但回包新增顶层字段 `roles:[{seat,role,reason}]` 走 forceRole。
- 为什么：改角色必须同时改数据（s.roles）与告知玩家；只发 info 会让 roleFaction / checkWin / nightOrderFor 全部错乱，只改数据玩家又不知道自己变了。

**3. 说书人「获得/被赋予能力」无承载结构**（瘟疫医生、科学怪人）
- 文件/函数：agents.cjs `nightOrderFor`（:434-445）只遍历 s.roles；`storytellerSystem`（:154-159）只注入规则/剧本/roleBrief/roleDetail。
- 改成：①engine.cjs 新增 state 字段 `s.stAbilities = [{name:'投毒者', from:'瘟疫医生', seat:NS}]` 与两个 API：`addStorytellerAbility(id, roleName, reason)` / `addRoleAbility(id, seat, roleName, reason)`；②`nightOrderFor` 在按 s.roles 收集 present 之后，把 stAbilities 里 roleName 对应角色名也加进 present（并允许同一角色名重复出现一次，用于「说书人版」行动）；③`viewForStoryteller`（agents.cjs:254-268）返回 stAbilities，夜间提示词在「【全场座位与真相】」后新增一节「【说书人当前拥有的爪牙能力】」，明确「这是你的能力，按该角色能力原文由你亲自选择目标并结算」。
- 为什么：现在能力只活在 LLM 的 think 里，跨轮次/跨夜必丢；且科学怪人给恶魔加的能力不会出现在夜序里，恶魔那一项永远结算不到。

**4. 「白天不会死亡 / 免死确认」无免疫判定**（维齐尔）
- 文件/函数：engine.cjs `execute`（:176-182）、`kill`（:227-238）。
- 改成：两者在 `s.alive[seat]=false` 之前加一个 `if (immuneToDeath(s, seat, mode)) return {ok:false, error:'该玩家当前不会死亡', immune:true}`；`immuneToDeath` 从 s.markers 读固定标记「白天免死」（**必须是 set 语义，不能走 toggleMarker**，见下条），且仅当 day 阶段/处决来源时生效。同时 nomFinish 在 execute 返回 immune 时不得清空 onBlock 之外的状态，直接宣布「今天没有人被处决」。
- 为什么：维齐尔「白天不会死亡」目前被 execute 无条件覆盖；且这是「免死确认」类能力的唯一落点。

**5. markers 是 toggle，无法承载持续状态**（本批 4 个角色受影响，也是全项目隐患）
- 文件/函数：engine.cjs `toggleMarker`（:287-292）——已存在则 splice 删除。agents.cjs:1002 每次回包都调它。
- 改成：新增 `setMarker(id, seat, marker, on)` / `clearMarkers(id, seat, /正则/)`，agents.cjs:1002 改用 setMarker（重复下发幂等）。保留 toggleMarker 给前端手点。
- 为什么：「中毒」「醉酒」「白天免死」「主人:N」这类必须持续整夜/整天的状态，说书人每晚重发一次就会被 toggle 掉，是当前最大的隐性 bug。

### 牙噶巴卜（恶魔）
- 夜序：无需改，first:51 / other:155 都在表内，位置在 other 段恶魔群中，合理。
- agents.cjs `buildStorytellerNightPrompt`（:446-523）：首夜要加一步「生成一段秘密短语并通过 info 私聊给该恶魔」。可在处理顺序提示里补一句「牙噶巴卜的秘密短语由你现编，只发给本人，不要写进公聊」。
- 白天触发：在 `buildStorytellerDayPrompt`（:525-560）的座位表之外增加「本局牙噶巴卜」提示，要求说书人每轮检查公聊里是否出现该短语；出现即调 `E.killPublic`（见共同根因 1）。因为短语是 LLM 现编的，引擎无法自己匹配，必须在白天提示词里明确要求核对。
- 为什么：能力原文写「当天便可能会有一名玩家在这之后死亡」，是即时公开死亡，走现在的夜间死亡记账会推迟到第二天早上。

### 痢蛭（恶魔）
- engine.cjs 新增死亡回调：`kill`（:227）与 `execute`（:176）在设 alive=false 之后，检查 `s.markers[deadSeat]` 是否含「痢蛭选中」；若是且痢蛭本人存活，则强制 `s.alive[demonSeat]=false` 并 push '死亡'，公聊播报「痢蛭随其宿主一同死亡」。
- 为什么：「只有当他处于死亡状态时你才会立即死亡」是被动连锁，靠说书人下次醒来补记会漏（尤其处决发生在白天、下一次说书人唤起可能在几十秒后，中间还会推进阶段）。
- 数据：roles.json:2033 把 `other_nights` 由 false 改为 true（能力原文是「每个夜晚*」，星号只表示首夜另有中毒步骤，不表示之后不行动）。低优先。

### 瘟疫医生（外来者）
- 依赖共同根因 3（stAbilities）。落地后还需两步：①死亡触发——engine.cjs `execute`/`kill` 里若死者角色为瘟疫医生且 markers 无 中毒/醉酒，则 `s.pendingStAbility = '瘟疫医生'`；②agents.cjs 夜间提示词开头检测 `s.pendingStAbility`，要求说书人**当场**从本剧本爪牙里挑一个并写 `stAbility` 字段落库，之后每夜都要把它当自己的角色处理。
- 为什么：能力写着「剩余游戏时间里持续生效」，没有持久字段就必然在下一轮对话里丢失。

### 科学怪人（爪牙）
- 同样依赖共同根因 3，但方向是「角色获得能力」：首夜用 `addRoleAbility(id, demonSeat, 善良角色名, '科学怪人')` 落库，并给科学怪人与恶魔各发一条 info「恶魔获得了 X 的能力」。
- agents.cjs `nightOrderFor` 已按 present 过滤，只要 addRoleAbility 把该角色名并入 present，恶魔那一夜就会多出一项待结算；提示词里要说明「这一项由恶魔本人选择目标，你去私聊恶魔，而不是自己替他选」。
- 为什么：「不在场的善良角色」需要程序给出候选池，否则说书人可能挑到在场角色；建议在 `bluffRoles`（engine.cjs:563-570）旁加 `absentGoodRoles(id)` 复用同一套「剧本镇民+外来者 减去 在场角色」的逻辑。

### 笑匠（旅行者）
- 依赖共同根因 2（forceRole）。另外：旅行者整体未实现（engine.cjs grep 旅行者=0、exile/流放=0、app.js 同样为 0），笑匠作为旅行者连「如何进场」都没有流程。
- 最小可行改法：①engine.cjs 增加 `joinTraveler(id, seat, role)`：把该座位加入 s.seats（或用已有的空座位）、s.roles[seat]=role、s.alive[seat]=true，不占用 compositionFor 名额；②白天提名前由说书人询问笑匠选谁，回包新增 `roles` 字段指定「另一名玩家」在当晚改成什么角色（由说书人决定，可随机），落 forceRole；③app.js 需在座位表上允许「旅行者」标记（否则阵营显示为空）。
- 为什么：能力本身（每白天选一人、当晚另一人改角色）在有了 forceRole 之后可执行，但前提是这个角色能真的坐进牌桌。

### 精神病患者（爪牙）
- ①白天即时杀人：改为调 `E.killPublic`（共同根因 1），并在 `nomPropose`（engine.cjs:744）之前留一个「提名开始前」检查点——建议在 agents.cjs 的白天主持循环里，把 `s.dayDeaths` 是否非空作为「今天已有处决」的判据传给 nomFinish，避免一天两次处决。
- ②猜拳免死：①须先补 roles.json:2096 的 ability 文本（把 wiki 第二段补上，否则说书人 system 里的 roleBrief 只看到第一句）；②engine.cjs `execute` 里对「被提名者角色为精神病患者」时不能直接死，应返回 `{ok:false, needDuel:true}`，由 agents.cjs 白天提示词要求说书人主持猜拳（各出石头剪刀布由 LLM 裁定），输才再调 execute。
- 为什么：能力有两段，现在数据层就把第二段丢了，说书人根本不知道要猜拳；而 execute 是硬编码必死。

### 维齐尔（爪牙）
- ①公开身份：engine.cjs `setPhase`（:95）在 phase 进入第一个 day 时，若场上有维齐尔，自动 `say(id,'storyteller','本局有维齐尔在场：N 号 某某','town')`。硬编码一条比让 LLM 记更可靠（夜间提示词本就禁止公聊透露身份，见 agents.cjs:455）。
- ②白天免死：依赖共同根因 4（immuneToDeath + setMarker '白天免死'）。首夜给维齐尔 setMarker「白天免死」，并在 execute/kill 判定。
- ③立即处决：白天回包新增字段 `executeTarget`（或复用 `deaths` 的对象形式 + `immediate:true`），agents.cjs apply 段走 `E.killPublic`，并同步把 `s.nom.onBlock=null`、标记本日已处决，避免 nomFinish 再杀一次。前置条件「本次提名中有善良玩家投票」需 engine 暴露 `nomResolve` 结果里的投票者阵营——建议在 `nomState`（:719-739）返回 `cur.voters:[{seat, evil:bool}]`，或在 nomResolve 里直接算 `goodVoters` 并写进 cur。
- ④数据：roles.json:2105-2115 的 ability 只有第一句，应补齐「你在白天时不会死亡。如果一次提名中有善良玩家投票，你可以让被提名者立即被处决。」否则说书人 system 的 roleBrief 与 roleDetail 都会缺关键规则。

### 罂粟种植者（镇民）
- engine.cjs `dealEvilInfo`（:572-591）：函数开头加守卫——若场上存在**存活且未中毒/醉酒**的罂粟种植者，则不发爪牙↔恶魔信息，只给恶魔发「可以伪装成的三个身份」（wiki 明确：恶魔仍能得知三个伪装）。调用点在 `setPhase`（:109-111）与 `dealRoles`（:541），两处都要走同一守卫，所以改在函数内部最稳。
- 死亡触发：`execute`/`kill` 里若死者为罂粟种植者且未中毒/醉酒，置 `s.pendingRevealEvil = true`；agents.cjs 夜间提示词开头检测该字段，要求当晚立即调用一次「强制互认」（即忽略守卫的 dealEvilInfo）并私聊双方。
- 为什么：现在 `dealEvilInfo` 是无条件执行，罂粟种植者的核心能力（阻隔互认）100% 失效；而 on_death 字段全项目无人读取，死亡触发必须自己加。

### 狂热者（外来者）
- 无需改动。nomHand（engine.cjs:798-802）的强制投票与 roles.json:2018 文本正则匹配，VOTE_ROLE_RULES（agents.cjs:228）也已向说书人声明。
- 唯一可选优化（低）：nomTick（:836-850）走时钟时，未举手者按 no 计（nomFinalizeSeat 里 `want=!!cur.hands[seat]` 默认 false），狂热者「必须投票」在「完全不表态」这一侧没有被提示；可在界面/提示词里对狂热者加一句「你必须举手，弃权会被拒」。

### 私货商人（奇遇角色 / loric）
- 无需改动。它不参与发牌（compositionFor 只吃四个基础阵营）、不参与胜负（roleFaction 返回 'loric'，isEvilSeat 判 false）。
- 可选（低）：若希望它作为「本剧本含自制内容」的显式标记，可在 UI 的剧本信息处展示；当前 roles.json 把它归到 loric 阵营已足够表达。
