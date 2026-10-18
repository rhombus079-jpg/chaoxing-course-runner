const API_URL = "https://api.deepseek.com/chat/completions";
const DIAGNOSTIC_KEY = "diagnostics";
const DIAGNOSTIC_LIMIT = 300;
const DIAGNOSTIC_EVENTS = new Set(["start", "pause", "state", "snapshot", "command", "error", "usage", "structure", "answer_result", "recovery"]);
const ANSWER_CODES = new Set(["ANSWER_OK", "ANSWER_EMPTY", "ANSWER_FORMAT", "ANSWER_ID", "ANSWER_OPTIONS", "ANSWER_BLANKS"]);
const DIAGNOSTIC_PHASES = new Set(["directory", "modernDirectory", "modernEntering", "enteringChapter", "document", "video", "videoQuestion", "videoQuestionSubmitting", "videoQuestionRetrying", "videoQuestionSubmitted", "quiz", "submitted", "confirming", "awaitingVerification", "captcha", "next", "advancing", "returningDirectory"]);
const DIAGNOSTIC_STATES = new Set(["running", "paused", "error", "completed"]);
const DIAGNOSTIC_COMMANDS = new Set(["PLAY", "INITIAL_PLAY", "OPEN_VIDEO", "OPEN_DOCUMENT", "OPEN_MODERN_CHAPTER", "SCROLL_DOCUMENT", "OPEN_QUIZ", "READ_QUIZ", "CAPTURE_QUESTION", "READ_VIDEO_QUESTION", "VIDEO_QUESTION_SHAPE", "CAPTURE_VIDEO_QUESTION", "CAPTURE_CAPTCHA", "SUBMIT_CAPTCHA", "FILL_VIDEO_QUESTION", "SUBMIT_VIDEO_QUESTION", "RETRY_VIDEO_QUESTION", "CONTINUE_VIDEO_QUESTION", "FILL_QUIZ", "VERIFY_QUIZ", "SUBMIT_QUIZ", "CONFIRM_SUBMIT", "NEXT"]);
const VIDEO_QUESTION_FEEDBACK = new Set(["open", "submitting", "incorrect", "correct", "continue", "closed"]);
// A whole sheet sent in one request made the model return an empty answers array
// (5 completion tokens) far too often; small batches keep it answering.
const ANSWER_BATCH_SIZE = 3;
const ANSWER_SYSTEM_PROMPT = "你是课程章节练习答题助手。只输出 JSON 对象，格式为 {\"answers\":[{\"id\":\"题目ID\",\"choices\":[\"A\"],\"blanks\":[\"第1空答案\"]}]}。单选和判断只能选一个 choices，多选可选多个 choices；填空题 type=fill 时按 blankCount 给出相同数量的纯文本 blanks，顺序与空位一致。每条答案的 id 必须逐字复制输入 questions 中对应的 id，不要改成序号；选择题必须使用 choices 数组，不使用 answer 字段。必须为 questions 里的每一道题都给出答案：优先依据给出的题干、选项、截图和参考资料判断；这些不够用时，只要题干与选项文字可读，就依据常识选出最可能的答案。只有在题干与选项文字都缺失、无法辨认或题目明显残缺时才省略该题。不要补造选项或空位。不要输出解释或依据。";
let diagnosticWrites = Promise.resolve();

function errorCategory(message) {
  const value = String(message || "");
  if (/Could not establish connection|Receiving end does not exist|message port closed/i.test(value)) return "connection";
  if (/DeepSeek|API Key|答题接口|密钥|Failed to fetch|fetch failed/i.test(value)) return "api";
  if (/截图|图像|图形|解码/i.test(value)) return "image";
  if (/验证码|captcha/i.test(value)) return "captcha";
  if (/视频|播放器|播放/i.test(value)) return "video";
  if (/测验|题目|选项|提交|答案/i.test(value)) return "quiz";
  if (/目录|章节|下一节|翻页/i.test(value)) return "navigation";
  if (/超时|timeout|aborted/i.test(value)) return "timeout";
  return "other";
}

