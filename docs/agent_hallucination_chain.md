# Agent Force-Submit 幻觉链路分析

> 测试 fixture: `golden_pytest-dev_pytest_pr8513`  
> 运行时间: 2026-05-08  
> 分支: `fix/fallback-plan-blocks-force-submit`（已应用修复 #3 + FINALIZE_REVIEW_NOTICE 强化）

---

## 一、整体流程（3 轮分析，逐轮拆解）

```
prepare ──► Iteration 0 ──► Iteration 1 ──► Force-submit ──► placeholder 结束
             (成功)          (失败!)         (幻觉!)
```

---

## 二、Iteration 0：模型请求工具，工具返回空内容

### 发生了什么

1. 系统组装了 system prompt + user message（包含 diff 片段、文件内容），发给 deepseek-v4-pro
2. 模型看了 diff，决定先读两个文件：`python_api.py` 和 `approx.py`
3. 模型返回：`finish_reason: "tool_calls"`，请求了 2 个 `read_file`，耗费 4315 tokens，耗时 10.7 秒

### 工具执行结果

```
read_file(python_api.py, offset=250, limit=60)  → content=""  (空!)
read_file(approx.py,   offset=260, limit=60)  → content=""  (空!)
```

**为什么是空的？** diff 的原始行号（如 offset=250）对应的是仓库中完整文件的行号。但 fixture 只保存了 diff 片段，片段文件只有几行（从第 1 行开始），`read_file` 从 offset=250 读当然读不到任何内容。这个行号问题用户已确认最新版本已修复。

### 第一轮结束

- 模型没有产出 draft_review（没调用 submit_review）
- 系统用 "Review pipeline completed with placeholder summary." 占位
- `should_continue()` 判断：工具已执行过，模型应该看到结果后再判断 → 决策：**继续**

---

## 三、Iteration 1：模型调用失败（核心 bug）

### 发生了什么

系统将第一轮的工具结果打包成消息，追加到对话历史后面，发起第二次 API 调用：

```
消息列表：
  [0] system:  "You are a code reviewer..."
  [1] user:    "{diff, files, project_structure...}"
  [2] assistant: {tool_calls: [read_file(id=?, ...), read_file(id=?, ...)]}  ← 模型第一轮的回复
  [3] tool:    {tool_call_id=?, content: "[iter=0] {ok:true, content:\"\"}"}  ← 工具结果1
  [4] tool:    {tool_call_id=?, content: "[iter=0] {ok:true, content:\"\"}"}  ← 工具结果2
```

### API 返回了什么

```
elapsed_ms: 448ms    ← 极快！说明 API 收到请求后立即拒绝，没有做推理
tokens: 0            ← 零 token 消耗，确认请求被拒绝
error: "Model provider returned a non-retriable status"
```

448 毫秒 + 零 token = 典型的 **HTTP 400 Bad Request**。API 在请求验证阶段就拒绝了。

### 推测根因

最可能的原因是消息 [3] 和 [4] 的 `tool_call_id` 字段缺失。

代码链路：

1. `_build_tool_feedback_messages()` 构建 tool 消息时需要从原始 tool_call 中取 `id`：
   ```python
   # inference_engine.py:369
   tool_call_id = str(raw_tool_call.get("id", "")).strip()
   ```

2. `_serialize_messages()` 序列化时因为空字符串是 falsy 值，会跳过该字段：
   ```python
   # client.py:164
   if message.tool_call_id:        # "" 为 False → 跳过！
       item["tool_call_id"] = message.tool_call_id
   ```

3. 结果：发往 API 的 JSON 中，`role: "tool"` 的消息缺少 `tool_call_id` 字段 → API 返回 400

（注意：这只是基于代码分析的推断，还没有通过日志确认实际的 HTTP status code）

### 第二轮结束

- API 调用失败 → 触发 `_fallback_plan()`（修复后返回 `draft_review=None`）
- `should_continue()` 判断：没有待执行工具，没有阻塞错误 → 决策：**停止**（model_completed）
- 循环退出，进入 `_maybe_force_submit_review()`

---

## 四、Force-Submit：兜底调用成功，但模型产生幻觉

### 触发条件（修复 #3 之后）

修复前，`_fallback_plan()` 返回一个假的 `draft_review`，导致 `_maybe_force_submit_review()` 看到 `plan.draft_review is not None` 就直接 return，不会发起兜底调用。

修复后，`draft_review=None`，兜底逻辑正常触发。

### 兜底调用的特殊配置

```
force_submit = True
tool_schemas = [submit_review]     ← 只有这一个工具！没有 read_file、list_dir 等
额外消息: FINALIZE_REVIEW_NOTICE   ← "不要输出推理文本，直接调 submit_review"
```

### 模型的实际行为（幻觉！）

```
API 调用: 成功
耗时:     100.4 秒
tokens:   7324 (completion: 3805)
finish_reason: "tool_calls"       ← 模型主动请求工具调用
tool_calls: [
    read_file(python_api.py, offset=1, limit=100),   ← 幻觉！
    read_file(approx.py,   offset=1, limit=100),   ← 幻觉！
]
submit_review_seen: false          ← 没有调 submit_review
```

### 为什么这是"幻觉"

当前对话中可用的工具只有 `submit_review`。`read_file` 在前一轮（iteration 0）可用，但 force-submit 阶段已经从 tool_schemas 中移除了。

模型的行为模式是：看到对话历史里有 `read_file` 的调用记录 → 顺着这个模式继续请求读文件 → 完全忽略了 FINALIZE_REVIEW_NOTICE 的指令。

**对比**：同一个模型在 `astral-sh_ruff_pr24648` 的 force-submit 中正确调用了 `submit_review`。区别在于那个 fixture 的 iteration 0 没有请求工具（直接文本输出），所以对话历史里没有"工具调用"的先例，模型没有可模仿的模式。

### 兜底调用结束

- 模型请求了 `read_file`，但 force-submit 不执行工具（直接走 format）
- `plan.needs_tools=True` 但被忽略
- `plan.draft_review=None` → ResultProcessor 生成占位 summary
- 最终结果：`submit_review_seen: false`，`matched_count: 0`

---

## 五、总结

```
                    Iteration 0          Iteration 1         Force-submit
                    ──────────          ──────────         ────────────
模型 API 调用:       ✅ 成功              ❌ 400 Bad Request   ✅ 成功
工具执行:            ✅ 执行但返回空       -                    ⚠️ 不执行
模型输出:            read_file 请求       (无)                 read_file 幻觉请求
submit_review:      ❌ 未调用             -                    ❌ 未调用
```

### 三个待修复问题

| # | 问题 | 严重程度 | 状态 |
|---|------|---------|------|
| 1 | Iteration 1 API 返回 400（推测 tool_call_id 缺失） | **核心**：导致正常流程中断 | 待修复 |
| 2 | 错误信息不包含 HTTP status code | 次要：阻碍排查 | 待修复 |
| 3 | fallback plan 阻止 force-submit | 已修复 | ✅ |
| 4 | force-submit 时模型"幻觉"调用已不存在的工具 | 衍生：因 #1 才触发此路径 | 观察 |

### 关键认知

修复 #1 是最关键的——如果 iteration 1 的 API 调用不失败，模型就能在正常的第二轮对话中看到工具结果（即使是空结果），然后自然地在 iteration 2 或 3 调用 submit_review。force-submit 只是兜底，不能替代正常的 agent loop。
