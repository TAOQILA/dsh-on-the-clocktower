# 批次 12 角色审核

审核范围：docs/audit/chunk-12.json 全部 10 个角色（女祭司 / 守夜人 / 寡妇 / 将军 / 小怪宝 / 小精灵 / 巡山人 / 工程师 / 巫师 / 帽匠）。
核对依据：docs/audit-flow.md、engine.cjs、agents.cjs、server.cjs、public/app.js、data/nightorder.json、data/roles.json、data/scripts/*.json（均实读对应行）。

先给一条贯穿全批的事实，后面各角色的定级都建立在它上面：

- **数据侧**：data/nightorder.json 中这 10 个角色的位置全部存在且**相对顺序完全正确**。first 表为 工程师#25 → 小怪宝#27 → 寡妇#32 → 巫师#35 → 小精灵#52 → 巡山人#53 → 守夜人#78 → 女祭司#82 → 将军#83（帽匠不在 first 表），other 表为 帽匠#5 → 工程师#9 → 巫师#18 → 小怪宝#60 → 巡山人#93 → 守夜人#114 → 女祭司#117 → 将军#118。与官方顺序（工程师61 / 小怪宝65 / 寡妇75 / 巫师81 / 小精灵115 / 巡山人117 / 守夜人167 / 女祭司175 / 将军177，其他夜 帽匠201 / 工程师209 / 巫师227 / 小怪宝311 / 巡山人377 / 守夜人419 / 女祭司425 / 将军427）两两相对次序逐条吻合。**A 问对 10 个角色全部通过**，唯一例外是帽匠：roles.json:1729-1737 写的是 `first_night: true / on_death: false`，而它是死亡触发、其他夜晚生效的角色，元数据写错了（nightorder 把帽匠只放在 other 表是对的）。
- **代码侧的统一结论**：说书人（Agent）的**唯一**回包 schema 是 `{think, say, whisper, info[{seat,text}], markers[{seat,marker}], deaths[seat], nextPhase, voteTarget, resolveVote}`（agents.cjs:512-518 夜间、agents.cjs:548 白天），parseReply（agents.cjs:631-658）按固定键取值、未知键丢弃；落库循环（agents.cjs:986-1016）只有 info→giveInfo、markers→toggleMarker、deaths→kill、voteTarget→openVote、resolveVote、nextPhase 六条通路；且 agents.cjs:992-995 在 roleMode==='program' 时对任何「你的角色是【X】」一律 log『已忽略说书人重复分配角色的尝试』并 return。**结论：程序发牌局里，说书人没有任何改角色/改阵营/复活/授予能力的通道**，唯一能改角色的入口是 server.cjs:90 的 `role` → assignRole，而它只被人类说书人面板 public/app.js:1090-1093（及作弊页 1173/1183）调用。这一条是「小怪宝 / 巡山人 / 工程师 / 帽匠」四个高严重度的共同根因。
- **状态侧**：createGame（engine.cjs:41-49）里没有 flags / usedAbilities / 阵营覆盖 / 效果到期表；toggleMarker（engine.cjs:287-292）是**开关语义**（已存在就删除），且全仓没有任何 marker 到期或跨夜清理逻辑；全仓 grep `usedAbility|abilityUsed|s.flags` 为零命中，`疯狂|madness` 在 engine.cjs / agents.cjs / server.cjs / public/app.js 亦为零实现（25 处仅存在于 roles.json 的能力文本）。
- **牌池侧**：data/scripts/{暗流涌动,梦殒春宵,黯月初升}.json 的 groups 与 roles 列表里，本批 10 个角色**全部 0 命中**（都是 experimental:true、scripts:[]），**落难少女也不在暗流涌动 groups 里**。dealRoles（engine.cjs:434-544）的候选池来自剧本 groups（约 440-456 行），因此正常开局根本抽不到这 10 个角色——所有能力只可能在「人类说书人面板手工分配角色」或「自定义剧本」下发生。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
| --- | --- | --- | --- |
| 女祭司 | 镇民 | 无 | 纯信息型，每夜 giveInfo 即可；nightorder first#82/other#117 正确。仅 roles.json:1612-1620 的 other_nights:false 与 other 表有她相矛盾（flags 未被读取，暂不影响运行）。 |
| 守夜人 | 镇民 | 中 | 「每局限一次」无任何记录；roles.json:1625-1633 两个 flag 都是 false 却在两表都有，导致每夜都会被重新排进顺序诱导重复触发；向目标发「他是守夜人」可用 giveInfo，但同座位同文本会被去重静默吞掉。 |
| 寡妇 | 爪牙 | 中 | 「查看魔典」没有通道，只能靠说书人把全部座位+角色拼成一段文字私发；「中毒」只能写成 marker，而全仓除 secretBallot 外无人读取中毒标记，中毒玩家的能力照常生效；「始终有一名善良玩家知道寡妇在场」无状态、该玩家死亡后不会转移。 |
| 将军 | 镇民 | 无 | 纯信息型，说书人每夜 giveInfo「善良/邪恶/均势」即可；nightorder first#83/other#118 正确。 |
| 小怪宝 | 恶魔 | 高 | 恶魔身份每夜由爪牙秘密决定后转移，而 program 模式禁止改角（agents.cjs:992-995）且回包无 role 字段；夜间又禁止玩家互发私聊（engine.cjs:303-305），爪牙无法「秘密商量」；checkWin（258-259/265-268）按静态阵营判断恶魔存活，身份转移后胜负判定会错。[+1爪牙] 本身由 bracketSpec(415-416)+dealRoles(465) 支持，无问题。 |
| 小精灵 | 镇民 | 中 | 「疯狂」零实现，是否触发完全主观且无法记录在疯狂证明哪个角色；「他死亡时获得该角色能力」无授予通道，且 nightOrderFor（434-445）只按 s.roles 里的名字过滤顺序表，小精灵获得能力后仍叫「小精灵」且只在 first 表，永远不会被再次排进夜晚顺序。 |
| 巡山人 | 镇民 | 高 | 变身落难少女需要改角色，program 模式被拦截、回包无 role 字段，根本执行不了；且 [+落难少女] 这条标签**永远无效**——落难少女不在任何剧本角色表里，dealRoles:467 会走 `notes.push('无法识别的额外角色…已忽略')` 分支；「每局限一次」也无记录。 |
| 工程师 | 镇民 | 高 | 需要把恶魔或全部爪牙换成指定角色，同属改角，Agent 说书人无通道；改角后 checkWin（253-277 全靠 roleFaction 静态查表）与已发出的 dealEvilInfo 同伴信息（580/587）都会过期，没有重发机制；「每局限一次」无记录。 |
| 巫师 | 爪牙 | 中 | 许愿本身是自由发挥，具体现实改动（杀人/加标记/给信息）可用现有 kill/markers/giveInfo 手工完成，不需要新 API；但「每局限一次」无记录，且愿望一旦涉及改角/复活/胜负仍会撞上同一批缺口。 |
| 帽匠 | 外来者 | 高 | 死亡触发没有任何钩子（kill 227-238 / execute 176-182 都不看角色 on_death），且 roles.json:1729-1737 的 on_death 写成了 false；触发后要多名爪牙与恶魔各自换角色，仍是改角，Agent 说书人无通道；换角还必须保证场上仍有恶魔，否则 checkWin(265-266) 会立刻判善良胜。 |

## 需要改动的地方

### 小怪宝（高）

1. **engine.cjs · createGame（41-49）**：state 增加 `demonSeat`（当前恶魔座位）与 `monsterKeeper`（本夜照看者座位）字段，初始为发牌结果。为什么：小怪宝的恶魔身份是**每夜移动**的，现在唯一的事实来源是 s.roles 里哪一格写着恶魔名，一旦移动就与「谁在照看小怪宝」脱钩。
2. **engine.cjs · checkWin（253-277）**：把 258-259 的 `anyDemon` / 265-268 的 `demonAlive` 改为优先读 `s.demonSeat`（有该字段时），回落到原 roleFaction 扫描。为什么：现在一旦说书人没把恶魔名挪到新座位，checkWin 会按旧座位判「恶魔已死→善良胜」，整个局直接错判。
3. **engine.cjs · say（298-322，禁聊判定在 303-305）**：目前夜间只允许玩家私聊说书人，爪牙之间无法互发消息。改法二选一：(a) 放行为「夜间允许爪牙→爪牙私密」，需要在 say 里按 roleFaction 判断收发双方是否都是爪牙；或 (b) 新增 `monsterVote` API（server.cjs:35-173 加键 + engine.cjs 加函数），让爪牙各自把「我选 N 号照看」投给说书人，说书人聚合。为什么：能力原文是「所有爪牙要**秘密决定**由哪名玩家照看」，没有一条通道能让爪牙互相交换意见，这个角色最核心的一步就缺了。
4. **agents.cjs · buildStorytellerNightPrompt（446-523，program 分支 488-492）**：在小怪宝登场时插入专门步骤——先向全体爪牙 whisper 收集照看人选（并在 500-506 的「处理方式」里说明必须等齐），再让说书人输出改角结果。为什么：现在的提示只按 nightorder 顺序罗列「能力原文」，说书人无从知道要先去收集爪牙的集体决定。
5. **agents.cjs · parseReply（631-658）+ 落库循环（986-1016）**：回包新增 `roleChanges:[{seat, role}]`，并在落库处调用新的 engine 函数（见下条）。为什么：这是所有改角类角色的共同缺口，不先加这条字段，小怪宝/工程师/帽匠/巡山人全都执行不了。
6. **agents.cjs:992-995**：`roleMode==='program'` 的「忽略说书人重复分配角色」拦截需要区分场景——发牌阶段的重复分配继续拦，**夜间结算阶段（s.phase==='night' 且已过 dealRoles）放行** roleChanges 通道。为什么：现在的拦截是一条无差别的硬闸，它保证了程序发牌的权威性，但也顺带封死了所有夜间改角能力。
7. **[+1爪牙] 无需改动**：engine.cjs:415-416 的正则已识别，engine.cjs:465 的 `bonusMinion` 会正确叠加到 comp[2]。这条在本批是唯一「开箱即用」的部分，写在此处备查。

### 巡山人（高）

1. **engine.cjs · dealRoles（467 行）**：`sp.extraRoles.forEach` 里当名字不在 `allNames`（剧本角色表）时，现在只 push 一条 notes 就忽略。改成：先查 data/roles.json 的全量角色表，若存在则仍加入 reqRoles；或在 data/scripts/暗流涌动.json 的 groups.外来者 里补上「落难少女」（data/roles.json:2145-2153 已有该角色定义）。为什么：巡山人的 [+落难少女] 是**能力的前置条件**，落难少女不在任何剧本 → 标签永远进不了场 → 即使改角通道修好，这个角色依然选不中目标，能力等于永久失效。这是本批最硬的一处数据级断路。
2. **agents.cjs · parseReply（631-658）/ 落库（986-1016）**：复用「小怪宝」第 5 条的 `roleChanges` 通道把目标玩家改成「一个不在场的镇民角色」。为什么：能力原文是「她会变成一个不在场的镇民角色」，本质就是一次 assignRole，而现在 Agent 说书人调不到 assignRole（server.cjs:90 只挂给面板）。
3. **engine.cjs · createGame（41-49）+ agents.cjs · nightOrderFor（434-445）**：「每局限一次」需要在 state 里记 `flags.rangerUsed`，并在生成夜晚顺序/提示时把已用过的能力剔除或标注「已使用，本夜不再生效」。为什么：现在没有任何一次性能力的使用记录（全仓 grep `usedAbility|abilityUsed|s.flags` 零命中），说书人每夜都会被重新提示一遍，玩家也能无限次使用。
4. **选目标的交互**：夜晚只能由说书人 whisper 玩家并等回复（agents.cjs:500-506），这条路可用；但确认「是否命中落难少女」必须由说书人私下查 s.roles，建议在 program 分支的提示里直接输出「本夜可选目标中是否含落难少女」的判定提示，避免说书人瞎猜。为什么：这条能力的结果 100% 取决于被选者是否落难少女，没有判定依据时整条能力是随机的。

### 工程师（高）

1. **agents.cjs · parseReply（631-658）/ 落库（986-1016）**：新增 `roleChanges` 通道，支持「批量改同阵营全部座位」（`roleChanges:[{seats:[...], role:'X'}]`）。为什么：能力的第二种用法是「让**所有**爪牙变成你选择的爪牙角色」，不是单人改角，只支持单体 `{seat, role}` 的话这条只能逐个手工敲，且容易漏人。
2. **engine.cjs · 新增 `reassignRoles(id, changes)`**（放在 assignRole 125-131 之后）：在一个事务里改 s.roles，并校验「改完后场上至少有一名恶魔角色」，不满足则拒绝。为什么：现在 assignRole 是裸赋值，改完不检查，若把唯一的恶魔改成别的角色，checkWin（258-259）的 `anyDemon` 变 false 会直接 `{over:false}`，游戏卡死。
3. **engine.cjs · dealEvilInfo（572-591）**：改角后需要重发同伴信息——新恶魔要知道自己的爪牙（587），新爪牙要知道自己的恶魔（580），且旧恶魔的 3 个伪装身份（587）应作废重抽。为什么：dealEvilInfo 目前只在 setPhase（109-111）的首夜自动调一次，改角之后所有人手上的邪恶信息全是过期的，会直接导致推理崩盘。
4. **data/roles.json:1703-1711**：`first_night: false / other_nights: false` 与 nightorder 两表都有工程师（first#25 / other#9）相矛盾；建议改成 `other_nights: true`（首夜也在两表里，first 也应置 true）。为什么：目前 flags 一个都没被读（nightOrderFor 434-445 只看 nightorder.json），但一旦后续按 flags 过滤顺序，工程师会被整个漏掉。

### 帽匠（高）

1. **data/roles.json:1729-1737**：把 `first_night: true` 改为 `false`、`on_death: false` 改为 `true`。为什么：帽匠是「如果你死亡，当晚…」的死亡触发角色，现在元数据写了首夜 + 非死亡触发，完全反了；nightorder 把他只放在 other 表（#5）是对的，说明数据本身是自相矛盾的。
2. **engine.cjs · kill（227-238）/ execute（176-182）**：在置 `alive=false` 之后加一个死亡钩子：查 roleFaction 之外的 on_death 标记（读 data/roles.json 的 `on_death`，需新增一个 `roleMeta(name)` 缓存函数，照 roleFaction 241-251 的写法复制即可），命中则设 `s.pendingDeathTrigger.push({seat, role})` 并在下一次说书人提示里出现。为什么：现在 kill/execute 只做「死 + 加死亡标记 + checkWin」，**没有任何角色死亡触发的位置**，帽匠的整个能力没有入口。
3. **agents.cjs · buildStorytellerNightPrompt（446-523）**：当 `s.pendingDeathTrigger` 含帽匠时，在当夜顺序开头插入专门步骤：向每名爪牙和恶魔逐个询问是否换角色，收集后一次性提交 `roleChanges`。为什么：能力原文是「爪牙和恶魔玩家**可以选择**变成新的爪牙和恶魔角色」，是多名玩家各自的选择，现有提示里没有任何多人同时选角色的流程。
4. **engine.cjs · reassignRoles（与工程师共用）**：换角时必须保证「至少一名恶魔存活」再做 checkWin；否则 265-266 的 `!demonAlive → good 胜` 会在帽匠刚死、众人尚未换完角色的瞬间误判善良胜利。为什么：这是这批改角能力里唯一会**改变胜负判定时机**的地方，必须在事务结束前不触发 checkWin，或加一个 `s.settling` 暂停位。
5. **帽匠是外来者**：如果换成爪牙/恶魔角色，roleFaction（241-251）静态查表会自动跟随新角色，这一点是兼容的，不需要额外做阵营覆盖表——写在此处说明「无需改」，避免后来人误加。

### 寡妇（中）

1. **server.cjs · buildApi（35-173）新增 `grimoire` API**：返回 `{ok:true, roles:{seat:role}}` 的快照，校验调用者座位是爪牙、且 phase==='night'。为什么：「查看魔典」目前唯一办法是说书人用 giveInfo（132-148）把全部座位+角色拼成一段文字私发，既笨重又容易漏座位，而且没有权限约束（任何角色都能被塞这段信息）。
2. **agents.cjs · buildStorytellerNightPrompt（446-523）/ nightOrderFor（434-445）**：在生成夜间提示时读取目标座位的 `中毒` / `醉酒` marker（toggleMarker 287-292 写入），并在该角色的能力说明旁标注「处于中毒状态，能力应视为失效/给出假信息」。为什么：全仓只有 secretBallot（702-710）和 voteWeight（687-696）读 marker，**中毒对绝大多数能力没有任何效果**，寡妇下毒等于白下。
3. **engine.cjs · kill（227-238）**：增加「知情者转移」逻辑——state 里存 `widowKnownSeat`，当该座位死亡时由说书人补发给另一名善良玩家。为什么：能力原文是「**始终**会有一名善良玩家知道寡妇在场」，是持续性状态；现在只能 giveInfo 一次，那个人一死这条信息就彻底消失，且没有任何字段记着曾经告诉过谁。
4. **data/roles.json:1638-1646**：`other_nights: true` 但 nightorder 的 other 表**没有**寡妇。能力是首夜限定（首个夜晚查看魔典+选人下毒，毒永久持续），other_nights 应改为 false。为什么：目前 flags 未被读取所以不报错，但这是明显的数据错误。

### 守夜人（中）

1. **engine.cjs · createGame（41-49）**：增加 `flags` 表，守夜人写入 `flags.nightwatchUsed = true`；**agents.cjs · nightOrderFor（434-445）或程序分支提示（488-492）** 在已用后跳过该角色。为什么：「每局游戏限一次」现在完全没有任何记录，玩家可以每夜都用一遍，说书人也不会有任何提示它已经用过了。
2. **data/roles.json:1625-1633**：`first_night: false / other_nights: false`，但 nightorder 两表都有他（first#78 / other#114）。按能力文本（每局限一次、夜晚可用、不限首夜）应改为 `first_night: true / other_nights: true`，或在 nightorder 里只保留一处。为什么：现在两个 flag 都是 false 意味着「任何夜晚都不该行动」，与两表都有他直接冲突，是元数据级别的自相矛盾。
3. **engine.cjs · giveInfo（132-148）**：135-136 行「同座位 + 同文本」直接 `{ok:true, skipped:true}` 静默去重。守夜人两次选中同一目标时，第二句「他是守夜人」会被吞掉且不报错。改法：在文本里自动带上夜次（如 `第N夜：X 是守夜人`），或把去重键改成「座位+文本+夜次」。为什么：这是一次会**静默失败**的写入，说书人完全感知不到信息没发出去。

### 小精灵（中）

1. **engine.cjs · createGame（41-49）**：增加 `s.madness[seat] = {role, active}` 与 `s.extraAbility[seat] = role`。为什么：「疯狂地证明你是该角色」是一个需要跨夜持续跟踪的状态（今晚疯狂、明晚不疯狂要撤销），markers 是开关语义且没有到期清理，承载不了「正在疯狂证明哪个角色」这种带参数的持续状态。
2. **agents.cjs · buildStorytellerNightPrompt（446-523）**：如果有 `s.madness` 活跃项，先把该玩家当日的公开发言摘要喂给说书人，让说书人判定「是否足够疯狂地证明」，判定结果写回 `s.madness[seat].active`。为什么：全仓 `疯狂|madness` 在代码里零命中（25 处全是 roles.json 的能力文本），说书人现在没有任何判定依据，也不会被提醒去看这个玩家的发言。
3. **agents.cjs · nightOrderFor（434-445）**：把 `s.extraAbility` 里的角色名并入顺序表筛选（`present` 既看 s.roles 的值，也看 s.extraAbility 的值）。为什么：现在顺序只按 `s.roles` 里的名字过滤，小精灵获得能力后**仍然叫「小精灵」**，而小精灵只在 first 表（#52）、other 表没有 → 获得能力之后再也不会被排进任何夜晚，那个「获得的能力」永远没有结算时机。这是这个角色最隐蔽的一处断路。
4. **授予能力的动作**：复用 `roleChanges` 通道并**同时**写 `s.extraAbility`（因为角色名不能改，改了会丢掉「小精灵」这个身份和疯狂这条线）。为什么：直接 assignRole 把小精灵改成别的角色会让阵营、死亡触发、顺序表全部跟着变，语义是错的。

### 巫师（中）

1. **engine.cjs · createGame（41-49）**：增加 `s.wishes = []`，巫师许愿时写 `{night, seat, text, granted, cost}`。为什么：许愿是自由文本，但「许过什么、有没有兑现、代价是什么」必须留痕，否则跨夜复盘和「每局限一次」都无从判断。
2. **「每局限一次」**：同守夜人，用 flags 记录 `flags.wishUsed`。为什么：现在没有任何一次性能力的记录机制，说书人每夜都会被重新提示巫师可以许愿。
3. **无需新增 API 的部分（写明以免过度设计）**：兑现愿望的常见手段——死人（kill 227-238 / execute 176-182）、加/去标记（toggleMarker 287-292）、给信息（giveInfo 132-148）、改阶段（setPhase 100-123）都已存在，巫师不需要专属 API。只有当愿望涉及**改角色 / 复活 / 改胜负**时才需要上面几节提到的通道。这一点决定了巫师只给「中」而不是「高」。
4. **agents.cjs · buildStorytellerNightPrompt（446-523）**：在巫师登场的夜里加一句固定提示「若愿望无法兑现或需要代价，请明确给出代价与线索」。为什么：能力原文有「可能会伴随着代价和线索」，现在提示里没有任何地方提醒说书人这一点，容易出现只说兑现、不给代价的漏结算。

### 女祭司（无）

1. 无需改动。engine.cjs · giveInfo（132-148）足以承载「每夜得知一名最该交流的玩家」，nightorder first#82 / other#117 位置正确，不涉及胜负、发牌、投票、死亡复活、阵营或信息可见性，也没有跨夜状态。
2. 可选修正：**data/roles.json:1612-1620** 的 `other_nights: false` 与 other 表有她（#117）矛盾，建议改为 true。理由同上：flags 目前未被任何代码读取，属于静态数据一致性问题，不影响运行。

### 将军（无）

1. 无需改动。每夜由说书人通过 giveInfo（132-148）发一句「善良 / 邪恶 / 均势」即可，nightorder first#83 / other#118 位置正确，无交互、无状态、无硬编码冲突。

## 共通项（不属于单个角色，但决定本批能否落地）

1. **说书人回包 schema 缺三个字段**：`roleChanges`（改角/授予能力）、`revive`（复活）、`abilityUsed`（一次性能力已用）。位置：agents.cjs:512-518（夜间 schema）、agents.cjs:548（白天 schema）、agents.cjs:631-658（parseReply 取值）、agents.cjs:986-1016（落库循环）。这四项打通后，小怪宝 / 巡山人 / 工程师 / 帽匠 / 小精灵 五个角色的「高」全部降级为中；不打通则这批改造只对人类说书人面板（public/app.js:1090-1093）有效，Agent 说书人一律无法执行。
2. **agents.cjs:992-995 的 program 模式硬拦截**必须改成「按阶段区分」：发牌阶段继续拦（保护程序发牌的权威性），夜间结算阶段放行 roleChanges。这是当前唯一一条把「程序可以发牌」和「说书人可以改角色」对立起来的代码，也是四个高严重度的同一个瓶颈。
3. **一次性能力 / 持续效果的状态位缺失**：createGame（engine.cjs:41-49）需要补 `flags`（每局限一次）、`effects`（带到期夜次的中毒/守护）、`roleSource`（角色是被转化的还是原始发到的）。toggleMarker（287-292）的开关语义 + 无到期清理，扛不住「中毒持续到某夜」「疯狂持续到不再证明」这类需求。
4. **marker 需要到期清理**：至少给 `effects` 加一个「在 setPhase（100-123）进入 dawn 时递减/过期」的清理循环，否则中毒/疯狂/守护会永久残留。
5. **牌池可达性**：本批 10 个角色在 data/scripts 三个剧本里全部 0 命中，程序发牌局抽不到。要么新增一个 experimental 剧本文件（含这 10 个角色 + 落难少女），要么在 dealRoles 的池构建处（engine.cjs 约 440-456 行）允许 experimental 角色按开关参与。不做这一步，本批所有结论都只能在「人类手工分配角色」的场景下被验证。
6. **数据 flag 与 nightorder 的双轨矛盾**：roles.json 的 `first_night / other_nights / on_death` 三个 flag 在 *.cjs / public/*.js 里**零读取**，真正决定顺序的是 nightorder.json。本批已发现 3 处矛盾（守夜人两 flag 全 false、寡妇 other_nights 应为 false、帽匠 first_night/on_death 写反）。建议统一为「以 nightorder.json 为准，roles.json 的 flag 只做展示」，或反过来让 nightOrderFor 读 flag——**但不能两套并存**，否则后续任何按 flag 过滤的改动都会静默漏角色。