function sanitizeDiagnostic(event, details, tabId) {
  if (!DIAGNOSTIC_EVENTS.has(event)) return null;
  const data = details && typeof details === "object" ? details : {};
  const record = { at: new Date().toISOString(), event };
  if (Number.isInteger(tabId) && tabId >= 0) record.tab = tabId;
  if (DIAGNOSTIC_PHASES.has(data.phase)) record.phase = data.phase;
  if (DIAGNOSTIC_STATES.has(data.state)) record.state = data.state;
  if (event === "snapshot") {
    record.page = ["directory", "document", "video", "quiz", "other"].includes(data.page) ? data.page : "other";
    record.videoPaused = data.videoPaused === true;
    record.videoReady = data.videoReady === true;
    record.videoEnded = data.videoEnded === true;
    for (const field of ["videoSeconds", "videoDuration", "remainingTasks", "questionCount", "frameCount", "submitConfirmDialogCount", "submitConfirmCandidateCount"]) {
      if (Number.isFinite(data[field])) record[field] = Math.max(0, Math.min(100000, Math.floor(data[field])));
    }
    record.videoJob = ["pending", "complete"].includes(data.videoJob) ? data.videoJob : "unknown";
    record.quizJob = ["pending", "complete"].includes(data.quizJob) ? data.quizJob : "unknown";
    if (VIDEO_QUESTION_FEEDBACK.has(data.videoQuestionFeedback)) record.videoQuestionFeedback = data.videoQuestionFeedback;
  }
  if (event === "command") {
    record.command = DIAGNOSTIC_COMMANDS.has(data.command) ? data.command : "UNKNOWN";
    record.ok = data.ok === true;
  }
  if (event === "error") {
    record.code = errorCategory(data.message);
    record.source = ["content", "popup", "background"].includes(data.source) ? data.source : "unknown";
    if (typeof data.name === "string" && /^[A-Za-z]{3,40}$/.test(data.name)) record.errorName = data.name;
    if (Number.isSafeInteger(data.httpStatus) && data.httpStatus >= 100 && data.httpStatus <= 599) record.httpStatus = data.httpStatus;
  }
  if (event === "recovery") {
    record.reason = ["marker-conflict", "ambiguous-entry", "new-tab", "connection", "layout-change", "submission-unverified", "entry-unverified", "manual-check", "transient-retry", "capture-activate", "image-unsupported", "auto-reload", "batch-partial", "answer-guess"].includes(data.reason) ? data.reason : "manual-check";
  }
  if (event === "answer_result") {
    record.code = ANSWER_CODES.has(data.code) ? data.code : "ANSWER_FORMAT";
    if (["read", "response"].includes(data.stage)) record.stage = data.stage;
    if (["stem", "type", "other"].includes(data.titleKind)) record.titleKind = data.titleKind;
    if (["object", "array", "empty", "other"].includes(data.responseShape)) record.responseShape = data.responseShape;
    for (const field of ["questionCount", "returnedCount", "matchedCount", "missingIdCount", "choicesArrayCount", "choicesStringCount", "answerAliasCount", "stemLength", "optionCount", "placeholderCount", "emptyOptionCount"]) {
      if (Number.isSafeInteger(data[field]) && data[field] >= 0 && data[field] <= 10000) record[field] = data[field];
    }
    record.usedImages = data.usedImages === true;
    if (["none", "provided", "matched", "fallback"].includes(data.referenceMode)) record.referenceMode = data.referenceMode;
  }
  if (event === "usage") {
    record.kind = ["answer", "captcha"].includes(data.kind) ? data.kind : "unknown";
    for (const field of ["promptTokens", "completionTokens", "totalTokens"]) {
      if (Number.isSafeInteger(data[field]) && data[field] >= 0 && data[field] <= 1000000000) {
        record[field] = data[field];
      }
    }
  }
  if (event === "structure") {
    for (const field of ["submitConfirmDialogCount", "submitConfirmCandidateCount", "submitConfirmLabelCount"]) {
      if (Number.isSafeInteger(data[field]) && data[field] >= 0 && data[field] <= 10000) record[field] = data[field];
    }
    if (typeof data.submitConfirmPanelKind === "string" &&
        /^[A-Za-z0-9 .#=_|-]{0,80}$/.test(data.submitConfirmPanelKind)) {
      record.submitConfirmPanelKind = data.submitConfirmPanelKind;
    }
    if (typeof data.submitConfirmDialogHits === "string" &&
        /^[A-Za-z0-9:,_-]{0,120}$/.test(data.submitConfirmDialogHits)) {
      record.submitConfirmDialogHits = data.submitConfirmDialogHits;
    }
    if (["known-dialog", "label-anchor", "panel-scan", "none"].includes(data.submitConfirmScanKind)) {
      record.submitConfirmScanKind = data.submitConfirmScanKind;
    }
    if (["top", "nested"].includes(data.frameRole)) record.frameRole = data.frameRole;
    if (Array.isArray(data.submitConfirmControlKinds)) {
      record.submitConfirmControlKinds = data.submitConfirmControlKinds
        .filter((value) => typeof value === "string" && /^[A-Za-z0-9=._/-]{1,160}$/.test(value))
        .slice(0, 20);
    }
    record.kind = "page-structure";
    record.frame = Number.isInteger(data.frame) ? Math.max(0, Math.min(10000, data.frame)) : -1;
    for (const field of ["pathDepth", "imageCount", "videoCount", "questionRoots", "radioCount", "checkboxCount", "fillEditors", "visibleButtons", "iframes", "controlCount", "selectedControlCount", "unknownControlStateCount", "disabledControlCount", "modernDirectoryItemCount", "modernDirectoryLinkCount", "modernDirectoryButtonCount", "modernDirectoryMarkerCount", "modernDirectoryCandidateCount", "visibleForms", "visibleLinks", "visibleInputs", "visibleTextareas", "visibleSelects", "loadingSignalCount", "errorSignalCount", "overlaySignalCount", "captchaSignalCount", "modalSignalCount", "entryCandidateCount"]) {
      if (Number.isSafeInteger(data[field]) && data[field] >= 0 && data[field] <= 100000) record[field] = data[field];
    }
    for (const field of ["hasQuizEntry", "hasVideoEntry", "hasDocumentEntry", "entryAmbiguous"]) {
      if (data[field] === true) record[field] = true;
    }
    if (Array.isArray(data.controlStateKinds)) {
      record.controlStateKinds = data.controlStateKinds
        .filter((value) => ["aria-checked", "aria-selected", "data-checked", "data-selected", "data-state", "class"].includes(value))
        .slice(0, 8);
    }
    if (data.modernDirectoryVisible === true) record.modernDirectoryVisible = true;
    if (Array.isArray(data.modernDirectoryMarkerSources)) {
      record.modernDirectoryMarkerSources = data.modernDirectoryMarkerSources
        .filter((value) => ["text", "attribute", "pseudo", "state"].includes(value)).slice(0, 4);
    }
    if (Array.isArray(data.modernDirectoryStateKinds)) {
      record.modernDirectoryStateKinds = data.modernDirectoryStateKinds
        .filter((value) => typeof value === "string" && /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(value) && value.length <= 60 && !/\d{4,}/.test(value))
        .slice(0, 40);
    }
    for (const field of ["urlKind", "bodyClassKind", "videoSelector", "quizSelector", "documentSelector", "taskSelector", "visibleTextKinds", "layout"]) {
      if (typeof data[field] === "string" && data[field].length <= 300) record[field] = data[field];
    }
    if (Array.isArray(data.selectorHints)) {
      record.selectorHints = data.selectorHints
        .filter((value) => typeof value === "string" && /^[.#][A-Za-z_-][A-Za-z0-9_-]*$/.test(value) && value.length <= 60)
        .slice(0, 100);
    }
  }
  return record;
}

function appendDiagnostic(event, details, tabId) {
  const record = sanitizeDiagnostic(event, details, tabId);
  if (!record) return Promise.resolve({ error: "无效日志事件" });
  const write = diagnosticWrites.then(async () => {
    const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
    const records = Array.isArray(stored[DIAGNOSTIC_KEY]) ? stored[DIAGNOSTIC_KEY] : [];
    records.push(record);
    await chrome.storage.local.set({ [DIAGNOSTIC_KEY]: records.slice(-DIAGNOSTIC_LIMIT) });
    return { ok: true };
  });
  diagnosticWrites = write.catch(() => {});
  return write;
}

async function exportDiagnostics() {
  await diagnosticWrites;
  const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
  const records = Array.isArray(stored[DIAGNOSTIC_KEY]) ? stored[DIAGNOSTIC_KEY] : [];
  const usage = records.filter((record) => record.event === "usage");
  return {
    format: "course-runner-diagnostics-v1",
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    说明: "仅含运行状态、脱敏页面结构线索、错误类别和最近保留记录中的接口用量，不含题目、答案、截图、密钥、课程链接或页面原文。",
    字段说明: {
      at: "记录时间", event: "事件类型", tab: "浏览器标签编号", phase: "运行阶段",
      state: "任务状态", page: "当前页面类型", videoPaused: "视频是否暂停",
      videoReady: "视频是否加载", videoEnded: "视频是否结束",
      videoSeconds: "已播放秒数", videoDuration: "视频总秒数",
      remainingTasks: "当前小节剩余任务点数",
      submitConfirmDialogCount: "可见候选确认框数量，不代表已提交成功",
      submitConfirmCandidateCount: "可识别的提交确认按钮数量；只有唯一候选才允许确认",
      submitConfirmPanelKind: "已识别的提交确认弹窗结构线索（只有标签、类名和角色，不含页面文字）",
      submitConfirmDialogHits: "哪个选择器命中了确认框，例如 confirmSubWin:0,role-dialog:1",
      submitConfirmLabelCount: "文字恰为提交/确定的可点元素数量（含 span/div），仅在未识别按钮时统计",
      submitConfirmScanKind: "提交确认框的识别路径：已知容器、按钮文字锚定、弹窗范围扫描或未识别",
      submitConfirmControlKinds: "提交确认框内控件的标签、角色、类型和安全类别，不含按钮文字",
      frameRole: "该结构记录来自顶层页面还是嵌套框架",
      visibleForms: "可见表单数量", visibleLinks: "可见链接数量", visibleInputs: "可见输入框数量",
      visibleTextareas: "可见多行文本框数量", visibleSelects: "可见下拉框数量",
      loadingSignalCount: "类名指定加载态的可见元素数量",
      errorSignalCount: "类名指定错误态的可见元素数量",
      overlaySignalCount: "类名指定遮罩层的可见元素数量",
      captchaSignalCount: "类名指定验证码的可见元素数量",
      modalSignalCount: "可见弹窗容器数量（role 或常见弹窗类名）",
      hasQuizEntry: "当前帧是否找到测验入口",
      hasVideoEntry: "当前帧是否找到视频入口",
      hasDocumentEntry: "当前帧是否找到文档入口",
      entryAmbiguous: "入口候选多于一个且无法区分（程序会暂停，不会随便点）",
      entryCandidateCount: "三个入口的候选数量合计",
      videoJob: "视频任务点状态", quizJob: "测验任务点状态",
      questionCount: "题目数量", frameCount: "页面框架数量",
      videoQuestionFeedback: "视频弹题的页面反馈状态", command: "执行的操作",
      ok: "操作是否成功", code: "错误类别", source: "错误来源", errorName: "出错对象的类型名（如 TypeError），不含错误正文",
      httpStatus: "答题接口返回的 HTTP 状态码，用于区分 402 余额不足 / 429 限流 / 5xx 上游故障",
      reason: "恢复原因；transient-retry 表示这次是暂态故障自动重试，不是真的停了",
      kind: "接口用途或结构记录类型", promptTokens: "输入 token", completionTokens: "输出 token",
      totalTokens: "本次请求 token", frame: "页面框架编号", pathDepth: "页面路径层级",
      imageCount: "图片元素数量", videoCount: "视频元素数量", questionRoots: "题目容器数量",
      radioCount: "单选输入数量", checkboxCount: "多选输入数量", fillEditors: "填空编辑器数量",
      visibleButtons: "可见按钮数量", iframes: "内嵌框架数量", urlKind: "页面类型而非网址",
      bodyClassKind: "body class 的类别摘要", videoSelector: "视频选择器命中情况",
      quizSelector: "测验选择器命中情况", documentSelector: "文档选择器命中情况",
      taskSelector: "任务点选择器命中情况", visibleTextKinds: "可见按钮文字的类别摘要", layout: "页面布局模式",
      selectorHints: "脱敏后的 ID/class 选择器候选，不含元素文字或属性值",
      stage: "answer_result 阶段：read 为读取、response 为接口返回",
      titleKind: "题干选择器类别，不含题干内容", stemLength: "题干字符数", optionCount: "选项数量",
      responseShape: "接口返回的 JSON 顶层类型", returnedCount: "答案条目数", matchedCount: "按原题号匹配数",
      missingIdCount: "缺少题号的条目数", choicesArrayCount: "choices 数组条目数",
      choicesStringCount: "choices 字符串条目数", answerAliasCount: "使用 answer 字段的条目数",
      usedImages: "本次读取或请求是否使用图片；不保存图片",
      referenceMode: "参考资料选择：none 无资料、provided 短资料全文、matched 关键词片段、fallback 未匹配而使用开头摘要；均不表示答案已获证实"
    },
    近300条记录用量: {
      requests: usage.length,
      promptTokens: usage.reduce((sum, record) => sum + (record.promptTokens || 0), 0),
      completionTokens: usage.reduce((sum, record) => sum + (record.completionTokens || 0), 0),
      totalTokens: usage.reduce((sum, record) => sum + (record.totalTokens || 0), 0)
    },
    records
  };
}

async function exportProbe(tabId) {
  await inspectFrames(tabId, true);
  await diagnosticWrites;
  const stored = await chrome.storage.local.get(DIAGNOSTIC_KEY);
  const records = Array.isArray(stored[DIAGNOSTIC_KEY]) ? stored[DIAGNOSTIC_KEY] : [];
  return {
    format: "course-runner-page-probe-v1",
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    说明: "仅含当前页面的脱敏结构线索，不含题目、答案、截图、课程链接、页面原文、账号或密钥。",
    records: records.filter((record) => record.event === "structure" &&
      (!Number.isInteger(tabId) || record.tab === tabId)).slice(-100)
  };
}

async function clearDiagnostics() {
  await diagnosticWrites;
  await chrome.storage.local.remove(DIAGNOSTIC_KEY);
  return { ok: true };
}

async function inspectFrames(tabId, forceStructure = false) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.all(frames.map(async (frame) => {
    try {
      const result = await chrome.tabs.sendMessage(tabId, { type: "INSPECT", forceStructure }, { frameId: frame.frameId });
      return { frameId: frame.frameId, ...result };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function commandFrame(tabId, frameId, command, data) {
  return chrome.tabs.sendMessage(tabId, { type: "FRAME_COMMAND", command, data }, { frameId });
}

async function fetchImageData(url) {
  // Used when the question's own <img> cannot be read from the page context.
  // Restricted to course hosts so this can never become a generic fetcher.
  let target;
  try { target = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(target.protocol) || !/(?:^|\.)chaoxing\.com$/i.test(target.hostname)) return null;
  const response = await fetch(target.href, { credentials: "include" });
  if (!response.ok) return null;
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 6 * 1024 * 1024) return null;
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  }
  const header = String(response.headers.get("content-type") || "").split(";")[0].trim();
  const type = /^image\/[a-z0-9.+-]+$/i.test(header) ? header : "image/png";
  return `data:${type};base64,${btoa(binary)}`;
}

// captureVisibleTab only ever photographs the ACTIVE tab of a WINDOW, so being
// in the foreground is not enough: the course tab itself must be selected, and
// the window must be restored and focused before a frame is produced.
async function prepareCapture(tab, force) {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (!force && active?.id === tab.id) return "already-active";
  try { await chrome.tabs.update(tab.id, { active: true }); } catch { /* keep going */ }
  try {
    const win = await chrome.windows.get(tab.windowId);
    // Only restore a MINIMISED window. Forcing state:"normal" on a maximised
    // window shrinks the user's window, which is never acceptable.
    if (win?.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
    // Focus unconditionally: Chrome can report focused=true while another window
    // covers it, and a covered window produces no capturable frame.
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* chrome.windows may be unavailable */ }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const [now] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  return now?.id === tab.id ? "switched" : "not-active";
}

async function captureTab(tab) {
  let status = await prepareCapture(tab, false);
  if (status === "not-active") status = await prepareCapture(tab, true);
  if (status === "not-active") {
    throw new Error("课程标签页切不过去（不是当前活动标签），无法读取题目截图；请手动点一下学习页面标签后再开始");
  }
  let image = null;
  let lastError = "";
  for (let attempt = 0; attempt < 3 && !image; attempt++) {
    if (attempt > 0) await prepareCapture(tab, true);
    try {
      image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    } catch (error) {
      // Keep the browser's own words (usually ASCII, e.g. "Failed to capture
      // tab") so the reason is identifiable instead of a generic placeholder.
      const raw = String(error?.message || "capture-failed");
      lastError = /^[\x00-\x7f]*$/.test(raw) ? raw.slice(0, 60) : raw;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  if (!image) {
    throw new Error(`无法读取题目截图（${String(lastError).slice(0, 50)}）；如果浏览器窗口被最小化或被完全遮挡，请恢复窗口后再点开始`);
  }
  const [stillActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (stillActive?.id !== tab.id) throw new Error("截图时切换了标签页，停止识别");
  if (status === "switched") appendDiagnostic("recovery", { reason: "capture-activate" }, tab.id).catch(() => {});
  return image;
}

function answerError(code,message){const e=new Error(message);e.code=code;return e;}

function parseAnswerResponse(content){
 if(typeof content!=='string'||!content.trim())throw answerError('ANSWER_EMPTY','答题接口没有给出答案，已暂停；请人工作答或补充课程资料后重试');
 let text=content.trim();const fence=text.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);if(fence)text=fence[1];
 try{return JSON.parse(text);}catch{throw answerError('ANSWER_FORMAT','答题接口返回格式无法解析，已暂停；请导出日志核对');}
}

function answerEntries(raw){return Array.isArray(raw)?raw:Array.isArray(raw?.answers)?raw.answers:null;}
function emptyChoices(value) {
  return value == null || (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'string' && !value.trim());
}

function responseSummary(raw,questions,usedImages){
 const entries=answerEntries(raw)||[],ids=new Set(questions.map(q=>String(q.id)));
 return {responseShape:Array.isArray(raw)?'array':raw&&typeof raw==='object'?'object':raw==null?'empty':'other',questionCount:questions.length,returnedCount:entries.length,
 matchedCount:entries.filter(e=>e&&ids.has(String(e.id??'').trim())).length,missingIdCount:entries.filter(e=>!e||e.id==null||!String(e.id).trim()).length,
 choicesArrayCount:entries.filter(e=>Array.isArray(e?.choices)).length,choicesStringCount:entries.filter(e=>typeof e?.choices==='string').length,
  answerAliasCount:entries.filter(e=>e&&emptyChoices(e.choices)&&!emptyChoices(e.answer)).length,usedImages,
  placeholderCount:questions.filter((q)=>q&&q.stem==='[题干见截图]').length,
  emptyOptionCount:questions.filter((q)=>q&&Array.isArray(q.options)&&q.options.some((o)=>o&&!String(o.text||'').trim())).length};
}

function planAnswerBatches(questions, size){
 const list=Array.isArray(questions)?questions:[];
 const limit=Number.isInteger(size)&&size>0?size:ANSWER_BATCH_SIZE;
 const batches=[];
 for(let index=0;index<list.length;index+=limit)batches.push(list.slice(index,index+limit));
 return batches;
}

// Answers are validated one question at a time so one malformed reply no longer
// discards a whole sheet; anything invalid simply stays unanswered and the caller
// decides whether to guess it or pause.
function normalizeAnswered(entries, questions){
 const list=Array.isArray(entries)?entries.filter(e=>e&&typeof e==='object'&&!Array.isArray(e)):[];
 const byId=new Map();
 for(const entry of list){const id=String(entry.id??'').trim();if(id&&!byId.has(id))byId.set(id,entry);}
 if(questions.length===1&&list.length===1){
  const only=questions[0],entry=list[0];
  try{return normalizeAnswers({answers:[entry]},[only]);}catch{return [];}
 }
 const answers=[];
 for(const question of questions){
  const entry=byId.get(String(question.id));if(!entry)continue;
  try{answers.push(...normalizeAnswers({answers:[entry]},[question]));}catch{/*留空，由调用方决定*/}
 }
 return answers;
}

function normalizeAnswers(raw,questions){
 const entries=answerEntries(raw);
 if(!entries)throw answerError('ANSWER_FORMAT','答题接口没有返回 answers 列表，已暂停；请导出日志核对');
 if(!entries.length){
   // Tell the user when the model declined because the text itself was unreadable
   // (placeholder stems/options) instead of repeating a generic "no answer".
   const blind=questions.filter((q)=>q&&(q.stem==='[题干见截图]'||(Array.isArray(q.options)&&q.options.some((o)=>o&&o.text==='[选项见截图]')))).length;
   const explained = [raw && raw.note, raw && raw.reason, raw && raw.message, raw && raw.explanation, raw && raw.hint]
     .find((value) => typeof value === 'string' && value.trim());
   let suffix = explained ? `（模型说：${String(explained).trim().slice(0, 60)}）` : '';
   if (!suffix) {
     // Unknown shape: show a short snippet so the reason is never invisible again.
     let snippet = '';
     try { snippet = JSON.stringify(raw).slice(0, 60); } catch { snippet = ''; }
     suffix = snippet ? `（返回：${snippet}）` : '';
   }
   throw answerError('ANSWER_EMPTY',blind?
     `答题接口未给出答案：有 ${blind}/${questions.length} 道题的文字读不出来（只能看图）${suffix}，已暂停；请把课程窗口切到前台并刷新后重试`:
     `答题接口未给出可用答案${suffix}，已暂停；请人工作答或补充课程资料后重试`);
 }
 if(entries.some(e=>!e||typeof e!=='object'||Array.isArray(e)))throw answerError('ANSWER_FORMAT','答题接口的答案条目格式不正确，已暂停；请导出日志核对');
 const byId=new Map(),ids=new Set(questions.map(q=>String(q.id)));
 for(const entry of entries){let id=entry.id==null?'':String(entry.id).trim();
  // A single video question can safely use an omitted synthetic ID or ordinal 1.
  if(questions.length===1&&entries.length===1&&questions[0].id==='video-question'&&(id===''||id==='1'))id='video-question';
  if(!ids.has(id)||byId.has(id))throw answerError('ANSWER_ID','答题接口返回题号不匹配或重复，已暂停；不会按顺序猜测对应关系，请导出日志核对');
  byId.set(id,entry);
 }
 return questions.map(q=>{
  const e=byId.get(String(q.id));if(!e)throw answerError('ANSWER_ID','答题接口漏答了部分题目，已暂停；不会填写不完整的答案');
  if(q.type==='fill'){
   if(!Number.isInteger(q.blankCount)||q.blankCount<1||q.blankCount>20||!Array.isArray(e.blanks)||e.blanks.length!==q.blankCount)throw answerError('ANSWER_BLANKS','答题接口返回的填空答案数量不匹配，已暂停');
   const blanks=e.blanks.map(x=>typeof x==='string'?x.trim():'');if(blanks.some(x=>!x||x.length>500))throw answerError('ANSWER_BLANKS','答题接口返回的填空答案为空或过长，已暂停');return {id:q.id,blanks};
  }
  // Empty choices are equivalent to a missing choices field. Only then use the
  // legacy answer alias; a non-empty choices field remains authoritative.
  let values = emptyChoices(e.choices) ? e.answer : e.choices;
  if (emptyChoices(values)) throw answerError('ANSWER_EMPTY','答题接口未给出可用选项，已暂停；请人工作答或补充课程资料后重试');
  if(typeof values==='string'){
   const text=values.trim(),tokens=text.split(/[\s,，、;；|]+/).filter(Boolean);
    if(tokens.length&&tokens.every(t=>/^[A-Za-z]$/.test(t)))values=tokens;
    else if(q.type==='multiple'&&/^[A-Za-z]+$/.test(text))values=[...text];
   else if(q.type==='judgment'){
    const truth=v=>/^(对|正确|是|true|√)$/i.test(v)?true:/^(错|错误|否|false|×)$/i.test(v)?false:null;
    const wanted=truth(text),matches=q.options.filter(o=>wanted!==null&&truth(String(o.text||'').trim().replace(/^[A-Z][.、．\s]+/i,''))===wanted);
    values=matches.length===1?[matches[0].id]:null;
   }else values=null;
  }
  if(!Array.isArray(values))throw answerError('ANSWER_FORMAT','答题接口没有返回可识别的选项字段，已暂停；请导出日志核对');
  if(!values.length)throw answerError('ANSWER_EMPTY','答题接口未给出可用选项，已暂停；请人工作答或补充课程资料后重试');
  if(values.some(x=>typeof x!=='string'))throw answerError('ANSWER_OPTIONS','答题接口返回的选项格式不正确，已暂停');
  const choices=[...new Set(values.map(x=>x.toUpperCase().trim()))],allowed=new Set(q.options.map(o=>o.id));
  if(choices.some(x=>!allowed.has(x)))throw answerError('ANSWER_OPTIONS','答题接口返回的答案不在当前选项中，已暂停');
  if(q.type!=='multiple'&&choices.length!==1)throw answerError('ANSWER_OPTIONS','答题接口给单选题返回了多个选项，已暂停');return {id:q.id,choices};
 });
}

function selectReferenceResult(referenceText, questions) {
  const reference = String(referenceText || "").trim().slice(0, 24000);
  if (!reference) return { text: "", mode: "none" };
  if (reference.length <= 1500) return { text: reference, mode: "provided" };
  const query = questions.map((question) => [question.stem,
    ...(question.options || []).map((option) => option.text)].join(" "))
    .join(" ").replace(/\[[^\]]*见截图[^\]]*\]/g, "").toLowerCase();
  const terms = new Set();
  for (const word of query.match(/[\p{Script=Han}a-z0-9]+/gu) || []) {
    for (let index = 0; index + 3 <= word.length; index++) terms.add(word.slice(index, index + 3));
  }
  if (!terms.size) return { text: reference.slice(0, 1500), mode: "fallback" };
  const chunks = [];
  let order = 0;
  for (const line of reference.split(/\n+/).map((item) => item.trim()).filter(Boolean)) {
    for (let offset = 0; offset < line.length; offset += 460) {
      const text = line.slice(offset, offset + 500);
      const lower = text.toLowerCase();
      const score = [...terms].reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score) chunks.push({ order, text, score });
      order++;
    }
  }
  if (!chunks.length) return { text: reference.slice(0, 1500), mode: "fallback" };
  const text = chunks.sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3).sort((a, b) => a.order - b.order)
    .map((chunk) => chunk.text).join("\n");
  return { text, mode: "matched" };
}

function selectReference(referenceText, questions) {
  return selectReferenceResult(referenceText, questions).text;
}

function recordApiUsage(data, kind, tabId) {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") return;
  const details = {
    kind,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens ??
      (Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens) ?
        usage.prompt_tokens + usage.completion_tokens : undefined)
  };
  if (![details.promptTokens, details.completionTokens, details.totalTokens]
    .some((value) => Number.isSafeInteger(value) && value >= 0)) return;
  appendDiagnostic("usage", details, tabId).catch(() => {});
}

// Surface the provider's own error text (e.g. "Model Not Exist", "Insufficient
// Balance") instead of guessing from the status code alone.
async function readApiError(response) {
  try {
    const text = await response.text();
    let message = "";
    try {
      const parsed = JSON.parse(text);
      message = String(parsed?.error?.message || parsed?.message || "");
    } catch { message = text; }
    return message.replace(/[^\x20-\x7E\u4e00-\u9fff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  } catch {
    return "";
  }
}

async function answerQuestions(questions, images = [], tabId, exclude = null, imageFallback = []) {
  const { apiKey, model, referenceText, customPrompt } = await chrome.storage.local.get(["apiKey", "model", "referenceText", "customPrompt"]);
  if (!apiKey) throw new Error("请先在扩展中填写答题接口密钥");
  const imageIds = new Set(images.map((item) => String(item.id)));
  // A failed capture is acceptable when the question text itself is readable:
  // the answer then comes from text alone instead of blocking the whole quiz.
  const fallbackIds = new Set((Array.isArray(imageFallback) ? imageFallback : []).map((id) => String(id)));
  // A failed capture is always acceptable when it is reported: the answer then
  // comes from the question text (the model is told to do exactly that).
  const missing = questions.filter((question) => question.needsImage &&
    !imageIds.has(String(question.id)) && !fallbackIds.has(String(question.id)));
  if (images.length !== imageIds.size || missing.length) {
    throw new Error("加密题截图不完整，停止答题");
  }
  if (images.some((item) => !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.image || ""))) {
    throw new Error("题目截图格式无效，停止答题");
  }
  const reference = selectReferenceResult(referenceText, questions);
  const referenceMode = reference.mode;
  if (Number.isInteger(tabId) && tabId >= 0) {
    await chrome.storage.local.set({ ["referenceStatus:" + tabId]: { mode: referenceMode, at: Date.now() } });
  }
  const instruction = String(customPrompt || "").trim().slice(0, 500);
  const excluded = (Array.isArray(exclude?.choices) ? exclude.choices : [])
    .map((combo) => (Array.isArray(combo) ? combo.map((choice) => String(choice).toUpperCase().trim()).filter(Boolean) : []))
    .filter((combo) => combo.length).slice(-4);
  const retryNote = excluded.length
    ? `这是第 ${Number(exclude?.attempt) || 2} 次作答。以下选项组合已被平台判错，请勿重复：${excluded.map((combo) => JSON.stringify(combo)).join("、")}。请重新审题后给出新的选择。`
    : "";
  // Without images or reference material the model used to abstain by default;
  // say explicitly that common-sense answering is expected.
  const noMaterialNote = (!images.length || fallbackIds.size)
    ? "本次部分或全部题目没有可用截图，请只依据题干与选项文字作答；文字也不完整的题，请给出最可能的选项，不要留空。"
    : "";
  const imageMap = new Map(images.map((item) => [String(item.id), item.image]));
  const batches = planAnswerBatches(questions);
  const collected = [];
  let lastFailure = null;
  let lastRaw = null;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const batchImages = batch
      .map((question) => ({ id: question.id, image: imageMap.get(String(question.id)) }))
      .filter((item) => item.image);
    let entries = [];
    try {
      const reply = await requestAnswerBatch({
        apiKey, model, instruction, retryNote, noMaterialNote, referenceText,
        questions: batch, images: batchImages, tabId,
        reference: reference.mode === "fallback" ? reference : selectReferenceResult(referenceText, batch)
      });
      entries = reply.entries || [];
      if (reply.raw && typeof reply.raw === "object") lastRaw = reply.raw;
    } catch (error) {
      // Only a malformed or incomplete reply is tolerated; network and HTTP failures
      // mean every remaining batch would fail the same way, so stop right there.
      if (!ANSWER_CODES.has(error?.code)) throw error;
      lastFailure = error;
      await appendDiagnostic("recovery", { phase: "quiz", reason: "batch-partial",
        batch: index + 1, batches: batches.length, code: error?.code || "api" }, tabId).catch(() => {});
    }
    for (const entry of entries) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) collected.push(entry);
    }
    // Compare against what actually normalized: a single-question alias like id "1"
    // already stands for that question and must not trigger another rescue round.
    const covered = new Set(normalizeAnswered(collected, questions).map((answer) => String(answer.id)));
    const leftovers = batch.filter((question) => !covered.has(String(question.id)));
    if (leftovers.length) {
      const rescued = await rescueAnswers({ apiKey, model: model || "deepseek-chat",
        questions: leftovers, tabId });
      collected.push(...rescued);
    }
  }
  const answers = normalizeAnswered(collected, questions);
  const parsed = { answers: collected };
  if (!answers.length) {
    let failure = lastFailure;
    if (!failure) {
      // Reuse the existing explanation builder so a refusal still shows its reason.
      try { normalizeAnswers(lastRaw && typeof lastRaw === "object" ? lastRaw : { answers: [] }, questions); }
      catch (error) { failure = error; }
    }
    failure = failure || answerError("ANSWER_EMPTY", "答题接口未给出可用答案，已暂停；请人工作作答或补充课程资料后重试");
    await appendDiagnostic("answer_result", { ...responseSummary(parsed, questions, images.length > 0), referenceMode, stage: "response", code: failure.code || "ANSWER_EMPTY" }, tabId).catch(() => {});
    throw failure;
  }
  await appendDiagnostic("answer_result", { ...responseSummary(parsed, questions, images.length > 0), referenceMode, stage: "response", code: "ANSWER_OK" }, tabId).catch(() => {});
  return answers;
}

// One batch (ANSWER_BATCH_SIZE questions at most) per request.
async function requestAnswerBatch({ apiKey, model, instruction, retryNote, noMaterialNote, referenceText, questions, images, tabId, reference }) {
  const prompt = {
    questions: questions.map(({ id, type, stem, options, blankCount }) => ({ id, type, stem, options, blankCount }))
  };
  const matched = reference || selectReferenceResult(referenceText, questions);
  if (matched.text) prompt.reference = matched.text;
  if (matched.mode === "fallback") prompt.referenceNote = "未找到与题目匹配的资料片段。以下仅为资料开头摘要，不能视为答案依据；无关内容请忽略，请依据题干与选项给出最可能的答案。";
  if (instruction) prompt.instruction = instruction;
  const notes = [retryNote, noMaterialNote].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  if (notes) prompt.note = notes;
  const userContent = images.length ? [
    { type: "text", text: `请根据下列题目截图和题号作答。题干或选项标注“见截图”时，以截图为准。\n${JSON.stringify(prompt)}` },
    ...images.flatMap(({ id, image }) => [
      { type: "text", text: `题目 ID ${id} 的完整截图` },
      { type: "image_url", image_url: { url: image, detail: "high" } }
    ])
  ] : JSON.stringify(prompt);
  let withImages = images.length > 0;
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), withImages ? 120000 : 60000);
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: withImages ? "deepseek-flash" : model || "deepseek-chat",
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: ANSWER_SYSTEM_PROMPT },
            { role: "user", content: withImages ? userContent : JSON.stringify(prompt) }
          ]
        }),
        signal: controller.signal
      });
    } catch (error) {
      throw new Error(error?.name === "AbortError" ? "答题接口等待超时，请稍后重试" : "答题接口连接失败，请检查网络后重试");
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) break;
    const detail = await readApiError(response);
    if (withImages && response.status === 400) {
      // The endpoint refused the image payload; answer from text instead of failing.
      withImages = false;
      appendDiagnostic("recovery", { reason: "image-unsupported" }, tabId).catch(() => {});
      continue;
    }
    const failure = new Error(`答题接口请求失败，状态码 ${response.status}${detail ? `（${detail}）` : ""}，请检查密钥、余额或网络`);
    failure.httpStatus = response.status;
    throw failure;
  }
  const data = await response.json();
  recordApiUsage(data, "answer", tabId);
  if (data.choices?.[0]?.finish_reason === "length") throw answerError("ANSWER_FORMAT", "答题接口返回被截断，已暂停；请导出日志核对");
  const raw = parseAnswerResponse(data.choices?.[0]?.message?.content);
  return { entries: answerEntries(raw) || [], raw: raw && typeof raw === "object" ? raw : null };
}


