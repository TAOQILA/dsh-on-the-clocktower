# 批次 16 角色审核

审核范围：docs/audit/chunk-16.json 的 10 个角色。
核对文件：engine.cjs（957 行）、agents.cjs（1465 行）、public/app.js（1966 行）、server.cjs（230 行）、data/nightorder.json（220 行）、data/roles.json、data/scripts/*.json。

先记两条贯穿本批的系统性事实（后面多个角色的结论都由它们推出）：

- **夜间顺序表只认名字。** `nightOrderFor(id)`（agents.cjs:434-445）的做法是：取 first/other 表里的一串名字，再用 `present[name] && out.indexOf(name)<0` 过滤，只有「表里有 + 本局在场」的角色才会进说书人的「本夜行动顺序」。所以**没进表 = 首夜能力永远不会被提示**；**误进表 = 说书人会对一个没有夜间行动的角色执行结算/询问**。
- **markers 是「切换」不是「设置」。** `toggleMarker(id,seat,marker)`（engine.cjs:287-292）是 `indexOf>=0 ? splice : push`。而 agents.cjs:1002 每轮把回包里的 `rp.markers` 逐条喂给 toggleMarker。于是**同一条标记重复声明一次，就会被摘掉**——所有需要跨夜持续的标记（讷帽、中毒、醉酒、被保护）都会在这里丢状态。

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
| --- | --- | --- | --- |
| 腹语师 | 奇遇（loric） | 高 | 处决是硬编码的：`nomFinish` 直接 `execute`，没有免死/拦截分支，也没有「处决前确认」的回包字段，能力无处执行。 |
| 落难少女 | 外来者 | 中 | 在 first 表位置正确；但 `dealEvilInfo` 只告诉爪牙「谁是恶魔」，从不告诉爪牙「落难少女在场」；「猜对善良落败」只能靠 `endGame` 手动宣布。 |
| 街头风琴手 | 爪牙 | 中 | 投票闭眼/秘密计票已硬编码且正确；但它本身没有夜间行动，却被同时写进 first(41) 和 other(123) 两张表，说书人会把它当成夜间角色处理。 |
| 解谜大师 | 外来者 | 高 | roles.json 标 `first_night:true`，但 first 表里没有它 → 首个夜晚的能力永远不会被提示；且「醉酒」在 engine 里没有机械语义，markers 又是 toggle 语义，持续状态会丢。 |
| 讷神 | 奇遇（loric） | 中 | 「讷帽算两票」在 `voteWeight` 里能生效；但「只能说单音节词 / 违规转移帽子」无检测，且帽子是持续标记，重复声明会被 toggle 摘掉。 |
| 诡诈杰克 | 奇遇（loric） | 高 | 需要「两位说书人」，而 state 里只有一个 `storyteller` 对象；「黄昏互换」也没有钩子（表里的「黄昏」永不被匹配）。 |
| 贵族 | 镇民 | 低 | first 表位置正确，能力可执行；只是不在任何剧本牌池，program 发牌永远抽不到，只能手工发牌。 |
| 赏金猎人 | 镇民 | 中 | first 表正确，但 other 表(207) 也收录了它，而能力是「首个夜晚」限定 → 第二夜起每夜都会被排进顺序，反复给邪恶线索（信息超发）。 |
| 遗忘之门 | 奇遇（loric） | 高 | 与硬编码正面冲突：发牌就发「你的角色是【X】」、`/api/game` 必然下发本人角色、前端还渲染角色名；「死亡时才得知」也没有任何钩子。 |
| 限 | 爪牙 | 中 | 中毒在 engine 里没有机械效果（voteWeight 不读中毒）；`[外来者数量任意]` 被解析成 `anyOutsider` 后从未被读取（死代码）；`initialOutsiders` 没有存进 state。 |

合计：高 4 / 中 5 / 低 1 / 无 0。

## 需要改动的地方

### 腹语师（高）

- **engine.cjs / `nomFinish(id)`（899-912）**：现在是 `const ob = s.nom.onBlock; ... if (ob) { const r = execute(id, ob.target); }`，无条件处决。改成处决前先读 `s.markers[ob.target]`，若含「免死」类标记则**跳过 execute**，改为公开播报「X 号没有死于处决」，并清掉该标记。理由：能力就是「被提名时宣称新角色 → 可能不死于当天处决」，而当前没有任何人能在 execute 之前介入。
- **agents.cjs / 说书人回包 schema（512-517、547-549）**：增加一个 `execVeto:[{seat,reason}]` 字段，并在 `runNomination` 收尾调用 `E.nomFinish(id)`（1289）之前先问一次说书人。理由：这是「说书人裁量」型能力，程序不能自己判断，必须给它一个否决口。
- **agents.cjs / `runNomination`（1288-1292）**：目前收尾是 `setStage('finish'); const fin = E.nomFinish(id);`，全程不问说书人。如果不想改 schema，最小改法就是上面 engine 那条按标记判断。
- 注：它不在 data/scripts 的三份剧本里（不在任何 `groups`），program 模式发牌不会出现，只能 roleMode=storyteller 手工发。

### 落难少女（中）

- **engine.cjs / `dealEvilInfo(id)`（572-591）**：给爪牙的那条只发「你的同伴是：<恶魔>（恶魔）。夜里不要公开谈论这些。」。在 `info.minionSeats.forEach` 里补一条：若本局在场角色含「落难少女」，追加 giveInfo「本局有落难少女在场」。理由：能力第一句就是「所有爪牙都知道落难少女在场」，而现在这条信息程序从不发，说书人也很容易漏。
- **engine.cjs / 胜负（253-277、279-286）**：能力要求「猜对则你的阵营落败」，`checkWin` 只会因为「恶魔出局」判善良胜，不会因为落难少女被猜中判善良负。最小实现：新增 `E.damselGuessed(id, seat, correct)`，correct 时调 `endGame(id,'evil','落难少女被猜中')`（`endGame` 已在 279）。
- **交互通道**：目前没有「爪牙公开猜测落难少女」的专用 action，只能走公聊 + 说书人裁量；每局一次的计数可以用 markers 存（markers 在 server.cjs:71-73 已对非说书人清空，不会泄露）。
- 位置：first 表 nightorder.json:17，在「爪牙信息」之后，**正确**，不要动。

### 街头风琴手（中）

- **data/nightorder.json**：从 `first`（第 41 行）与 `other`（第 123 行）两张表**都删除**「街头风琴手」。理由：roles.json:2162-2163 是 `first_night:false / other_nights:false`，它没有夜间行动；而 `nightOrderFor` 会把它排进「本夜行动顺序」，说书人按 agents.cjs:494-505 会去「结算」它，甚至可能私聊问它选目标。
- **engine.cjs / `secretBallot`（702-710）**：实现是对的（存活 + 未带 /中毒|醉酒/ 标记），不用改；只有一处小瑕疵——agents.cjs 落标记用 toggle，若说书人某轮把「中毒」再声明一次反而会解除，见「解谜大师」一节的 setMarker 改造。
- **engine.cjs / `nomFinish`（910）**：`say(id,'storyteller', secretBallot(s) ? '今天没有人被处决。' : '今天没有人被处决。', 'town');` 两个分支文本完全相同，属于漏写的分支，建议合并或补上秘密投票下的措辞差异（低，顺手改）。

### 解谜大师（高）

- **data/nightorder.json / first 表**：在「恶魔信息」（第 18 行）之后插入「解谜大师」。理由：roles.json:2175 `first_night:true`，但两表都没有它，`nightOrderFor` 永远不会把它排进去 → 首夜「一名玩家醉酒」的设定与「每局限一次猜测」的启动时机全部缺失。
- **engine.cjs / 新增 `setMarker(id,seat,marker,on)`**：与 `toggleMarker`（287-292）并列导出，幂等设置；把 **agents.cjs:1002** 的 `E.toggleMarker(id, i, x.marker)` 改为 `E.setMarker(id, i, x.marker, true)`，另给一个清标记的出口（说书人回包可加 `clearMarkers`）。理由：`toggleMarker` 的语义是翻转，说书人每夜重复声明「醉酒」会把它摘掉，而解谜大师的醉酒必须「即使你已死亡」也持续。
- **engine.cjs / `voteWeight`（687-696）**：增加一条——markers 含 /中毒|醉酒/ 时返回 0（或按规则不计票）。理由：现在只有 `secretBallot` 读中毒/醉酒，`voteWeight` 完全不读，导致「中毒」对票权毫无影响，与「中毒玩家能力失效」的通用预期不符。

### 讷神（中）

- **engine.cjs / `voteWeight`（693-694）**：`if (ms.some(x=>/讷帽/.test(String(x)))) return 2;` 已能工作，**不要动**。
- **engine.cjs / `setMarker`**（同上一节）：讷帽是持续状态，必须用幂等写入；否则说书人第二次声明「讷帽」＝摘帽。
- **agents.cjs / 说书人提示词（509 附近）**：补一句「标记的增删请用 setMarker/clearMarkers 语义，不要重复声明已有标记」，并明确「讷帽」这个标记名与「主人:N」一样属于可读标记（`butlerMaster` engine.cjs:678-685 已有「主人:N」的解析先例，可作为标记约定写法）。
- 「只能说单音节词 / 违规转移」不要求代码实现（属于说书人裁量 + 玩家自律），当前 toggleMarker 手改也能做，属可接受。

### 诡诈杰克（高）

- **engine.cjs / `createGame`（41-49）与 `setSeatModel`（352-363）**：state 只有一个 `storyteller` 对象，`setSeatModel` 也把 'storyteller' 作为单数处理。要支持该角色，需增加 `storyteller2` 与「当前哪一位在说话」的开关（例如 `s.storytellerActive`），并让 `buildStorytellerNightPrompt`（agents.cjs:446）按开关切换「说真话/说假话」的提示。成本高。
- **data/nightorder.json**：「黄昏」在 first(4) 与 other(95) 只是占位字符串，`nightOrderFor` 的 `present[name]` 永远匹配不到「黄昏」（s.roles 里只有角色名），所以「黄昏互换」这一步从来不执行。若保留该角色，需要单独一个 phase 钩子（`PHASES` engine.cjs:19 目前只有 setup/night/day/nomination/vote/dawn/ended，没有黄昏）。
- **建议**：在 `data/scripts` 的 `usable()`（engine.cjs:444-450）之外，另加一个「本架构不支持」清单把它排除；或直接在角色页标注「需双说书人，暂不支持」。理由：单说书人架构下这个能力不是「跑得不对」，而是**根本没有对应的执行主体**。

### 贵族（低）

- **无需改代码**。first 表 nightorder.json:71 位置正确（信息类后段），other 表无 —— 符合「在你的首个夜晚」。
- 若希望 program 模式能发到它：把它加进某份 `data/scripts/*.json` 的 `groups["镇民"]`（当前三份剧本都没有它）。`bracketSpec` 的 `usable()`（engine.cjs:444-450）只拦 noDemon/noEvil/legion 三类，不会拦它。
- 能力本身可执行：说书人 prompt 里有全场真相（agents.cjs:473-481），`isEvilSeat`（engine.cjs:697）可用来校验「有且只有一名邪恶」。

### 赏金猎人（中）

- **data/nightorder.json / other 表**：删除第 207 行的「赏金猎人」。理由：roles.json:2228 `other_nights:false`，能力是「在你的首个夜晚」，first 表(80) 已有正确位置；留在 other 表会让 `nightOrderFor` 从第二夜起每夜把它排进行动顺序，说书人会反复发「一名邪恶玩家」的线索，等于每夜多一条真信息。
- first 表位置（80 行，在「钦天监」之后、「守夜人」之前）**正确**，不要动。

### 遗忘之门（高）

- **data/nightorder.json**：从 first(14) 与 other(176) 两张表都删除。理由：roles.json:2240-2241 两夜皆 false，它没有夜间行动，却被当成每夜角色处理；而且它是**开局全局效果**，不是夜间步骤。
- **engine.cjs / `dealRoles`（539）**：`s.seats.forEach(...giveInfo(id,i,'你的角色是【'+picked[i]+'】。'))` 会把角色直接发给本人 —— 与「玩家不知道自己的角色」正面冲突。需要在该角色在场时跳过这一步（只发给说书人/不写 info）。
- **engine.cjs / `giveInfo`（143-144）**：`const m = String(text||'').match(/你的角色是[【\[]([^】\]]+)[】\]]/); if (m && m[1] && !s.roles[seat]) s.roles[seat]=m[1].trim();` —— 就算不给玩家发，只要有别的路径发过这条文本就会回写 roles。改造时要一并考虑。
- **server.cjs / `game`（76-81）**：非说书人视角会把「自己那一张」下发给本人（`s.roles = { [mineSeat]: mineRole }`）。需要增加一个 state 位（例如 `s.hideOwnRole=true`），在该位为真时连自己那张也不下发。
- **public/app.js / `drawTable`（469-470）**：`var role = g && g.roles[i] ? g.roles[i] : (s.role||'');` 自己座位上会渲染角色名，也要按同一开关遮蔽。
- **engine.cjs / `kill`（227-238）**：目前只做 `s.alive[seat]=false; s.markers[seat].push('死亡'); ...`，不发任何信息。「当他们死亡时才会得知这些信息」需要在这里补一次 giveInfo（角色 + 阵营）。注意 kill 是夜间死亡入口，处决走 `execute`（176-182），两处都要补，否则被处决的玩家永远不知道自己的角色。
- 注：与 `dealRoles`/`bracketSpec`/`dealEvilInfo` 无矛盾（它不在任何剧本），矛盾全部来自「角色必然可见」的硬编码。

### 限（中）

- **engine.cjs / `bracketSpec`（399-425）+ `dealRoles`（473-482）**：`[外来者数量任意]` 在 412 行被解析成 `out.anyOutsider=true`，478 行 `if (sp.anyOutsider) anyOutsider = true;` 之后 **`anyOutsider` 再也没有被读过**（全文件仅此两处）—— 这个标签当前完全无效。要么让它真正影响外来者配比（把 `no` 放开/写进 notes），要么从能力文本里去掉这个标签，避免误以为已支持。
- **engine.cjs / `createGame`（41-49）**：state 里没有「初始外来者数量」。能力的触发条件是「等同于初始外来者数量的夜晚」，说书人只能自己从全场角色表数。建议存 `s.initialOutsiders = <外来者人数>`（在 `dealRoles` 末尾按 `picked` 统计写入），并让它进入说书人 prompt。
- **中毒的机械效果**：同「解谜大师」——`voteWeight`（687-696）不读中毒/醉酒；只有 `secretBallot`（708）读。所以「所有镇民玩家中毒」除了让说书人自己给假信息外，对票权与判定没有任何作用。要真生效，需在 `voteWeight` 加中毒判定，并在所有「能力是否生效」的地方统一读同一个状态。
- **「直到下个黄昏」的清除**：没有定时清理，`PHASES`（19）里也没有「黄昏」，nightorder 里的「黄昏」占位不会触发。最小实现：在 `setPhase` 进入 night 时清掉带「限:中毒」前缀的标记（或给标记加一个 `until` 字段）。
- **markers 语义**：`toggleMarker` 的问题同样适用于「所有镇民中毒」——说书人跨夜重复声明会把中毒摘掉，需要 `setMarker` 幂等接口（同「解谜大师」一节）。
