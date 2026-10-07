# 参考谱引导扒谱(REF 模式)

> 场景:这首歌网上已有**人工扒的参考谱**(Songsterr / Guitar Pro 等),用户要的是
> 「这版录音能用的、对的谱」,而不是从零盲扒。
>
> 首个案例:《God knows…》(平野綾)整曲混音,参考 [Songsterr tab 529836](https://www.songsterr.com/a/wsa/god-knows-tab-s529836)。
> 实现日期 2026-10-07。脚本:`scripts/parse-score.mjs`(谱面解析)、`scripts/ref-align.ts`(对齐)、
> `scripts/ref-guided.ts`(验证+产出)、`scripts/ref-compare.ts`(盲扒对照)。

## 为什么需要这个模式(实测依据)

同一首《God knows》,两条路线的实测(2026-10-07 修正口径:时基 bug 修复后 + 音高消歧对齐;
指标 = 音符级 F1,±50ms 起音 + 音高全等,n=参考谱音符数):

| 路线 | 主音+节奏并集参考(6911 音) | 主音单轨参考(1173 音) |
|---|---|---|
| 盲扒·现行预设(ot0.55/ft0.40) | F1 5.9%(P 42.2 / R 3.2) | F1 10.3%(P 16.6 / R 7.4) |
| 盲扒·召回优先(ot0.35/ft0.30) | F1 14.8%(P 37.5 / R 9.2) | — |
| **REF 模式**(参考谱+对齐+音频验证) | 谱面=参考谱本身,见下方验证率 | **主音 91.4%** 音频验证 |

盲扒的低一致度不是实现 bug:时基修复后依然是这个量级——重度失真+人声+密集鼓的混音
超出 Basic Pitch 的能力范围(模型墙,ACCURACY.md 的 oracle 实验同结论)。
**有参考谱时,瓶颈从"识别"变成"对齐+验证",而这个我们能做到毫秒级。**

> ⚠ 历史口径警示:本文档 2026-10-07 之前的版本写"盲扒 ~5% / REF 验证 84.3%"——当时存在
> 两个测量 bug(帧率时基 86→86.58、对齐差一拍),数字已全部按修正后口径重写。引用时以本表为准。

## 流程(三步,推理只做一次;或一条命令)

**一键(推荐,数据工厂)**:`scripts/ref-pipeline.ts` 把三步合成一条命令,并额外产出
阶段 4 的训练资产(三元组 + 一致性摘要):

```powershell
npx esbuild scripts/ref-pipeline.ts --bundle --format=cjs --platform=node --outfile=.rp.cjs
node .rp.cjs --audio=song.wav --lead=track0.json --rhythm=track1.json `
  --out-dir="<输出目录>" --name="歌名"
```

**分步(调试用,与一键共用核心 `scripts/ref-core.ts`,数值口径一致)**:

```
参考谱(Songsterr JSON / Guitar Pro)
  → ① 解析 parse-songsterr.ts(或库外 parse-score.mjs):measures/beats → 音符事件(处理连音线/三连音/速度)
  → ② 对齐 ref-align.ts:起音网格搜 (offset,scale) + 稳健回归
       → 音高消歧(--frames):起音分辨不出整拍平移,用 BP 音高激活在 ±3 拍候选中裁决
       《God knows》:offset 0.610s(修正前 1.010,差一拍)· scale 1.0000 · 残差中位 −1ms / P90 13ms
  → ③ 验证+产出 ref-guided.ts:整曲推理一次(帧矩阵落盘缓存)→ 逐音符双证据
       (DSP 起音 ±60ms + BP 音高激活;失真吉他加八度泛音证据分支)
       → 曲库 JSON(主音+节奏两首)+ 逐音符判定 + 逐小节弱证据地图
```

对齐为什么这么准:参考谱时间本身就是拍点的整数倍(150 BPM),录音与谱面同速,
仿射映射后残差自然收敛到 ±15ms——远小于评测口径的 ±50ms。

## 使用

```powershell
# ① 解析谱面(Songsterr 播放器加载的 <hash>.json,gzip 解压后)
node godknows-ref/parse-score.mjs track0.json lead-events.json

# ② 对齐(参考谱时间 → 录音时间)
npx esbuild scripts/ref-align.ts --bundle --format=cjs --platform=node --outfile=.ra.cjs
node .ra.cjs --audio=song.wav --events=lead-events.json [--rhythm=...] --out=align.json

# ③ 验证 + 产出曲库(首次推理 ~10 分钟,之后走帧缓存秒级)
npx esbuild scripts/ref-guided.ts --bundle --format=cjs --platform=node --outfile=.rg.cjs
node .rg.cjs --audio=song.wav --lead=lead-events.json --rhythm=rhythm-events.json --align=align.json `
  --out-dir="<输出目录>" --name="歌名"

# ④(可选)盲扒 vs 参考谱对照
npx esbuild scripts/ref-compare.ts --bundle --format=cjs --platform=node --outfile=.rc.cjs
node .rc.cjs --ref-dir=... --cache-dir=... --preset=mix
```

产物 `<out-dir>/`:
| 文件 | 说明 |
|---|---|
| `<歌名>.ref.library.json` | 页面「📂 导入曲库」即用(含置信分级与 `source:'ref'` 标记,曲库列表显示 📖) |
| `ref-report.md` | 验证报告 + **弱证据小节地图**(建议人工复核处) |
| `verify-{lead,rhythm}.json` | 逐音符判定(时间/音高/证据类型/起音) |
| `align.json` | 对齐结果(offset/scale/音高消歧) |
| `frame-cache.*` | 帧矩阵缓存(避免重复推理) |
| `<歌名>.triple.json` | **数据工厂(阶段 4)**:音频时间轴上的音符级标注(逐音 conf/verdict)——微调/弱监督的训练样本 |
| `dataset.json` | 一致性摘要(强验证/验证占比),批量收集 ≥50 首时的质量门槛 |

## 数据工厂(PLAN-90 阶段 4)

行业缺的正是「真实录音(含人声+鼓+失真吉他)的音符级标注」。每个**有谱的歌**都能用
`ref-pipeline` 产出一个「对齐音频 + 人工谱 + 逐音验证」三元组——这是唯一能突破
盲扒 50–55% 证据上限的路径(把参考谱知识蒸馏进模型),而我们有现成资产:
每首歌一条命令,一致性门槛用 `dataset.json` 的 `verifiedShare`(《God knows》:主音 0.914 / 节奏 0.819)。

## 诚实口径(重要)

- 「音频验证率」(主音 91.4% / 节奏 81.9%,修正口径)= **至少**这么多的音在录音里找到了音高证据;弱证据 ≠ 错,
  重度失真混音里被掩蔽是常态(本曲 0 个音完全无证据)。谱面正确性来自人工参考谱,
  我们保证的是:与**这版录音**时间对齐(±13ms)+ 逐音符证据分级 + 该复核哪几小节。
- conf 分级:强验证 0.95 / 基本 0.8 / 泛音验证 0.75 / 弱 0.55 / 无 0.3 —— 页面里
  低置信音即"值得人工看一眼"的音。
- REF 模式与盲扒(`npm run auto`)互补:无参考谱的歌仍走 auto;两者共用同一套
  评测口径与曲库格式。
