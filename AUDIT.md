# GuitarMate 代码审计报告

> 审计对象:`D:\music\guitar-mate`(React 18 + TS + Vite,约 30 个源文件)
> 审计方式:全量源码精读 + 类型检查(`tsc --noEmit` 通过)+ 运行项目自带测试 + 编写临时探针脚本对可疑路径做**可复现实验**(探针已删除)
> 结论摘要:工程结构清晰、算法覆盖完整、自测可跑通;但存在 **8 处会导致错误结果的逻辑缺陷**(其中 2 处必现功能性错误),若干普通 bug,以及一批可显著提升手感与识别精度的优化点。

---

## 0. 基线验证(实测)

| 项目 | 命令 | 结果 |
|------|------|------|
| 类型检查 | `tsc --noEmit` | ✅ 0 错误 |
| 算法自测 | `node scripts/run-tests.mjs` | ✅ 全部通过(和弦 16 指法/5ms、反查、指法、MIDI、扒谱 4 音、音色) |
| Basic Pitch 验证 | `node scripts/test-bp.mjs` | ⚠️ 可运行,但**识别精度明显不足**(见 §4.1) |

---

## 1. 逻辑 Bug(会导致错误结果,按严重度排序)

### L1 ★★★ 指法缓存 key 漏掉 `limit`,后续调用拿到被截断的旧结果(已复现)

