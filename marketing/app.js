"use strict";
document.documentElement.classList.add("js");
const reveals = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("in-view"); observer.unobserve(entry.target); }
  }, { threshold: 0.12 });
  reveals.forEach(element => observer.observe(element));
} else { reveals.forEach(element => element.classList.add("in-view")); }

const relationshipData = {
  calls: { root: "normalize()", target: "import_data()", title: "参数改了，调用方跟上了吗？", description: "沿 incoming call 查找调用位置，读取未修改文件，核对参数约定与实际行为。", diagram: "调用关系示意：从修改的 normalize 函数定位 import_data 调用方，再读取调用位置的源码" },
  inherits: { root: "BaseStore.save()", target: "FileStore.save()", title: "父类变了，子类约定还成立吗？", description: "沿继承关系查找相关实现，读取父类与子类源码，检查方法约定和行为变化。", diagram: "继承关系示意：从 BaseStore 声明定位 FileStore 子类，并读取对应源码" },
  imports: { root: "parser.py", target: "client.py", title: "接口变了，引用它的模块知道吗？", description: "沿导入关系定位关联文件，再结合文本搜索与源码读取，核对接口的实际使用。", diagram: "导入关系示意：从 parser.py 定位导入它的 client.py，再读取引用位置的源码" }
};
const byId = id => document.getElementById(id);

function activateTab(button) {
  const tablist = button.closest('[role="tablist"]');
  tablist.querySelectorAll('[role="tab"]').forEach(tab => {
    const selected = tab === button;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  byId(button.getAttribute("aria-controls")).setAttribute("aria-labelledby", button.id);
}

document.querySelectorAll("[data-relation]").forEach(button => button.addEventListener("click", () => {
  activateTab(button);
  const data = relationshipData[button.dataset.relation];
  byId("graph-root").textContent = data.root;
  byId("graph-target").textContent = data.target;
  byId("relation-title").textContent = data.title;
  byId("relation-description").textContent = data.description;
  byId("relation-diagram-title").textContent = data.diagram;
}));

const skillData = {
  source: { kicker: "DELIVERED REVIEW + FEEDBACK", title: "让纠正，有后续。", description: "已交付运行与开发者反馈成为学习来源。来源与失败尝试保留，经验可以追溯。" },
  learn: { kicker: "LOCAL SERIAL LEARNING", title: "留下方法，保留边界。", description: "本地单 worker 逐项处理学习来源。结合已有知识提炼触发条件、检查步骤与反例，避免只记住一次事件。" },
  version: { kicker: "VERSIONED KNOWLEDGE", title: "每份经验，有版本可循。", description: "知识以不可变对象与版本记录保存。版本冲突拒绝提交，来源撤回与回滚保留历史。" },
  review: { kicker: "FROZEN. READ-ONLY. ON DEMAND.", title: "带着经验，重新看源码。", description: "审查开始时冻结只读知识包，按仓库、路径与语言选择相关方法。按需加载受预算约束，历史经验不能替代当前证据。" }
};
document.querySelectorAll("[data-skill]").forEach(button => button.addEventListener("click", () => {
  activateTab(button);
  const data = skillData[button.dataset.skill];
  byId("skill-kicker").textContent = data.kicker;
  byId("skill-title").textContent = data.title;
  byId("skill-description").textContent = data.description;
}));

// Source: MergeWarden 2 / eval/results/code-graph-20260928.json.
// Scenario sets overlap; the complex scenario was selected after the experiment.
const benchmarkData = {
  all: { baseline: 67.8, graph: 77.4, precision: 85.7, precisionBaseline: 80.0, token: "+19.6", rounds: "+6.5", note: "全量 40 例，80 次配对结果。质量提升伴随更多 Token 投入。" },
  cross: { baseline: 78.6, graph: 82.8, precision: 92.3, precisionBaseline: 91.7, token: "−4.5", rounds: "−8.9", note: "全部跨文件任务 12 例，按任务依赖类型划分。质量与探索效率同时改善。" },
  core: { baseline: 78.3, graph: 83.3, precision: 90.9, precisionBaseline: 90.0, token: "−9.2", rounds: "−12.5", note: "核心跨文件依赖 9 例，需读取未修改文件中的调用、继承或接口契约；属于跨文件任务子集。" },
  complex: { baseline: 63.6, graph: 83.3, precision: 83.3, precisionBaseline: 70.0, token: "−18.3", rounds: "−19.4", note: "复杂场景 10 例：6 个跨文件依赖与 4 个局部契约／控制样本。按评测后的任务特征与表现选取，属事后分析。" }
};
function displayPercent(id, value) {
  const target = byId(id);
  target.replaceChildren(document.createTextNode(value));
  const unit = document.createElement("span"); unit.textContent = "%"; target.append(unit);
}
document.querySelectorAll("[data-benchmark]").forEach(button => button.addEventListener("click", () => {
  activateTab(button);
  const d = benchmarkData[button.dataset.benchmark];
  displayPercent("metric-f1", d.graph.toFixed(1));
  displayPercent("metric-precision", d.precision.toFixed(1));
  displayPercent("metric-token", d.token);
  byId("metric-f1-change").textContent = "从 " + d.baseline.toFixed(1) + "% 提升 · +" + (d.graph - d.baseline).toFixed(1) + " 个百分点";
  byId("metric-precision-change").textContent = "文本基线 " + d.precisionBaseline.toFixed(1) + "%";
  byId("metric-rounds").textContent = "探索轮次 " + d.rounds + "%";
  byId("bar-baseline").style.width = d.baseline + "%";
  byId("bar-graph").style.width = d.graph + "%";
  byId("bar-baseline-label").textContent = d.baseline.toFixed(1) + "%";
  byId("bar-graph-label").textContent = d.graph.toFixed(1) + "%";
  byId("benchmark-scope-note").textContent = d.note;
}));

const commandData = {
  staged: "--scope staged",
  commits: "--base BASE_SHA --head HEAD_SHA",
  worktree: "--scope worktree"
};
document.querySelectorAll("[data-command]").forEach(button => button.addEventListener("click", () => {
  activateTab(button);
  byId("review-command").textContent = "npm run cli -- review \\\n  --repo /path/to/repository \\\n  " + commandData[button.dataset.command] + " \\\n  --provider openai-codex \\\n  --model MODEL_ID --auth oauth";
  byId("copy-status").textContent = "";
  byId("copy-command").textContent = "复制命令";
}));
byId("copy-command").addEventListener("click", async () => {
  const text = byId("review-command").textContent.replace(/\\\n\s*/g, " ").trim();
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; }
  catch {
    const textarea = document.createElement("textarea");
    textarea.value = text; textarea.style.cssText = "position:fixed;left:-9999px;top:0;"; textarea.setAttribute("aria-hidden", "true");
    document.body.append(textarea); textarea.select();
    try { copied = document.execCommand("copy"); } finally { textarea.remove(); }
  }
  byId("copy-command").textContent = copied ? "已复制" : "复制命令";
  byId("copy-status").textContent = copied ? "命令已复制。请替换仓库路径与模型 ID。" : "复制未完成。可选中上方命令手动复制。";
});

// Roving focus for all tablists. Home/End and both arrow axes work on keyboard.
document.querySelectorAll('[role="tablist"]').forEach(tablist => tablist.addEventListener("keydown", event => {
  const keys = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  event.preventDefault();
  let next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
}));
