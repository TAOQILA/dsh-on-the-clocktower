# 角色审核报告 · chunk-06

> 审核对象：`docs/audit/chunk-06.json` 中的 10 个角色（沙巴洛斯、珀、法官、女舍监、巫毒师、学徒、主教、钟表匠、筑梦师、舞蛇人）
> 审核基准：`docs/audit-flow.md` 描述的现有流程 + `engine.cjs` / `agents.cjs` / `public/app.js` / `data/nightorder.json` 的实际硬编码
> 判定口径：高＝硬编码直接拒绝/覆盖核心效果，或说书人根本无法执行；中＝能勉强执行但依赖自由文本标记、易漏结算；低＝仅措辞/顺序层面需注意；无＝现有流程完全能承载

## 一、总表

| 角色 | 阵营 | 能力摘要（≤40字） | 是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 沙巴洛斯 | 恶魔 | 每夜选两名玩家，他们死亡 | 是（轻微） | `nightorder.json` 的 other 表有、first 表无，与「每夜*」一致；说书人可私聊问两名目标，`deaths` 数组支持一次传两个座位。唯一注意点：`engine.cjs:227-238` 的 `kill()` 每杀一人就调一次 `checkWin`，两杀同夜时第一个死亡就可能触发终局，第二条死亡播报的归属会略显混乱。能力原文（本 chunk 版）不含「复活/反刍」，故无复活通道需求。 | 低 |
| 珀 | 恶魔 | 每夜可选一名玩家，他死亡 | 是（轻微） | other 表有、first 表无，与「每夜*」一致；单杀走 `deaths` 无问题。问题在「可以」＝可放弃选择，而 `agents.cjs` 的防空转逻辑要求说书人每轮至少做一件事，「本夜不杀人」只能靠写一条 `info`（如「你今晚没有选择目标」）来表达，没有语义化的「弃权」字段。若按官方原文含「不选则次夜可杀三人」，则还需跨夜记忆，`state.markers` 自由文本可勉强承载但极易漏。 | 低 |
| 法官 | 旅行者 | 每局限一次，可在他人提名时直接处决或让投票无效 | 是 | 双重阻断：①`engine.cjs:434-544 dealRoles` 只从镇民/外来者/爪牙/恶魔四池抽牌，剧本的「旅行者」组完全不参与发牌，法官根本不会进场；②即便在场，`nomResolve`（engine.cjs:851-890）的 `passed`/`onBlock` 无任何外部覆盖入口，说书人输出 JSON 也没有 `voteOverride` 字段，无法「直接处决」或「投票无效」；`agents.cjs:224-239` 只有一行文字提示，无程序支持。 | 高 |
| 女舍监 | 旅行者 | 每个白天可选至多三对玩家交换座位 | 是 | ①旅行者不入发牌池，不会进场（同上）；②`s.seats` 是固定数组，全项目没有交换座位/座位重排的接口，前端 `public/app.js` 按索引渲染座位、只有改名（renameSeat），无交换 UI；③交换座位必须同步搬迁 `s.roles`/`s.markers`/`s.alive` 上的座位归属，否则后续所有按座位号的结算（投票、夜间行动、播报）全部错位。 | 高 |
| 巫毒师 | 旅行者 | 只有你和死者可投票，不需投票标记，忽略过半 | 是 | ①旅行者不入发牌池，不会进场；②`engine.cjs:786-806 nomHand` 明确拒绝「已用完死亡票的死者投票」，`engine.cjs:827-828` 要求 `deadVoteUsed` 未用；`nomPropose` 还要求发起人在场存活——死者投票权被硬性限制；③`nomResolve` 的 `const majority=(votes*2>=aliveCount)` 焊死过半条件，无跳过开关；只有 `VOTE_ROLE_RULES` 一行文字。 | 高 |
| 学徒 | 旅行者 | 首夜依阵营获得一名镇民或爪牙角色的能力 | 是 | ①旅行者不入发牌池，不会进场；②「获得某角色的能力」需要额外能力槽，但代码只有 `s.roles[seat]` 一个字段，`roleFaction`（读 data/roles.json）、`checkWin`、`nightOrderFor`（按 roles 过滤顺序表）全部按它判定——直接改 roles 会连带改阵营与胜负判定；③`agents.cjs:992-995` 在 `roleMode==='program'` 时**直接丢弃**任何含「你的角色是【X】」的 info，连绕道改角色都做不到。 | 高 |
| 主教 | 旅行者 | 只有说书人可以发起提名，每天至少提名一名对立阵营玩家 | 是 | ①旅行者不入发牌池，不会进场；②`engine.cjs:740-761 nomPropose` 硬性要求 `s.alive[from]` 为真，`from` 必须是座位号，**没有「说书人代为提名」的入口**，说书人输出 JSON 也没有 `nominate` 字段——「只有说书人可以发起提名」与流程直接矛盾；③「每个白天至少提名一名对立阵营玩家」无任何约束与检查，只能靠 LLM 自觉。 | 高 |
| 钟表匠 | 镇民 | 首夜得知恶魔与爪牙之间的最近距离（邻座为1） | 否（仅措辞） | `nightorder.json` first 表有钟表匠，首夜发一条 `info` 即可，不改变任何基础规则、不需要额外状态。唯一风险是距离由 LLM 自己按座位号环形数，双向取最近、邻座记 1 的口径必须在提示词里写死，否则容易算错或算成单向。 | 低 |
| 筑梦师 | 镇民 | 每夜选一名非己非旅行者玩家，得知一个善良与一个邪恶角色之一 | 否 | first/other 表都在；每夜「私聊问目标 → 收到回答 → 用 `info` 给出两个角色名」这条链路 `agents.cjs:494-505` 已完整支持，纯文本信息不涉及规则改动。仅「只展现一个善良与一个邪恶角色、该玩家是其中之一」需要提示词约束说书人别把两个都给成同阵营角色。 | 无 |
| 舞蛇人 | 镇民 | 每夜选一名存活玩家：若选中恶魔则交换角色与阵营，他中毒 | 是 | first/other 表都在，选人与判定的入口有；但核心「交换角色和阵营」**没有通道**：改 `s.roles` 被 `agents.cjs:992-995` 拦截丢弃，说书人 JSON 无 `swapRoles` 字段；阵营只能由 `roleFaction` 按静态 roles.json 反查，无法表达「同一角色不同阵营」；且角色一变 `checkWin` 立刻按新 roles 重判，可能出现瞬间终局的错乱。中毒可勉强用 markers 承载。 | 高 |

