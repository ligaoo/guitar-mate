# MT3 对比评测(阶段 3 · 外部引擎链路)

目的:回答「换更强的预训练模型能买到多少召回」,**不需要任何训练**。
MT3(Google,Transformer 多乐器转录)在复音召回上公认强于 Basic Pitch。
这是 PLAN-90 阶段 3 的第一步:先拿 MT3 在《God knows》的真实数字(M3 里程碑),
再决定域适配往哪个方向投入。

## 一、GuitarSet 片段对比(干净独奏/伴奏)

```bash
# ① 本地:导出评测音频(单声道 16 位 WAV)
npm run eval -- --export-wav=../eval-export                     # 全部合成样例
npm run eval -- --real --variant=raw --export-wav=../eval-export # 真实样例(需本地 GuitarSet)

# ② Colab(GPU 运行时):上传 eval-export/,逐单元运行 transcribe_colab.py
#    第一次约 10 分钟装环境 + 下载 checkpoint,之后每个 22s 片段约 10-30s

# ③ mt3-out/ 下载回本地,评分(与内置引擎同表对比):
npm run eval -- --engine=ext --ext-dir=../mt3-out --variant=raw
npm run eval -- --engine=bp,ext --ext-dir=../mt3-out --variant=raw
```

## 二、整曲 vs 人工参考谱(《God knows》,M3 数字)

```bash
# ① Colab:把 D:/music/godknows-ref/godknows.wav(279s 混音)也放进 eval-export/,
#    与片段一起转写(整曲由 MT3 内部滑窗切分;输出带 program/is_drum 音色标记)

# ② 本地:整曲评分(5 指标 + 随机基线 + 分数级,与盲扒链路同口径可直接拼表):
npx esbuild scripts/ext-song-score.ts --bundle --format=cjs --platform=node --outfile=.es.cjs
node .es.cjs --json=../mt3-out/godknows.raw.json --ref-dir=D:/music/godknows-ref
# 产物 eval/ext-godknows-godknows.json;对比基线在 eval/ref-compare-godknows.json
#   (产品盲扒召回聚合提取 = 并集 F1 20.6%;阈值 oracle 上限 26%)
```

评分口径三行:全部输出(非鼓)/ 仅吉他音色(GM 24-30)/ 吉他+音域 40-86(与盲扒同音域)。
MT3 是全乐器模型,整曲混音会把贝斯/人声旋律也写出来——**先看「仅吉他音色+音域」行**
再与盲扒对比,但三行都保留在报告里(避免选择性引用)。

## 结果文件约定

`<clipId>.<variant>.json`:

```json
{ "model": "mt3",
  "notes": [{ "start": 0.52, "end": 0.94, "midi": 60, "program": 27,
              "is_drum": false, "confidence": 0.7 }] }
```

任何外部转录器(YourMT3+、微调后的 Basic Pitch、FretNet……)按此格式输出即可进同一套评测
(`runExtEngine` 忽略 program;整曲评分用它过滤乐器),这就是「换模型不用改评测」的接入口。

## 三、域适配(阶段 3.2,需要上面 MT3 数字先行)

训练数据已就绪:`npm run` scripts/build-corpus.ts 把数据工厂三元组 + GuitarSet 统一成
`eval/corpus-guitar.jsonl`(361 条 / 43,653 音 / 3.12h,弦/品级标注)。
EGDB-PG 的结论:音色多样性是决定性的(DI 干净音色训练 22.8% → 256 种音箱音色 ~79%)。
MT3 官方不支持训练(README 明说),微调要走 T5X + mt3/tasks.py 自建管线——
在 MT3 对比数字出来后再决定投入方向(也可能 Basic Pitch 微调性价比更高)。

## 注意

- MT3 输出**全部乐器**的音符;评测样例是纯吉他(GuitarSet 独奏录音),直接比对即可。
  混音样例上 MT3 会把贝斯/鼓以外的旋律乐器都写进来,精确率天然偏低——
  关注召回率与 F1 的相对比较,不是绝对值。
- MT3 是 16kHz 输入;脚本内已自动重采样。
- `transcribe_colab.py` 的 `InferenceModel` 类是官方 Colab 源码原样保留,
  上游更新时可对照 `mt3/colab/music_transcription_with_transformers.ipynb` 同步。
- 整曲 token 预算:MT3 每个内部滑窗(约 5.12s)输出上限 1024 token,
  极端密集混音段落可能被截断——这是模型行为,如实测量并记录。
