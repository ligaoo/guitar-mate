# MT3 对比评测(外部引擎链路)

目的:回答「换更强的预训练模型能买到多少召回」,**不需要任何训练**。
MT3(Google,Transformer 多乐器转录)在复音召回上公认强于 Basic Pitch。

## 流程

```bash
# ① 本地:导出评测音频(合成样例和/或真实样例的原始混音,单声道 16 位 WAV)
npm run eval -- --export-wav=../eval-export                     # 全部合成样例
npm run eval -- --real --clip=gs-xxx --variant=raw --export-wav=../eval-export   # 指定样例

# ② Colab:上传 eval-export/ 目录,逐单元运行 transcribe_colab.py
#    (GPU 运行时;第一次约 10 分钟装环境 + 下载 checkpoint,之后每个 22s 片段约 10-30s)

# ③ 把 mt3-out/ 下载回本地任意目录(如 ../mt3-out),评分:
npm run eval -- --engine=ext --ext-dir=../mt3-out --variant=raw
# 与内置引擎同表对比:
npm run eval -- --engine=bp,ext --ext-dir=../mt3-out --variant=raw
```

## 结果文件约定

`<clipId>.<variant>.json`:

```json
{ "notes": [{ "start": 0.52, "end": 0.94, "midi": 60, "confidence": 0.7 }], "bpm": 120 }
```

任何外部转录器(微调后的 Basic Pitch、FretNet……)按此格式输出即可进同一套评测,
这就是「换模型不用改评测」的接入口。

## 注意

- MT3 输出**全部乐器**的音符;评测样例是纯吉他(GuitarSet 独奏录音),直接比对即可。
  混音样例上 MT3 会把贝斯/鼓以外的旋律乐器都写进来,精确率天然偏低——
  关注召回率与 F1 的相对比较,不是绝对值。
- MT3 是 16kHz 输入;脚本内已自动重采样。
- `transcribe_colab.py` 的 `InferenceModel` 类是官方 Colab 源码原样保留,
  上游更新时可对照 `mt3/colab/music_transcription_with_transformers.ipynb` 同步。