// One question per request, with an explicit "must answer" instruction.
async function rescueAnswers({ apiKey, model, questions, tabId }) {
  const rescued = [];
  const modelName = model || "deepseek-chat";
  for (const question of questions) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "你是课程练习答题助手。只输出 JSON：{\"answers\":[{\"id\":\"题目ID\",\"choices\":[\"A\"]}]}。必须为题目给出 choices，不要留空，不要输出解释；判断题只有一个正确选项。" },
            { role: "user", content: JSON.stringify({ questions: [question],
              note: "只回答这一道题。请依据题干与选项按常识判断，即使不确定也要给出最可能的选项，不要留空。" }) }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) continue;
      const data = await response.json();
      recordApiUsage(data, "answer", tabId);
      const parsed = parseAnswerResponse(data.choices?.[0]?.message?.content);
      for (const entry of answerEntries(parsed) || []) {
        if (String(entry?.id ?? "").trim() === String(question.id)) rescued.push(entry);
      }
    } catch { /* skip this question */ } finally {
      clearTimeout(timeout);
    }
  }
  return rescued;
}

async function solveCaptcha(image, tabId) {
  const { apiKey } = await chrome.storage.local.get("apiKey");
  if (!apiKey) throw new Error("请先在扩展中填写答题接口密钥");
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(image || "")) {
    throw new Error("验证码截图格式无效");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-flash",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "只读取图片中的验证码字符。只输出 JSON 对象 {\"code\":\"识别出的字符\"}；无法确定时返回 {\"code\":\"\"}。不要输出解释。" },
          { role: "user", content: [
            { type: "text", text: "请识别验证码字符，区分大小写。" },
            { type: "image_url", image_url: { url: image, detail: "original" } }
          ] }
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error?.name === "AbortError" ? "验证码识别接口超时" : "验证码识别接口连接失败");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(`验证码识别接口请求失败，状态码 ${response.status}`);
  const data = await response.json();
  recordApiUsage(data, "captcha", tabId);
  const content = data.choices?.[0]?.message?.content;
  if (!content || data.choices?.[0]?.finish_reason === "length") throw new Error("验证码识别结果不完整");
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error("验证码识别结果格式无效"); }
  const code = String(parsed.code || "").trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(code)) throw new Error("验证码无法可靠识别，请人工完成");
  return { code };
}

