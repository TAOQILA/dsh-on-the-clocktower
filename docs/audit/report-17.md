# 批次 17 角色审核

## 总表

| 角色 | 阵营 | 严重度 | 问题摘要 |
|---|---|---|---|
| 食人魔 | 外来者 | 高 | 首夜转变阵营，但阵营全程由 roleFaction(roles.json) 硬判，角色名不变即无法表达，isEvilSeat/checkWin 都会按原阵营算 |
| 魔术师 | 镇民 | 高 | 伪装信息被 dealEvilInfo() 硬编码覆盖：爪牙只收到真恶魔、恶魔只收到真爪牙，魔术师完全不被注入，能力失效 |
| 隐士 | 外来者 | 中 | 无夜间行动（nightorder 无、可接受），但「拥有所有外来者能力」无载体：abilityOfSeat 只读自己那条 ability；且 [-0~1 外来者] 范围写法 bracketSpec 解析不了，配比不修正 |
| 食人族 | 镇民 | 中 | 需要「上个被处决者」的持续状态，但 execute()/nomFinish 只 push '死亡' 不记死因与角色，无 lastExecuted；中毒态也无人统一检查 |
| 魔像 | 外来者 | 中 | nomPropose() 只有每天一次的 usedNom，没有每局一次的计数，也不在提名时结算死亡，第二次提名会被放行 |
| 首席律师 | 奇遇角色(loric) | 中 | 无旅行者/奇遇角色入场通道（engine 无 traveler 相关函数），根本无法进场；且「投票前只有指定玩家可发言」nomSpeech 只有 reason/defense 两种 kind，无法表达 |
| 黑帮 | 旅行者 | 中 | 同上无入场通道，无法进场；邻座与「另一边玩家同意」可借私聊通道做，但座位变更后无相邻关系维护 |
| 鹰身女妖 | 爪牙 | 低 | nightorder other 有、位置正确；但 first 表也列了它（第 47 行），与 roles.json first_night:false 矛盾，首夜会被误唤醒；「疯狂」无校验 schema，靠说书人判 |
| 骑士 | 镇民 | 无 | nightorder first 第 70 位在信息段，位置可接受；首夜发两名非恶魔玩家靠 giveInfo 私聊即可，无硬编码冲突 |

## 需要改动的地方

### 食人魔
- engine.cjs `roleFaction()` / `isEvilSeat()`：改为先查 `s.markers[seat]` 里的「阵营:邪恶」「阵营:善良」，命中则优先返回，再回落到 roles.json。为什么：阵营转变是基础规则，现在被角色表硬判覆盖，转变后胜负与票权全算错。
- engine.cjs `voteWeight()` / `checkWin()`（同文件 687、253 行）走上面同一个阵营判定函数，不要再直接 `roleFaction(roleOfSeat(...))`。为什么：避免一处改了另一处还按老阵营。
- agents.cjs `VOTE_ROLE_RULES`（224 行表）加一条：食人魔首夜选完人后用 toggleMarker 写「阵营:X」，并提醒不得告知其本人。为什么：目前该表里没有食人魔，说书人拿不到落地指令。

### 魔术师
- engine.cjs `evilInfoFor()` / `dealEvilInfo()`（550、572 行）：增加「伪装覆盖」入参，若场上存在清醒的魔术师，爪牙收到的 demonTxt 换成魔术师座位，恶魔收到的 minionTxt 追加魔术师座位。为什么：现在是纯按 s.roles 硬发，魔术师的伪装根本没进信息，能力等于不存在。
- engine.cjs `setPhase()` 109 行的自动 dealEvilInfo 与 `dealRoles()` 541 行的调用都要传这份覆盖，否则首夜两条路径各发一次真话。为什么：两处都会下发，只改一处仍会泄露。
- 若暂不改程序：agents.cjs 里要禁止说书人补发爪牙/恶魔信息（giveInfo 已有去重，但换文案可绕过），并在细则里注明「魔术师在场时按说书人裁定重发」。为什么：避免程序真话与说书人假话同时进玩家私聊。

### 隐士
- engine.cjs `bracketSpec()`（399 行）：`[-−]\s*(\d+)\s*外来者` 之前加一条范围匹配 `[-−]\s*(\d+)\s*[~～-]\s*(\d+)\s*外来者`，取 max 作为 minusOutsider。为什么：`[-0~1外来者]` 现在整条落到「只记录不强制」，配比不修正。
- engine.cjs `abilityOfSeat()`（671 行）：角色为隐士时，把本剧本在场/全量外来者的 ability 拼进返回值。为什么：票权、秘密投票、狂信者这些机械判定都靠 ability 文本正则匹配，隐士现在拿不到任何一条。

### 食人族
- engine.cjs `execute()`（176 行）与 `nomFinish()`（899 行）处决分支：写 `s.lastExecuted = { seat, role, faction, day }` 并给 markers 记「被处决」。为什么：食人族能力依赖「上个死于处决的玩家」，现在无处可查，说书人只能翻日志猜。
- engine.cjs `abilityOfSeat()`：角色为食人族时返回 `lastExecuted.role` 的能力原文；若该角色阵营为邪恶则同时返回中毒态（markers 加「中毒」直到下个善良玩家被处决）。为什么：能力继承与中毒解除都需要一个确定的状态源。
- engine.cjs `voteWeight()` / `secretBallot()` 的中毒判断改为统一函数 `isPoisoned(s,seat)`（读 markers「中毒」「醉酒」）。为什么：现在只有 secretBallot 和 voteWeight 各自零散检查，食人族继承来的能力会绕过中毒。

### 魔像
- engine.cjs `nomPropose()`（744 行）：开头加 `if (roleOfSeat(s,from)==='魔像' && s.nom.golemUsed) return {ok:false,...}`，并在入队时置 `s.nom.golemUsed=true`；随后在 `nomNext()` 建提名时，若发起者是魔像且被提名者阵营不是 demon，直接 `kill(id,target,'魔像提名')`。为什么：现在魔像每天都能提名一次，且提名不会致死，能力与硬编码直接冲突。
- agents.cjs `VOTE_ROLE_RULES` 232 行那条改成「每局一次（程序已计数），程序会自动结算死亡」，与实现同步。为什么：现在只写了规则，说书人会以为还要自己数。

### 首席律师
- engine.cjs 新增 `addTraveler(id, seat, role)`（或至少在 dealRoles 里显式排除 loric/traveler 并在 notes 说明）。为什么：目前牌池只抽四类，奇遇角色永远进不来，能力无意义也没人知道。
- engine.cjs `nomSpeech()`（776 行）：kind 增加 'lawyer'，并允许 stage 从 'vote' 前插入一次「指定发言者」阶段；`nomHand()` 在 lawyer 阶段对非指定座位直接拒绝举手。为什么：「投票前只有他可以发言」需要一个独占发言的通道，现在没有。

### 黑帮
- 同首席律师：先在 dealRoles 里排除 traveler 并写 note。若要做，需要 `addTraveler()` + 座位相邻关系（现存 seats 数组按下标取模，可在 kill 后重算）。为什么：无法进场，其余都是空谈。
- 同意机制可直接用现有私聊（agents.cjs 的 runRound replyTo:'storyteller'）实现，不需要新 schema。为什么：避免重复造通道。

### 鹰身女妖
- data/nightorder.json `first` 数组第 47 行删除「鹰身女妖」。为什么：roles.json 里 first_night:false，首夜表却列了它，说书人会在首夜错误唤醒。
- 其余（明天第一名玩家疯狂证明第二名是邪恶、否则可能死亡）用 markers 写「鹰身女妖:1>2」足够承载，不需要新字段。
