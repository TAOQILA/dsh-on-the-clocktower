# 角色审核报告 · chunk-01（10 个角色）

审核对象：`docs/audit/chunk-01.json`（10 个镇民）
审核依据：`docs/audit-flow.md`（现状流程）、`engine.cjs`（状态机：发牌/提名/投票/处决/死亡/胜负）、`agents.cjs`（说书人与玩家提示词、夜间顺序裁剪、主持回包落地）、`data/nightorder.json`（夜间行动顺序表）

## 总表

| 角色 | 阵营 | 能力摘要（≤40字） | 与现状是否冲突 | 冲突说明 | 严重度 |
|---|---|---|---|---|---|
| 洗衣妇 | 镇民 | 首夜得知两名玩家与一个镇民角色，其一为该角色 | 否 | `nightorder.json` 的 first 已收录；信息走 info 私聊下发，说书人有全场真相表可查在场镇民；自动发牌不与其冲突 | 无 |
| 图书管理员 | 镇民 | 首夜得知两名玩家与一个外来者；或得知没有外来者 | 否 | 同上；「没有外来者在场」分支由说书人清点真相表即可得出，info 通道足够 | 无 |
| 调查员 | 镇民 | 首夜得知两名玩家与一个爪牙；或得知没有爪牙 | 否 | 夜序已收录、通道够；但「间谍」这类可登记为善良的爪牙会与「一个爪牙角色」的判定产生裁量歧义，说书人需自行圆场 | 低 |
| 厨师 | 镇民 | 首夜得知场上邻座邪恶玩家有多少对 | 否 | 座位表与阵营表齐备，说书人可算；但「邻座」是环形（末位与首位相邻），程序没有提供环形邻座辅助，全靠说书人手算，容易按线性算错 | 低 |
| 共情者 | 镇民 | 每夜得知相邻两名存活玩家中邪恶玩家的数量 | 是 | 夜序已收录，但「跳过已死者后的相邻」＋环形相邻都要说书人每夜重算；中毒/醉酒时应给错误数字也无程序校验。每夜必结算，漏算算错无人发现 | 中 |
| 占卜师 | 镇民 | 每夜选两名玩家，得知其中是否有恶魔 | 是 | 需每夜私聊问「你想选择谁」，但 `giveInfo` 对完全相同文本去重，同一句提问到第二夜会被 `skipped` 吞掉，玩家不再被驱动回答，夜里直接卡死 | 高 |
| 送葬者 | 镇民 | 除首夜外每夜得知当天被处决者的角色 | 是 | `state` 里没有「今天谁被处决」字段，处决结果只写进 log 与公聊；说书人只能从对话记录反推，容易答错或答成昨夜死亡者 | 中 |
| 僧侣 | 镇民 | 除首夜外每夜选一名其他玩家：恶魔的负面能力当夜对他无效 | 是 | 夜序已收录；「被保护」只能写进自由文本 markers，说书人裁 deaths 时没有任何强制校验；每夜提问同样受文本去重影响 | 中 |
| 守鸦人 | 镇民 | 若夜里死亡会被唤醒，选一名玩家得知其角色 | 是 | 触发依赖说书人同一夜内「先裁死亡→再唤醒死者提问→再推进白天」；程序不提示，若同轮写了 nextPhase=day 就整个漏掉（死者仍可被 runRound 驱动，这层没问题） | 中 |
| 贞洁者 | 镇民 | 首次被提名时，若提名者是镇民，提名者立刻被处决 | 是 | 提名全走 nomPropose→nomNext→投票→nomFinish，没有「提名者立刻被处决」的钩子；白天回包也没有 execute 通道，只能靠 deaths 硬杀，而 kill() 会把白天死亡写进 nightDeaths，第二天天亮重复播报「昨夜死亡」 | 高 |

## 需要改动的地方