**统计**：本批 10 个角色：高 6 / 中 0 / 低 3 / 无 1。

## 二、需要改动的地方

### A. 旅行者根本没有进场路径（影响 法官/女舍监/巫毒师/学徒/主教 5 个角色，最高优先级）

1. **engine.cjs / dealRoles（约 434-544 行）**
   - 现在只从 `groups` 的「镇民/外来者/爪牙/恶魔」四池抽牌，剧本里的「旅行者」组被完全忽略。需要新增一条与配比正交的发牌分支：旅行者不占用 `compositionFor(n)` 的四阵营配额，单独从「旅行者」池抽 1~N 张（通常由人数/剧本决定），写入 `s.roles[seat]`，并且 `s.roles` 里旅行者的 faction 必须是 `traveler`。
   - 发牌顺序上，旅行者应最后发放，且**不得参与** `bracketSpec` 的方括号修正（现在 `engine.cjs:399-425` 完全不认识旅行者标签，需补一条「旅行者不计入配比」的排除逻辑，否则一旦剧本带 `[+1旅行者]` 之类的标签会被静默忽略）。
   - `dealEvilInfo` 与首夜邪恶信息需要显式排除旅行者（旅行者不是爪牙/恶魔，但若未来有邪恶旅行者，需按 faction 判定而非按「不是镇民就算邪恶」）。

