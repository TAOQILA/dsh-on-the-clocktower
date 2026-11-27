# chunk-02 角色能力审核报告

> 审核对象：`docs/audit/chunk-02.json` 的 10 个角色
> 审核依据：`docs/audit-flow.md`（流程现状说明）+ 逐行核对 `engine.cjs` / `agents.cjs` / `server.cjs` / `public/app.js` / `data/nightorder.json` / `data/roles.json`
> 判定口径：高=硬编码会直接拒绝/覆盖核心效果，或能力根本无法执行；中=能勉强执行但依赖自由文本标记、易漏结算；低=仅措辞层面需注意；无=完全能承载。

## 总表

| 角色 | 阵营 | 能力摘要（≤40字） | 是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 猎手 Hunter | 镇民 | 每局限一次，白天公开选一名玩家，若是恶魔则死 | 是 | 无「白天能力致死」通道：白天只能走 `deaths→E.kill(id,i,'夜间死亡')`，会把非处决死亡记成夜间死亡并写入 `nightDeaths`；「每局限一次」无状态承载，只能靠说书人自由文本标记 | 高 |
| 士兵 Soldier | 镇民 | 恶魔的负面能力对你无效 | 弱 | 死亡由说书人填 `deaths` 触发，可自行不写；但夜晚提示词未告知此豁免，有机械照抄恶魔选择杀人的风险；中毒后免疫失效也无提示 | 低 |
| 镇长 Mayor | 镇民 | 三名玩家存活且白天无人被处决，你的阵营获胜 | 是 | `checkWin` 只有「恶魔出局→善胜 / 存活≤2→恶胜」两条硬编码，完全不认镇长条件；且 `setPhase` 进夜晚时不调用 `checkWin`，白天结束没有判定时机 | 高 |
| 管家 Butler | 外来者 | 每夜选一人，明天只有他投票时你才能投票 | 弱 | `nightorder` 有、`butlerMaster`/`voteWeight` 已实现；但 `toggleMarker` 是切换语义，连两晚会出现「主人:3」「主人:5」并存，`butlerMaster` 用 `find` 取**第一个**命中→取到旧主人；`public/app.js` 标记下拉只有 4 个固定项 | 中 |
| 酒鬼 Drunk | 外来者 | 不知道自己是酒鬼，以为自己是某个镇民角色 | 是 | `dealRoles` 纯机械随机发牌 + `giveInfo`「你的角色是【X】。」直接暴露身份，且 `giveInfo` 正则把告知角色写进 `s.roles`；代码里没有「真实角色 ≠ 告知角色」的双层结构 | 高 |
| 陌客 Recluse | 外来者 | 可能被当作邪恶阵营/爪牙/恶魔角色，即使已死亡 | 弱 | 纯说书人裁定，无需程序；只需明确 `checkWin`/`roleFaction` 继续按真实阵营判（当前是对的），提示词说清「可被当作邪恶来回答，但不改真实结算」 | 低 |
| 圣徒 Saint | 外来者 | 如果你死于处决，你的阵营落败 | 是 | `execute` 176-182 行只置死+加「死亡」标记+调 `checkWin`，没有「处决圣徒→邪恶胜」分支；圣徒被处决后程序照常按恶魔存活判，结果可能完全相反 | 高 |
| 投毒者 Poisoner | 爪牙 | 每夜选一人，他当晚和明天白天中毒 | 弱 | `nightorder` 有、提示词要求私聊问；但「中毒」是不带时效的自由文本标记，无自动过期，说书人漏删就变永久中毒；连锁失效（士兵免疫/占卜师信息）全靠自觉 | 中 |
| 间谍 Spy | 爪牙 | 每个夜晚查看魔典 | 弱 | 魔典内容可用 `info` 私聊文本下发，技术上可行；但 `giveInfo` 按文本完全相同去重，重发同样内容会被 `skipped`；且夜晚提示词把间谍写成「要选目标看谁」，与实际能力（看整本魔典）不符 | 低 |
| 红唇女郎 Scarlet Woman | 爪牙 | 存活≥5时恶魔死亡，你变成那个恶魔 | 是 | `kill`/`execute` 里恶魔一死 `checkWin` 立即判「恶魔已出局→善良胜」并 `phase='ended'`；没有「恶魔死亡→红唇女郎接替」转化分支，`on_death=true` 完全未被使用 | 高 |