[chords.ts:58](guitar-mate/src/theory/chords.ts#L58)
```ts
const key = `${mod12(rootPc)}|${intervals.join(',')}|${tuning.join(',')}|${maxFret}`
```
缓存 key 不含 `opts.limit`,而结果数组在**首次**调用时就被 `limit` 截断后存入缓存。

复现:
```
generateVoicings(0,[0,4,7],STANDARD,{maxFret:12,limit:12}) → 12  ✓
generateVoicings(0,[0,4,7],STANDARD,{maxFret:12,limit:16}) → 12  ✗(期望 16)
```
影响:任何先以较小 `limit` 请求过的和弦,之后请求更多指法都会被静默截断。页面文案「共 N 个指法」与「只看收藏」会因此对不上。
修复:key 加入 `limit`,或缓存**未截断**的全量结果、返回时再 `slice(0, limit)`。

---

### L2 ★★★ 反查和弦:纯子集被判定为「精确匹配」

[chords.ts:243-248](guitar-mate/src/theory/chords.ts#L243-L248)
```ts
let subset = true
pcs.forEach((p) => { if (!chordPcs.has(p)) subset = false })
if (subset) out.push({ rootPc, type, exact: true })
```
`exact` 只要求「我按的音都在该和弦内」,不要求「该和弦的音都按齐了」。三和弦在无三音时无法区分大小调,五音常常可省略——这是和声学常识,但代码把这类情况标成确定答案。

复现:`reverseLookup([-1,3,2,0,-1,-1], STANDARD)`(只按 C+E,无 G)→ 首条结果 `C`,**不带「近似」标记**。
正确语义应为:
- 三和弦:必须含根音 + 三音(五音可省)才算 exact;
- 七和弦:必须含三音 + 七音;
- 否则标记为「近似」并给出置信度排序。

---

### L3 ★★★ 音质/旋律兜底分段对「揉弦、滑音、连续音」过度切分,可能**整段丢音**

[pipeline.ts:232-258](guitar-mate/src/transcription/pipeline.ts#L232-L258)
```ts
const m = Math.round(69 + 12 * Math.log2(f0[f] / 440))
if (m === curMidi) segEnd = t
else { flush(); curMidi = m; segStart = t; segEnd = t }
```
判据是**取整后的 MIDI 严格相等**,而 `flush()` 又要求段长 ≥ 0.12s。真实演奏中揉弦 ±0.5 半音很常见,取整值会在两个半音间来回跳跃 → 每段都被切碎 → 全部短于 0.12s → **返回 0 个音符**。

复现(单持续音 + 合成揉弦):
```
揉弦 ±0.2 / 0.35 / 0.45 半音 → 1 个音符  ✓
揉弦 ±0.6 半音            → 0 个音符  ✗ 整段丢失
揉弦 ±0.8 半音            → 0 个音符  ✗
```
修复:改用「与段内中位数偏差 ≤ 0.x 半音」或滑动中值滤波后再分段;短段不要直接丢弃,而是并入相邻段或延长到最小音值。

---

### L4 ★★ BPM 估计:折叠边界 off-by-one + 八度选择缺失,输出系统性偏离

[pipeline.ts:262-285](guitar-mate/src/transcription/pipeline.ts#L262-L285)
```ts
while (x < 0.35) x *= 2
while (x > 0.9) x /= 2      // 0.9 恰好落回 0.45
...
const period = (best + 0.5) * 0.02   // 桶中心偏移修正不足
return { bpm: Math.round(60 / period) }
```
两个问题:
1. 折叠上界用 `>` 而非 `>=`(或先归一化),`x = 0.9` 会被再除以 2 → 拍长减半 → BPM 翻倍。
2. 折叠完成后没有做「八度仲裁」(用拍点强度、常见 BPM 先验、2/3/4 倍关系打分),导致结果常在真实值的 1/2 或 2 倍附近。

实测矩阵(统一 IOI,真实 BPM → 估计 BPM):
```
0.3s(200) → 98  ✗      0.75s(80) → 80  ✓
0.4s(150) → 146 ✗      0.85s(71) → 71  ✓
0.5s(120) → 118 ✗      0.9s (67) → 67  ✓
0.6s(100) → 98  ✗      1.0s (60) → 118 ✗
0.8s (75) → 74  ✗      1.2s (50) → 98  ✗
```
项目自测只覆盖了 109 BPM(恰好在可用区间),所以没暴露。
修复:折叠用 `[0.4, 0.8)` 半开区间避免边界回环;叠加 60–180 BPM 先验与「拍点重合度」评分做八度仲裁;桶中心改为按桶内样本均值。

---

### L5 ★★ `assignFingering` 静默丢弃不可弹音符,用户无法感知

[fingering.ts:26](guitar-mate/src/transcription/fingering.ts#L26)
```ts
const playable = notes.filter((n) => positionsForMidi(n.midi, tuning, maxFret).length > 0)
```
超出指板范围的音被直接过滤,返回值里也没有任何「被丢弃」的信息,页面只显示「识别到 N 个音符」与实际谱面数量不一致。

复现:输入 3 个音(含一个 MIDI 30)→ 输出 2 个音,无任何提示。
修复:返回 `{ notes, dropped: number[], droppedReasons }`,UI 用黄色角标提示「有 N 个音超出指板范围(可调高最高品或换调弦)」。

---

### L6 ★★ 量化偏移只能单向移动(负步被 clamp,无法修正「晚于拍点」的检测)

[TranscribePage.tsx:201-202](guitar-mate/src/pages/TranscribePage.tsx#L201-L202)
```ts
let step = Math.round((n.start - anchor) / gridSec)
if (step < 0) step = 0          // ← 负数被吃掉
```
锚点取第一个起音,起音检测通常**滞后数十毫秒**。要往左对齐就得让 `step` 变负,但负值被强制归零 → 那部分音会全部塌到 step 0,之后无论怎么点 ◀ 都无效(只有「右移」方向有效)。

修复:不要 clamp,保留负 step;把整谱平移放到渲染/导出层统一处理(允许负偏移后整体归一化),或允许 anchor 比首音更早。

---

### L7 ★★ DSP 分割对复音输入必然给错误结果(而非「识别不出」)

[pipeline.ts:187-229](guitar-mate/src/transcription/pipeline.ts#L187-L229)
每个起音区间只取**单个**中位数音高并输出一个音符。同时发声的和弦会被报成一个既不属于根音也不属于三音的音(中位数),且 `conf >= 0.5` 的门槛并不能拦截这种情况。

实测:合成 C 大三和弦单次扫弦 → **0 音符**(YIN 在复音下 `prob = 0` 被全帧过滤)、但原始起音 18 个;BPM 退化为默认 90。
建议:在 DSP 路径加「复音检测」(谱峰数 / 平坦度 / 谐波一致性),只要判定为复音就**明确提示切换到 Basic Pitch**,而不是返回空结果 + 泛化错误文案(现文案见 [TranscribePage.tsx:174](guitar-mate/src/pages/TranscribePage.tsx#L174))。

---

### L8 ★ `reverseLookup` 的 exact/近似排序在同权重下顺序不稳定

[chords.ts:251](guitar-mate/src/theory/chords.ts#L251) 的 `sort` 只比较 `exact`,返回 0 时依赖引擎稳定性,且未按「含根音/三音」等音乐性权重排序,导致同分候选顺序随机、结果可重复性差。建议补充明确权重(含根音 > 含三音 > 音数多 > 低把位)。

---

## 2. 普通 Bug

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| B1 | [pipeline.ts:24-29](guitar-mate/src/transcription/pipeline.ts#L24-L29)、[pipeline.ts:45-52](guitar-mate/src/transcription/pipeline.ts#L45-L52) | `toMono` 单声道时**直接返回入参**;`normalize` 原地改写入参 | 调用方数组被就地放大 0.95/peak。当前因 `AudioBuffer.getChannelData` 每次返回副本而侥幸无害,属埋雷式副作用 |
| B2 | [pipeline.ts:171](guitar-mate/src/transcription/pipeline.ts#L171)、[TonePage](guitar-mate/src/pages/TonePage.tsx#L48)、[recorder.ts:18](guitar-mate/src/audio/recorder.ts#L18) | `rec.analyser!` 非空断言;YIN 每秒分配约 100 个 `Float32Array`(约 3MB/s 垃圾),逐帧分析是浏览器掉帧主因 | 移动端卡顿 |
| B3 | [pipeline.ts:144](guitar-mate/src/transcription/pipeline.ts#L144) | 起音阈值 `mean*1.5 + 0.02` 中的常量与 FFT 幅度量纲强耦合;`stftMags` 未做窗/幅度归一化 | 换采样率或换归一化策略即失效,阈值不可移植 |
| B4 | [TonePage.tsx:258-260](guitar-mate/src/pages/TonePage.tsx#L258-L260) | 瀑布图 `ctx.drawImage(canvas,-1,0)` 未关闭 `imageSmoothingEnabled` | 长按运行逐帧高斯化,图像越来越模糊 |
| B5 | [TranscribePage.tsx:121-128](guitar-mate/src/pages/TranscribePage.tsx#L121-L128) | 「试听原音频」每次点击都新建 `BufferSource`,旧的不停;且直连 `destination` | 多次点击声音叠加、无法停止,还绕过主音量/限幅器(音量滑杆对它无效),也不受组件卸载清理 |
| B6 | [TranscribePage.tsx:218-221](guitar-mate/src/pages/TranscribePage.tsx#L218-L221) | 重建 effect 依赖含 `bpm/offset/minConf/maxFret/tuningId` | 拖动任一滑杆即**丢弃全部手工编辑**(移弦/改时值/插入的音),无二次确认、无撤销 |
| B7 | [stats.ts:33](guitar-mate/src/stores/stats.ts#L33)、[EarTrainingPage.tsx:86](guitar-mate/src/pages/EarTrainingPage.tsx#L86) | `new Date().toISOString().slice(0,10)` 取的是 **UTC 日期** | 中国时区(UTC+8)凌晨 0–8 点练的题记到「昨天」,打卡与连续天数错位 |
| B8 | [ear/engine.ts:192-202](guitar-mate/src/ear/engine.ts#L192-L202) | L1/L2 跳过奇数格且目标数 = `slots/2 + level - 1` 可能超过可用格数(8 格 → 目标 5,可用 4) | `while` 空转到 `guardMax = slots*4` 才退出;节奏形态被限制、生成耗时不确定 |
| B9 | [ChordsPage.tsx:57](guitar-mate/src/pages/ChordsPage.tsx#L57) | `capoName = mod12(root + capo)` | 夹 N 品应高 N 个**半音**;`+capo` 只是把根音移了 capo 个半音,恰好等价纯属巧合,条件一改(如按度数换算)就错 |
| B10 | [chords.ts:165-168](guitar-mate/src/theory/chords.ts#L165-L168) | 手指数把「最低品跨多弦」记为 1 指横按,但未校验被横按的中间弦是否真的同时按在同一品 | 个别情况下会生成手指数被低估、实际按不出的指法 |
| B11 | [ChordDiagram.tsx:34-35](guitar-mate/src/components/ChordDiagram.tsx#L34-L35) | 弦线按硬编码 6 弦画,`stringGap` 也按 6 弦算 | 一旦支持尤克里里(4 弦)/贝斯,图形即错位 |
| B12 | [exporters.ts:69](guitar-mate/src/transcription/exporters.ts#L69) | `tabToMidi` 未做 `bpm > 0` 防护(内部有 clamp,导出路径无) | 异常 bpm 会产生非法 MPQ/负 delta-time |
| B13 | [basicPitch.ts:19-31](guitar-mate/src/transcription/basicPitch.ts#L19-L31) | 失败重试只挂在**模型加载**阶段 | 模型加载成功但推理抛错后无法恢复(需要整页刷新) |
| B14 | [public/sw.js:2](guitar-mate/public/sw.js#L2) | 缓存名硬编码 `guitarmate-v1`,`CORE` 全为绝对路径 | 改了前端代码,老用户长期命中旧缓存(见 §3.1);部署到子路径时预缓存全部 404 |
| B15 | [TunerPage.tsx:53-58](guitar-mate/src/pages/TunerPage.tsx#L53-L58) | 最近弦搜索无「距离上限」 | 某弦偏差 >±300 音分时,指针会被吸附到**另一根弦**并显示「已准」,误导调弦 |
| B16 | [TranscribePage.tsx:345](guitar-mate/src/pages/TranscribePage.tsx#L345) | `endTime = t0 + totalSteps*stepDur` 未含最后一个音自身时值 | 全音符等长音的尾部被 `stop()` 掐掉 |
| B17 | [EarTrainingPage.tsx:25-28](guitar-mate/src/pages/EarTrainingPage.tsx#L25-L28)、[TonePage.tsx:71-82](guitar-mate/src/pages/TonePage.tsx#L71-L82) | 自动播放 `setTimeout` / 录音 `setTimeout` 未纳入清理 | 切题型/切页后仍会触发旧的回放或完成录音并 `setState` |
| B18 | [TranscribePage.tsx:263-272](guitar-mate/src/pages/TranscribePage.tsx#L263-L272) | 插入笔只给固定 9 个品 | 无法插入第 6/8/10/11… 品的音,也无升降品微调 |
| B19 | [TunerPage.tsx:39](guitar-mate/src/pages/TunerPage.tsx#L39) | `useEffect(() => () => stop(), [])` 依赖不完整 | 当前行为正确(靠 ref),但 ESLint 会报错,且未来若给 `stop` 加状态依赖会静默失效 |

---

## 3. 使用体验优化

### 3.1 PWA 更新链路断掉(优先级最高)
`sw.js` **缓存优先 + 永不失效** + 硬编码 `guitarmate-v1`:发布新版本后老用户可能一直跑旧代码。
建议:构建时把内容哈希注入缓存名(或改用 `vite-plugin-pwa` + `workbox`);HTML 走 network-first,带哈希的静态资源走 cache-first。

### 3.2 编辑与重算解耦(B6 的正解)
参数滑杆与编辑结果分离:参数变化只标记「谱面已过期」,由用户点「重新生成」;或保留 `undo` 栈 + 变更前确认。

### 3.3 指法排序更「像老师给的谱」
实测排序前四名:
```
0,3,2,0,1,0 (20.50) | 0,3,2,0,5,0 (19.77) | 0,3,5,0,0,? … 
```
标准开放把位 C(x32010) 只排到第 5,排在前面的都是「多加空弦音」的变体。建议:
- 提高「根音在低音弦」权重,并对「非根音低音」倒扣;
- 惩罚高音区空弦堆叠(可用音域中心作为惩罚项);
- 每个和弦置顶 1–2 个**教科书指法**(可内置一张小表覆盖 C/G/D/Am/E 等常用和弦)。

### 3.4 和弦查询体验
- 和弦类型建议按 `basic/color/jazz` 分组(`ChordType.group` 字段已存在但未使用);
- 增加变调夹下的「实际音名」显示(`showNotes` 已实现,可在开启变调夹时默认打开);
- 反查页支持滑过品位时实时播放试听,以及「清空/撤销/常见指法模板」。

### 3.5 音频工程
- 试听原音频改用统一的 `playBuffer()`(受主音量与限幅器控制、可停止、可 A/B 循环);
- 「片段选择 + 循环对比」(PLAN P2-A 已规划但未实现)对扒谱核对帮助最大;
- 频谱/声谱图给 60Hz/120Hz 工频与 50Hz 标注,便于排查环境噪声。

### 3.6 其他
- 练耳答题节奏:答题后立即「揭晓 + 延迟进入下一题」,当前 `finish` 的 1.1s/2s 会打断用户在听最后一个音;
- 键盘快捷键需在输入框聚焦时禁用(数字/空格会误触发作答);
- 曲库保存用 `window.prompt`,移动端体验差且无法输入元信息,建议改为内联表单 + 覆盖/另存为;
- 调音器增加「自动/手动选弦」与参考音 A4=440/442 切换。

---

## 4. 准确性与识别精度提升

### 4.1 Basic Pitch 参数与后处理(实测数据)

Node 端用 Karplus-Strong 合成 8 音上行音阶(C 大调 64→76),同一模型不同阈值:

| onset / frame | 识别结果 | 判定 |
|---|---|---|
| **0.5 / 0.3(应用当前默认)** | `64@0.00` `64@1.00` `76@3.01` —— **漏掉 4 个音,并把 68/69/71/73 报成 64/76** | ✗ 不可用 |
| 0.35 / 0.2 | `64@0.00` `66@0.50` `64@1.00` `76@3.01` | ✗ 音高错 |
| 0.25 / 0.12 | 11 个音,含 `30@3.15` `45@2.83` `52@3.34` 等低频伪音 | ✗ 噪声 |

结论与建议:
1. **默认阈值偏低**(0.5/0.3)是精度陷阱,建议默认 0.35/0.2 起,并在 UI 同时暴露 `frameThresh`(现固定 0.3,见 [basicPitch.ts:61-71](guitar-mate/src/transcription/basicPitch.ts#L61-L71));
2. `outputToNotesPoly(..., minNoteLen = 60 帧 ≈ 0.7s)` 对快句太苛刻,建议按 BPM 换算(如 1/8 音符时长)后传入;
3. 低阈值产生的 **MIDI 30/45/52 伪音**说明需要「按调弦音域过滤」:吉他标准调弦实际音域 E2(40)–E6(88),现有 `filter(midi>=40 && <=88)` 已在 [basicPitch.ts:81](guitar-mate/src/transcription/basicPitch.ts#L81) 做了,但 `minNoteLen` 降低后仍会出现 30——说明过滤发生在 `outputToNotesPoly` **之后**,伪音应改在输出前按 pitch 先验抑制(或在 `outputToNotesPoly` 内部参数上调);
4. 把 `minConf` 的语义讲清楚:Basic Pitch 的 `amplitude` 是**音高轮廓幅度**(≈响度),不是「识别可信度」;用它当置信度滑杆会让弱奏的音被整体删掉(见 §1.5 附近 UI 文案 [TranscribePage.tsx:442](guitar-mate/src/pages/TranscribePage.tsx#L442))。建议改成「音量过滤」并另设「起音阈值/最短音长」两档。

### 4.2 合成器物理模型(直接影响练耳与扒谱自测)
[synth.ts:35](guitar-mate/src/audio/synth.ts#L35)
```ts
delay[idx] = damping * 0.5 * (cur + nxt)     // 一阶低通,衰减与频率无关
```
真实弦的衰减随频率升高而**加快**(高频耗散更大),建议加一阶/二阶低通使 `damping` 随弦长变化;另可在激励中引入拨片位置(梳状滤波)与「张力导致的音分偏移」(低音弦实际偏高数音分)。这会让练耳音色更接近吉他,也让 Basic Pitch 的自测数据更有参考价值。

### 4.3 扒谱算法精度
1. **起音检测**:建议做二次差分(脊线)或改用相位偏差(phase deviation)提升弱起准确率;当前只在能量突变时可靠。
2. **帧率/分辨率**:YIN 帧长 1536、hop 256(约 11.6ms),对 16 分音符(120BPM ≈ 125ms)足够;但**低频弦**(E2 82Hz)需 ≥2 个周期,建议低音区用更长窗或用插值+谐波校正(YIN 的 `dp[tauEst]` 与谐波一致性联合判分)。
3. **量化**:应把「音符起止」吸附到**最近的节拍网格**而非四舍五入到固定 16 分(现有 `SNAP_DURS` 已做时值吸附,但起点量化未考虑切分点/三连音);建议加 swing/三连音检测。
4. **指法 DP**:应增加
   - **同弦冲突约束**(同弦上时间重叠的音必须换弦或换把);
   - **把位连续性**(当前 `transitionCost` 只看相邻两个音,缺少把位中心状态);
   - **跨弦手型代价**(相邻弦跨度 >2 品的拉伸惩罚);
   - 返回被丢弃音符的报告(见 L5)。
   加入这些后,「一键出可弹 Tab」的比例会明显上升。
5. **音色分析**:[analysis.ts:97-104](guitar-mate/src/audio/analysis.ts#L97-L104) 的 `harmonicAmplitude` 用 `±0.08*bin` 搜索窗,高次谐波(如 H8)窗会跨越相邻谐波,建议窗口收窄到 `< 0.5 * f0` 并做抛物线插值;`attackMs` 的 10% 起点应从「峰值向前扫描底噪阈值」改成「相对底噪(noise floor)的 10%」,当前在带底噪录音里偏大(实测 4ms → 8.7ms,底噪更大时会明显膨胀)。
6. **回归测试**:`test-sanity.ts` 只用了 109BPM、单音、干净正弦的项目友好用例。建议加「黄金样例」集:揉弦、滑音、切分、三连音、弱起、扫弦、6/8 拍,并把 BPM 矩阵(见 L4)纳入断言。

### 4.4 内存与性能
- Worker 通信对整段通道做 `slice()` + transfer,长音频(10 分钟立体声)会有约 100MB 级瞬时拷贝;建议分块流式发送或直接传 `AudioBuffer` 的副本引用;
- `voicingCache` / `bufferCache` 均无容量上限(前者按和弦累积),长时间使用建议加 LRU 上限;
- `generateVoicings` 单和弦约 5ms,点击 12 类型浏览时会有可感知延迟,可放进 `requestIdleCallback` 预热常用和弦。

---

## 5. 建议的修复顺序

| 优先级 | 项 | 理由 |
|---|---|---|
| P0 | L1 缓存 key、L2 反查 exact、B7 UTC 日期、3.1 SW 更新 | 必现错误 / 影响所有用户的数据正确性 |
| P1 | L3 揉弦丢音、L6 量化偏移单向、L5 丢音上报、B6 编辑被重置 | 直接影响核心功能可用性 |
| P2 | L4 BPM 八度仲裁、4.1 Basic Pitch 阈值与默认值、4.2 合成器模型 | 直接提升识别精度 |
| P3 | L7 复音前置检测与提示、B5/B16 播放链路、4.3 指法 DP 增强 | 体验与专业度 |
| P4 | 其余普通 bug 与体验项 | 打磨 |

---

## 附:复现脚本

审计中使用的探针脚本(已删除)覆盖:缓存 key 冲突、反查子集误判、揉弦分段丢失、BPM 折叠矩阵、复音输入表现、指法丢音。如需回归,建议把其中的断言直接并入 `test-sanity.ts`。