2. **engine.cjs / checkWin（253-277 行）**
   - 胜负判定必须排除旅行者：旅行者的死亡/存活不能计入 `aliveCount ≤ 2` 的邪恶胜利条件，旅行者换阵营也不能触发「恶魔出局＝善良胜」。现在 `checkWin` 遍历 `s.roles` 直接按 faction 判定，加入旅行者后会产生误判。

3. **engine.cjs + public/app.js：旅行者加入与流放**
   - 官方流程里旅行者是「中途加入 / 被流放」。当前 `s.seats` 在开桌时固定，`app.js` 没有加座/流放 UI。若本仓库不打算做中途加入，至少需要「开局即发旅行者」这一条路径，并在 `app.js` 座位卡片上把旅行者与常规角色区分显示（阵营色/标签）。

### B. 法官：投票结果覆盖（engine.cjs + agents.cjs）

4. **engine.cjs**
   - 给 `nomResolve`（851-890 行）增加一个可选的强制结果参数，例如 `resolveVote(id, { force: 'execute' | 'void' })`：`force='execute'` 时跳过 `majority` 判定直接置 `passed=true, onBlock=target`；`force='void'` 时置 `passed=false` 并清空本轮的 `votes`/`onBlock`。
   - 新增一次性限次标记，例如 `s.usedOnce = { judge: true }`（或复用 `state.markers` 里一条「法官已用」的自由文本，但建议做成结构化字段），用于「每局限一次」的校验。
   - `nomFinish`（899-912 行）需要能被法官的「直接处决」调用：现在它是白天提名流程的收尾函数，需确认可以在「提名刚发起、还没投票」时就处决 `target`，并且处决后立刻结束本白天（调 `setPhase` 到下一个 night）。

5. **agents.cjs**
   - 说书人夜间/白天输出 JSON（512-518 行）新增 `voteOverride` 字段，取值为 `'execute'`/`'void'`，并在 `applyReply` 里映射到上面的 `resolveVote(id, {force})`。
   - `VOTE_ROLE_RULES`（224-239 行）里法官那条文字提示保留，同时补上「只有别人发起提名且尚未结算时才能用，每局仅一次」。

### C. 女舍监：座位交换（engine.cjs + agents.cjs + public/app.js）

6. **engine.cjs**
   - 新增 `swapSeats(id, a, b)`：交换 `s.seats[a]`/`s.seats[b]` 的**全部座位属性**——即 `s.roles`、`s.alive`、`s.markers`、`s.deadVoteUsed` 等所有以座位号为索引的数组都要同步交换，或（更稳妥）改成「座位对象」结构后交换对象引用。
   - 校验：存活玩家的座位交换不影响死亡状态；每个白天最多 3 对；交换后需重新广播一次座位表（见第 8 条）。
   - 若交换导致座位相邻关系变化，凡依赖座位相邻的结算（目前主要是说书人自裁定，程序侧没有硬编码相邻逻辑）需要在下一轮 prompt 里重新注入新的座位顺序。

7. **agents.cjs**
   - 白天 prompt 里为女舍监预留「询问要交换哪几对座位 → 收到后调用 `swapSeats`」的流程，并在说书人 JSON 里新增 `swapSeats: [[a,b],...]` 字段（不能靠 markers 表达，因为这是结构性改动）。
   - 现有 `VOTE_ROLE_RULES` 没有女舍监，需要新增一条文字提示。

8. **public/app.js**
   - 座位列表在交换后必须重新渲染，并给玩家一条可见播报（谁和谁换了座位）。现在 `app.js` 的座位渲染依赖座位索引，交换后角色/标记都要跟着走，务必确认它读的是服务端最新状态而不是本地缓存。

### D. 巫毒师：投票权与过半条件（engine.cjs + agents.cjs）