## 需要改动的地方

### 一、engine.cjs — 胜利条件扩展（镇长 / 圣徒 / 红唇女郎）

**1. `engine.cjs:253-277 checkWin`（镇长 + 红唇女郎）**

现状：只有两条规则——`!demonAlive ⇒ good 胜`、`aliveSeats.length<=2 ⇒ evil 胜`，判胜即 `s.phase='ended'`。

问题：三张牌的核心效果全部落在「胜负判定」上，而这里是唯一写死的判定点，都会被覆盖。

改法（在统计 `aliveSeats` 之后、判恶魔出局之前插入）：

- 先算接替：若 `!demonAlive` 且 `aliveSeats.length >= 5`，找存活爪牙里角色为 `红唇女郎` 的座位；存在则把该座位的 `s.roles[x]` 改成原恶魔角色名、`E.giveInfo(x,'你变成了【恶魔名】')`，**把该座位视作新的恶魔**（重新计算 `demonAlive`），不进入胜利结算。
- 再算镇长：`aliveSeats.length === 3 && s.dayExecuted === false && 存活座位含镇长` ⇒ `endGame('good','镇长三人存活且白天无人被处决')`。
- 圣徒不走 checkWin，见下条。

建议先做一个 `function winOverrides(s)` 返回 `'good'|'evil'|null`，`checkWin` 开头调用，避免继续堆 if。

**2. `engine.cjs:176-182 execute`（圣徒）**

现状：`alive=false` → `markers.push('死亡')` → `log('被处决')` → `checkWin`。

改法：置死之后、`checkWin` 之前加
```js
if (s.roles[seat] === '圣徒') return endGame(id,'evil',`玩家${seat+1}（圣徒）被处决，其阵营落败`);
```
必须先于 `checkWin`，否则 `checkWin` 会先按恶魔存活判出别的结果并 `ended`，圣徒就永远失效。

**3. 新增「当天是否有人被处决」状态（镇长）**

现状：没有任何地方记录今天有没有处决过，`nomFinish`（899-912）执行完就结束。

改法：`nomFinish` 处决成功后置 `s.dayExecuted = true`；`setPhase` 里 `phase==='day' && wasNight` 时重置 `s.dayExecuted = false`（`engine.cjs:113-122` 段旁边）。同时**让 `setPhase` 在 `day→night` 时调一次 `checkWin`**——镇长要在白天结束时判定，而现在 `setPhase` 全程不调 `checkWin`，白天结束那一刻根本没有任何判定发生。

### 二、engine.cjs — 白天死亡通道（猎手）

**4. `engine.cjs:227-238 kill` + `agents.cjs:1003`（猎手）**

现状：`kill` 无条件 `s.nightDeaths.push(seat)`、log 恒定写「在夜里死亡」。`runStoryteller` 落库 deaths 时写死 `E.kill(id,i,'夜间死亡')`，白天也用同一调用。

问题：猎手是**白天**能力。白天击杀会污染 `s.nightDeaths`，下一次天亮播报（`setPhase` 113-122）会把这具尸体当成「昨夜死亡」念出来；日志语气也错。

改法：`kill` 加参数 `(id, seat, reason, opts={})`，只有 `opts.night !== false` 时才 `nightDeaths.push`；`agents.cjs:1003` 按当前 `s.phase==='night'` 传 `{night:true}`，白天传 `{night:false}` 且 reason 改「被能力杀死」。另：猎手「每局限一次」用 `猎手已用` 标记承载，并在白天提示词要求说书人先查该标记。

### 三、engine.cjs + agents.cjs — 酒鬼的双层角色结构

**5. `engine.cjs:434-544 dealRoles` + `engine.cjs:132-148 giveInfo`（酒鬼）**

现状：`dealRoles` 机械抽角色、机械分座位；534-539 行对每人 `giveInfo('你的角色是【X】。')`，而 `giveInfo` 143-144 行的正则会把 `X` **写进 `s.roles[seat]`**（仅当为空）。代码里只有一层 `s.roles`。

