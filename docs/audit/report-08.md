# chunk-08 角色审核报告（10 个角色）

审核对象：`docs/audit/chunk-08.json`（4 外来者 / 4 爪牙 / 2 恶魔）
审核基准：`docs/audit-flow.md` + 实际代码 `engine.cjs` / `agents.cjs` / `public/app.js` / `data/nightorder.json` / `data/roles.json` / `data/wiki/pages/*.md`
判定口径：高＝硬编码会直接拒绝或覆盖核心效果，或缺通道导致根本执行不了；中＝能勉强执行但依赖自由文本标记或要额外小心，容易漏结算；低＝仅措辞层面；无＝完全可承载。

| 角色 | 阵营 | 能力摘要 | 是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 畸形秀演员 | 外来者 | 疯狂地证明自己是外来者时，说书人可处决他 | 是 | 无「白天立即处决」通道：说书人回包只有 `deaths[]`，而它走 `E.kill`（engine.cjs:227）被记为**夜间死亡**，天亮才在「昨夜死亡」里播报；也不计入「今天已处决一次」 | 中 |
| 心上人 | 外来者 | 死亡时令一名玩家醉酒，持续到终局 | 是 | 死亡触发无回调：`execute`(engine.cjs:176)、`kill`(:227)、`nomFinish`(:899) 都不通知说书人；处决在引擎里直接完成，说书人要等到下次被唤起才补标记；`markers` 是 toggle(:287)，重发会误删「醉酒」 | 中 |
| 理发师 | 外来者 | 死亡当晚恶魔可令两名玩家交换角色 | 是 | **完全改不了角色**：说书人 info 里含「你的角色是【X】」在 program 模式下被硬拦截（agents.cjs:992-995），`giveInfo` 只在 roles 为空时写入（engine.cjs:144） | 高 |
| 呆瓜 | 外来者 | 知死时公开选一人，若其邪恶则己方落败 | 是 | 说书人回包 JSON 没有终局字段（schema 见 agents.cjs:512-517 / 547-549，`rp.win` 零引用），`checkWin`(engine.cjs:253) 只认「恶魔死」「存活≤2」；只能靠前端管理员按钮 | 高 |
| 镜像双子 | 爪牙 | 与对立阵营玩家互知角色；善良双子死→邪恶胜 | 是 | `checkWin` 一见恶魔死亡立刻判善良胜（engine.cjs:265-266），直接覆盖「双子都存活时善良无法获胜」；「善良双子被处决→邪恶胜」无入口；首夜只发爪牙↔恶魔信息（engine.cjs:109），双子互知要靠说书人另发 | 高 |
| 女巫 | 爪牙 | 每夜诅咒一人，其次日提名即死；仅剩 3 人失能 | 是 | 提名无钩子：`nomPropose`(engine.cjs:744) 直接 `say`「X 提名了 Y」，且提名由 `nomTick` 自动跑完，说书人插不进去 → 被诅咒者提名不会死；「被诅咒」无一天过期机制，toggleMarker 还会把它翻掉 | 高 |
| 洗脑师 | 爪牙 | 每夜令一人疯狂扮演某善良角色，违者可处决 | 是 | 告知与「疯狂」标记可做（info + markers），但**违者无法被处决**：白天只有 `openVote/resolveVote`，`deaths[]` 会被记成夜间死亡；「疯狂」每夜重发会被 toggle 删掉 | 中 |
| 麻脸巫婆 | 爪牙 | 每夜造角色不在场者变成该角色，可能造出恶魔 | 是 | 同理发师：**改角色通道缺失**；且改完必须同步 `s.roles` 才能让 `roleFaction`/`checkWin`/夜序正确；「造出恶魔则当晚死亡由说书人定」可用 deaths[]，但依赖上一步先能改角色 | 高 |
| 方古 | 恶魔 | 每夜杀人；首次杀外来者改为方古死亡、外来者变邪恶方古 | 是 | 核心转化要**改角色**（外来者→邪恶方古）且原方古死亡，角色改不了＝能力失效；另外 `roles.json`(1177-1189) 的能力文本被截断成「每个夜晚*，你要选择一名玩家：他死亡。」，丢了 `[+1 外来者]`，`bracketSpec`(engine.cjs:399) 读不到 → 配比不修正 | 高 |
| 亡骨魔 | 恶魔 | 每夜杀人；被杀爪牙保留能力、邻近镇民中毒 | 是 | 杀人可做；「保留能力」勉强成立（`nightOrderFor`:434 只看 roles 不看存活，死者仍会被排进夜序），但「邻近两名镇民之一中毒」要说书人手算座位并加自由文本标记；`[-1 外来者]` 同样在 roles.json 里丢失 → 配比不修正 | 中 |

