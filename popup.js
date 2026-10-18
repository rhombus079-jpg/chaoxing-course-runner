// 课程流程助手 0.1.41：ARIA 测验控件适配、测验结构适配、加载超时恢复。
const $ = (id) => document.getElementById(id);
let tabId;
let timer;
let currentTab = null;
let pageHint = "";
let ready = Promise.resolve();
let sending = false;

const DEFAULT_MODEL = "deepseek-v4-pro";
const CHAOXING_PAGE = /^https?:\/\/(?:[^/]*\.)?chaoxing\.com(\/|$)/i;
const PAGE_KIND_LABEL = { runner: "学习页", directory: "课程目录", quiz: "章节测验或练习",
  video: "视频页", document: "文档页", screen: "屏幕页", other: "未识别的页面" };

function labelOf(kind) {
  return PAGE_KIND_LABEL[kind] || "未识别的页面";
}

function isConnectionError(error) {
  return /Could not establish connection|Receiving end does not exist|message port closed/i.test(error?.message || String(error));
}

function displayError(error) {
  const message = error?.message || String(error);
  // 只有真的是“接收端不存在”才提示刷新；其余中文原因原样展示
  if (/Could not establish connection|Receiving end does not exist/i.test(message)) {
    return "扩展与课程页连接已断开，请刷新课程标签页后重试";
  }
  return /[\u3400-\u9fff]/.test(message) ? message : "操作失败，请导出日志并反馈";
}