问题：发到酒鬼时玩家会直接被告知「你是酒鬼」，能力核心（不知道自己是酒鬼）当场失效；也没有地方放「他以为的镇民角色」。

改法：

- `dealRoles` 发牌后做替换：若某座位抽到酒鬼，再抽一个「镇民」作为假身份；`s.roles[seat]='酒鬼'`（真实，用于阵营/胜负），新增 `s.apparentRoles[seat]='占卜师'`（用于告知与夜间行动表）。
- 告知文本改为 `你的角色是【${s.apparentRoles[seat]}】。`，并**绕开 `giveInfo` 正则自动写 roles**（143-144）：或加参数 `noRoleWrite:true`，或让该正则只写 `s.apparentRoles`。
- 阵营仍取真实角色（酒鬼=外来者/善良），`roleFaction` 不用改。

**6. `agents.cjs:434-444 nightOrderFor` + `agents.cjs:446-523 buildStorytellerNightPrompt`（酒鬼）**

现状：夜间顺序按 `s.roles` 过滤。酒鬼真实角色是「酒鬼」，而 nightorder 里没有酒鬼。

问题：若酒鬼的假角色是占卜师/管家/投毒者这类有夜间行动的角色，说书人**必须替他行动**，但顺序表按真实角色过滤会把这一项整个丢掉，等于每晚漏结算。

改法：`nightOrderFor` 里对每个座位按 `s.apparentRoles?.[k] ?? s.roles[k]` 参与过滤（真实角色也参与，取并集）。并在夜晚提示词加一条：「若酒鬼的假角色是需要选目标的角色，**由你（说书人）代为选择目标**，绝不能告诉该玩家他是酒鬼；他的信息按假角色的能力正常给。」

### 四、engine.cjs — 管家标记覆盖

**7. `engine.cjs:287-292 toggleMarker` + `engine.cjs:678-685 butlerMaster` + `public/app.js:1099`（管家）**

现状：`toggleMarker` 是「有则删、无则加」的切换语义；`butlerMaster` 用 `markers.find(...)` **取第一个命中**。

问题：第一晚设「主人:3」，第二晚设「主人:5」→ 数组两条并存，`find` 取到 3，管家被绑死在旧主人身上，玩家完全看不出，属静默错判。

改法：
- `runStoryteller` 落库 markers 时，对以「主人:」开头的标记先 `filter` 掉同前缀旧值再 push（或在 `toggleMarker` 里对这种「键值型」标记实现同键覆盖）。
- `butlerMaster` 改成 `filter(...).pop()` 取**最后一条**，更稳。
- `public/app.js:1099` 的标记下拉只有「中毒/醉酒/被保护/死亡」，说书人人工干预时无法输入「主人:N」，建议加自由文本输入框（或至少加「主人:」模板）。

### 五、engine.cjs + agents.cjs — 中毒的时效

**8. `engine.cjs` 标记体系 + `agents.cjs:446-523`（投毒者）**

现状：`state.markers` 是无时效的自由文本数组，`toggleMarker` 切换语义。

问题：投毒者的「当晚和明天白天中毒」有明确生命周期。现在全靠说书人记得次日夜晚删掉「中毒」；漏删就是永久中毒，而中毒会连锁影响士兵免疫、占卜师信息、管家投票等一堆地方。

改法：
- 给标记加可选时效结构（如 `{name:'中毒',expireAt:'day-3'}`），或最小改动：`engine.cjs setPhase` 里，`night` 开始时自动清掉 `expire==='nextNight'` 的「中毒」标记。
- `agents.cjs` 夜晚提示词加一句：「先清除昨晚遗留的『中毒』标记，再处理投毒者本夜的选择；中毒者本夜与明天白天的能力一律视为失效，若中毒者是士兵，其免疫同时失效。」

### 六、agents.cjs — 提示词层面的角色说明

**9. `agents.cjs:456、504`（间谍 / 士兵 / 陌客）**