function blankQuestionRoots() {
  const candidates = [...new Set([
    ...document.querySelectorAll(".TiMu.singleQuesId"),
    ...document.querySelectorAll(".newTiMu"),
    ...document.querySelectorAll(".TiMu")
  ])];
  const roots = candidates.filter((candidate) => {
    const titles = [...candidate.querySelectorAll(".Zy_TItle, .newZy_TItle")]
      .filter((title, index, all) => !all.some((other, otherIndex) => otherIndex !== index && title.contains?.(other)));
    return titles.length === 1;
  });
  return roots.filter((root) => !roots.some((other) => other !== root && root.contains?.(other)));
}

function blankEditorAction(questionId, blanks, mode) {
  const roots = blankQuestionRoots();
  const positional = String(questionId).match(/^question-(\d+)$/i);
  const position = positional ? Number(positional[1]) - 1 : -1;
  const root = roots.find((item) => item.getAttribute("data") === questionId || item.id === questionId) ||
    (position >= 0 ? roots[position] : null);
  if (!root) return { error: "填空题已变化，停止填写" };
  const textareas = [...root.querySelectorAll("textarea[name^='answerEditor']")];
  if (!Array.isArray(blanks) || !textareas.length || textareas.length !== blanks.length) {
    return { error: "填空数量与页面不一致，停止填写" };
  }
  if (!window.UE?.getEditor) return { error: "填空编辑器尚未加载，请稍后重试" };
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  for (let index = 0; index < textareas.length; index++) {
    const textarea = textareas[index];
    if (!textarea.id || !/^answerEditor/i.test(textarea.name || "")) {
      return { error: "填空编辑器标识无法识别" };
    }
    const editor = window.UE.getEditor(textarea.id);
    if (!editor || typeof editor.getContent !== "function" || typeof editor.setContent !== "function") {
      return { error: "填空编辑器尚未准备好" };
    }
    if (mode === "fill") {
      const escaped = String(blanks[index]).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      editor.setContent(escaped);
    }
    const decoded = document.createElement("div");
    decoded.innerHTML = editor.getContent();
    if (normalize(decoded.textContent) !== normalize(blanks[index])) {
      return { error: `第 ${index + 1} 空的内容未通过核对，停止提交` };
    }
  }
  return mode === "fill" ? { filled: textareas.length } : { verified: textareas.length };
}