9. **engine.cjs / nomHand（786-806 行）**
   - 当场上存在「存活且未中毒/醉酒」的巫毒师时：死者投票不再受 `deadVoteUsed` 限制（不消耗死亡票），并允许死亡玩家投票；同时按能力原文「只有你和死亡的玩家可以投票」限制**存活的其他玩家不得投票**（这是否决式限制，需要在 `nomHand` 里对非巫毒师、非死亡的存活玩家直接拒绝）。
   - 需要在 `state` 里有一个判定巫毒师在场的辅助函数（复用 `secretBallot` 里查「街头风琴手」的写法，engine.cjs:702-710 附近），并排除中毒/醉酒状态。

10. **engine.cjs / nomResolve（851-890 行）**
    - `const majority=(votes*2>=aliveCount)` 这一行需要改成可被角色能力关闭：巫毒师在场时 `majority` 恒为 `true`（只要 `votes>=1`）。建议抽出一个 `needMajority(id)` 函数统一判定，避免以后再遇到同类能力再次改主流程。

11. **agents.cjs**
    - `VOTE_ROLE_RULES` 里巫毒师那条已存在，需补上「死者不消耗投票标记」与「存活者不能投票」两条具体约束，否则 LLM 只会执行「忽略过半」这一半。

### E. 学徒：能力附加槽（engine.cjs + agents.cjs）

12. **engine.cjs**
    - 新增 `s.extraAbilities = [{ seat, roleName }]`（或 `s.roles[seat].extra`），**不要**改动 `s.roles[seat]` 的主角色名：这样 `roleFaction`、`checkWin` 的阵营判定完全不受影响，旅客仍然是 `traveler` 阵营。
    - `nightOrderFor`（agents.cjs:494-505 调用的过滤逻辑，底层读 data/nightorder.json）需要把 `extraAbilities` 里的角色名一并纳入「本局存在的角色」，否则学徒获得的镇民/爪牙能力不会出现在夜间顺序表里。
    - 若学徒获得的是恶魔/爪牙能力（邪恶学徒），需额外确认该能力是否会在 checkWin 里被误算。

13. **agents.cjs**
    - 说书人输出 JSON 新增 `grantAbility: { seat, role }` 字段，由说书人首夜私聊询问「你是善良/邪恶」后写入；写入后私聊通知学徒获得了什么能力。
    - `agents.cjs:992-995` 的角色写入黑名单只拦「你的角色是【X】」这类文本，`grantAbility` 走独立字段不受影响，但需要在提示词里明确「分配额外能力不要用 info 文本，用 grantAbility」。

### F. 主教：说书人提名（engine.cjs + agents.cjs）

14. **engine.cjs / nomPropose（740-761 行）**
    - 允许 `from` 为 `'storyteller'`（或新增 `E.stNominate(id, target)`）：绕过 `s.alive[from]` 检查与 `usedNom` 限制，但仍然占用当天「每人一次提名/被提名一次」的名额，并正常走 `nomHand`/`nomResolve`。
    - `nomPropose` 里「死者不能提名」的判定要区分「代表玩家提名」与「说书人提名」，不能把说书人也拦掉。

15. **agents.cjs**
    - 说书人 JSON 新增 `nominate: seat` 字段，只在「主教在场」时允许（其他情况应拒绝并记日志）。
    - 白天 prompt 需要为说书人注入「主教在场 → 今天必须至少提名一名与主教对立阵营的玩家，否则流程不完整」的约束，并在 `nomFinish` 之后做一次检查：若当天没有任何由说书人发起的提名，给说书人一条「必须补一次」的追问提示（不能靠 LLM 自愿）。

### G. 舞蛇人：角色与阵营交换（engine.cjs + agents.cjs）—— 与学徒的 `grantAbility` 相关但独立