- **间谍**：456 行把间谍列进「角色能力要求某位玩家自己选择目标（…间谍看谁）」，504 行又点名「间谍」。实际间谍不选人，是**看整本魔典**。改：从「选目标」名单删掉间谍，改成「间谍不需要选目标，直接把它私聊能看到的魔典全文（每个座位的真实角色 + 当前标记）作为 info 发给它」。
- **间谍**的魔典重发会被 `giveInfo` 去重挡住（135-136）：建议信息文本带「第 N 夜」前缀，避免完全相同被 `skipped`。
- **士兵**：夜晚提示词加：「若恶魔本夜的目标是士兵且士兵未处于中毒/醉酒，则恶魔的负面能力对其无效——**不要写 deaths**，可在私聊里以符合世界观的方式带过。」同理，士兵免疫的是「恶魔的负面能力」而非处决。
- **陌客**：回答类提示词加：「陌客可能被当作邪恶阵营、爪牙角色或恶魔角色来回答调查类问题（即使他已死亡），说书人可自由选择怎么显示他；但 `checkWin` 与阵营结算仍按真实阵营，绝不因『被当作』而改变真实归属。」

### 七、nightorder.json — 顺序表口径

**10. `data/nightorder.json` + `agents.cjs:434-444 nightOrderFor`**

现状：猎手/士兵/镇长/酒鬼/陌客/圣徒都不在 first/other 里；红唇女郎只在 other（other[38]）。

结论：
- 猎手、士兵、镇长、陌客、圣徒确实**不需要**入表（无每夜固定结算），保持不动是对的。
- 红唇女郎在 other 里，但它的效果是「恶魔死亡时被动接替」，属于 on_death 触发器、**不是每夜选择**——建议在表格 note 里注明「红唇女郎的行只用于提醒说书人检查接替条件，本角色无需每夜选目标」，避免说书人误以为要私聊问红唇女郎选人（`buildStorytellerNightPrompt` 对表里每一项都要求「需选目标就问」，会多问一轮）。
- 酒鬼本身不该入表（无夜间行动），但**酒鬼的假角色**必须入表：改法是让 `nightOrderFor` 用 `apparentRoles` 参与过滤（见第 6 条），而不是在 JSON 里加「酒鬼」。

### 八、server.cjs — 无新增接口，但需确认

**11. `server.cjs:60-172 buildApi`**

现状：没有「免死 / 复活 / 角色转换 / 额外胜利条件」接口。

结论：本批 10 个角色的改动集中在 `engine.cjs` 内部（`checkWin` / `execute` / `kill` / `dealRoles` / `setPhase`）与提示词，**不需要新增 HTTP 路由**；但若希望说书人在白天主动触发「红唇女郎接替」或「圣徒判负」，则需要给 `runStoryteller` 的返回 schema 增加 `endGame` 字段（见第 12 条）。

### 九、agents.cjs — 说书人输出 schema 缺 `endGame`

**12. `agents.cjs:512-517`（夜晚 schema）+ `agents.cjs:525-551 buildStorytellerDayPrompt`（白天 schema）**

现状：夜晚 schema 只有 `think/say/info/markers/deaths/nextPhase`；白天 schema 只有 `think/say/info/markers/deaths/nextPhase/voteTarget/resolveVote`。`runStoryteller`（986-1016）也只处理这些字段，**没有任何胜利/终局字段**。

问题：圣徒被处决判负、镇长三人获胜、红唇女郎接替，都需要说书人侧有一个明确出口。现在只能靠程序内部硬编码，说书人即使看出来也无法表达。

改法：两个 schema 都增加可选 `"endGame": {"side":"good|evil","reason":"..."}`；`runStoryteller` 落库时调用已有的 `E.endGame(id, side, reason)`（`engine.cjs:279-286`，函数已存在、签名现成）。这是最小改动路径，且不破坏现有逻辑。

---

### 小结

- 本批四张高严重度角色指向同一类缺口：**程序把「角色效果」全部外包给说书人的自由裁量，但胜负 / 死亡 / 角色这三件事是写死的，说书人没有通道去覆盖它**。
- 最小可行的补齐顺序：① `checkWin` 扩展（镇长 / 红唇女郎）→ ② `execute` 圣徒分支 → ③ `kill` 的 night 参数（猎手）→ ④ `dealRoles` 酒鬼双层角色。四步做完，本批高严重度问题即可全部消除。