async function runBlankEditorAction(sender, questionId, blanks, mode) {
  if (!sender.tab?.id || !Number.isInteger(sender.frameId) ||
      !Array.isArray(blanks) || blanks.length > 20 ||
      blanks.some((blank) => typeof blank !== "string" || !blank.trim() || blank.length > 500)) {
    throw new Error("填空请求无效，停止填写");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
    world: "MAIN",
    func: blankEditorAction,
    args: [String(questionId), blanks, mode]
  });
  if (results.length !== 1 || !results[0].result) throw new Error("填空编辑器未返回核对结果");
  return results[0].result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "DIAG_LOG") {
      const details = message.details && typeof message.details === "object" ?
        { ...message.details, frame: Number.isInteger(sender.frameId) ? sender.frameId : message.details.frame } : message.details;
      return appendDiagnostic(message.event, details, sender.tab?.id ?? message.tabId);
    }
    if (message.type === "DIAG_SNAPSHOT") {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("无法识别当前课程标签页");
      await inspectFrames(message.tabId, true);
      return { ok: true };
    }
    if (message.type === "DIAG_PROBE") {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error("无法识别当前课程标签页");
      return exportProbe(message.tabId);
    }
    if (message.type === "DIAG_EXPORT") return exportDiagnostics();
    if (message.type === "DIAG_CLEAR") return clearDiagnostics();
    if (message.type === "TAB_ID") return sender.tab?.id;
    if (message.type === "INSPECT_FRAMES") return inspectFrames(sender.tab.id);
    if (message.type === "COMMAND_FRAME") {
      return commandFrame(sender.tab.id, message.frameId, message.command, message.data);
    }
    if (message.type === "CAPTURE_TAB") return captureTab(sender.tab);
    if (message.type === "FETCH_IMAGE") return fetchImageData(message.url).then((dataUrl) => ({ dataUrl }), () => ({ dataUrl: null }));
    if (message.type === "ANSWER") return answerQuestions(message.questions, message.images, sender.tab?.id, message.exclude, message.imageFallback);
    if (message.type === "SOLVE_CAPTCHA") return solveCaptcha(message.image, sender.tab?.id);
    if (message.type === "FILL_BLANKS") return runBlankEditorAction(sender, message.questionId, message.blanks, "fill");
    if (message.type === "VERIFY_BLANKS") return runBlankEditorAction(sender, message.questionId, message.blanks, "verify");
    throw new Error("未知消息类型");
  })().then(sendResponse, (error) => {
    if (!["DIAG_LOG", "DIAG_EXPORT", "DIAG_CLEAR"].includes(message.type)) {
      appendDiagnostic("error", { source: "background", message: error.message || String(error), httpStatus: error.httpStatus }, sender.tab?.id).catch(() => {});
    }
    sendResponse({ error: error.message || String(error), ...(ANSWER_CODES.has(error.code) ? { code: error.code } : {}) });
  });
  return true;
});