## 需要改动的地方

### A. 说书人「改角色」通道（理发师 / 麻脸巫婆 / 方古 —— 最高优先）

1. **engine.cjs**：`assignRole`(:125) 目前只在 setup 用。新增 `forceRole(id, seat, role, reason)`：无条件写 `s.roles[seat]`，写一条「角色变更」日志并推 `s.pendingRoleNotify[seat]=role`，供后续私聊告知。
2. **engine.cjs**：`giveInfo`(:132) 里 `if (m && m[1] && !s.roles[seat])` 这条「仅在无角色时落角色」的守卫，改为：允许覆盖，但必须同时清空该座位旧的 `markers` 中与旧角色相关的项（否则旧角色标记残留）。
3. **agents.cjs**：在说书人回包 schema（夜 :512-517、昼 :547-549）新增字段 `"roles":[{"seat":N,"role":"角色名","reason":"…"}]`，并在 apply 段（:986-1016 之间）新增处理：`roleMode==='program'` 时**允许** roles 字段改角色，但保留 info 里「你的角色是【X】」的拦截（:992-995）不动——两者分工：info 只发消息，roles 才改数据。改完立刻 `E.forceRole`，并自动给该座位私聊「你的角色变为【X】」，避免玩家不知道。
4. **提示词**：在夜间提示词（agents.cjs:446 起）加一段「若本夜有角色变更（理发师/麻脸巫婆/方古），必须同时写 roles 字段并在 info 里私聊告知当事人；只写 info 不改 roles 会导致胜负与夜序错乱」。

### B. 自定义胜负入口（呆瓜 / 镜像双子）

5. **agents.cjs**：说书人回包新增 `"win":{"side":"good"|"evil","reason":"…"}`，apply 段调用已有的 `E.endGame`(:279)。这是当前唯一缺失的「说书人宣布终局」通路（`rp.win` 目前零引用）。
6. **engine.cjs `checkWin`(:253)**：加两层可插拔判定，放在现有两条之前：
   - `s.winBlocks`：数组，如 `[{kind:'twinsAlive',seats:[a,b]}]`，命中则**抑制**「恶魔出局→善良胜」（但保留「存活≤2→邪恶胜」）；
   - `s.winOverride`：`{side,reason}`，直接结束。
7. **engine.cjs**：新增 `setWinBlock(id, kind, data)` / `clearWinBlock(id, kind)`，让说书人能声明「双子都在场，善良不能胜」；镜像双子死亡时（`kill`/`execute` 里）自动 `clearWinBlock`。
8. **提示词**：白天/夜晚提示词加「若善良双子被处决，或呆瓜选到的存活玩家是邪恶，直接写 win 字段宣布终局，不要靠 voteTarget 绕」。

### C. 提名钩子（女巫）

9. **engine.cjs `nomPropose`(:744)**：在 `say「X 提名了 Y」` 之后加钩子判断——若 `s.markers[from]` 含「被诅咒」，立即 `kill(id, from, '被诅咒者发起提名')`（提名本身仍然生效，按 wiki 规则），并把死亡结果返回到返回值里。这样 `nomTick` 自动跑也能触发。
10. **engine.cjs**：`markerMeta` 增加作用域。在 state 里加 `s.markerExpire[seat] = {marker: 'day'|'night'}`，`setPhase('day')`(:95) 时扫一遍清掉 day 域的标记（「被诅咒」只保留一个白天），`setPhase('night')` 清 night 域（「疯狂」的白天部分）。
11. **engine.cjs**：新增 `countAlive` 后，在 `setPhase` 里检查「存活 ≤3 且场上有女巫」→ 自动 `removeMarker(seat,'被诅咒')` 并给女巫私聊「你失去能力」（现在没有任何自动检查）。

### D. 标记要有「加/删」而不是「切换」