async function currentTask() {
  if (!tabId) return null;
  const key = `task:${tabId}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

async function render() {
  const task = await currentTask();
  const referenceElement = $("referenceStatus");
  if (referenceElement) {
    const key = "referenceStatus:" + tabId;
    const reference = (await chrome.storage.local.get(key))[key];
    const labels = {
      none: "最近一次答题请求：未提供课程资料。",
      provided: "最近一次答题请求：已提供短资料，尚未验证是否包含答案。",
      matched: "最近一次答题请求：按关键词选取了资料片段，尚未验证是否包含答案。",
      fallback: "最近一次答题请求：未匹配到相关资料，仅发送开头摘要，不能据此确认答案有资料支撑。"
    };
    const current = reference && (!task?.startedAt || reference.at >= task.startedAt);
    referenceElement.textContent = current ? labels[reference.mode] || "" : "";
    referenceElement.hidden = !referenceElement.textContent;
  }
  const state = task?.state || "idle";
  const indicator = $("indicator");
  if (indicator) indicator.textContent = ({ running: "运行中", paused: "已暂停", error: "需处理", completed: "已完成" })[state] || "待启动";
  const status = $("status");
  if (status) status.textContent = task?.status ? displayError({ message: task.status })
    : (pageHint || "打开超星课程目录、视频或练习页面后开始当前课程。");
  const start = $("start");
  if (start) start.disabled = state === "running";
  const pause = $("pause");
  if (pause) pause.disabled = state !== "running";
}

// 探测内容脚本是否存活：HELLO 由内容脚本无条件回应
async function pingPage() {
  try { return await chrome.tabs.sendMessage(tabId, { type: "HELLO" }, { frameId: 0 }); }
  catch (_) { return null; }
}

async function injectContentScript() {
  const url = currentTab?.url || "";
  let host = "未知地址";
  try { host = new URL(url).host || host; } catch (_) { /* 忽略 */ }
  if (!CHAOXING_PAGE.test(url)) {
    throw new Error(`当前标签页不是超星页面（${host}），请切换到已登录的超星课程页后再点开始。`);
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch (error) {
    const reason = String(error?.message || error).replace(/[。.\s]+$/, "");
    throw new Error(`无法向课程页注入脚本（${host}）：${reason}。请刷新课程标签页后重试`);
  }
}

// Commands always target the top controller; embedded frames are inspected by it.
async function ensurePageConnection() {
  currentTab = await chrome.tabs.get(tabId);
  if (!CHAOXING_PAGE.test(currentTab?.url || "")) {
    throw new Error("请切换到超星课程目录或学习页面后再操作");
  }
  let hello = await pingPage();
  if (!hello?.ok) {
    await injectContentScript();
    hello = await pingPage();
  }
  if (!hello?.ok) throw new Error("无法连接课程页面，请按 F5 刷新后重试");
  if (hello.version !== chrome.runtime.getManifest().version) {
    throw new Error("课程标签页仍运行旧版脚本，请按 F5 刷新课程页后重试");
  }
  if (!hello.controller) throw new Error("未找到课程页面控制器，请刷新课程标签页");
  return hello;
}

async function sendToPage(type) {
  await ready;
  if (!Number.isInteger(tabId)) throw new Error("未找到当前标签页");
  if (sending) throw new Error("正在连接课程页，请稍候再操作");
  sending = true;
  try {
    await ensurePageConnection();
    let result;
    try {
      result = await chrome.tabs.sendMessage(tabId, { type }, { frameId: 0 });
    } catch (error) {
      if (!isConnectionError(error)) throw error;
      throw new Error("课程页正在切换或连接中断，请等待页面加载后重试；如仍失败请刷新课程页");
    }
    if (result?.error) throw new Error(result.error);
    if (result?.ok !== true) throw new Error("课程页未确认操作结果，请刷新后重试");
    await render();
  } finally { sending = false; }
}

function showError(error) {
  const message = error?.message || String(error);
  try {
    const sent = chrome.runtime.sendMessage({ type: "DIAG_LOG", event: "error", tabId, details: { source: "popup", message } });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch (_) { /* 后台不可用时忽略，避免连带报错 */ }
  const el = $("message");
  if (el) el.textContent = displayError(error);
}

function setMessage(text) {
  const el = $("message");
  if (el) el.textContent = text;
}

// 统一的事件绑定入口：元素不存在时提示并跳过，而不是让整个脚本崩溃
function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    showError(new Error(`弹窗页面缺少元素 #${id}，请确认 popup.html 与 popup.js 版本一致`));
    return null;
  }
  el.addEventListener(event, (...args) => {
    try {
      const result = handler(...args);
      if (result && typeof result.catch === "function") result.catch(showError);
    } catch (error) { showError(error); }
  });
  return el;
}

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab || null;
    tabId = tab?.id;
    const url = tab?.url || "";
    pageHint = url && !CHAOXING_PAGE.test(url)
      ? "当前标签页不是超星页面，请切换到已登录的超星课程目录、视频或练习页后再开始。"
      : "";

    let settings = {};
    try {
      settings = await chrome.storage.local.get(["apiKey", "model", "referenceText", "customPrompt", "autoSubmit", "captchaExperimental", "guessUnknown", "answerMode", "autoRefresh"]);
    } catch (error) { showError(error); }

    const apiKey = $("apiKey");
    if (apiKey) apiKey.placeholder = settings.apiKey ? "已保存（输入新值可替换）" : "sk-…";

    const model = $("model");
    if (model) {
      const stored = settings.model || DEFAULT_MODEL;
      const exists = Array.prototype.some.call(model.options || [], (option) => option.value === stored);
      if (!exists) {
        const option = document.createElement("option");
        option.value = stored;
        option.textContent = stored;
        model.append(option);
      }
      model.value = stored;
    }

    const reference = $("reference");
    if (reference) reference.value = settings.referenceText || "";

    const customPrompt = $("customPrompt");
    if (customPrompt) customPrompt.value = settings.customPrompt || "";

    const autoSubmit = $("autoSubmit");
    if (autoSubmit) autoSubmit.checked = settings.autoSubmit !== false;
    const answerMode = $("answerMode");
    if (answerMode) answerMode.value = ["random", "collect"].includes(settings.answerMode) ? settings.answerMode : "ai";
    const autoRefresh = $("autoRefresh");
    if (autoRefresh) autoRefresh.checked = settings.autoRefresh !== false;
    const guessUnknown = $("guessUnknown");
    if (guessUnknown) guessUnknown.checked = settings.guessUnknown === true;

    const captcha = $("captchaExperimental");
    if (captcha) captcha.checked = settings.captchaExperimental === true;

    await render();
    if (timer) clearInterval(timer);
    timer = setInterval(() => render().catch(() => {}), 1500);
  } catch (error) { showError(error); }
}