1. **engine.cjs:132-148 `giveInfo` 的文本去重必须收窄（对应占卜师、僧侣、守鸦人等「每夜都要问一次」的角色）**
   现状：`const dup = (s.info[seat] || []).some(x => String(x.text||'').trim() === String(text||'').trim()); if (dup) return { ok:true, skipped:true };`
   问题：这条去重本来只为防「一名玩家收到两个角色」，但它不分内容，把「请告诉我你想选择谁」这类每夜重复的提问也一并吞掉。第二夜起同一句提问返回 skipped，`agents.cjs:997` 的 `if (r && r.skipped) return;` 直接跳过，`newlyAsked` 不会记录，玩家永不被驱动回答。
   改法：只在文本命中角色告知时才去重，例如
   `if (/你的角色是[【\[]/.test(text)) { /* 走原来的 dup 判定 */ }`，
   其余 info 改为按 `text + night + phase` 组合去重（或干脆不去重）。这样每夜提问都能发出去。

2. **engine.cjs:744-761 `nomPropose` 增加贞洁者钩子**
   现状：提名一经提出就置 `usedNom/usedTarget` 并 push 进队列，随后必然走 reason/defense/vote/clock/nomFinish。
   问题：贞洁者的效果是「提名者立刻被处决」并且不走投票流程，当前流程会直接把被提名者推上去投票，核心效果被流程覆盖。
   改法：在 `s.nom.usedNom[from] = true` 之前插入判定——
   `if (roleOfSeat(s, target) === '贞洁者' && !已触发标记 && roleFaction(roleOfSeat(s, from)) === 'townsfolk') { 立刻 execute(from)；本次提名不入队；返回 {ok:true, chaste:true, executed:from} }`；
   同时给该贞洁者打一个 `贞洁者已触发` marker（或 `s.nom.usedTarget` 之外的独立 flag），保证「首次」只生效一次。返回值要让 `agents.cjs:1209` 的 `E.nomPropose` 调用点识别并中止后续队列处理。

3. **engine.cjs:227-238 `kill` 必须区分白天死亡与夜间死亡**
   现状：无论 phase 是什么，都 `s.nightDeaths.push(seat)` 并记「在夜里死亡」。
   问题：白天用 deaths 通道处置（贞洁者、以及后续所有「白天立即死亡」的角色）会污染 `nightDeaths`，下一次 `setPhase('day')`（engine.cjs:113-122）会把这些白天死者重新播报成「昨夜死亡」，死亡播报直接错。
   改法：`if (s.phase === 'night' || s.phase === 'dawn') { s.nightDeaths.push(seat); log(...'在夜里死亡') } else { log(...'死亡（白天）') }`，白天不进 nightDeaths。

4. **engine.cjs:176-182 `execute` 与 state 增加「今日处决记录」（对应送葬者）**
   现状：execute 只把 alive 置 false、push「死亡」marker、写一条 log，state 上没有可查询的处决记录。
   改法：在 state 上维护 `s.lastExecuted = { seat, day: s.day, role: s.roles[seat] || '', t: ... }`（`nomFinish` 里经 execute 处决时写入），并在 `agents.cjs` 的 `buildStorytellerNightPrompt`（agents.cjs:473-481 的「全场座位与真相」段）追加一行「今天白天被处决的是 N 号（角色 X）；今天无人被处决」。送葬者直接读这行，不必再反推对话。

5. **engine.cjs 增加环形邻座辅助函数并导出（对应厨师、共情者）**
   改法：新增
   `function neighborsAlive(s, seat){ const n=s.seats.length; const out=[]; for(let d=-1; d<=1; d+=2){ let k=(seat+d+n*2)%n; let guard=0; while(!s.alive[k] && guard++<n){ k=(k+d+n*2)%n; } if(s.alive[k] && out.indexOf(k)<0) out.push(k); } return out; }`
   加入 `module.exports`（engine.cjs:940 附近那行导出清单）。在说书人夜间提示词里直接给出每个在场「共情者/厨师」的邻座座位号与其中邪恶人数，让 LLM 只做陈述而不做算术。