16. **engine.cjs**
    - 新增 `swapRoles(id, a, b)`：交换 `s.roles[a]` 与 `s.roles[b]` 的角色名（阵营随角色名由 `roleFaction` 自动推导，正好符合「交换角色和阵营」）。若未来出现「同角色不同阵营」的需求，才需要引入 `s.alignment[seat]` 覆盖层，本期可先不做。
    - 交换后需要：①给双方各发一条新的私聊「你现在的角色是【X】」（这条要走程序而不是说书人 info，否则被 992 行拦掉）；②重新判定 `checkWin`；③若原恶魔变成善良的舞蛇人，需确认 `secretBallot`/`nightOrderFor` 等按角色名判定的逻辑同步生效。
    - 给原恶魔挂「中毒」标记（可用 `s.markers` 自由文本，但注意 `toggleMarker` 是**切换**语义，重复发同一标记会互相抵消，建议在这里改成显式的 `addMarker`/`removeMarker`，避免连续两夜中毒把人「切换」回健康）。

17. **agents.cjs**
    - 说书人 JSON 新增 `swapRoles: [a, b]` 字段并在 `applyReply` 里映射；`VOTE_ROLE_RULES` 没有舞蛇人，需新增一条「选中恶魔才交换，否则无事发生」的文字提示。
    - `agents.cjs:992-995` 的拦截逻辑需放行由 `swapRoles` 触发的角色变更（走环境函数，不走 info 文本）。

### H. 通用基础设施（为上面多条共用，建议优先做）

18. **agents.cjs：说书人输出 JSON 扩展**
    - 目前只有 `think / say / info / markers / deaths / nextPhase`（外加 `voteTarget / resolveVote`）。建议一次性补齐：`swapSeats`、`swapRoles`、`grantAbility`、`voteOverride`、`nominate`、`revive`、`forceExecute`，并在 `buildStorytellerNightPrompt`/`buildStorytellerDayPrompt` 的「可用动作」说明里逐条列出，否则说书人 LLM 根本不知道该输出这些字段。

19. **engine.cjs：`revive(seat)`**
    - 全项目没有复活函数。虽然本 chunk 里只有沙巴洛斯的官方原文（附加效果）可能用到，但结合其他 chunk 的角色（如「教授」类复活）建议本期就把 `revive` 做出来：清除 `alive=false`、移除「死亡」标记、在 `setPhase` 的天亮播报里增加「昨夜复活：…」一句（现在只播报死亡，engine.cjs:95-124）。

20. **engine.cjs：`toggleMarker` 的切换语义**
    - 现在是「有则删、无则加」（287-292 行），对「中毒/保护/交换过」这类需要持续存在的状态非常危险——说书人重复发一次就会把状态抹掉。建议改为幂等 `addMarker`/`removeMarker` 两个函数，说书人 JSON 用 `markers`（加）与 `unmarkers`（删）区分。

21. **data/nightorder.json**
    - 沙巴洛斯、珀只在 other 表、first 表缺席 —— 与「每夜*」的星号语义一致，**无需改动**。
    - 法官/女舍监/巫毒师/学徒/主教 不在任何顺序表 —— 作为旅行者它们是白天/被动生效的能力（学徒是首夜一次性），若采纳第 1 条的旅行者发牌，需要把「学徒」加入 first 表（首夜授予能力），其余四个可以不入表但必须在白天 prompt 里单独提醒说书人检查。

22. **public/app.js**
    - 座位交换后重渲染、旅行者标签显示、以及（若做）复活/流放的状态更新。当前只有 `renameSeat`，需要新增 `swapSeats` 对应的前端轮询刷新或服务端推送处理。

### 附：本批无需改动或仅提示词层面

- **钟表匠**：只需在角色提示词里写死「距离＝座位环形最短距离，邻座为 1，顺/逆时针取近者」。
- **筑梦师**：只需在提示词里写死「给出一个善良角色与一个邪恶角色，两者必须异阵营，且目标不能是自己或旅行者」。
- **沙巴洛斯/珀**：能力（本 chunk 文本）本身能被 `deaths` 数组完整表达；仅需在第 20 条把 `kill` 的 `checkWin` 调用改为「批量死亡结算完毕后统一判定」，避免两杀同夜时胜负在中途就被改写。