12. **engine.cjs `toggleMarker`(:287)**：拆成 `addMarker(id,seat,marker)`（幂等）与 `removeMarker`，保留 `toggleMarker` 只给 UI 按钮用。
13. **agents.cjs :1002**：`rp.markers` 的处理从 `E.toggleMarker` 改为 `E.addMarker`（幂等），否则说书人每夜重发「疯狂」「被诅咒」会把前一晚的标记翻掉——这是洗脑师/女巫/心上人最容易出错的一环。
14. **public/app.js :1099**：标记下拉只有 中毒/醉酒/被保护/死亡 四项，改成下拉＋自由输入框（自定义：被诅咒/疯狂/保留能力/限一次/双子存活），否则 GM 手动补标记只能走后端。

### E. 死亡触发与「白天立即处决」

15. **engine.cjs `kill`(:227) / `execute`(:176)**：写 `s.pendingTriggers.push({seat, kind:'onDeath', night:s.night, day:s.day, role:s.roles[seat]})`，让说书人在下一次被唤起时看到「上一段里谁死了、该谁结算」（心上人醉酒、理发师换角色、呆瓜公开选人）。
16. **agents.cjs**：两处 prompt 增加【待结算的死亡触发】段落，把 `pendingTriggers` 渲染出来并提示「这些必须先结算完再推进阶段」；结算完由说书人写 `"triggersDone":[座位号]`，apply 段清空。
17. **engine.cjs**：新增 `execution(id, seat, reason)`——立即处决、计入 `s.dayExecCount`、**不入 nightDeaths**、日志写「被处决」而不是「夜里死亡」。当前 `execute` 已经不入 nightDeaths（这点是对的），但缺 `dayExecCount` 计数与「今天已经处决过」的校验，导致畸形秀演员/洗脑师的额外处决无法界定「是否算今天那次」。
18. **agents.cjs**：回包加 `"executions":[座位号]`（白天立即处决，走上面 `execution`），与 `deaths`（夜间死亡，走 `kill`）严格分开；提示词写清两者区别。

### F. 配比修正（方古 / 亡骨魔）

19. **data/roles.json**：方古(:1181) 与 亡骨魔(:1196) 的 `ability` 被截断成只有「每个夜晚*，你要选择一名玩家：他死亡。」，丢失了 `[+1外来者]` / `[-1外来者]`。补全为：
    - 方古：`每个夜晚*，你要选择一名玩家：他死亡。被该能力杀死的外来者改为变成邪恶的方古且你代替他死亡，但每局游戏仅能成功转化一次。[+1外来者]`
    - 亡骨魔：`每个夜晚*，你要选择一名玩家：他死亡。被你杀死的爪牙保留他的能力，且与他邻近的两名镇民之一中毒。[-1外来者]`
    否则 `bracketSpec`(engine.cjs:399) 读不到括号，`dealRoles` 不会修正配比，开局人数分布就错。
20. **data/roles.json 标志位**：麻脸巫婆(:1167) `first_night:true`、方古(:1182) `first_night:true` 与「每个夜晚*（不含首夜）」矛盾，应为 `false`；亡骨魔(:1198) `other_nights:true` 正确。这三组标志目前代码不读（`on_death/first_night` 在 engine/agents/app 里零引用），但会误导后续维护与外部工具。
21. **data/nightorder.json**：核对结论——first 有 镜像双子/女巫/洗脑师 ✔，other 有 麻脸巫婆/理发师/心上人/女巫/洗脑师/方古/亡骨魔 ✔；first 缺 麻脸巫婆/方古/亡骨魔 与「每个夜晚*」一致，不必补。**但** other 序列里「洗脑师」在「女巫」之后、「方古/亡骨魔」在「军团/小恶魔」之后，符合官方夜序，无需调整。

### G. 文档与代码不一致（顺带修）

22. **engine.cjs :750** `nomPropose` 拒绝已死亡玩家提名（`已死亡的玩家不能发起提名`），而 `docs/audit-flow.md` 写「死者可发起提名」。二者必须统一：若按官方规则（死者不能发起提名、但保留一次死亡票），改文档；否则改代码。当前女巫的「提名即死」判定逻辑（改动 9）也要按最终口径对齐。

---

**审核方法说明**：以上结论逐条对照了角色的 wiki 细则页（死亡触发时机、持续时长、是否计入当天处决、是否改变阵营）与四个通道（info / markers / deaths / say）的实际能力，未使用批量模板。