6. **agents.cjs:446-523 `buildStorytellerNightPrompt` 补三类「本夜上下文」**
   a) 在【剧本】行下方输出本局配比「镇民 X / 外来者 Y / 爪牙 Z / 恶魔 W」（洗衣妇、图书管理员、调查员判定「没有外来者/没有爪牙」时要用）；
   b) 输出第 4 条里的「今天白天被处决者」；
   c) 对在场「守鸦人」额外加一条硬提示：「若守鸦人今夜死亡，必须在本夜内（nextPhase 之前）私聊唤醒他并问他要看谁，再给角色；不得在同一轮直接把 nextPhase 写成 day」。
   这三条都是现状「全靠 LLM 记得」的地方，写进提示词才能稳定。

7. **agents.cjs:999 提问识别不能靠关键词正则，改为显式标记**
   现状：`if (/[?？]|请告诉|你想选|选谁|选择谁|告诉我/.test(t) && ...)` 决定是否 `newlyAsked.push(i)`，进而决定是否驱动该玩家回答。
   问题：提问措辞一旦不命中这几个词（例如「请指定两名玩家」），说书人发了提问但玩家不会被驱动，夜里空转——占卜师、僧侣、守鸦人、管家都受此影响。
   改法：info 项增加可选字段 `ask: true`（engine.cjs 的 giveInfo `let rp.info` 落地处把 ask 一起存进 info 条目，或在 agents.cjs:986-1001 的循环里读 `x.ask`），并在提示词的输出 JSON 模板里写成
   `"info":[{"seat":3,"text":"...","ask":true}]`；
   保留原关键词正则作为兜底，但以 `ask` 为准。

8. **agents.cjs:547-550 白天回包 JSON 增加 `execute` 字段（贞洁者等「白天立即处决」能力的通用出口）**
   现状：白天只能 `voteTarget`/`resolveVote`，没有「直接处决某人」的通道，只能滥用 `deaths`（语义是夜间死亡）。
   改法：模板加 `"execute":[座位号]`，落地处（agents.cjs:1002 附近）调用 `E.execute(id, i)` 并记入 lastExecuted。这样贞洁者、以及后续「白天直接死亡」的能力都有正路可走。

9. **public/app.js：贞洁者触发时前端要能跳过投票界面**
   现状：提名流程前端按 `nom.stage`（reason/defense/vote/clock/result）渲染。
   改法：当 `nomState()` 返回 `chaste`/`executedImmediately` 标记时，直接展示「X 号 提名了贞洁者，提名者被立刻处决」并跳到 result，不渲染举手按钮；否则会出现「人已经被处决，界面还在等投票」的错位。

10. **data/nightorder.json：本批 10 个角色已全部正确入表，无需改动**
    核对结果：first 段含 洗衣妇、图书管理员、调查员、厨师、共情者、占卜师（首夜限定，符合能力）；other 段含 共情者、占卜师、送葬者、僧侣、守鸦人（每夜/触发型，符合能力）；贞洁者两段都没有（它没有夜间行动，正确）。送葬者、僧侣、守鸦人未出现在 first 段，也与「每个夜晚*」排除首夜一致。**此文件保持原样即可。**

## 判定口径备注

- 本批全部为镇民，不涉及胜负判定（checkWin 只认 demon/minion），也没有角色改变阵营或角色本身，所以「阵营变化/角色变化」类冲突为 0。
- 所有角色都靠 `info / markers / deaths / say` 四个通道执行；本批的通道缺口集中在两点：**每夜重复提问被去重吞掉**（改动 1）与**白天没有直接处决通道**（改动 2、8）。
- `state.markers` 为自由文本数组（engine.cjs:47、287），「被保护」「贞洁者已触发」这类持续状态可以承载，但没有任何强制校验，属于「说书人自律」级别，因此僧侣判为「中」而非「无」。