function bindActions() {
  on("start", "click", () => sendToPage("START").then(() => window.close()));
  on("pause", "click", () => sendToPage("PAUSE"));

  on("saveKey", "click", async () => {
    const apiKey = $("apiKey");
    const value = apiKey ? apiKey.value.trim() : "";
    if (!value) throw new Error("请输入答题接口密钥");
    await chrome.storage.local.set({ apiKey: value });
    if (apiKey) { apiKey.value = ""; apiKey.placeholder = "已保存（输入新值可替换）"; }
    setMessage("密钥已保存在本机扩展存储中");
  });

  on("clearKey", "click", async () => {
    await chrome.storage.local.remove("apiKey");
    const apiKey = $("apiKey");
    if (apiKey) { apiKey.value = ""; apiKey.placeholder = "sk-…"; }
    setMessage("本机密钥已删除");
  });

  on("model", "change", () => chrome.storage.local.set({ model: $("model").value }));
  on("autoSubmit", "change", () => chrome.storage.local.set({ autoSubmit: $("autoSubmit").checked }));
  on("guessUnknown", "change", () => chrome.storage.local.set({ guessUnknown: $("guessUnknown").checked }));
  on("answerMode", "change", () => chrome.storage.local.set({ answerMode: $("answerMode").value }));
  on("autoRefresh", "change", () => chrome.storage.local.set({ autoRefresh: $("autoRefresh").checked }));
  on("exportReview", "click", async () => {
    try {
      const key = "review:" + tabId;
      const records = ((await chrome.storage.local.get(key))[key] || []);
      if (!records.length) { setMessage("还没有待复习的题目"); return; }
      const lines = ["# 待复习题目", "", `导出时间：${new Date().toLocaleString()}`, ""];
      records.forEach((item, index) => {
        lines.push(`## ${index + 1}. ${item.stem || "（无题干）"}`);
        for (const option of item.options || []) lines.push(`- ${option.id}. ${option.text}`);
        lines.push(`- 已选：${(item.choice || []).join("、") || "（空）"}`);
        const reasons = { wrong: "平台判错", guess: "接口无答案，随机选择", random: "随机作答（未调用接口）", collect: "仅收集题目" };
        lines.push(`- 原因：${reasons[item.reason] || "待复习"}`);
        if (item.correct) lines.push(`- 正确答案：${item.correct}`);
        lines.push("");
      });
      const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `course-runner-review-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      setMessage(`已导出 ${records.length} 道待复习题目`);
    } catch (error) { showError(error); }
  });
  on("captchaExperimental", "change", () => chrome.storage.local.set({ captchaExperimental: $("captchaExperimental").checked }));

  on("saveReference", "click", async () => {
    const reference = $("reference");
    const original = reference ? reference.value : "";
    const saved = original.slice(0, 24000);
    await chrome.storage.local.set({ referenceText: saved });
    if (reference) reference.value = saved;
    setMessage(original.length > 24000 ?
      "资料超过上限，已保存前 24000 字符；答题时会选取相关片段，未匹配时使用开头摘要" :
      "课程资料已保存；长资料会选取相关片段，未匹配时使用开头摘要");
  });

  on("savePrompt", "click", async () => {
    const el = $("customPrompt");
    const customPrompt = (el ? el.value : "").trim().slice(0, 500);
    await chrome.storage.local.set({ customPrompt });
    if (el) el.value = customPrompt;
    setMessage(customPrompt ? "答题提示词已保存" : "答题提示词已清空");
  });

  on("exportLogs", "click", async () => {
    if (tabId) {
      try { await chrome.runtime.sendMessage({ type: "DIAG_SNAPSHOT", tabId }); } catch (_) { /* 快照失败不阻断导出 */ }
    }
    const report = await chrome.runtime.sendMessage({ type: "DIAG_EXPORT" });
    if (report?.error) throw new Error(report.error);
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `course-runner-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const count = Array.isArray(report?.records) ? report.records.length : 0;
    setMessage(`已导出 ${count} 条日志`);
  });

on("exportProbe", "click", async () => {
  await ready;
  if (Number.isInteger(tabId)) await ensurePageConnection();
  try {
    const probe = await chrome.runtime.sendMessage({ type: "DIAG_PROBE", tabId });
    if (probe?.error) throw new Error(probe.error);
    const text = [
      "课程流程助手页面探针（请将本段完整粘贴给 AI）",
      "本探针只包含脱敏页面结构线索，不含题目、答案、截图、课程链接、账号或密钥。",
      JSON.stringify(probe, null, 2)
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      try {
        if (!document.execCommand("copy")) throw new Error("无法自动复制探针，请检查浏览器剪贴板权限");
      } finally { textarea.remove(); }
    }
    $("message").textContent = `页面探针已复制（${probe.records.length} 条），请到 AI 输入框按 Ctrl+V`;
  } catch (error) { showError(error); }
});

  on("clearLogs", "click", async () => {
    const result = await chrome.runtime.sendMessage({ type: "DIAG_CLEAR" });
    if (result?.error) throw new Error(result.error);
    setMessage("本机诊断日志已清除");
  });
}

function cleanup() {
  if (timer) { clearInterval(timer); timer = null; }
}

function boot() {
  bindActions();
  ready = init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

window.addEventListener("pagehide", cleanup);
window.addEventListener("unload", cleanup); // 兼容旧内核
