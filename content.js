(() => {
// Keep exactly one controller/listener in each isolated frame.
if (window.__courseRunnerInjected) return;
window.__courseRunnerInjected = { version: chrome.runtime.getManifest().version };
const RUNNER_URL = /\/(?:mooc-ans\/)?mycourse\/studentstudy/i;
const DIRECTORY_URL = /\/(?:mooc-ans\/)?mycourse\/studentcourse/i;
const MODERN_DIRECTORY_URL = /\/mooc2-ans\/mycourse\/stu/i;
const QUIZ_URL = /\/(?:mooc-ans\/)?(?:api\/work|work\/(?:doHomeWorkNew|selectWorkQuestion))/i;
const CARDS_URL = /\/(?:mooc-ans\/)?knowledge\/cards/i;
const VIDEO_URL = /\/ananas\/modules\/video\/index\.html/i;
const DOCUMENT_URL = /\/ananas\/modules\/pdf\/index\.html/i;
const SCREEN_URL = /^\/screen\//i;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHAPTER_SWITCH_GRACE_MS = 12000;
const QUIZ_LOAD_TIMEOUT_MS = 45000;
const SUBMISSION_WAIT_MS = 45000;
const CONFIRM_DETECT_GRACE_MS = 6000;
const CONFIRM_RETRY_INTERVAL_MS = 3000;
const MAX_CONFIRM_ATTEMPTS = 3;
// Each screenshot is billed as image tokens; cap how many a single quiz may take.
const MAX_CAPTURE_IMAGES = 4;
// Transient trouble (a reloading frame, a slow page, a flaky network) deserves a
// few retries before the run stops; deterministic problems still stop at once.
const RETRY_DELAYS_MS = [2000, 5000, 10000, 15000];
const FATAL_ERROR_PATTERN = /验证码|新版页面|旧版页面结构|题目|题号|题干|选项|答案|填空|截图|可见区域|缩放|接口|API Key|ANSWER_|进入了另一门课程|进入的小节与目录选择不一致|课程目录链接缺少必要参数|视频弹题|提交确认框不可见|已判错|重复|无法识别当前/;

function retryPlan(message, attempts) {
  const value = String(message || "");
  if (FATAL_ERROR_PATTERN.test(value)) return { retry: false, fatal: true, delay: 0, attempt: Number(attempts) || 0 };
  const used = Math.max(0, Number(attempts) || 0);
  if (used >= RETRY_DELAYS_MS.length) return { retry: false, fatal: false, delay: 0, attempt: used };
  return { retry: true, fatal: false, delay: RETRY_DELAYS_MS[used], attempt: used + 1 };
}

function retryReasonText(error) {
  const message = error?.message || String(error);
  if (/[\u3400-\u9fff]/.test(message)) return message;
  // Browser-level exceptions are English only; name them instead of showing a
  // generic "something failed" line to the user.
  const name = /^[A-Za-z]{3,40}$/.test(error?.name || "") ? error.name : "Error";
  return `页面脚本报错（${name}）`;
}
const MAX_VIDEO_QUESTION_RETRIES = 2;
const PAGE_MESSAGE_TIMEOUT_MS = 12000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
const textOf = (element) => clean(element?.innerText || element?.textContent);
let lastStructureSignature = "";
let lastStructureScanAt = -Infinity;
// Some quiz pages expose no usable question id. Keep a private snapshot for
// this page instance so positional ids cannot silently follow a reordered DOM.
let quizShapeSnapshot = null;
let quizIdSnapshot = null;

function layoutProfile() {
  const path = location.pathname;
  const legacyRoute = RUNNER_URL.test(path) || DIRECTORY_URL.test(path) || QUIZ_URL.test(path) ||
    CARDS_URL.test(path) || VIDEO_URL.test(path) || DOCUMENT_URL.test(path) || SCREEN_URL.test(path);
  const legacyMarkers = document.querySelectorAll(
    "#coursetree, div.timeline, .ans-job-icon, #dct1, #dct2, #video_html5_api, .vjs-big-play-button, .TiMu.singleQuesId"
  ).length;
  const modernSignals = document.querySelectorAll(
    "video, input[type='radio'], input[type='checkbox'], textarea[name^='answerEditor'], [role='dialog']"
  ).length;
  if (legacyRoute && (legacyMarkers > 0 || modernSignals === 0)) return "legacy";
  if (modernSignals > 0) return "modern";
  return legacyRoute ? "legacy-loading" : "unknown";
}

function modernDirectoryRows() {
  const rows = [...document.querySelectorAll(".knowledgeJobCount, .catalog_task")]
    .filter(visible)
    .map((marker) => marker.closest(
      ".chapter_td, .chapter_unit, .chapter_item, .chapter_body, .chapter_head, .chapter_th, .chapter_th_renwu, .chapter_th_mulu"
    ))
    .filter(Boolean);
  return [...new Set(rows)];
}

function modernNumericMarker(marker) {
  if (!marker || !visible(marker)) return null;
  const text = clean(marker.textContent);
  const readCount = (value) => {
    const normalized = clean(value);
    if (!normalized) return null;
    if (/^\d+$/.test(normalized)) return Number(normalized);
    if (!/(?:未完成|待完成|未开始|进行中|待处理|任务点|任务|pending|unfinish|task|job|count)/i.test(normalized)) return null;
    const match = normalized.match(/(?:^|\D)(\d{1,4})(?:\D|$)/);
    return match ? Number(match[1]) : null;
  };
  const textCount = readCount(text);
  if (Number.isFinite(textCount)) return { count: textCount, source: "text" };
  for (const name of ["data-count", "data-unfinish-count", "data-job-count", "value"]) {
    const value = readCount(marker.getAttribute(name));
    if (Number.isFinite(value)) return { count: value, source: "attribute" };
  }
  for (const pseudo of ["::before", "::after"]) {
    const content = clean(getComputedStyle(marker, pseudo).content).replace(/^['\"]|['\"]$/g, "");
    const value = readCount(content);
    if (Number.isFinite(value)) return { count: value, source: "pseudo" };
  }
  const state = [text, marker.getAttribute?.("aria-label"), marker.getAttribute?.("title"),
    [...(marker.classList || [])].join(" ")].filter(Boolean).join(" ");
  if (/(?:未完成|待完成|未开始|进行中|待处理|pending|unfinish(?:ed)?)/i.test(state)) {
    return { count: 1, source: "state" };
  }
  return null;
}

function modernRowLocked(row) {
  if (!row) return true;
  return row.getAttribute?.("aria-disabled") === "true" || row.disabled === true ||
    [...(row.classList || [])].some((name) => /(^|[-_])(lock|locked|disabled)([-_]|$)/i.test(name));
}

function modernElementLocked(element, row) {
  let current = element;
  while (current) {
    if (current.getAttribute?.("aria-disabled") === "true" || current.disabled === true ||
        [...(current.classList || [])].some((name) => /(^|[-_])(lock|locked|disabled)([-_]|$)/i.test(name))) return true;
    if (current === row) break;
    current = current.parentElement;
  }
  return false;
}

function modernRowTarget(row) {
  if (!row || modernRowLocked(row)) return null;
  const selfIsEntry = /(^|_)(chapter_th|chapter_th_renwu|chapter_th_mulu|chapter_body|chapter_head|clicktitle)(_|$)/i
    .test([...(row.classList || [])].join(" ")) || row.getAttribute?.("role") === "button" || Boolean(row.getAttribute?.("onclick"));
  const descendants = [...row.querySelectorAll(
      ".clicktitle, .chapter_th, .chapter_th_renwu, .chapter_th_mulu, .chapter_body, .chapter_head, a[href], [role='button'], [onclick], [data-chapter-id], [data-id]"
    )];
  const parentCandidates = row.parentElement ? [...row.parentElement.querySelectorAll(
    ".clicktitle, .chapter_th, .chapter_th_renwu, .chapter_th_mulu, [role='button'], [onclick], [data-chapter-id], [data-id]"
  )].filter((element) => element !== row && !row.contains?.(element)) : [];
  const siblingFallback = descendants.length || parentCandidates.length !== 1 ? [] : parentCandidates;
  const candidates = [
    ...descendants,
    ...siblingFallback,
    ...(selfIsEntry && !descendants.length ? [row] : [])
  
  ]
    .filter((element) => visible(element) && !["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName) &&
      !modernElementLocked(element, row));
  return candidates[0] || null;
}

function modernDirectoryTargets() {
  const targets = [];
  for (const row of modernDirectoryRows()) {
    const markers = [...row.querySelectorAll(".knowledgeJobCount, .catalog_task")]
      .map((marker) => ({ marker, numeric: modernNumericMarker(marker) }))
      .filter((entry) => entry.numeric && entry.numeric.count > 0);
    const button = modernRowTarget(row);
    if (button && markers.length) targets.push({ row, button, remaining: markers[0].numeric.count, markerSource: markers[0].numeric.source });
  }
  return targets;
}

function modernDirectoryInfo() {
  const root = document.querySelector("#fanyaChapter, .fanyaChapter");
  const items = modernDirectoryRows();
  const stateKinds = new Set();
  let linkCount = 0;
  let buttonCount = 0;
  for (const item of items) {
    for (const element of [item, ...item.querySelectorAll("[class]")]) {
      for (const name of element.classList || []) {
        if (/finish|complete|done|unfinish|pending|lock|job|video|quiz|task/i.test(name)) stateKinds.add(name);
      }
    }
    linkCount += item.querySelectorAll("a[href]").length;
    buttonCount += item.querySelectorAll("button, [role='button'], [onclick], .clicktitle, .chapter_th, .chapter_th_renwu, .chapter_th_mulu, .chapter_body, .chapter_head").length;
  }
  const targets = modernDirectoryTargets();
  return {
    visible: Boolean(root && visible(root)),
    itemCount: items.length,
    linkCount,
    buttonCount,
    stateKinds: [...stateKinds].sort().slice(0, 40),
    markerCount: document.querySelectorAll(".knowledgeJobCount, .catalog_task").length,
    candidateCount: targets.length,
    markerSources: [...new Set(targets.map((target) => target.markerSource))]
  };
}

function modernDirectoryTarget() {
  return modernDirectoryTargets()[0] || null;
}

function modernDirectoryHasVisiblePendingMarker() {
  return [...document.querySelectorAll(".knowledgeJobCount, .catalog_task")]
    .some((marker) => modernNumericMarker(marker)?.count > 0);
}

function isChaoxingPage() {
  return /(^|\.)chaoxing\.com$/i.test(location.hostname);
}

function requireLegacyLayout() {
  const profile = layoutProfile();
  if (profile !== "legacy") {
    throw new Error(profile === "modern" ?
      "检测到学习通新版页面；当前新版适配尚未确认，已暂停并保留诊断日志" :
      "未能确认学习通旧版页面结构，已暂停以避免误操作");
  }
}

function safeSelectorHints(elements) {
  const structural = /video|player|quiz|work|question|answer|option|choice|timu|title|job|chapter|course|class|unit|document|pdf|screen|iframe|submit|next|content|main|root|topic|ans/i;
  const values = new Set();
  for (const element of elements || document.querySelectorAll("[id], [class]")) {
    if (element.id && structural.test(element.id)) values.add(`#${element.id}`);
    for (const name of element.classList || []) if (structural.test(name)) values.add(`.${name}`);
  }
  return [...values]
    .filter((value) => value.length <= 60 && /^[.#][A-Za-z_-][A-Za-z0-9_-]*$/.test(value) && !/\d{4,}/.test(value))
    .sort()
    .slice(0, 100);
}

function safeControlKind(element) {
  const tag = String(element?.tagName || "").toLowerCase() || "unknown";
  const role = clean(element?.getAttribute?.("role")).toLowerCase();
  const type = clean(element?.getAttribute?.("type")).toLowerCase();
  const classes = [...(element?.classList || [])]
    .filter((name) => /btn|button|submit|confirm|cancel|dialog|modal|pop|layer|input|option|radio|check/i.test(name))
    .filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]{0,50}$/.test(name))
    .slice(0, 4);
  return [tag, role ? `role=${role}` : "", type ? `type=${type}` : "",
    element?.getAttribute?.("onclick") != null ? "onclick" : "", classes.length ? `class=${classes.join(".")}` : ""]
    .filter(Boolean).join("/").slice(0, 160);
}

function structureSignalCounts(elements) {
  const countVisible = (selector) => [...document.querySelectorAll(selector)].filter(visible).length;
  // Shares the single id/class scan with the selector hints: five separate scans
  // would each force a layout pass on the same elements.
  const marked = (elements || [...document.querySelectorAll("[id], [class]")]).filter(visible)
    .map((element) => `${element.id || ""} ${[...(element.classList || [])].join(" ")}`);
  const signalCount = (pattern) => marked.filter((value) => pattern.test(value)).length;
  return {
    visibleForms: countVisible("form"),
    visibleLinks: countVisible("a[href]"), visibleInputs: countVisible("input"),
    visibleTextareas: countVisible("textarea"), visibleSelects: countVisible("select"),
    loadingSignalCount: signalCount(/load|loading|spinner|wait/i),
    errorSignalCount: signalCount(/error|fail|timeout|exception/i),
    overlaySignalCount: signalCount(/overlay|mask|shade|backdrop/i),
    captchaSignalCount: signalCount(/captcha|verify|verification|code/i),
    modalSignalCount: countVisible("[role='dialog'], [role='alertdialog'], [aria-modal='true'], .popClass, .popMain, .layui-layer, .modal, .dialog")
  };
}

function structureDiagnostic(force = false) {
  // Poll playback state frequently, but scan structural selector hints less often.
  // Explicit probes bypass this limit and always record a fresh structure.
  if (!force && Date.now() - lastStructureScanAt < 15000) return;
  lastStructureScanAt = Date.now();
  const path = location.pathname.toLowerCase();
  const modernDirectory = modernDirectoryInfo();
  const visibleButtons = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
    .filter(visible).length;
  const markedElements = [...document.querySelectorAll("[id], [class]")];
  const hints = safeSelectorHints(markedElements);
  const confirmation = submitConfirmation();
  const entries = learningEntries();
  const controls = getQuestionElements().flatMap((root) => questionInputs(root));
  const signals = structureSignalCounts(markedElements);
  const controlStateKinds = [...new Set(controls.flatMap((control) => stateElements(control).flatMap((element) => {
    const names = ["aria-checked", "aria-selected", "data-checked", "data-selected", "data-state"]
      .filter((name) => element.getAttribute?.(name) != null);
    if ([...(element.classList || [])].some((name) => /selected|checked|active|disabled/i.test(name))) names.push("class");
    return names;
  })))].sort();
  const summary = {
    frame: window === top ? 0 : -1,
    frameRole: window === top ? "top" : "nested",
    pathDepth: path.split("/").filter(Boolean).length,
    imageCount: document.images.length,
    videoCount: document.querySelectorAll("video").length,
    questionRoots: getQuestionElements().length,
    radioCount: document.querySelectorAll("input[type='radio']").length,
    checkboxCount: document.querySelectorAll("input[type='checkbox']").length,
    controlCount: controls.length,
    selectedControlCount: controls.filter((control) => controlSelected(control) === true).length,
    unknownControlStateCount: controls.filter((control) => controlSelected(control) === null).length,
    disabledControlCount: controls.filter((control) => control.disabled === true || control.getAttribute?.("aria-disabled") === "true").length,
    controlStateKinds,
    submitConfirmDialogCount: confirmation.dialogCount,
    submitConfirmCandidateCount: confirmation.candidateCount,
    submitConfirmPanelKind: confirmation.panelKind || "",
    submitConfirmDialogHits: confirmation.hits || "",
    submitConfirmLabelCount: Number.isFinite(confirmation.labelCount) ? confirmation.labelCount : 0,
    submitConfirmScanKind: confirmation.scanKind || "none",
    submitConfirmControlKinds: confirmation.controlKinds || [],
    hasQuizEntry: Boolean(entries.quiz.element),
    hasVideoEntry: Boolean(entries.video.element),
    hasDocumentEntry: Boolean(entries.document.element),
    entryAmbiguous: entries.quiz.ambiguous === true || entries.video.ambiguous === true ||
      entries.document.ambiguous === true,
    entryCandidateCount: Math.min(9999, (entries.quiz.candidateCount || 0) +
      (entries.video.candidateCount || 0) + (entries.document.candidateCount || 0)),
    ...signals,
    fillEditors: document.querySelectorAll("textarea[name^='answerEditor']").length,
    visibleButtons,
    iframes: document.querySelectorAll("iframe").length,
    urlKind: RUNNER_URL.test(path) ? "runner" : DIRECTORY_URL.test(path) ? "directory" :
      QUIZ_URL.test(path) ? "quiz" : VIDEO_URL.test(path) ? "video" :
      DOCUMENT_URL.test(path) ? "document" : SCREEN_URL.test(path) ? "screen" : "other",
    bodyClassKind: [...(document.body?.classList || [])].filter((name) => /^[A-Za-z_-][A-Za-z0-9_-]{0,50}$/.test(name)).slice(0, 20).join(","),
    videoSelector: ["#video_html5_api", ".vjs-big-play-button", "video"].map((selector) => `${selector}:${document.querySelectorAll(selector).length}`).join(","),
    quizSelector: [".TiMu.singleQuesId", ".newTiMu", ".TiMu", ".Zy_TItle", ".newZy_TItle", "input[name^='answer']", "input[type='hidden'][name^='answer']", ".num_option", "[role='radio']", "[role='checkbox']"].map((selector) => `${selector}:${document.querySelectorAll(selector).length}`).join(","),
    documentSelector: ["#dct1", "#dct2", "img"].map((selector) => `${selector}:${document.querySelectorAll(selector).length}`).join(","),
    taskSelector: [".ans-job-icon", ".ans-job-video", ".ans-job-finished", ".jobUnfinishCount"].map((selector) => `${selector}:${document.querySelectorAll(selector).length}`).join(","),
    visibleTextKinds: [...document.querySelectorAll("button, a")].filter(visible).map((item) => {
      const text = textOf(item);
      return /提交|交卷/.test(text) ? "submit" : /下一节|下一章/.test(text) ? "next" : /视频/.test(text) ? "video" : /测验|练习|测试/.test(text) ? "quiz" : "other";
    }).filter((value, index, list) => list.indexOf(value) === index).join(","),
    layout: layoutProfile(),
    modernDirectoryVisible: modernDirectory.visible,
    modernDirectoryItemCount: modernDirectory.itemCount,
    modernDirectoryLinkCount: modernDirectory.linkCount,
    modernDirectoryButtonCount: modernDirectory.buttonCount,
    modernDirectoryMarkerCount: modernDirectory.markerCount,
    modernDirectoryCandidateCount: modernDirectory.candidateCount,
    modernDirectoryMarkerSources: modernDirectory.markerSources,
    modernDirectoryStateKinds: modernDirectory.stateKinds,
    selectorHints: hints
  };
  const signature = JSON.stringify(summary);
  if (force || signature !== lastStructureSignature) {
    lastStructureSignature = signature;
    recordDiagnostic("structure", summary);
  }
}

function recordDiagnostic(event, details = {}) {
  try {
    chrome.runtime.sendMessage({ type: "DIAG_LOG", event, details }).catch(() => {});
  } catch { /* extension may have been reloaded */ }
}

function displayError(error) {
  const message = error?.message || String(error);
  if (/Could not establish connection|Receiving end does not exist|message port closed/i.test(message)) {
    return "扩展与课程页连接已断开，请刷新课程页后重试";
  }
  return /[\u3400-\u9fff]/.test(message) ? message : "运行时发生错误，请导出日志并反馈";
}

function frameVisible() {
  for (let current = window; current !== current.top; current = current.parent) {
    if (!visible(current.frameElement)) return false;
  }
  return true;
}

function currentVideo() {
  const player = document.querySelector("#video_html5_api");
  if (visible(player)) return player;
  return [...document.querySelectorAll("video")].find((video) => visible(video)) || null;
}

function initialPlayButton() {
  if (!VIDEO_URL.test(location.pathname)) return null;
  const button = document.querySelector(".vjs-big-play-button");
  return visible(button) ? button : null;
}

function videoJobState() {
  if (!CARDS_URL.test(location.pathname) && !RUNNER_URL.test(location.pathname)) return null;
  const markers = [...document.querySelectorAll(".ans-job-icon.ans-job-video")];
  if (!markers.length) return null;
  const states = markers.map((marker) => {
    if (marker.parentElement?.classList.contains("ans-job-finished")) return "complete";
    const label = clean(marker.getAttribute("aria-label"));
    if (label === "任务点未完成") return "pending";
    return null;
  });
  if (states.every((state) => state === "complete")) return "complete";
  if (states.includes("pending")) return "pending";
  return null;
}

function quizJobState() {
  if (!CARDS_URL.test(location.pathname) && !RUNNER_URL.test(location.pathname)) return null;
  const markers = [...document.querySelectorAll(".ans-job-icon:not(.ans-job-video)")];
  if (!markers.length) return null;
  if (markers.every((marker) => marker.parentElement?.classList.contains("ans-job-finished"))) return "complete";
  if (markers.some((marker) => clean(marker.getAttribute("aria-label")) === "任务点未完成")) return "pending";
  return null;
}

function currentTreeTaskState() {
  if (!RUNNER_URL.test(location.pathname)) return null;
  const node = document.querySelector("#coursetree h4.currents, #coursetree h5.currents");
  if (!node) return null;
  const own = (selector) => [...node.querySelectorAll(selector)]
    .filter((element) => element.closest("h4, h5") === node);
  const badges = own("span.jobCount, span.roundpointStudent, span.roundpoint");
  const inputs = own("input.jobUnfinishCount");
  if (badges.length > 1 || inputs.length > 1) return { kind: "unknown", count: null };
  const badge = badges[0];
  const countInput = inputs[0];
  const rawCount = countInput?.value;
  const count = rawCount !== undefined && /^\d+$/.test(String(rawCount)) ? Number(rawCount) : null;
  const badgeKind = !badge ? null : badge.classList.contains("noJob") ||
    /jobfinished\.png/i.test(getComputedStyle(badge).backgroundImage) ? "complete" :
    badge.classList.contains("orange01") || badge.classList.contains("jobCount") ? "remaining" : "unknown";
  if (count !== null && badgeKind && badgeKind !== (count ? "remaining" : "complete")) {
    return { kind: "unknown", count: null };
  }
  if (count !== null) return { kind: count ? "remaining" : "complete", count };
  if (badgeKind === "complete") return { kind: "complete", count: 0 };
  if (badgeKind === "remaining") {
    const value = clean(badge.textContent);
    return { kind: "remaining", count: /^\d+$/.test(value) ? Number(value) : null };
  }
  return { kind: "unknown", count: null };
}

function documentEntry() {
  if (!RUNNER_URL.test(location.pathname)) return null;
  return findLearningEntry("document").element;
}

function documentReader() {
  if (!SCREEN_URL.test(location.pathname) || !frameVisible()) return null;
  const images = [...document.querySelectorAll("img")];
  if (images.length < 2) return null;
  const imageCounts = new Map();
  for (const image of images) {
    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
      imageCounts.set(parent, Math.min(2, (imageCounts.get(parent) || 0) + 1));
    }
  }
  const elements = [...new Set([
    document.scrollingElement, document.documentElement, document.body,
    ...[...imageCounts.keys()].filter((element) => /^(DIV|SECTION|MAIN)$/.test(element.tagName))
  ])].filter((element) => element && element.clientHeight > 100 &&
    element.scrollHeight > element.clientHeight + 20 && imageCounts.get(element) >= 2);
  elements.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const element = elements[0];
  if (!element) return null;
  return { element, state: {
    atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 4,
    pageCount: images.length
  } };
}

function jobFinishBlocked() {
  if (!RUNNER_URL.test(location.pathname)) return false;
  return visible(document.querySelector("#jobFinishTip")) ||
    visible(document.querySelector(".maskDiv.jobFinishTip")) ||
    visible(document.querySelector("#freezePageInfo"));
}

function chapterId() {
  const fromUrl = new URLSearchParams(location.search).get("chapterId");
  if (fromUrl) return fromUrl;
  const candidates = [
    ...document.querySelectorAll("#chapterId, #curChapterId, #chapterIdid, [data-chapter-id]")
  ];
  for (const element of candidates) {
    const value = clean(element.value || element.getAttribute("value") || element.getAttribute("data-chapter-id"));
    if (value && /^[A-Za-z0-9_-]{1,160}$/.test(value)) return value;
  }
  return null;
}

function courseDirectoryUrl() {
  if (!RUNNER_URL.test(location.pathname) && !DIRECTORY_URL.test(location.pathname)) return null;
  const source = new URL(location.href);
  const prefix = source.pathname.toLowerCase().startsWith("/mooc-ans/") ? "/mooc-ans" : "";
  const url = new URL(prefix + "/mycourse/studentcourse", source.origin);
  for (const name of ["courseId", "clazzid", "enc"]) {
    const value = source.searchParams.get(name);
    if (!value) return null;
    url.searchParams.set(name, value);
  }
  return url.href;
}

function courseIdentity(url) {
  // The modern directory writes courseid/clazzid, the legacy pages write
  // courseId/clazzid. Comparing raw URLs (or enc) made every modern->legacy hop
  // look like a different course, so the identity is course + class only.
  try {
    const source = new URL(url, location.href);
    const pick = (...names) => {
      for (const name of names) {
        const value = source.searchParams.get(name);
        if (value) return clean(value).toLowerCase();
      }
      return "";
    };
    const course = pick("courseId", "courseid", "course_id");
    const clazz = pick("clazzid", "clazzId", "classid", "classId");
    if (course || clazz) return `${course}|${clazz}`;
    const enc = pick("enc");
    return enc ? `enc:${enc}` : "";
  } catch {
    return "";
  }
}

function courseMismatch(task, url) {
  if (!task?.directoryUrl) return false;
  const previous = courseIdentity(task.directoryUrl);
  const current = courseIdentity(url || location.href);
  // Only a confirmed difference counts as another course. An unreadable URL must
  // never stop the run: that guard used to fire on every normal chapter change.
  return Boolean(previous && current && previous !== current);
}

function directoryCandidates() {
  if (!DIRECTORY_URL.test(location.pathname)) return null;
  const rows = document.querySelectorAll("div.timeline div.units div.leveltwo h3.clearfix");
  const candidates = [];
  for (const row of rows) {
    const link = row.querySelector("a[href]");
    const href = link?.getAttribute("href") || "";
    if (!href || /^javascript:/i.test(href)) continue;
    let target;
    try { target = new URL(href, location.href); } catch { continue; }
    if (target.origin !== location.origin || !RUNNER_URL.test(target.pathname)) continue;
    const chapter = target.searchParams.get("chapterId");
    if (!chapter) continue;
    const badge = row.querySelector("em");
    if (!badge) continue;
    const background = getComputedStyle(badge).backgroundImage;
    if (/jobfinished\.png/i.test(background)) continue;
    if (/bg\.png/i.test(background) && getComputedStyle(badge).backgroundPosition === "-18px 0px") continue;
    candidates.push({ link, chapter });
  }
  return candidates;
}

function directoryTarget(excluded = []) {
  return directoryCandidates()?.find((candidate) => !excluded.includes(candidate.chapter)) || null;
}

function directoryStatus() {
  const rows = [...document.querySelectorAll("div.timeline div.units div.leveltwo h3.clearfix")];
  let locked = false;
  let unknown = false;
  for (const row of rows) {
    const href = row.querySelector("a[href]")?.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) {
      locked = true;
      continue;
    }
    const badge = row.querySelector("em");
    try {
      const target = new URL(href, location.href);
      if (!href || target.origin !== location.origin || !RUNNER_URL.test(target.pathname) ||
          !target.searchParams.get("chapterId") || !badge) unknown = true;
    } catch { unknown = true; }
  }
  return { rows: rows.length, locked, unknown };
}

function quizRoot() {
  if (!QUIZ_URL.test(location.pathname)) return null;
  const legacy = [...document.querySelectorAll(".TiMu.singleQuesId")];
  if (legacy.length) return legacy;
  // Probe-confirmed alternatives only. A wrapper containing several questions
  // must never be treated as a single question.
  const candidates = [...new Set([...document.querySelectorAll(".newTiMu"),
    ...document.querySelectorAll(".TiMu")])];
  const roots = candidates.filter((candidate) => {
    const titles = quizTitles(candidate);
    return titles.length === 1;
  });
  const grouped = roots.filter((root) => !roots.some((other) =>
    other !== root && root.contains?.(other)));
  return grouped.length ? grouped : null;
}

function quizTitles(root) {
  const titles = [...new Set([...root.querySelectorAll(".Zy_TItle"),
    ...root.querySelectorAll(".newZy_TItle")])];
  // A new title can wrap the old title. Count the innermost title once.
  return titles.filter((title) => !titles.some((other) =>
    other !== title && title.contains?.(other)));
}

function questionTitle(root) {
  return quizTitles(root)[0] || root.querySelector(".Zy_TItle") || root.querySelector(".newZy_TItle");
}

function videoInfo() {
  const video = currentVideo();
  if (!video) return null;
  return {
    kind: "video",
    paused: video.paused,
    ended: video.ended,
    time: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    ready: video.readyState >= 2,
    error: video.error?.message || null
  };
}

function videoQuestionRoot() {
  if (!VIDEO_URL.test(location.pathname)) return null;
  const submit = document.querySelector("#videoquiz-submit");
  if (!visible(submit)) return null;
  const root = submit.closest(".tkTopic");
  const options = root ? [...root.querySelectorAll("li.ans-videoquiz-opt")].filter(visible) : [];
  return options.length >= 2 ? root : null;
}

function videoQuestionVisible() {
  if (!VIDEO_URL.test(location.pathname)) return false;
  return visible(document.querySelector("#videoquiz-submit"));
}

function videoQuestionSurfaceVisible() {
  if (!VIDEO_URL.test(location.pathname)) return false;
  return [...document.querySelectorAll(".tkTopic")].some((root) =>
    visible(root) && root.querySelectorAll("li.ans-videoquiz-opt").length >= 2);
}

function videoQuestionFeedback() {
  if (!videoQuestionSurfaceVisible()) return "closed";
  if (visible(document.querySelector("#spanNot")) || visible(document.querySelector("#spanNotBack"))) return "incorrect";
  if (visible(document.querySelector("#videoquiz-continue"))) return "continue";
  if (visible(document.querySelector("#spanHas"))) return "correct";
  if (visible(document.querySelector("#videoquiz-submitting"))) return "submitting";
  return "open";
}

function captchaDialog() {
  if (!RUNNER_URL.test(location.pathname)) return null;
  const dialog = document.querySelector("#chapterVerificationCode");
  return visible(dialog) ? dialog : null;
}

function captchaErrorVisible() {
  return RUNNER_URL.test(location.pathname) && visible(document.querySelector("#chapterVerificationCodeTip"));
}

function captchaControls(dialog) {
  if (!dialog) return null;
  const inputs = [...dialog.querySelectorAll("input")].filter((input) =>
    visible(input) && ["text", "tel", "number", ""].includes(input.type));
  const buttons = [...dialog.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
    .filter((button) => visible(button) && /^(继续学习|确定|提交)$/.test(textOf(button) || button.value || ""));
  return inputs.length === 1 && buttons.length === 1 ? { input: inputs[0], button: buttons[0] } : null;
}

function assertNoCaptchaOverlay() {
  try {
    const page = window.top.document;
    if (visible(page.querySelector("#chapterVerificationCodeTip"))) throw new Error("验证码错误一次，已暂停；请人工核对");
    if (visible(page.querySelector("#chapterVerificationCode"))) throw new Error("验证码弹窗待处理");
  } catch (error) {
    if (/验证码/.test(error?.message || "")) throw error;
  }
}

function stripOptionPrefix(value, id) {
  const text = clean(value);
  if (!/^[A-Z]$/.test(id || "")) return text;
  // A. text / A、text / A.中文 are labels; U.S. and B.C. are content.
  return text.replace(new RegExp("^" + id + "(?:[、．]\\s*|\\.\\s+|\\.(?=[^A-Za-z0-9\\s])\\s*|\\s+)"), "");
}

function hasQuestionVisual(scope) {
  if (!scope) return false;
  return [...scope.querySelectorAll("img, canvas, svg")].some((image) => {
    if (!visible(image)) return false;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) return false;
    const decorative = image.getAttribute("aria-hidden") === "true" ||
      ["presentation", "none"].includes(image.getAttribute("role"));
    return !(decorative && textOf(scope));
  });
}

function videoQuestionOptions(root) {
  return [...root.querySelectorAll("li.ans-videoquiz-opt")].filter(visible).map((row, index) => ({
    id: LETTERS[index],
    row,
    label: row.querySelector("label"),
    input: row.querySelector("input[name='ans-videoquiz-opt']")
  }));
}

function videoQuestionShape() {
  const root = videoQuestionRoot();
  if (!root) return {};
  const options = videoQuestionOptions(root);
  if (options.length < 2 || options.length > LETTERS.length || options.some((option) =>
    !option.label || !option.input || option.input.disabled || !["radio", "checkbox"].includes(option.input.type) ||
    option.input.type !== options[0].input.type)) return {};
  return {
    count: options.length,
    inputType: options[0].input.type,
    selected: options.filter((option) => option.input.checked).map((option) => option.id)
  };
}

function comboKey(choices) {
  return [...new Set((Array.isArray(choices) ? choices : [])
    .map((choice) => String(choice).toUpperCase().trim()).filter(Boolean))].sort().join("");
}

function appendQuestionAttempt(list, choices) {
  const combo = comboKey(choices);
  const next = Array.isArray(list) ? list.slice() : [];
  if (combo && !next.some((item) => comboKey(item) === combo)) next.push(combo.split(""));
  return next.slice(-5);
}

function readVideoQuestion() {
  const root = videoQuestionRoot();
  if (!root) throw new Error("视频弹题结构无法识别，已停止自动播放");
  const options = videoQuestionOptions(root);
  const types = options.map((option) => option.input?.type);
  if (options.length < 2 || options.length > LETTERS.length || options.some((option) => !option.label || !option.input) ||
      !types.every((type) => ["radio", "checkbox"].includes(type) && type === types[0])) {
    throw new Error("视频弹题选项结构不完整，请人工检查");
  }
  const heading = textOf(root);
  let type = /多选题/.test(heading) ? "multiple" : /判断题/.test(heading) ? "judgment" : /单选题/.test(heading) ? "single" : "unknown";
  if (type === "unknown") {
    const labels = options.map((option) => stripOptionPrefix(textOf(option.label), option.id));
    const judgment = labels.length === 2 && labels.some((value) => /^(对|正确|是|true|√)$/i.test(value)) &&
      labels.some((value) => /^(错|错误|否|false|×)$/i.test(value));
    type = types[0] === "checkbox" ? "multiple" : judgment ? "judgment" : "single";
    recordDiagnostic("answer_result", { code: "ANSWER_OK", stage: "video_type_inferred", optionCount: options.length, inputType: types[0] });
  }
  if ((type === "multiple") !== (types[0] === "checkbox")) {
    throw new Error("视频弹题题型无法确认，请人工检查");
  }
  const title = root.querySelector(".tkItem_title") || root.querySelector(".ans-videoquiz-title") || root.querySelector(".tkTopic_title");
  const titleText = textOf(title);
  const stem = /^(判断题|单选题|多选题)[：:。]?\s*$/.test(titleText) ? "" : titleText;
  const optionTexts = options.map((option) => stripOptionPrefix(textOf(option.label || option.row), option.id));
  const visibleText = [stem, ...optionTexts].join(" ");
  const encrypted = Boolean(root.querySelector(".font-cxsecret") || /[\uE000-\uF8FF]/.test(visibleText));
  const optionImage = options.some((option) => hasQuestionVisual(option.row));
  const titleImage = hasQuestionVisual(title);
  const needsImage = encrypted || titleImage || optionImage || !stem || optionTexts.some((text) => !text);
  recordDiagnostic("answer_result", { code: "ANSWER_OK", stage: "read", titleKind: title?.matches?.(".tkItem_title") ? "stem" : title?.matches?.(".tkTopic_title") ? "type" : "other",
    stemLength: stem.length, optionCount: options.length, usedImages: needsImage });
  return {
    id: "video-question",
    type,
    stem: needsImage ? "[题干见截图]" : stem.slice(0, 3000),
    needsImage,
    options: options.map((option, index) => ({ id: option.id, text: needsImage ? "[选项见截图]" : optionTexts[index].slice(0, 1000) }))
  };
}

async function fillVideoQuestion(answer) {
  const root = videoQuestionRoot();
  if (!root) throw new Error("视频弹题已变化，停止填写");
  const options = videoQuestionOptions(root);
  if (!options.length || options.some((option) => !option.input || !option.label)) throw new Error("视频弹题选项已变化");
  const allowed = new Set(options.map((option) => option.id));
  if (!answer.choices.length || answer.choices.some((choice) => !allowed.has(choice))) throw new Error("视频弹题答案与页面选项不匹配");
  if (options[0].input.type === "radio") {
    if (answer.choices.length !== 1) throw new Error("视频弹题单选答案不合法");
    const choice = options.find((option) => option.id === answer.choices[0]);
    if (!choice.input.checked) choice.label.click();
  } else {
    for (const option of options) {
      if (option.input.checked !== answer.choices.includes(option.id)) option.label.click();
    }
  }
  await wait(350);
  if (options.some((option) => option.input.checked !== answer.choices.includes(option.id))) {
    throw new Error("视频弹题选中状态未生效，停止提交");
  }
  return { filled: true };
}

async function retryVideoQuestion(data = {}) {
  const root = videoQuestionRoot();
  if (!root || !visible(document.querySelector("#spanNot"))) {
    throw new Error("视频弹题错误反馈已变化，停止重试");
  }
  const options = videoQuestionOptions(root);
  if (options.length !== 2 || options.some((option) =>
    !option.label || option.input?.type !== "radio" || option.input.disabled)) {
    return { action: "unsupported" };
  }
  const selected = options.filter((option) => option.input.checked);
  if (selected.length !== 1) throw new Error("视频弹题当前选项无法确认，停止重试");
  const alternative = options.find((option) => !option.input.checked);
  if ((Array.isArray(data.exclude) ? data.exclude : []).some((combo) => comboKey(combo) === comboKey([alternative.id]))) {
    return { action: "duplicate", choices: [alternative.id] };
  }
  alternative.label.click();
  await wait(350);
  if (!videoQuestionSurfaceVisible()) return { action: "closed" };
  if (!alternative.input.checked || selected[0].input.checked) {
    throw new Error("视频弹题改选未生效，停止重试");
  }
  const choices = [alternative.id];
  if (data.autoSubmit === false) return { action: "selected", choices };
  const continueButton = document.querySelector("#videoquiz-continue");
  if (visible(continueButton)) {
    continueButton.click();
    return { action: "continued", choices };
  }
  const submit = document.querySelector("#videoquiz-submit");
  if (visible(submit) && !visible(document.querySelector("#videoquiz-submitting"))) {
    submit.click();
    return { action: "submitted", choices };
  }
  return { action: "waiting", choices };
}

function getQuestionElements() {
  const roots = quizRoot();
  return roots ? [...new Set(roots)] : [];
}

function ensureQuizVisible() {
  if (!QUIZ_URL.test(location.pathname) || !frameVisible() || !getQuestionElements().some(visible)) {
    throw new Error("测验标签已切换或题目不可见，停止填写与提交");
  }
}

function questionId(root, index) {
  const explicit = root.getAttribute("data") || root.id;
  if (explicit) return String(explicit);
  const inputs = [...questionInputs(root), ...root.querySelectorAll("input[type='hidden'][name^='answer']")];
  const names = [...new Set(inputs.map((input) =>
    String(input.name || "").match(/^answer(?:check)?(\d+)$/i)?.[1]).filter(Boolean))];
  if (names.length === 1) return names[0] || null;
  // This id is only meaningful for the current ordered quiz DOM. The shape
  // snapshot below rejects a changed or reordered quiz before any fill/verify.
  return Number.isInteger(index) && index >= 0 ? `question-${index + 1}` : null;
}

function positionalQuestionId(index) {
  return Number.isInteger(index) && index >= 0 ? `question-${index + 1}` : null;
}

function quizQuestionIds(roots) {
  const base = roots.map((root) => {
    const explicit = root.getAttribute("data") || root.id;
    if (explicit) return String(explicit);
    const inputs = [...questionInputs(root), ...root.querySelectorAll("input[type='hidden'][name^='answer']")];
    const names = [...new Set(inputs.map((input) =>
      String(input.name || "").match(/^answer(?:check)?(\d+)$/i)?.[1]).filter(Boolean))];
    return names.length === 1 ? names[0] || null : null;
  });
  const counts = new Map();
  for (const id of base) if (id) counts.set(id, (counts.get(id) || 0) + 1);
  const used = new Set();
  return base.map((id, index) => {
    let resolved = id && counts.get(id) === 1 ? id : positionalQuestionId(index);
    if (!resolved || used.has(resolved)) resolved = `question-position-${index + 1}`;
    used.add(resolved);
    return resolved;
  });
}

function quizQuestionFingerprint(root) {
  const title = questionTitle(root);
  const options = optionElements(root);
    return JSON.stringify({
    explicit: String(root.getAttribute?.("data") || root.id || ""),
    title: textOf(title),
    type: questionType(root),
    options: options.map((option) => ({ id: option.id, text: option.text })),
    fields: hiddenAnswerFields(root).map((field) => String(field.name || ""))
  });
}

function quizQuestionShape(roots) {
  return roots.map((root) => quizQuestionFingerprint(root));
}

function rememberQuizShape(roots) {
  quizShapeSnapshot = quizQuestionShape(roots);
}

function ensureQuizShape(roots) {
  if (!quizShapeSnapshot) return;
  const current = quizQuestionShape(roots);
  if (current.length !== quizShapeSnapshot.length ||
      current.some((value, index) => value !== quizShapeSnapshot[index])) {
    throw new Error("测验题目数量、顺序或内容已变化，停止填写并请重新读取");
  }
}

function questionInputs(root) {
  const native = [...root.querySelectorAll("input[type='radio'], input[type='checkbox']")]
    .filter((input) => /^answer(?:check)?/i.test(input.name || ""));
  const aria = [...root.querySelectorAll("[role='radio'], [role='checkbox']")]
    .filter((input) => !native.some((item) => input !== item && input.contains?.(item)));
  return [...new Set([...native, ...aria])];
}

function controlType(control) {
  return control?.getAttribute?.("role") || control?.type || "";
}

function stateElements(control) {
  const elements = [control, control?.parentElement,
    control?.closest?.("li"), control?.closest?.("label"), control?.closest?.("[role='option']")]
    .filter(Boolean);
  return [...new Set(elements)].filter((element) => element === control ||
    [...(element.querySelectorAll?.("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']") || [])]
      .every((item) => item === control || control?.contains?.(item)));
}

function parseControlState(value) {
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes", "on", "checked", "selected"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "unchecked", "unselected"].includes(normalized)) return false;
  return null;
}

function controlSelected(control) {
  if (!control) return null;
  // A native input may also have an explicit ARIA role; its checked property is authoritative.
  if (typeof control.checked === "boolean") return control.checked;
  for (const element of stateElements(control)) {
    for (const name of ["aria-checked", "aria-selected", "data-checked", "data-selected", "data-state"]) {
      const state = parseControlState(element.getAttribute?.(name));
      if (state !== null) return state;
    }
    const classNames = [...(element.classList || [])].join(" ");
    const positive = /(?:^|\s)(?:(?:is|option|num_option)[-_])?(?:selected|checked)(?:$|\s)/i.test(classNames);
    const negative = /(?:^|\s)(?:(?:is|option|num_option)[-_])?(?:unselected|unchecked)(?:$|\s)/i.test(classNames);
    if (positive && negative) return null;
    if (positive) return true;
    if (negative) return false;
  }
  return null;
}

function controlDisabled(control) {
  return control?.disabled === true || control?.matches?.(":disabled") === true ||
    stateElements(control).some((element) => element.getAttribute?.("aria-disabled") === "true");
}

function hiddenAnswerFields(root) {
  return [...root.querySelectorAll("input[type='hidden'][name^='answer']")]
    .filter((field) => /^answer(?:check)?\d*$/i.test(field.name || ""));
}

function hiddenAnswerChoices(root, ids) {
  const fields = hiddenAnswerFields(root);
  if (!fields.length) return null;
  const values = fields.map((field) => clean(field.value));
  if (values.every((value) => !value)) return new Set();
  const choices = new Set();
  for (const value of values) {
    for (const token of value.toUpperCase().split(/[\s,，、;；|/]+/).filter(Boolean)) {
      if (/^[A-Z]$/.test(token) && ids.includes(token)) choices.add(token);
      const number = Number(token);
      if (Number.isInteger(number) && number >= 1 && number <= ids.length) choices.add(ids[number - 1]);
    }
  }
  return choices.size ? choices : null;
}

function allowBlankInitialState(root) {
  const controls = questionInputs(root);
  return controls.length > 0 && controls.every((control) => controlSelected(control) === null) &&
    hiddenAnswerFields(root).length > 0 && hiddenAnswerFields(root).every((field) => !clean(field.value));
}

function blankEditors(root) {
  return [...root.querySelectorAll("textarea[name^='answerEditor']")]
    .filter((element) => /^answerEditor/i.test(element.name || ""));
}

function optionElements(root) {
  const inputs = questionInputs(root);
  const values = inputs.map((input) => clean(input.value || input.getAttribute?.("data-value") || "").toUpperCase());
  const useValues = values.every((value, index) => value === LETTERS[index]);
  const ids = inputs.map((input, index) => useValues ? values[index] : LETTERS[index]);
  const hiddenChoices = hiddenAnswerChoices(root, ids);
  return inputs.map((input, index) => {
    const row = input.closest?.("li") || input.closest?.("label") || input.closest?.("[role='option']") ||
      (input.parentElement !== root ? input.parentElement : input);
    const id = useValues ? values[index] : LETTERS[index];
    const directSelected = controlSelected(input);
    return {
      id,
      row,
      text: stripOptionPrefix(textOf(row?.querySelector?.("a.fl.after") || row), id),
      input,
      target: input.closest?.("label") || input,
      selected: directSelected !== null ? directSelected :
        hiddenChoices !== null ? hiddenChoices.has(id) : allowBlankInitialState(root) ? false : null
    };
  });
}

function questionType(root) {
  if (blankEditors(root).length) return "fill";
  const inputs = questionInputs(root);
  if (inputs.length < 2) return "unknown";
  if (inputs.every((input) => controlType(input) === "checkbox")) return "multiple";
  if (!inputs.every((input) => controlType(input) === "radio")) return "unknown";
  const values = inputs.map((input) => clean(input.value));
  if (values.length === 2 && new Set(values.map((value) => value.toLowerCase())).size === 2 &&
      values.every((value) => /^(true|false)$/i.test(value))) return "judgment";
  const labels = optionElements(root).map((option) => option.text);
  if (labels.length === 2 && labels.some((value) => /^(对|正确|是|true|√)$/i.test(value)) &&
      labels.some((value) => /^(错|错误|否|false|×)$/i.test(value))) {
    return "judgment";
  }
  // Radio values can be 1/2/3/4 or implementation-specific identifiers.
  // The option order is converted to A/B/C/D by optionElements().
  return "single";
}

function extractQuestions() {
  quizShapeSnapshot = null;
  quizIdSnapshot = null;
  const roots = getQuestionElements();
  if (!roots.length) return { error: "未识别到章节测验题目" };
  const controls = roots.flatMap((root) => questionInputs(root));
  if (controls.some(controlDisabled)) {
    return { error: "题目已加载，但检测到禁用选项；已暂停，请确认是否为只读页面并复制页面探针", unsupportedControls: true };
  }
  const ids = quizQuestionIds(roots);
  const questions = roots.map((root, index) => {
    const options = optionElements(root);
    const type = questionType(root);
    const title = questionTitle(root);
    const stem = textOf(title);
    const encryptedTitle = Boolean(title?.matches?.(".font-cxsecret") ||
      title?.querySelector?.(".font-cxsecret") || /[\uE000-\uF8FF]/.test(stem));
    const hasQuestionImage = hasQuestionVisual(title) ||
      (type !== "fill" && options.some((option) => hasQuestionVisual(option.row)));
    const hasPrivateText = /[\uE000-\uF8FF]/.test(stem + options.map((option) => option.text).join(""));
    const needsImage = type === "fill" ? encryptedTitle || hasQuestionImage || hasPrivateText :
      Boolean(root.matches(".font-cxsecret") || root.querySelector(".font-cxsecret") ||
        hasQuestionImage || hasPrivateText);
    // Only hide the text when the text itself is unusable. A decorative image in
    // an option row used to blank out perfectly readable text, which made a
    // failed screenshot fatal instead of a harmless fallback.
    // Placeholders are per-field: a question with a readable stem but one
    // unreadable option keeps its stem instead of losing all of its text.
    const usableText = (value) => Boolean(clean(value)) && !/[\uE000-\uF8FF]/.test(value);
    const stemUnusable = Boolean(encryptedTitle || !usableText(stem));
    const optionUsable = options.map((option) => usableText(option.text));
    // Screenshots are the expensive part (image tokens), so only take one when
    // the text cannot carry the question: unreadable text, or a stem that points
    // at a figure ("如下图"/"表中"…).
    const pointsAtFigure = /下图|上图|如图|图中|图示|如下图|下表|表格|见图|图\s*\d/i
      .test(clean(stem) + " " + options.map((option) => option.text).join(" "));
    const captureNeeded = needsImage && (stemUnusable || !optionUsable.every(Boolean) || pointsAtFigure);
    return {
      id: ids[index],
      type,
      stem: stemUnusable ? "[题干见截图]" : clean(stem).slice(0, 3000),
      needsImage,
      captureNeeded,
      textUsable: !stemUnusable && optionUsable.every(Boolean),
      blankCount: blankEditors(root).length,
      options: options.map(({ id, text }, optionIndex) => ({ id,
        text: optionUsable[optionIndex] ? text.slice(0, 1000) : "[选项见截图]" }))
    };
  });
  if (roots.some((root) => optionElements(root).some((option) => option.selected === null))) {
    return { error: "题目已加载，但当前选项状态规则无法确认；已暂停，请复制页面探针", unsupportedControls: true };
  }
  const unsupported = roots.find((root, index) => questions[index].type === "unknown" &&
    root.querySelector("input[name^='tiankongsize']"));
   if (unsupported) return { error: "检测到填空题，但编辑器尚未加载；请等待后重试", retryable: true };
  if (questions.some((question) => question.type === "unknown")) {
    return { error: "题干已加载，但未识别到受支持的答题控件；可能是自定义选项或只读页面。已暂停，请复制页面探针", unsupportedControls: true };
  }
  const bad = questions.find((question) => question.type === "unknown" || !question.stem ||
    (question.type === "fill" ? question.blankCount < 1 :
      question.options.length < 2 || question.options.length > LETTERS.length || question.options.some((option) => !option.id || !option.text) ||
      new Set(question.options.map((option) => option.id)).size !== question.options.length));
  if (bad) return { error: `题目 ${bad.id} 识别不完整，请人工检查` };
  if (questions.some((question) => !question.id) || new Set(questions.map((question) => question.id)).size !== questions.length) {
    return { error: "题目缺少稳定编号，停止填写以免答案错位" };
  }
  if (questions.some((question) => /[\uE000-\uF8FF]/.test(question.stem + question.options.map((option) => option.text).join("")))) return { error: "题目含有无法识别的特殊字符" };
  rememberQuizShape(roots);
  quizIdSnapshot = ids;
  return { questions };
}

function topViewportRect(element) {
  const rect = element.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;
  let current = window;
  // Validate the question region at every viewport, not the whole player.
  while (true) {
    if (x < -2 || y < -2 || x + rect.width > current.innerWidth + 2 ||
        y + rect.height > current.innerHeight + 2) {
      throw new Error("题干或选项超出可见区域，请缩小页面或调整滚动位置后重试");
    }
    if (current === current.top) break;
    let iframe;
    try { iframe = current.frameElement; } catch { /* cross-origin boundary */ }
    if (!iframe) throw new Error("无法定位题目内嵌页面，请优先使用文字识别或人工处理");
    const parentRect = iframe.getBoundingClientRect();
    const outerWidth = iframe.offsetWidth || iframe.clientWidth + 2 * iframe.clientLeft;
    const outerHeight = iframe.offsetHeight || iframe.clientHeight + 2 * iframe.clientTop;
    if ((outerWidth && Math.abs(parentRect.width / outerWidth - 1) > 0.02) ||
        (outerHeight && Math.abs(parentRect.height / outerHeight - 1) > 0.02)) {
      throw new Error("题目框架存在缩放，无法确认截图范围，请使用文字识别或人工处理");
    }
    x += parentRect.left + iframe.clientLeft;
    y += parentRect.top + iframe.clientTop;
    current = current.parent;
  }
  return { x, y, width: rect.width, height: rect.height, viewportWidth: current.innerWidth, viewportHeight: current.innerHeight };
}

function scrollTargetThroughFrames(element) {
  element.scrollIntoView({ block: "center", behavior: "auto" });
  let current = window;
  let rect = element.getBoundingClientRect();
  while (current !== current.top) {
    const iframe = current.frameElement;
    if (!iframe) throw new Error("无法定位测验内嵌页面的屏幕位置");
    const parent = current.parent;
    const frameRect = iframe.getBoundingClientRect();
    const targetCenter = frameRect.top + iframe.clientTop + rect.top + rect.height / 2;
    parent.scrollBy(0, targetCenter - parent.innerHeight / 2);
    const movedFrame = iframe.getBoundingClientRect();
    rect = {
      top: movedFrame.top + iframe.clientTop + rect.top,
      left: movedFrame.left + iframe.clientLeft + rect.left,
      width: rect.width,
      height: rect.height
    };
    current = parent;
  }
}

// The question's own <img>/<canvas> pixels can be read without any screenshot.
// Icons and spacers are skipped so a decorative 收藏/纠错 icon never becomes the
// image the model reasons about.
function questionImageParts(elements) {
  const parts = [];
  for (const element of elements || []) {
    for (const media of element?.querySelectorAll?.("img, canvas") || []) {
      if (!visible(media)) continue;
      const tag = String(media.tagName || "").toUpperCase();
      if (tag === "IMG") {
        const url = clean(media.currentSrc || media.getAttribute?.("src"));
        if (!url || !/^(?:https?:\/\/|data:image\/)/i.test(url)) continue;
        const width = Number(media.naturalWidth || media.width) || 0;
        const height = Number(media.naturalHeight || media.height) || 0;
        if (width && height && (width < 32 || height < 32)) continue;
        parts.push({ kind: "url", url });
      } else if (tag === "CANVAS") {
        parts.push({ kind: "canvas", element: media });
      }
    }
    // Some quizzes paint figures as CSS backgrounds instead of <img>.
    const seen = new Set(parts.filter((part) => part.url).map((part) => part.url));
    const nodes = [element, ...(element?.querySelectorAll?.("*") || [])].slice(0, 300);
    for (const node of nodes) {
      let shown = false;
      try { shown = visible(node); } catch { shown = false; }
      if (!shown) continue;
      let background = "";
      try { background = getComputedStyle(node).backgroundImage || ""; } catch { continue; }
      const match = /url\(["']?(.+?)["']?\)/.exec(background);
      if (!match) continue;
      const url = match[1];
      if (!/^(?:https?:\/\/|data:image\/)/i.test(url) || seen.has(url)) continue;
      const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
      if ((rect.width || 0) < 32 || (rect.height || 0) < 32) continue;
      seen.add(url);
      parts.push({ kind: "url", url });
    }
  }
  return parts;
}

function blobDataUrl(blob) {
  if (typeof FileReader !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function imageDataUrl(url) {
  if (/^data:image\//i.test(url)) return url;
  try {
    const response = await fetch(url, { credentials: "include" });
    if (response.ok) {
      const dataUrl = await blobDataUrl(await response.blob());
      if (dataUrl) return dataUrl;
    }
  } catch { /* cross-origin: let the background fetch it with host permissions */ }
  try {
    const result = await chrome.runtime.sendMessage({ type: "FETCH_IMAGE", url });
    return result?.dataUrl || null;
  } catch {
    return null;
  }
}

async function loadImageBitmap(source) {
  if (typeof createImageBitmap !== "function") return null;
  try {
    if (source.kind === "canvas") return await createImageBitmap(source.element);
    const dataUrl = await imageDataUrl(source.url);
    if (!dataUrl) return null;
    const response = await fetch(dataUrl);
    return await createImageBitmap(await response.blob());
  } catch {
    return null;
  }
}

async function composeElementImages(elements) {
  if (!elements?.length || typeof document.createElement !== "function") return null;
  const parts = questionImageParts(elements);
  if (!parts.length) return null;
  const bitmaps = [];
  for (const part of parts.slice(0, 6)) {
    const bitmap = await loadImageBitmap(part);
    if (bitmap?.width && bitmap?.height) bitmaps.push(bitmap);
  }
  if (!bitmaps.length) return null;
  const width = Math.min(1600, Math.max(...bitmaps.map((bitmap) => bitmap.width)));
  const heights = bitmaps.map((bitmap) => Math.max(1, Math.round(bitmap.height * (width / bitmap.width))));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.min(4000, heights.reduce((sum, height) => sum + height, 0)));
  const context = canvas.getContext?.("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  let offset = 0;
  for (let index = 0; index < bitmaps.length; index++) {
    if (offset + heights[index] > canvas.height) break;
    context.drawImage(bitmaps[index], 0, offset, width, heights[index]);
    offset += heights[index];
  }
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

// Save questions (and what was chosen) for later review. One entry per question,
// later writes replace earlier ones so reruns do not pile up duplicates.
async function rememberQuestions(tabId, questions, answers, reason) {
  const key = "review:" + tabId;
  const stored = (await chrome.storage.local.get(key))[key] || [];
  const byId = new Map(stored.map((item) => [String(item.id), item]));
  const chosen = new Map((answers || []).map((answer) => [String(answer?.id), answer]));
  for (const question of questions || []) {
    const id = String(question.id);
    const answer = chosen.get(id);
    byId.set(id, {
      id, at: Date.now(), reason,
      stem: question.stem,
      options: question.options || [],
      choice: answer ? (answer.choices || answer.blanks || []) : []
    });
  }
  const merged = [...byId.values()].slice(-200);
  await chrome.storage.local.set({ [key]: merged });
  return questions ? questions.length : merged.length;
}

// Random answers for every question, used when the user does not want any API call.
function buildRandomAnswers(questions) {
  const answers = [];
  guessMissingAnswers(questions, answers);
  for (const question of questions || []) {
    if (answers.some((answer) => String(answer.id) === String(question.id))) continue;
    if (question.type !== "fill") continue;
    const count = Math.max(1, Number(question.blankCount) || 1);
    answers.push({ id: question.id, choices: [], blanks: Array(count).fill("无"), guessed: true });
  }
  return answers;
}

// Fill the gaps with a random option so the sheet can be submitted; the caller
// stores what was guessed. Fill-in questions cannot be guessed reliably.
function guessMissingAnswers(questions, answers) {
  const answered = new Set((answers || []).map((answer) => String(answer?.id)));
  const guessed = [];
  for (const question of questions || []) {
    if (answered.has(String(question.id))) continue;
    const pool = (question.options || []).map((option) => option.id).filter(Boolean);
    if (!pool.length) continue;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    answers.push({ id: question.id, choices: [pick], blanks: [], guessed: true });
    guessed.push({ id: question.id, stem: question.stem, options: question.options, choice: [pick] });
  }
  return guessed;
}

async function captureQuestion(id) {
  const roots = getQuestionElements();
  ensureQuizShape(roots);
  const ids = quizIdSnapshot || quizQuestionIds(roots);
  const root = roots.find((candidate, index) => ids[index] === String(id));
  if (!root) throw new Error(`题目 ${id} 已变化，无法截图`);
  if (questionType(root) === "fill") {
    const title = questionTitle(root);
    if (!title) throw new Error(`题目 ${id} 缺少题干，无法截图`);
    return captureElement(title, id, 20);
  }
  return captureElement(root, id);
}

async function captureVideoQuestion() {
  const root = videoQuestionRoot();
  if (!root) throw new Error("视频弹题已消失或结构不完整，无法截图");
  const title = root.querySelector(".tkItem_title") || root.querySelector(".ans-videoquiz-title") || root.querySelector(".tkTopic_title");
  const options = videoQuestionOptions(root).map((option) => option.row);
  const targets = [title, ...options].filter(Boolean);
  return captureElements(targets.length ? targets : [root], "video-question");
}

async function captureElement(root, id, minHeight = 60) {
  return captureElements([root], id, minHeight);
}

async function captureElements(elements, id, minHeight = 60) {
  if (!elements.length) throw new Error(`题目 ${id} 没有可截图区域`);
  // Prefer the question's own image files: that needs no visible window and keeps
  // working while the course tab sits in the background.
  const composed = await composeElementImages(elements);
  if (composed) return { id, image: composed };
  scrollTargetThroughFrames(elements[0]);
  let box;
  let previous;
  let stable = 0;
  let boundsError;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await wait(150);
    try {
      const rects = elements.map((element) => topViewportRect(element));
      const left = Math.min(...rects.map((rect) => rect.x));
      const top = Math.min(...rects.map((rect) => rect.y));
      const right = Math.max(...rects.map((rect) => rect.x + rect.width));
      const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
      box = { x: left, y: top, width: right - left, height: bottom - top,
        viewportWidth: rects[0].viewportWidth, viewportHeight: rects[0].viewportHeight };
      boundsError = null;
    }
    catch (error) { boundsError = error; continue; }
    const signature = [box.x, box.y, box.width, box.height].map((value) => Math.round(value)).join(":");
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    if (stable >= 2) break;
  }
  if (stable < 2 || !box) throw boundsError || new Error(`题目 ${id} 页面位置未稳定，停止识别`);
  const rightEdge = Math.min(box.x + box.width, box.viewportWidth);
  const bottomEdge = Math.min(box.y + box.height, box.viewportHeight);
  const leftEdge = Math.max(0, box.x);
  const topEdge = Math.max(0, box.y);
  box = { ...box, x: leftEdge, y: topEdge, width: rightEdge - leftEdge, height: bottomEdge - topEdge };
  if (box.width < 100 || box.height < minHeight) throw new Error(`题目 ${id} 可见区域太小，停止识别`);
  const shot = await chrome.runtime.sendMessage({ type: "CAPTURE_TAB" });
  if (shot?.error) throw new Error(shot.error);
  const image = await new Promise((resolve, reject) => {
    const candidate = new Image();
    candidate.onload = () => resolve(candidate);
    candidate.onerror = () => reject(new Error("无法解码题目截图"));
    candidate.src = shot;
  });
  const scaleX = image.naturalWidth / box.viewportWidth;
  const scaleY = image.naturalHeight / box.viewportHeight;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.width * scaleX);
  canvas.height = Math.ceil(box.height * scaleY);
  canvas.getContext("2d").drawImage(image, box.x * scaleX, box.y * scaleY,
    canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
  return { id, image: canvas.toDataURL("image/png") };
}

async function verifyAnswers(answers) {
  // Some pages report one control as unreadable (no checked/aria/class marker).
  // Before stopping, re-click the intended choices and re-read a few times: a
  // miss-registered click is far more common than a truly unreadable option.
  let lastProblem = null;
  for (let round = 0; round <= 2; round++) {
    const roots = getQuestionElements();
    if (roots.length !== answers.length) throw new Error("填写后题数发生变化，停止提交");
    ensureQuizShape(roots);
    const ids = quizIdSnapshot || quizQuestionIds(roots);
    const byId = new Map(answers.map((answer) => [String(answer.id), answer]));
    const problems = [];
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index];
      const id = ids[index];
      if (!id) throw new Error("题目缺少稳定编号，停止核对");
      const answer = byId.get(id);
      if (!answer) throw new Error(`题目 ${id} 无法核对答案`);
      if (questionType(root) === "fill") {
        const result = await chrome.runtime.sendMessage({ type: "VERIFY_BLANKS", questionId: id, blanks: answer.blanks });
        if (result?.error) throw new Error(result.error);
        if (result?.verified !== answer.blanks.length) throw new Error(`题目 ${id} 的填空内容未通过核对`);
        continue;
      }
      const options = optionElements(root);
      if (options.length < 2) throw new Error(`题目 ${id} 的选项结构异常，停止提交`);
      const expected = new Set(answer.choices.map(String));
      const radio = options.some((option) => controlType(option.input) === "radio");
      for (const option of options) {
        const want = expected.has(String(option.id));
        if (option.selected === want) continue;
        // A radio group has one winner: an unreadable option that is not the
        // answer is simply not selected, because the chosen one is confirmed.
        if (option.selected === null && !want && radio) continue;
        problems.push({ id, option, want, radio, unknown: option.selected === null });
      }
    }
    if (!problems.length) return { verified: answers.length };
    lastProblem = problems[0];
    if (round === 2) break;
    for (const problem of problems) {
      // In a radio group clicking the answer already clears the others; clicking
      // an unwanted one afterwards would undo the repair.
      if (problem.radio && !problem.want) continue;
      try { problem.option.target.click(); } catch { /* retry below */ }
    }
    await wait(400);
  }
  if (lastProblem?.unknown) {
    throw new Error(`题目 ${lastProblem.id} 的 ${lastProblem.option.id} 项选中状态读不出来（页面用了无法识别的样式），已重试 3 次仍无法确认；请复制页面探针`);
  }
  throw new Error(`题目 ${lastProblem?.id || ""} 的页面选中状态与答案不一致，已重试 3 次；停止提交`);
}

function findButton(pattern) {
  return [...document.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
    .find((element) => visible(element) && pattern.test(textOf(element) || element.value || ""));
}

function findLearningEntry(kind) {
  const patterns = {
    quiz: /^(?:(?:章节|单元)(?:测验|测试|作业|练习)|课后(?:练习|作业|测试)|在线练习|随堂(?:测验|测试|练习))$/i,
    video: /^(?:视频|视频课程|课程视频|视频学习|教学视频)$/i,
    document: /^(?:主要内容|文档|课件|课程课件|阅读材料|学习资料)$/i
  };
  const normalizeLabel = (value) => clean(value).replace(/\s+/g, "")
    .replace(/^\d+[.、]?/, "").replace(/(?:[（(]\d+[)）]|\d+)$/, "");
  const labelPattern = patterns[kind];
  if (!labelPattern) return { element: null, candidateCount: 0, ambiguous: false };
  const candidates = [
    ...document.querySelectorAll(
      "#dct2, #dct3, [id^='dct'], [class*='zt_tab'], [role='tab'], [role='button'], [role='menuitem'], [onclick], a[href], button, input[type='button'], input[type='submit']"
    ),
    document.querySelector("#dct1"),
    document.querySelector("#dct1[title='主要内容']"),
    document.querySelector("#dct2[title='章节测验'], #dct2[title='章节测试'], #dct2[title='课后练习'], #dct2[title='课后作业']"),
    ...document.querySelectorAll("[title], div, span, li")
  ];
  const seen = new Set();
  const matches = [];
  for (const element of candidates) {
    if (seen.has(element) || !visible(element)) continue;
    seen.add(element);
    if (modernElementLocked(element, null)) continue;
    const href = clean(element.getAttribute?.("href"));
    let quizLink = false;
    if (href && !href.startsWith("#")) {
      try {
        const url = new URL(href, document.baseURI || location.href);
        if (/^javascript:/i.test(href)) {
          if (!element.getAttribute?.("onclick")) continue;
        } else if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin) continue;
        quizLink = /^(?:\/mooc-ans)?\/(?:api\/work|work\/(?:doHomeWorkNew|selectWorkQuestion))\/?$/i.test(url.pathname);
      } catch (_) { continue; }
    }
    const rawLabels = [
      element.value,
      String(element.textContent || element.innerText || "").length <= 80 ? textOf(element) : "",
      element.getAttribute?.("title"),
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("data-title")
    ];
    const labels = rawLabels.map(normalizeLabel);
    const labelMatch = labels.some((label) => labelPattern.test(label));
    if (!labelMatch && !(kind === "quiz" && quizLink)) continue;
    if (kind !== "quiz" && quizLink) continue;
    const role = clean(element.getAttribute?.("role")).toLowerCase();
    const tag = clean(element.tagName).toUpperCase();
    const semanticLabel = [labels[0], ...labels.slice(2)].some((label) => labelPattern.test(label));
    const score = labelMatch ?
      (role === "tab" || role === "button" || tag === "BUTTON" || tag === "INPUT" ? 5 :
        /^(?:A|LI|SPAN|DIV)$/.test(tag) ? 4 : 3) + (semanticLabel ? 2 : 0) : 2;
    matches.push({ element, score: score + (/^dct\d+$/i.test(element.id || "") ? 3 : 0) });
  }
  if (!matches.length) return { element: null, candidateCount: 0, ambiguous: false };
  const bestScore = Math.max(...matches.map((match) => match.score));
  const best = matches.filter((match) => match.score === bestScore);
  // A tab and its nested label are one action, not two competing entries.
  const distinct = best.filter((match) => !best.some((other) =>
    other !== match && other.element.contains?.(match.element)));
  return { element: distinct.length === 1 ? distinct[0].element : null,
    candidateCount: distinct.length, ambiguous: distinct.length > 1 };
}

// The inspector asks for the same three entries on every tick and again on every
// structure scan. A short cache keeps one page visit at one lookup set, and lets
// the structure record report entry state without paying for a second scan.
const ENTRY_CACHE_MS = 1200;
let entryCache = { at: 0, entries: null };

function learningEntries() {
  const now = Date.now();
  if (entryCache.entries && now - entryCache.at < ENTRY_CACHE_MS) return entryCache.entries;
  const entries = {
    quiz: findLearningEntry("quiz"),
    video: findLearningEntry("video"),
    document: findLearningEntry("document")
  };
  entryCache = { at: now, entries };
  return entries;
}

function findQuizEntry() {
  return findLearningEntry("quiz").element;
}

function findVideoEntry() {
  return findLearningEntry("video").element;
}

function findNextButton() {
  const completedButton = [...document.querySelectorAll("a.nextChapter, #prevNextFocusNext, .nextChapter, .nextbutton")]
    .find(visible);
  if (completedButton) return completedButton;
  const sideButton = document.querySelector("#right2");
  return visible(sideButton) && textOf(sideButton).includes("下一节") ? sideButton : null;
}

function submissionNeedsVerification(task, chapter) {
  return ["submitted", "confirming", "awaitingVerification"].includes(task?.phase) &&
    (!task.submissionChapterId || task.submissionChapterId === chapter);
}

// A confirmation button is judged by its own label, never by container class.
// 0.1.49 only looked inside a few known containers, so a visible 提示/确认提交？
// dialog whose buttons carried no matching id/role reported zero candidates and
// the run silently fell through to the 45s "still no completion marker" pause.
const CONFIRM_LABEL = /^(?:提交|确定|确认|交卷|提交答案|确定提交|确认提交|确定交卷|确认交卷|提交试卷)$/;
const CONFIRM_PHRASE = /(?:确认提交|确定提交|确认交卷|确定交卷|是否提交|是否交卷|确定要提交|确定要交卷|确认要提交|确认要交卷|提交后不可|提交后不能|交卷后不可|交卷后不能)/;
const CANCEL_LABEL = /^(?:取消|关闭|返回|再想想|否|暂不提交|暂不交卷)$/;
const CONFIRM_ANCHOR_SELECTOR = "button, a, input[type='button'], input[type='submit'], [role='button'], [onclick], .popBtn, .lay_btn, .layui-layer-btn0, .layui-layer-btn1, [class*='btn'], [class*='Btn']";
const CONFIRM_PANEL_SELECTOR = "#confirmSubWin, #submitBack, #popcontent, #workpop, .popClass, .popMain, .layui-layer, .aui_state_focus, .el-dialog, .ant-modal, .x-window, [role='dialog'], [role='alertdialog'], [aria-modal='true'], [id*='confirm'], [id*='Confirm'], [class*='confirm'], [class*='Confirm'], [class*='dialog'], [class*='Dialog'], [class*='modal'], [class*='Modal'], [class*='popClass'], [class*='popMain'], [class*='layer'], [class*='Layer']";
let confirmAnchorCache = { at: 0, value: null };

function confirmLabel(element) {
  return clean(element?.value || textOf(element)).replace(/[。．.！!？?]+$/g, "");
}

function confirmPanelKind(panel) {
  if (!panel) return "";
  const tokens = [];
  const id = clean(panel.id);
  if (/^[A-Za-z_-][A-Za-z0-9_-]{0,40}$/.test(id)) tokens.push(`#${id}`);
  for (const name of [...(panel.classList || [])].slice(0, 3)) {
    if (/^[A-Za-z_-][A-Za-z0-9_-]{0,40}$/.test(name)) tokens.push(`.${name}`);
  }
  const role = clean(panel.getAttribute?.("role")).toLowerCase();
  if (/^(?:dialog|alertdialog)$/.test(role)) tokens.push(`role=${role}`);
  return clean(`${String(panel.tagName || "").toUpperCase()} ${tokens.join("")}`).slice(0, 80);
}

function confirmPanelFor(element) {
  // Walk up from the button until a short container carries explicit submit
  // semantics. Leaving the dialog crosses into page chrome, so stop early there.
  let current = element?.parentElement;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current === document.body || current === document.documentElement) return null;
    const text = clean(current.innerText || current.textContent);
    if (text.length > 800) return null;
    if (CONFIRM_PHRASE.test(text)) return current;
    current = current.parentElement;
  }
  return null;
}

function confirmPanelScore(panel) {
  const role = clean(panel.getAttribute?.("role")).toLowerCase();
  const names = [clean(panel.id), ...(panel.classList || [])].join(" ");
  let score = 0;
  if (/^(?:dialog|alertdialog)$/.test(role)) score += 4;
  if (/(?:pop|dialog|modal|layer|confirm|alert|window|win|tip)/i.test(names)) score += 2;
  const clickables = panel.querySelectorAll ? [...panel.querySelectorAll("button, a, [role='button'], [onclick]")] : [];
  if (clickables.some((item) => CANCEL_LABEL.test(confirmLabel(item)))) score += 2;
  // A container that also owns the question stems is the quiz body, not a dialog.
  if (panel.querySelector && panel.querySelector(".TiMu, .newTiMu, .Zy_TItle, .newZy_TItle")) score -= 4;
  const text = clean(panel.innerText || panel.textContent);
  score += Math.max(0, 2 - Math.floor(Math.max(0, text.length - 24) / 60));
  return score;
}

function computeAnchoredSubmitConfirmation() {
  let { scored, labelCount } = confirmAnchors();
  const scanKind = scored.length ? "label-anchor" : "panel-scan";
  if (!scored.length) {
    const second = panelScopedConfirmAnchors();
    scored = second.scored;
    labelCount = Math.max(labelCount, second.labelCount);
  }
  if (!scored.length) return { dialogCount: 0, candidateCount: 0, button: null, panel: null, panelKind: "",
    scanKind: "none", controlKinds: [], labelCount };
  const panels = [...new Set(scored.map((item) => item.panel))];
  const bestScore = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === bestScore);
  const buttons = [...new Set(best.map((item) => item.button))]
    .filter((button) => !best.some((item) => item.button !== button && button.contains?.(item.button)));
  return {
    dialogCount: panels.filter(visible).length,
    candidateCount: buttons.length,
    button: buttons.length === 1 ? buttons[0] : null,
    panel: best[0].panel,
    panelKind: confirmPanelKind(best[0].panel),
    scanKind,
    controlKinds: [...new Set(best.map((item) => safeControlKind(item.button)))].filter(Boolean).slice(0, 20),
    labelCount
  };
}

function clickableState(element) {
  return visible(element) && element.disabled !== true && element.getAttribute?.("aria-disabled") !== "true";
}

function confirmAnchors() {
  const scored = [];
  const seen = new Set();
  let labelCount = 0;
  for (const element of document.querySelectorAll(CONFIRM_ANCHOR_SELECTOR)) {
    if (seen.has(element) || !clickableState(element)) continue;
    if (!CONFIRM_LABEL.test(confirmLabel(element))) continue;
    seen.add(element);
    labelCount += 1;
    const panel = confirmPanelFor(element);
    if (!panel) continue;
    scored.push({ button: element, panel, score: confirmPanelScore(panel) });
  }
  return { scored, labelCount };
}

// Some layers render the buttons as bare spans with no class or handler, so the
// dialog itself is located first and every label inside it is inspected.
function panelScopedConfirmAnchors() {
  const scored = [];
  let labelCount = 0;
  for (const panel of [...document.querySelectorAll(CONFIRM_PANEL_SELECTOR)].filter(visible)) {
    const text = clean(panel.innerText || panel.textContent);
    if (!CONFIRM_PHRASE.test(text) || text.length > 800) continue;
    const inner = [...(panel.querySelectorAll?.(
      "button, a, input[type='button'], input[type='submit'], [role='button'], [onclick], span, div, label, td"
    ) || [])].filter((element) => clickableState(element) && CONFIRM_LABEL.test(confirmLabel(element)));
    const leaves = inner.filter((element) => !inner.some((other) => other !== element && element.contains?.(other)));
    labelCount += leaves.length;
    for (const element of leaves) scored.push({ button: element, panel, score: confirmPanelScore(panel) });
  }
  return { scored, labelCount };
}

function anchoredSubmitConfirmation() {
  // The anchored scan is the expensive fallback; keep it off the per-second path.
  const now = Date.now();
  if (confirmAnchorCache.value && now - confirmAnchorCache.at < 800) return confirmAnchorCache.value;
  const value = computeAnchoredSubmitConfirmation();
  confirmAnchorCache = { at: now, value };
  return value;
}

function dialogKey(dialog) {
  const id = clean(dialog?.id);
  if (id === "confirmSubWin" || id === "submitBack") return id;
  const role = clean(dialog?.getAttribute?.("role")).toLowerCase();
  if (role === "alertdialog") return "role-alertdialog";
  if (role === "dialog") return "role-dialog";
  return "other";
}

function knownSubmitConfirmation() {
  const dialogs = [...document.querySelectorAll("#confirmSubWin, #submitBack, [role='alertdialog'], [role='dialog']")].filter(visible);
  const candidates = [];
  // Every clickable found inside the matched dialogs is described, even when no
  // label matches: candidateCount=0 with an empty controlKinds list is what made
  // the 0.1.49 report undiagnosable.
  const dialogButtons = [];
  // Which selector actually matched matters: reporting only a count hid the fact
  // that the real layer was .popClass while the count came from an unrelated node.
  const hitCounts = {};
  for (const dialog of dialogs) {
    const key = dialogKey(dialog);
    hitCounts[key] = (hitCounts[key] || 0) + 1;
  }
  const hits = Object.entries(hitCounts).map(([key, count]) => `${key}:${count}`).join(",");
  // The quiz can live in a child frame while the platform renders its
  // confirmation dialog in the outer student-study frame. Both routes are
  // trusted here; generic dialogs still need explicit submit semantics below.
  const canUseGenericDialog = QUIZ_URL.test(location.pathname) || RUNNER_URL.test(location.pathname);
  for (const dialog of dialogs) {
    if (!["confirmSubWin", "submitBack"].includes(dialog.id) && !canUseGenericDialog) continue;
    const buttons = [...dialog.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']")]
      .filter((button) => visible(button) && button.disabled !== true && button.getAttribute?.("aria-disabled") !== "true");
    dialogButtons.push(...buttons);
    const modernButtons = dialog.id === "submitBack" ? buttons.filter((button) => button.id === "submitBackOk") : [];
    const modernConfirm = dialog.id === "submitBack" && modernButtons.length === 1 &&
      /(?:确认提交|确定提交|确认交卷|确定交卷|确认\s*提交|确定\s*提交)/.test(textOf(dialog)) ? modernButtons[0] : null;
    const known = dialog.id === "confirmSubWin" ? buttons.filter((button) =>
      /submitCheckTimes/.test(button.getAttribute?.("onclick") || "")) : dialog.id === "submitBack" ?
      [modernConfirm].filter((button) => button && visible(button) && button.disabled !== true &&
        button.getAttribute?.("aria-disabled") !== "true" && !/删除|退出|放弃|撤销/.test(textOf(dialog))) : [];
    const explicit = /(?:确认|确定|是否|确定要|提交后|交卷后|提交本次|提交答案|提交测验|提交作业|提交试卷).{0,40}(?:提交|交卷)|(?:提交|交卷).{0,40}(?:确认|确定|是否|不可修改|不能修改)/.test(textOf(dialog));
    const matches = known.length ? known : explicit ? buttons.filter((button) =>
      /^(?:确定|确认|提交|交卷|确定提交|确认提交|确认交卷|确定交卷)$/.test(textOf(button) || clean(button.value))) : [];
    for (const button of matches) candidates.push({ dialog, button });
  }
  const unique = [...new Map(candidates.map((item) => [item.button, item])).values()];
  const panel = unique.length ? unique[0].dialog : dialogs[0] || null;
  return { dialogCount: dialogs.length, candidateCount: unique.length, button: unique.length === 1 ? unique[0].button : null,
    panel,
    panelKind: confirmPanelKind(panel),
    hits,
    scanKind: dialogs.length ? "known-dialog" : "none",
    controlKinds: [...new Set(dialogButtons.map((button) => safeControlKind(button)))].filter(Boolean).slice(0, 20) };
}

function submitConfirmation() {
  const known = knownSubmitConfirmation();
  // A recognised legacy dialog stays authoritative, including the ambiguous
  // case: an ambiguous confirmation must pause, never fall through to guessing.
  if (known.candidateCount > 0) return known;
  const anchored = anchoredSubmitConfirmation();
  return {
    dialogCount: Math.max(known.dialogCount, anchored.dialogCount),
    candidateCount: anchored.candidateCount,
    button: anchored.button,
    panel: anchored.panel,
    panelKind: anchored.panelKind || known.panelKind || "",
    hits: known.hits || "",
    labelCount: Number.isFinite(anchored.labelCount) ? anchored.labelCount : null,
    scanKind: anchored.scanKind === "none" ? known.scanKind || "none" : anchored.scanKind,
    controlKinds: [...new Set([...(known.controlKinds || []), ...(anchored.controlKinds || [])])].slice(0, 20)
  };
}

function activateConfirmButton(element) {
  // Real pointer sequence first (some layers only listen to mousedown), then a
  // single click() so the activation behaviour still fires exactly once.
  if (typeof element?.dispatchEvent === "function" && typeof MouseEvent === "function") {
    let rect = { left: 0, top: 0, width: 0, height: 0 };
    try { rect = element.getBoundingClientRect?.() || rect; } catch (_) { /* keep defaults */ }
    const init = { bubbles: true, cancelable: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        element.dispatchEvent(/^pointer/.test(type) && typeof PointerEvent === "function" ?
          new PointerEvent(type, init) : new MouseEvent(type, init));
      } catch (_) { /* pointer events are optional */ }
    }
  }
  if (typeof element?.click === "function") {
    element.click();
    return true;
  }
  if (typeof element?.dispatchEvent === "function" && typeof MouseEvent === "function") {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, button: 0 }));
    return true;
  }
  return false;
}

async function ensureRunning(tabId) {
  const key = `task:${tabId}`;
  const task = (await chrome.storage.local.get(key))[key];
  if (task?.state !== "running") throw new Error("任务已暂停");
}

async function runFrameCommand(command, data) {
  if (["PLAY", "INITIAL_PLAY", "CAPTURE_QUESTION", "CAPTURE_VIDEO_QUESTION", "CAPTURE_CAPTCHA", "SUBMIT_CAPTCHA", "FILL_VIDEO_QUESTION", "SUBMIT_VIDEO_QUESTION", "RETRY_VIDEO_QUESTION", "VIDEO_QUESTION_SHAPE", "CONTINUE_VIDEO_QUESTION", "FILL_QUIZ", "VERIFY_QUIZ", "SUBMIT_QUIZ", "CONFIRM_SUBMIT", "OPEN_QUIZ", "OPEN_VIDEO", "OPEN_DOCUMENT", "OPEN_MODERN_CHAPTER", "SCROLL_DOCUMENT", "NEXT"].includes(command)) {
    await ensureRunning(await chrome.runtime.sendMessage({ type: "TAB_ID" }));
  }
  if (!["CAPTURE_CAPTCHA", "SUBMIT_CAPTCHA"].includes(command)) assertNoCaptchaOverlay();
  if (command === "PLAY") {
    const video = currentVideo();
    if (!video) throw new Error("找不到可播放的视频");
    if (video.ended) return videoInfo();
    try {
      await video.play();
    } catch (error) {
      // Chrome rejects play() after the tab was backgrounded or the player was
      // rebuilt. Try the visible controls, then report in plain Chinese instead
      // of leaking a raw DOMException that the popup can only show generically.
      const button = document.querySelector(".vjs-big-play-button");
      if (visible(button)) button.click();
      else video.click?.();
      await wait(500);
      if (video.paused) {
        throw new Error("视频暂停后未能自动恢复播放（浏览器可能限制自动播放），请手动点一次播放键后继续");
      }
    }
    return videoInfo();
  }
  if (command === "INITIAL_PLAY") {
    const button = initialPlayButton();
    if (!button) throw new Error("首次播放按钮不可见");
    button.click();
    return { clicked: true };
  }
  if (command === "READ_QUIZ") {
    ensureQuizVisible();
    return extractQuestions();
  }
  if (command === "CAPTURE_QUESTION") return captureQuestion(data.id);
  if (command === "READ_VIDEO_QUESTION") return readVideoQuestion();
  if (command === "VIDEO_QUESTION_SHAPE") return videoQuestionShape();
  if (command === "CAPTURE_VIDEO_QUESTION") return captureVideoQuestion();
  if (command === "CAPTURE_CAPTCHA") {
    const dialog = captchaDialog();
    if (!captchaControls(dialog) || captchaErrorVisible()) throw new Error("验证码弹窗结构无法确认");
    return captureElement(dialog, "captcha");
  }
  if (command === "SUBMIT_CAPTCHA") {
    const dialog = captchaDialog();
    const controls = captchaControls(dialog);
    if (!controls || captchaErrorVisible()) throw new Error("验证码弹窗已变化，停止提交");
    const code = String(data?.code || "").trim();
    if (!/^[A-Za-z0-9]{1,10}$/.test(code)) throw new Error("验证码识别结果无效，停止提交");
    controls.input.value = code;
    controls.input.dispatchEvent(new Event("input", { bubbles: true }));
    controls.input.dispatchEvent(new Event("change", { bubbles: true }));
    controls.button.click();
    return { clicked: true };
  }
  if (command === "FILL_VIDEO_QUESTION") return fillVideoQuestion(data.answer);
  if (command === "RETRY_VIDEO_QUESTION") return retryVideoQuestion(data);
  if (command === "SUBMIT_VIDEO_QUESTION") {
    const button = document.querySelector("#videoquiz-submit");
    if (!videoQuestionRoot() || !visible(button)) throw new Error("视频弹题提交按钮已变化");
    button.click();
    return { clicked: true };
  }
  if (command === "CONTINUE_VIDEO_QUESTION") {
    const button = document.querySelector("#videoquiz-continue");
    if (videoQuestionFeedback() !== "continue" || !visible(button)) throw new Error("视频弹题继续按钮已变化");
    button.click();
    return { clicked: true };
  }
  if (command === "VERIFY_QUIZ") {
    ensureQuizVisible();
    return verifyAnswers(data.answers);
  }
  if (command === "FILL_QUIZ") {
    ensureQuizVisible();
    const roots = getQuestionElements();
    if (!roots.length || roots.length !== data.answers.length) throw new Error("测验题数已变化，停止填写");
    ensureQuizShape(roots);
    const ids = quizIdSnapshot || quizQuestionIds(roots);
    const byId = new Map(data.answers.map((answer) => [String(answer.id), answer]));
    const tabId = await chrome.runtime.sendMessage({ type: "TAB_ID" });
    for (let index = 0; index < roots.length; index++) {
      await ensureRunning(tabId);
      const root = roots[index];
      const id = ids[index];
      if (!id) throw new Error("题目缺少稳定编号，停止填写");
      const answer = byId.get(id);
      if (!answer) throw new Error(`题目 ${id} 缺少答案`);
      if (questionType(root) === "fill") {
        const result = await chrome.runtime.sendMessage({ type: "FILL_BLANKS", questionId: id, blanks: answer.blanks });
        if (result?.error) throw new Error(result.error);
        if (result?.filled !== answer.blanks.length) throw new Error(`题目 ${id} 的填空内容未填完`);
        continue;
      }
      const options = optionElements(root);
      if (options.some((option) => controlType(option.input) === "radio")) {
        const choice = options.find((option) => answer.choices.includes(option.id));
        if (!choice || answer.choices.length !== 1) throw new Error(`题目 ${id} 的单选答案不合法`);
        if (!choice.selected) {
          choice.target.click();
          await wait(1000);
          const after = optionElements(root).find((option) => option.id === choice.id);
          if (!after?.selected) throw new Error(`题目 ${id} 点击后无法确认选项状态`);
        }
        continue;
      }
      for (const option of options) {
        await ensureRunning(tabId);
        const desired = answer.choices.includes(option.id);
        if (desired !== option.selected) {
          option.target.click();
          await wait(1000);
          const after = optionElements(root).find((item) => item.id === option.id);
          if (desired !== Boolean(after?.selected)) throw new Error(`题目 ${id} 点击后无法确认选项状态`);
        }
      }
    }
    return { filled: roots.length };
  }
  if (command === "SUBMIT_QUIZ") {
    ensureQuizVisible();
    const button = findButton(/^(提交|交卷|提交答案)$/);
    if (!button) throw new Error("未找到测验提交按钮");
    button.click();
    return { clicked: true };
  }
  if (command === "CONFIRM_SUBMIT") {
    const confirmation = submitConfirmation();
    if (!confirmation.button) {
      throw new Error(`提交确认框不可见或确认按钮无法识别${confirmation.panelKind ? `（弹窗结构：${confirmation.panelKind}）` : ""}`);
    }
    const clicked = activateConfirmButton(confirmation.button);
    confirmAnchorCache = { at: 0, value: null };
    if (!clicked) throw new Error("提交确认框已找到，但确认按钮无法点击，请人工点一次『提交』");
    return { clicked: true, panelKind: confirmation.panelKind, dialogCount: confirmation.dialogCount };
  }
  if (command === "OPEN_QUIZ") {
    const button = findQuizEntry();
    if (!button) throw new Error("未找到章节测验入口");
    const target = clean(button.getAttribute?.("target") ||
      document.querySelector("base[target]")?.getAttribute("target")).toLowerCase();
    button.click();
    return { clicked: true, openedInNewTab: target === "_blank" };
  }
  if (command === "OPEN_VIDEO") {
    const button = findVideoEntry();
    if (!button) throw new Error("未找到视频标签");
    button.click();
    return { clicked: true };
  }
  if (command === "OPEN_DOCUMENT") {
    const tab = documentEntry();
    if (!tab) throw new Error("未找到文档主要内容标签");
    tab.click();
    return { clicked: true };
  }
  if (command === "OPEN_MODERN_CHAPTER") {
    const target = modernDirectoryTarget();
    if (!target) throw new Error("新版目录中没有能确认的未完成项目，已暂停");
    target.button.click();
    return { clicked: true, remaining: target.remaining };
  }
  if (command === "SCROLL_DOCUMENT") {
    const reader = documentReader();
    if (!reader) throw new Error("未定位到文档正文滚动区");
    const { element } = reader;
    const before = element.scrollTop;
    element.scrollTop = Math.min(element.scrollHeight - element.clientHeight,
      before + Math.max(160, Math.floor(element.clientHeight * 0.7)));
    return { moved: element.scrollTop > before,
      atBottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 4 };
  }
  if (command === "NEXT") {
    const button = findNextButton();
    if (!button) throw new Error("未找到下一节按钮");
    button.click();
    return { clicked: true };
  }
  throw new Error("未知页面命令");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HELLO") {
    const path = location.pathname.replace(/\/$/, "");
    const pageKind = RUNNER_URL.test(path) ? "runner" : DIRECTORY_URL.test(path) ? "directory" :
      QUIZ_URL.test(path) ? "quiz" : CARDS_URL.test(path) ? "cards" : VIDEO_URL.test(path) ? "video" :
      DOCUMENT_URL.test(path) ? "document" : SCREEN_URL.test(path) ? "screen" :
      path === "/mooc2-ans/mycourse/stu" ? "modernDirectory" : "other";
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version, frame: window === top ? 0 : -1,
      pageKind, coursePage: pageKind !== "other", controller: window === top && isChaoxingPage() });
    return;
  }
  if (message.type === "INSPECT") {
    structureDiagnostic(message.forceStructure === true);
    const active = frameVisible();
    const video = active ? videoInfo() : null;
    const roots = active ? getQuestionElements().filter(visible) : [];
    const entries = active ? learningEntries() : null;
    const quizEntry = entries ? entries.quiz : {};
    const videoEntry = entries ? entries.video : {};
    const docEntry = entries ? entries.document : {};
    const confirmation = active ? submitConfirmation() : { dialogCount: 0, candidateCount: 0 };
    sendResponse({
      version: chrome.runtime.getManifest().version,
      kind: roots.length ? "quiz" : video?.kind || "other",
      quizPageVisible: active && QUIZ_URL.test(location.pathname),
      videoPageVisible: active && VIDEO_URL.test(location.pathname),
      documentPageVisible: active && DOCUMENT_URL.test(location.pathname),
      hasDocumentEntry: Boolean(docEntry.element),
      documentActive: Boolean(docEntry.element?.classList?.contains("currents")),
      documentReader: active ? documentReader()?.state || null : null,
      treeTask: active ? currentTreeTaskState() : null,
      jobBlocked: jobFinishBlocked(),
      hasInitialPlayButton: active && Boolean(initialPlayButton()),
      video,
      inVideoQuestion: videoQuestionVisible(),
      videoQuestionSurface: videoQuestionSurfaceVisible(),
      videoQuestionFeedback: active && VIDEO_URL.test(location.pathname) ? videoQuestionFeedback() : null,
      captchaVisible: Boolean(captchaDialog()),
      captchaReady: Boolean(captchaControls(captchaDialog())),
      captchaError: captchaErrorVisible(),
      videoJobState: active ? videoJobState() : null,
      quizJobState: active ? quizJobState() : null,
      layout: layoutProfile(),
      modernDirectory: modernDirectoryInfo(),
      modernDirectoryHasTarget: Boolean(modernDirectoryTarget()),
      chapterId: chapterId(),
      questionCount: roots.length,
      hasQuizEntry: Boolean(quizEntry.element),
      hasVideoEntry: Boolean(videoEntry.element),
      entryAmbiguous: quizEntry.ambiguous === true || videoEntry.ambiguous === true || docEntry.ambiguous === true,
      hasNext: Boolean(findNextButton()),
      hasSubmitConfirm: confirmation.candidateCount === 1,
      submitConfirmDialogCount: confirmation.dialogCount,
      submitConfirmCandidateCount: confirmation.candidateCount,
      submitConfirmPanelKind: confirmation.panelKind || "",
      submitConfirmScanKind: confirmation.scanKind || "none",
      submitConfirmControlKinds: confirmation.controlKinds || [],
    });
    return;
  }
  if (message.type === "FRAME_COMMAND") {
    runFrameCommand(message.command, message.data).then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
    return true;
  }
  if (window !== top) return;
  if (!isChaoxingPage()) {
    if (message.type === "START" || message.type === "PAUSE") sendResponse({ error: "请先切换到超星课程页面" });
    return;
  }
  if (message.type === "START" || message.type === "PAUSE") {
    (async () => {
      const tabId = await chrome.runtime.sendMessage({ type: "TAB_ID" });
      if (!tabId) throw new Error("无法识别当前标签页");
      const key = `task:${tabId}`;
      const previous = (await chrome.storage.local.get(key))[key];
      if (message.type === "PAUSE") {
        await chrome.storage.local.set({ [key]: { ...previous, state: "paused", status: "已由用户暂停", updatedAt: Date.now() } });
        recordDiagnostic("pause", { phase: previous?.phase, state: "paused" });
        return { ok: true };
      }
      if (previous?.state === "running" && loopActive) return { ok: true };
      const initialFrames = await inspect();
      const knownTopRoute = RUNNER_URL.test(location.pathname) || DIRECTORY_URL.test(location.pathname) ||
        QUIZ_URL.test(location.pathname) || CARDS_URL.test(location.pathname) || VIDEO_URL.test(location.pathname) ||
        DOCUMENT_URL.test(location.pathname) || SCREEN_URL.test(location.pathname);
      const knownFrame = initialFrames.some((frame) => frame.modernDirectory?.visible || frame.videoPageVisible ||
        frame.quizPageVisible || frame.documentPageVisible || frame.treeTask || frame.videoJobState || frame.quizJobState);
      if (!knownTopRoute && !knownFrame) {
        throw new Error("未找到已加载的课程目录或学习内容，请等待页面加载后重试；仍失败请复制页面探针");
      }
      const hasLegacyFrame = initialFrames.some((frame) => frame.layout === "legacy" &&
        (frame.videoPageVisible || frame.quizPageVisible || frame.treeTask || frame.videoJobState ||
          frame.quizJobState || frame.documentPageVisible));
      const hasLegacyLoadingFrame = initialFrames.some((frame) => frame.layout === "legacy-loading");
      const hasModernFrame = initialFrames.some((frame) => frame.layout === "modern");
      const hasModernDirectory = initialFrames.some((frame) => frame.modernDirectory?.visible);
      if (!hasLegacyFrame && !hasLegacyLoadingFrame && hasModernDirectory) {
        const task = {
          state: "running", phase: "modernDirectory", directoryMode: true,
          modernDirectoryMode: true, modernDirectoryUrl: location.href, directoryUrl: location.href,
          startedAt: Date.now(), updatedAt: Date.now(),
          status: "已识别新版课程目录，正在寻找第一个未完成项目"
        };
        await chrome.storage.local.set({ [key]: task });
        recordDiagnostic("start", { phase: task.phase, state: task.state });
        startLoop(tabId);
        return { ok: true };
      }
      if (!hasLegacyFrame && !hasLegacyLoadingFrame && hasModernFrame &&
          !RUNNER_URL.test(location.pathname) && !DIRECTORY_URL.test(location.pathname)) {
        throw new Error("检测到新版页面，但暂未找到可复用的旧版学习框架；已暂停并保留探针");
      }
      const selectedDirectoryTarget = DIRECTORY_URL.test(location.pathname) ? directoryTarget() : null;
      const chapter = selectedDirectoryTarget?.chapter || chapterId();
      if (submissionNeedsVerification(previous, chapter)) {
        if (!chapter || previous.submissionChapterId !== chapter || courseMismatch(previous, location.href)) {
          throw new Error("无法确认待核对测验属于当前章节，请先人工核对提交结果");
        }
        const now = Date.now();
        const phase = previous.confirmedAt ? "confirming" : "submitted";
        await chrome.storage.local.set({ [key]: { ...previous, state: "running", phase,
          submittedAt: now, confirmedAt: previous.confirmedAt ? now : null, confirmAttempts: 0, updatedAt: now,
          status: "正在重新核对本节提交状态，不会重新答题或点击首次提交" } });
        recordDiagnostic("start", { phase, state: "running" });
        startLoop(tabId);
        return { ok: true };
      }
      if (["videoQuestionSubmitting", "videoQuestionRetrying", "videoQuestionSubmitted"].includes(previous?.phase)) {
        const frames = await inspect();
        if (previous.phase === "videoQuestionSubmitted" && previous.state === "paused" &&
            (previous.questionRetryCount || 0) < MAX_VIDEO_QUESTION_RETRIES && previous.activeChapterId === chapter &&
            frames.some((frame) => frame.videoQuestionFeedback === "incorrect")) {
          await chrome.storage.local.set({ [key]: { ...previous, state: "running",
            status: "视频弹题答错，正在核对剩余重试次数", updatedAt: Date.now() } });
          recordDiagnostic("start", { phase: previous.phase, state: "running" });
          startLoop(tabId);
          return { ok: true };
        }
        if (frames.some((frame) => frame.videoQuestionSurface)) {
          throw new Error("视频弹题提交状态未核对，弹层仍在，请人工检查后再开始");
        }
      }
      if (DIRECTORY_URL.test(location.pathname)) {
        const target = selectedDirectoryTarget;
        const directoryUrl = courseDirectoryUrl();
        if (!directoryUrl) throw new Error("课程目录链接缺少必要参数，无法连续运行");
        if (!target) {
          const { rows, locked, unknown } = directoryStatus();
          if (!rows) throw new Error("课程目录尚未加载，无法识别待完成小节");
          const task = {
            state: locked || unknown ? "paused" : "completed", phase: "directory", directoryMode: true,
            directoryUrl, startedAt: Date.now(), updatedAt: Date.now(),
            status: unknown ? "课程目录有未识别的小节状态，请导出日志核对" :
              locked ? "当前没有可做的小节，但目录仍有锁定内容" : "当前课程目录的可做小节已全部完成"
          };
          await chrome.storage.local.set({ [key]: task });
          return { ok: true };
        }
        const task = {
          state: "running", phase: "directory", directoryMode: true,
          directoryUrl, deferredChapters: [],
          targetChapterId: target.chapter, startedAt: Date.now(), updatedAt: Date.now(),
          status: "已找到首个未完成小节，准备进入学习页"
        };
        await chrome.storage.local.set({ [key]: task });
        recordDiagnostic("start", { phase: task.phase, state: task.state });
        startLoop(tabId);
        return { ok: true };
      }
      const frames = await inspect();
      const quizPage = frames.some((frame) => frame.quizPageVisible);
      const documentPage = frames.some((frame) => frame.documentPageVisible);
      const hasDocumentEntry = frames.some((frame) => frame.hasDocumentEntry);
      const videoCompleted = frames.some((frame) => frame.videoJobState === "complete");
      const quizCompleted = frames.some((frame) => frame.quizJobState === "complete");
      const directoryUrl = courseDirectoryUrl();
      const task = {
        state: "running", status: documentPage || hasDocumentEntry ? "正在检查文档阅读任务" : quizPage ? "正在检测当前测验" : "正在检测当前视频",
        startedAt: Date.now(), updatedAt: Date.now(),
        directoryMode: Boolean(directoryUrl), directoryUrl, deferredChapters: [],
        phase: documentPage || hasDocumentEntry ? "document" : quizPage ? "quiz" : "video", activeChapterId: chapter, videoCompleted, quizCompleted,
        quizOpenedAt: null, quizLoadStartedAt: quizPage ? Date.now() : null,
        quizWaitStartedAt: quizPage ? Date.now() : null
      };
      await chrome.storage.local.set({ [key]: task });
      recordDiagnostic("start", { phase: task.phase, state: task.state });
      startLoop(tabId);
      return { ok: true };
    })().then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
    return true;
  }
});

let loopActive = false;
async function saveTask(tabId, patch) {
  const key = `task:${tabId}`;
  const task = (await chrome.storage.local.get(key))[key] || {};
  const next = { ...task, ...patch, updatedAt: Date.now() };
  if (next.state === "paused" && task.state !== "paused") {
    recordDiagnostic("recovery", { phase: next.phase, reason: recoveryReason(next.status) });
  }
  await chrome.storage.local.set({ [key]: next });
  if (next.phase !== task.phase || next.state !== task.state) {
    recordDiagnostic("state", { phase: next.phase, state: next.state });
  }
  return next;
}

function recoveryReason(status) {
  const text = String(status || "");
  if (/冲突/.test(text)) return "marker-conflict";
  if (/多个|歧义/.test(text)) return "ambiguous-entry";
  if (/新标签/.test(text)) return "new-tab";
  if (/断网|网络|连接/.test(text)) return "connection";
  if (/新版|旧版|框架|学习帧/.test(text)) return "layout-change";
  if (/提交|确认后/.test(text)) return "submission-unverified";
  if (/入口|未识别/.test(text)) return "entry-unverified";
  return "manual-check";
}

async function frameCommand(frameId, command, data) {
  try {
    const result = await withTimeout(
      chrome.runtime.sendMessage({ type: "COMMAND_FRAME", frameId, command, data }),
      PAGE_MESSAGE_TIMEOUT_MS,
      "页面操作超过12秒未响应，已暂停；请刷新课程页后重试"
    );
    if (!result || typeof result !== "object") throw new Error("页面操作没有收到确认，已停止；请检查页面后再继续");
    // READ_QUIZ carries expected page-read failures to the controller, which can
    // distinguish a loading editor from a permanently unsupported question.
    if (result?.error && command !== "READ_QUIZ") throw new Error(result.error);
    recordDiagnostic("command", { command, ok: !result?.error });
    return result;
  } catch (error) {
    recordDiagnostic("command", { command, ok: false });
    throw error;
  }
}

async function inspect() {
  const result = await withTimeout(
    chrome.runtime.sendMessage({ type: "INSPECT_FRAMES" }),
    PAGE_MESSAGE_TIMEOUT_MS,
    "课程页检查超过12秒未响应，已暂停；请刷新课程页后重试"
  );
  if (result?.error) throw new Error(result.error);
  return result || [];
}

async function handleCaptcha(tabId, task, frame) {
  const { captchaExperimental } = await chrome.storage.local.get("captchaExperimental");
  if (captchaExperimental !== true) {
    return saveTask(tabId, { state: "paused", status: "检测到验证码；测试功能未开启，请人工输入后重新开始" });
  }
  if (task.captchaAttemptedAt) {
    if (Date.now() - task.captchaAttemptedAt > 15000) {
      return saveTask(tabId, { state: "paused", status: "验证码提交后仍未通过，请人工检查" });
    }
    return saveTask(tabId, { status: "已提交一次验证码，等待平台验证" });
  }
  if (!frame.captchaReady) {
    return saveTask(tabId, { state: "paused", status: "验证码弹窗结构无法识别，请人工完成" });
  }
  if (task.phase !== "captcha") {
    return saveTask(tabId, { phase: "captcha", captchaReturnPhase: task.phase, status: "检测到验证码，正在尝试识别一次" });
  }
  try {
    const shot = await frameCommand(frame.frameId, "CAPTURE_CAPTCHA");
    await ensureRunning(tabId);
    const answer = await chrome.runtime.sendMessage({ type: "SOLVE_CAPTCHA", image: shot.image });
    if (answer?.error) throw new Error(answer.error);
    await ensureRunning(tabId);
    await saveTask(tabId, { captchaAttemptedAt: Date.now(), status: "正在提交一次验证码" });
    await frameCommand(frame.frameId, "SUBMIT_CAPTCHA", { code: answer.code });
    return;
  } catch (error) {
    return saveTask(tabId, { state: "paused", status: `验证码自动处理失败：${displayError(error)}` });
  }
}

async function returnToDirectory(tabId, task, status) {
  const url = task.directoryUrl || courseDirectoryUrl();
  if (!url) throw new Error("无法定位当前课程目录，停止自动跳转");
  await ensureRunning(tabId);
  await saveTask(tabId, {
    phase: "returningDirectory", lastProcessedChapterId: task.activeChapterId || chapterId(),
    returnStartedAt: Date.now(), directoryRefreshCount: 0, status
  });
  await ensureRunning(tabId);
  location.assign(url);
}

let lastDiagnosticSnapshotAt = 0;
async function tick(tabId, task) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return saveTask(tabId, { state: "paused", status: "检测到断网，已暂停并保留进度；网络恢复后核对页面再点开始" });
  }
  if (MODERN_DIRECTORY_URL.test(location.pathname) &&
      !["modernDirectory", "modernEntering", "returningDirectory"].includes(task.phase)) {
    const directoryFrames = await inspect();
    const modernDirectory = directoryFrames.some((frame) => frame.layout === "modern" && frame.modernDirectory?.visible);
    if (courseMismatch(task, location.href)) {
      return saveTask(tabId, { state: "paused", status: "检测到的新版目录属于另一门课程，已暂停，请确认课程后再开始" });
    }
    if (!modernDirectory) return saveTask(tabId, { status: "正在等待新版课程目录加载" });
    return saveTask(tabId, {
      state: "running", phase: "modernDirectory", directoryMode: true, modernDirectoryMode: true,
      modernDirectoryUrl: location.href, activeChapterId: null, targetChapterId: null,
      deferredChapters: [], videoCompleted: false, quizCompleted: false, chapterMismatchAt: null,
      startedAt: Date.now(), status: "已回到新版课程目录，正在重新寻找未完成项目"
    });
  }
  if (DIRECTORY_URL.test(location.pathname) &&
      !["directory", "returningDirectory", "modernDirectory", "modernEntering"].includes(task.phase)) {
    const directoryUrl = courseDirectoryUrl();
    if (!directoryUrl || courseMismatch(task, directoryUrl)) {
      return saveTask(tabId, { state: "paused", status: "检测到的课程目录与原任务不一致，已暂停，请确认课程后再开始" });
    }
    const directoryFrames = await inspect();
    const modernDirectory = directoryFrames.some((frame) => frame.layout === "modern" && frame.modernDirectory?.visible);
    return saveTask(tabId, {
      state: "running", phase: modernDirectory ? "modernDirectory" : "directory",
      directoryMode: true, modernDirectoryMode: modernDirectory, modernDirectoryUrl: modernDirectory ? location.href : null,
      directoryUrl, activeChapterId: null, targetChapterId: null, deferredChapters: [],
      videoCompleted: false, quizCompleted: false, videoEndedAt: null, quizOpenedAt: null,
      quizLoadStartedAt: null, quizWaitStartedAt: null, documentAttempted: false, chapterMismatchAt: null,
      startedAt: Date.now(), updatedAt: Date.now(),
      status: modernDirectory ? "已回到新版课程目录，正在重新寻找未完成项目" : "已回到课程目录，正在重新寻找未完成小节"
    });
  }
  if (task.phase === "captcha" && !RUNNER_URL.test(location.pathname)) {
    return saveTask(tabId, { state: "paused", status: "验证码处理后页面已跳转，请人工核对当前课程" });
  }
  // The chapter we just asked the modern directory to open only flips chapterId
  // after the click, so the mismatch guard must not fire during that window.
  const modernEntryActive = task.phase === "modernEntering" &&
    Date.now() - (task.modernEnterStartedAt || 0) < 25000;
  if (!["advancing", "enteringChapter", "directory", "returningDirectory"].includes(task.phase) && !modernEntryActive &&
      task.activeChapterId && RUNNER_URL.test(location.pathname)) {
    const currentChapterId = chapterId();
    if (currentChapterId && currentChapterId !== task.activeChapterId) {
      const mismatchSince = task.chapterMismatchAt || Date.now();
      if (Date.now() - mismatchSince < CHAPTER_SWITCH_GRACE_MS) {
        return saveTask(tabId, { chapterMismatchAt: mismatchSince,
          status: "页面正在切换章节，等待平台确认后继续" });
      }
      if (["submitted", "confirming", "awaitingVerification"].includes(task.phase)) {
        return saveTask(tabId, { state: "paused", chapterMismatchAt: mismatchSince,
          status: "上一节测验提交状态尚未确认，已暂停；请先核对上一节结果" });
      }
      if (courseMismatch(task, courseDirectoryUrl() || location.href)) {
        return saveTask(tabId, { state: "paused", chapterMismatchAt: mismatchSince,
          status: "运行中切换到了另一门课程，已暂停以免误用上一门课进度" });
      }
      const switchedFrames = await inspect();
      const switchedModernDirectory = switchedFrames.some((frame) => frame.layout === "modern" && frame.modernDirectory?.visible);
      if (switchedModernDirectory) {
        return saveTask(tabId, { phase: "modernDirectory", modernDirectoryMode: true, directoryMode: true,
          modernDirectoryUrl: location.href, activeChapterId: null, targetChapterId: null, chapterMismatchAt: null,
          deferredChapters: [], videoCompleted: false, quizCompleted: false, status: "已回到新版目录，正在重新寻找未完成项目" });
      }
      const switchedQuiz = switchedFrames.some((frame) => frame.quizPageVisible);
      const switchedDocument = switchedFrames.some((frame) => frame.documentPageVisible || frame.hasDocumentEntry);
      return saveTask(tabId, { phase: switchedDocument ? "document" : switchedQuiz ? "quiz" : "video",
        activeChapterId: currentChapterId, chapterMismatchAt: null, startedAt: Date.now(),
        videoCompleted: switchedFrames.some((frame) => frame.videoJobState === "complete"),
        quizCompleted: switchedFrames.some((frame) => frame.quizJobState === "complete"),
        videoEndedAt: null, quizOpenedAt: null, quizLoadStartedAt: switchedQuiz ? Date.now() : null,
        quizWaitStartedAt: switchedQuiz ? Date.now() : null,
        documentAttempted: false, lastVideoTime: 0, lastProgressAt: null, playRetries: 0,
        status: "已识别当前章节，已清除上一节临时状态并继续运行" });
    }
    if (task.chapterMismatchAt) await saveTask(tabId, { chapterMismatchAt: null });
  }
  let observedFrames;
  if (RUNNER_URL.test(location.pathname)) {
    observedFrames = await inspect();
    const legacyFrame = observedFrames.some((frame) => frame.layout === "legacy" &&
      (frame.videoPageVisible || frame.quizPageVisible || frame.treeTask || frame.videoJobState ||
        frame.quizJobState || frame.documentPageVisible));
    const modernDirectory = observedFrames.some((frame) => frame.layout === "modern" &&
      frame.modernDirectory?.visible);
    if (!legacyFrame) {
      const since = task.layoutWaitingAt || Date.now();
      if (Date.now() - since < 15000) return saveTask(tabId, { layoutWaitingAt: since,
        status: "学习页面正在加载或切换版本，等待确认页面结构" });
      return saveTask(tabId, { state: "paused", status: modernDirectory ?
        "页面已切换到新版目录，已保留进度；请核对课程后点开始重新识别" :
        "未找到可用的学习帧，已暂停；请检查登录和网络，再复制页面探针" });
    }
    if (task.layoutWaitingAt) await saveTask(tabId, { layoutWaitingAt: null });
    if (observedFrames.some((frame) => frame.captchaError)) {
      return saveTask(tabId, { state: "paused", status: "验证码错误一次，已暂停；请人工核对" });
    }
    const captchaFrame = observedFrames.find((frame) => frame.captchaVisible);
    if (captchaFrame) return handleCaptcha(tabId, task, captchaFrame);
    if (task.phase === "captcha") {
      if (!task.captchaAttemptedAt) return saveTask(tabId, { state: "paused", status: "验证码弹窗消失但未提交，请人工核对" });
      if (Date.now() - task.captchaAttemptedAt < 5000) return saveTask(tabId, { status: "正在等待平台确认验证码" });
      return saveTask(tabId, { phase: task.captchaReturnPhase || "video", captchaAttemptedAt: null,
        captchaReturnPhase: null, status: "验证码弹窗已关闭，继续当前小节" });
    }
  }
  const modernFrames = observedFrames || await inspect();
  if (task.modernDirectoryMode && DIRECTORY_URL.test(location.pathname) &&
      ["modernDirectory", "modernEntering", "returningDirectory"].includes(task.phase)) {
    const legacyDirectoryUrl = courseDirectoryUrl();
    if (!legacyDirectoryUrl) throw new Error("旧版课程目录参数不完整，请人工核对后重试");
    return saveTask(tabId, { phase: "returningDirectory", modernDirectoryMode: false,
      directoryUrl: legacyDirectoryUrl, deferredChapters: [], returnStartedAt: Date.now(),
      status: "页面已切回旧版课程目录，正在按旧版逻辑核对进度" });
  }
  if (task.phase === "modernDirectory") {
    const directoryFrame = modernFrames.find((frame) => frame.modernDirectory?.visible);
    if (!directoryFrame) {
      const legacyReady = modernFrames.some((frame) => frame.layout === "legacy" &&
        (frame.videoPageVisible || frame.quizPageVisible || frame.documentPageVisible || frame.treeTask));
      if (legacyReady) {
        const documentReady = modernFrames.some((frame) => frame.documentPageVisible || frame.hasDocumentEntry);
        const quizReady = modernFrames.some((frame) => frame.quizPageVisible);
        return saveTask(tabId, { phase: documentReady ? "document" : quizReady ? "quiz" : "video",
          activeChapterId: chapterId(), startedAt: Date.now(),
          videoCompleted: modernFrames.some((frame) => frame.videoJobState === "complete"),
          quizCompleted: modernFrames.some((frame) => frame.quizJobState === "complete"),
          lastVideoTime: 0, lastProgressAt: null, playRetries: 0,
          status: "已识别旧版学习页面，继续按旧版逻辑处理" });
      }
      if (Date.now() - task.startedAt > 20000) {
        return saveTask(tabId, { state: "paused", status: "新版课程目录暂时未加载，请刷新页面后重新复制探针" });
      }
      return;
    }
    if (!directoryFrame.modernDirectoryHasTarget) {
      if (directoryFrame.modernDirectory?.candidateCount === 0 && directoryFrame.modernDirectory?.markerCount > 0) {
        return saveTask(tabId, { state: "paused", status: "新版目录检测到未完成标记，但入口结构未确认，已暂停等待人工核对" });
      }
      return saveTask(tabId, { state: "paused", status: "新版目录没有可确认的未完成入口，已暂停等待人工核对" });
    }
    await saveTask(tabId, { phase: "modernEntering", modernDirectoryFrameId: directoryFrame.frameId,
      modernEnterStartedAt: Date.now(), status: "正在打开新版目录中的未完成项目" });
    await frameCommand(directoryFrame.frameId, "OPEN_MODERN_CHAPTER");
    return;
  }
  if (task.phase === "modernEntering") {
    const legacyFrame = modernFrames.find((frame) => frame.layout === "legacy" &&
      (frame.videoPageVisible || frame.quizPageVisible || frame.treeTask || frame.videoJobState ||
        frame.quizJobState || frame.documentPageVisible));
    if (legacyFrame) {
      const quizPage = modernFrames.some((frame) => frame.quizPageVisible);
      const documentPage = modernFrames.some((frame) => frame.documentPageVisible);
      const hasDocumentEntry = modernFrames.some((frame) => frame.hasDocumentEntry);
      return saveTask(tabId, {
        phase: documentPage || hasDocumentEntry ? "document" : quizPage ? "quiz" : "video",
        activeChapterId: chapterId(), startedAt: Date.now(), videoCompleted: modernFrames.some((frame) => frame.videoJobState === "complete"),
        quizCompleted: modernFrames.some((frame) => frame.quizJobState === "complete"),
        lastVideoTime: 0, lastProgressAt: null, videoEndedAt: null, playRetries: 0,
        initialPlayAttemptedAt: null, questionSubmittedAt: null, questionCorrectAt: null, quizEditorWaitingAt: null, questionContinueClickedAt: null,
        questionRetryCount: 0, questionAttempts: [], quizOpenedAt: null, quizWaitStartedAt: null, submittedAt: null, confirmedAt: null,
        status: documentPage || hasDocumentEntry ? "已进入章节，正在阅读资料" : quizPage ? "已进入章节，正在检查答题" : "已进入章节，正在检查视频"
      });
    }
    if (Date.now() - task.modernEnterStartedAt > 20000) {
      return saveTask(tabId, { state: "paused", status: "新版目录项目未打开学习页面，请复制探针检查点击入口" });
    }
    return;
  }
  if (task.phase === "returningDirectory") {
    if (task.modernDirectoryMode) {
      const directoryFrame = modernFrames.find((frame) => frame.modernDirectory?.visible);
      if (directoryFrame) {
        return saveTask(tabId, { phase: "modernDirectory", startedAt: Date.now(),
          status: directoryFrame.modernDirectoryHasTarget ? "已回到新版目录，正在核对下一项" :
            "已回到新版目录，但剩余状态未能确认，已暂停核对" });
      }
      if (Date.now() - task.returnStartedAt > 20000) {
        return saveTask(tabId, { state: "paused", status: "返回新版目录超时，未判定课程已完成" });
      }
      return;
    }
    if (!DIRECTORY_URL.test(location.pathname)) {
      if (Date.now() - task.returnStartedAt > 20000) throw new Error("返回课程目录超时，请检查页面");
      return;
    }
    if (courseMismatch(task, courseDirectoryUrl() || location.href)) throw new Error("进入了另一门课程，已停止以免错用进度");
    const candidates = directoryCandidates();
    if (!candidates) throw new Error("当前页面不是预期的课程目录");
    const deferred = task.deferredChapters || [];
    const target = directoryTarget(deferred);
    if (target && task.lastProcessedChapterId && target.chapter === task.lastProcessedChapterId) {
      if (Date.now() - task.returnStartedAt < 10000) return;
      if ((task.directoryRefreshCount || 0) < 2) {
        await saveTask(tabId, {
          returnStartedAt: Date.now(), directoryRefreshCount: (task.directoryRefreshCount || 0) + 1,
          status: "目录仍显示本节未完成，正在刷新核对"
        });
        await ensureRunning(tabId);
        location.reload();
        return;
      }
      deferred.push(target.chapter);
      await saveTask(tabId, { deferredChapters: deferred, status: "本节仍有未完成任务点，先处理其他小节" });
    }
    const nextTarget = directoryTarget(deferred);
    if (nextTarget) {
      return saveTask(tabId, { phase: "directory", targetChapterId: nextTarget.chapter,
        status: "已从目录找到下一节未完成课程" });
    }
    if (candidates.length || deferred.length) {
      return saveTask(tabId, { state: "paused", status: `仍有 ${deferred.length || candidates.length} 节未完成任务，需检查未识别的任务点` });
    }
    const { rows, locked, unknown } = directoryStatus();
    if (!rows) {
      if (Date.now() - task.returnStartedAt < 20000) return saveTask(tabId, { status: "正在等待课程目录加载" });
      throw new Error("课程目录长时间未加载，无法核对完成情况");
    }
    if (unknown) return saveTask(tabId, { state: "paused", status: "课程目录有未识别的小节状态，请导出日志核对" });
    if (locked) {
      if ((task.directoryRefreshCount || 0) < 2) {
        await saveTask(tabId, {
          returnStartedAt: Date.now(), directoryRefreshCount: (task.directoryRefreshCount || 0) + 1,
          status: "目录暂时没有可做小节，正在刷新检查是否解锁"
        });
        await ensureRunning(tabId);
        location.reload();
        return;
      }
      return saveTask(tabId, { state: "paused", status: "当前没有可做的小节，但课程目录仍有锁定内容" });
    }
    return saveTask(tabId, { state: "completed", status: "当前课程目录的可做小节已全部完成" });
  }
  if (task.phase === "directory") {
    const target = directoryTarget(task.deferredChapters || []);
    if (!target) return saveTask(tabId, { phase: "returningDirectory", returnStartedAt: Date.now() });
    if (target.chapter !== task.targetChapterId) {
      return saveTask(tabId, { targetChapterId: target.chapter, status: "目录进度已更新，正在重新选择未完成小节" });
    }
    await saveTask(tabId, { phase: "enteringChapter", directoryEnteredAt: Date.now(), status: "正在进入未完成小节" });
    await ensureRunning(tabId);
    target.link.click();
    return;
  }
  if (task.phase === "enteringChapter") {
    if (RUNNER_URL.test(location.pathname)) {
      const current = chapterId();
      if (current !== task.targetChapterId) throw new Error("进入的小节与目录选择不一致，已停止");
      const frames = observedFrames || await inspect();
      if (frames.find((frame) => frame.frameId === 0)?.treeTask?.kind === "complete") {
        return returnToDirectory(tabId, task, "本节任务点已完成，正在返回目录");
      }
      if (frames.some((frame) => frame.videoJobState === "complete") &&
          frames.some((frame) => frame.quizJobState === "complete")) {
        return returnToDirectory(tabId, task, "本节任务点已完成，正在返回目录");
      }
      const quizPage = frames.some((frame) => frame.quizPageVisible);
      const documentPage = frames.some((frame) => frame.documentPageVisible);
      const hasDocumentEntry = frames.some((frame) => frame.hasDocumentEntry);
      return saveTask(tabId, {
        phase: documentPage || hasDocumentEntry ? "document" : quizPage ? "quiz" : "video", startedAt: Date.now(),
        activeChapterId: current,
        videoCompleted: frames.some((frame) => frame.videoJobState === "complete"),
        quizCompleted: frames.some((frame) => frame.quizJobState === "complete"),
        lastVideoTime: 0, lastProgressAt: null, videoEndedAt: null, playRetries: 0,
        initialPlayAttemptedAt: null, questionSubmittedAt: null, questionCorrectAt: null, quizEditorWaitingAt: null, questionContinueClickedAt: null,
        questionRetryCount: 0, questionAttempts: [],
        quizOpenedAt: null, submittedAt: null, confirmedAt: null,
        quizLoadStartedAt: quizPage ? Date.now() : null,
        quizWaitStartedAt: quizPage ? Date.now() : null,
        status: documentPage || hasDocumentEntry ? "已进入文档小节，正在检查阅读任务" : quizPage ? "已进入小节，正在检测测验" : "已进入小节，正在检测视频"
      });
    }
    if (Date.now() - task.directoryEnteredAt > 20000) throw new Error("点击目录后未进入学习页，请人工检查");
    return;
  }
  const frames = observedFrames || await inspect();
  const quiz = frames.find((frame) => frame.kind === "quiz" && frame.questionCount);
  const video = frames.find((frame) => frame.kind === "video" && frame.video);
  const questionFrame = frames.find((frame) => frame.inVideoQuestion);
  const main = frames.find((frame) => frame.frameId === 0);
  const quizPage = frames.some((frame) => frame.quizPageVisible);
  const videoPage = frames.some((frame) => frame.videoPageVisible);
  const documentPage = frames.some((frame) => frame.documentPageVisible);
  const documentReaderFrame = frames.find((frame) => frame.documentReader);
  const videoMarker = frames.find((frame) => frame.videoJobState)?.videoJobState;
  const quizMarker = frames.find((frame) => frame.quizJobState)?.quizJobState;
  const treeTask = main?.treeTask;
  const videoCompleted = videoMarker === "complete" || (!videoMarker && task.videoCompleted === true);
  const quizCompleted = quizMarker === "complete" || (!quizMarker && task.quizCompleted === true);
  if (treeTask?.kind === "complete" && (videoMarker === "pending" || quizMarker === "pending")) {
    return saveTask(tabId, { state: "paused", status: "目录完成标记与学习页任务状态冲突，已暂停核对；不会自动翻页" });
  }
  if (treeTask?.kind === "complete" && task.directoryUrl) {
    return returnToDirectory(tabId, task, "平台已确认本节任务点完成，正在返回目录");
  }
  if (Date.now() - lastDiagnosticSnapshotAt >= 15000) {
    lastDiagnosticSnapshotAt = Date.now();
    recordDiagnostic("snapshot", {
      phase: task.phase,
      page: quizPage ? "quiz" : documentPage ? "document" : videoPage ? "video" : "other",
      videoPaused: video?.video.paused,
      videoReady: video?.video.ready,
      videoEnded: video?.video.ended,
      videoSeconds: video?.video.time,
      videoDuration: video?.video.duration,
      videoJob: videoMarker,
      quizJob: quizMarker,
      submitConfirmDialogCount: frames.reduce((sum, frame) => sum + (frame.submitConfirmDialogCount || 0), 0),
      submitConfirmCandidateCount: frames.reduce((sum, frame) => sum + (frame.submitConfirmCandidateCount || 0), 0),
      videoQuestionFeedback: frames.find((frame) => frame.videoQuestionSurface)?.videoQuestionFeedback,
      remainingTasks: treeTask?.count,
      questionCount: quiz?.questionCount || 0,
      frameCount: frames.length
    });
  }
  if (task.phase === "document") {
    if (!main?.hasDocumentEntry) {
      if (Date.now() - (task.startedAt || Date.now()) < 15000) return;
      throw new Error("文档主要内容入口未加载，请检查当前小节");
    }
    if (!main.documentActive) {
      await frameCommand(main.frameId, "OPEN_DOCUMENT");
      return saveTask(tabId, { documentStartedAt: task.documentStartedAt || Date.now(), status: "已打开文档主要内容，等待阅读区加载" });
    }
    if (treeTask?.kind === "unknown" || !treeTask ||
        (treeTask.kind === "remaining" && treeTask.count === null)) {
      return saveTask(tabId, { state: "paused", status: "文档小节的剩余任务数无法核对，请导出日志" });
    }
    if (!documentReaderFrame) {
      return saveTask(tabId, { state: "paused", status: "未定位到文档正文滚动区；已停止，不会把页面外框当作文档" });
    }
    const startedAt = task.documentStartedAt || Date.now();
    if (!documentReaderFrame.documentReader.atBottom) {
      const result = await frameCommand(documentReaderFrame.frameId, "SCROLL_DOCUMENT");
      if (!result.moved && !result.atBottom) throw new Error("文档阅读区没有响应滚动");
      return saveTask(tabId, { documentStartedAt: startedAt, status: "正在浏览文档并等待平台更新任务进度" });
    }
    if (Date.now() - startedAt < 15000) {
      return saveTask(tabId, { documentStartedAt: startedAt, status: "文档正文已滚到底部，正在核对平台剩余任务数" });
    }
    if (main.hasQuizEntry) {
      const opened = await frameCommand(main.frameId, "OPEN_QUIZ");
      if (opened?.openedInNewTab) return saveTask(tabId, { state: "paused", phase: "quiz",
        documentAttempted: true, quizOpenedAt: null, quizLoadStartedAt: null,
        status: "章节测验已打开新标签页；请切换到该标签页后重新点开始" });
      return saveTask(tabId, { phase: "quiz", documentAttempted: true, quizLoadStartedAt: Date.now(),
        status: "文档任务尚未确认，正在检查课后练习" });
    }
    if (task.directoryUrl) return returnToDirectory(tabId, task, "文档进度未确认，正在返回目录处理其他小节");
    return saveTask(tabId, { state: "paused", status: "文档已浏览到底，但平台仍显示任务未完成" });
  }
  if (task.phase === "video") {
    if (questionFrame) {
      return saveTask(tabId, { phase: "videoQuestion", questionStartedAt: Date.now(),
        questionRetryCount: 0, questionAttempts: [], questionCorrectAt: null, questionContinueClickedAt: null,
        status: "检测到视频内答题，正在识别题目" });
    }
    if (quizPage) {
      return saveTask(tabId, { phase: "quiz", videoCompleted, quizCompleted, quizOpenedAt: null, quizLoadStartedAt: Date.now(), status: "检测到章节测验，正在读取题目" });
    }
    if (videoCompleted) {
      return saveTask(tabId, { phase: "quiz", videoCompleted: true, videoCompletedAt: Date.now(), status: "平台已确认视频任务完成，正在检查章节测验" });
    }
    if (video?.video.error) throw new Error("视频播放器报错，请检查网络或手动播放");
    const needsInitialPlay = !video || (video.video.paused && !video.video.ready && video.video.time === 0);
    if (needsInitialPlay && videoPage) {
      const playFrame = frames.find((frame) => frame.videoPageVisible && frame.hasInitialPlayButton);
      if (playFrame && !task.initialPlayAttemptedAt) {
        await saveTask(tabId, { initialPlayAttemptedAt: Date.now(), status: "已点击播放器首次播放按钮，正在等待加载" });
        await frameCommand(playFrame.frameId, "INITIAL_PLAY");
        return;
      }
      if (task.initialPlayAttemptedAt && Date.now() - task.initialPlayAttemptedAt > 20000) {
        return saveTask(tabId, { state: "paused", status: "播放器未响应自动点击，请手动点击视频中央播放按钮后重新开始" });
      }
      return saveTask(tabId, { status: playFrame ? "正在等待播放器加载" : "未找到首次播放按钮，请手动点击视频中央播放按钮" });
    }
    if (!video) {
      if (task.startedAt && Date.now() - task.startedAt < 15000) return;
      throw new Error("当前页面没有可识别的视频或测验，请检查课程页面");
    }
    const info = video.video;
    if (info.ended) {
      if (task.videoEndedAt && Date.now() - task.videoEndedAt > 20000) {
        throw new Error("视频已播完，但平台仍未确认任务完成，请人工检查");
      }
      return saveTask(tabId, { videoEndedAt: task.videoEndedAt || Date.now(), status: "视频已播完，等待平台确认任务点" });
    }
    if (info.paused) {
      if ((task.playRetries || 0) >= 3) throw new Error("视频连续暂停，自动恢复失败；请检查是否出现弹题或播放限制");
      await frameCommand(video.frameId, "PLAY");
      return saveTask(tabId, { playRetries: (task.playRetries || 0) + 1, status: info.ready ? "视频暂停，已尝试恢复播放" : "正在启动视频并等待加载" });
    }
    if (info.time > (task.lastVideoTime || 0) + 1) {
      return saveTask(tabId, { lastVideoTime: info.time, lastProgressAt: Date.now(), playRetries: 0, status: `正在播放视频 ${Math.floor(info.time)} / ${Math.floor(info.duration || 0)} 秒` });
    }
    if (Date.now() - Math.max(task.lastProgressAt || 0, task.startedAt || 0, task.initialPlayAttemptedAt || 0) > 45000) {
      throw new Error("视频进度长时间未推进，请检查播放器或网络状态");
    }
    return;
  }
  if (task.phase === "videoQuestion") {
    if (!questionFrame) return saveTask(tabId, { phase: "video", questionAttempts: [], status: "视频弹题已消失，继续检测播放" });
    const question = await frameCommand(questionFrame.frameId, "READ_VIDEO_QUESTION");
    await ensureRunning(tabId);
    const images = question.needsImage ? [await frameCommand(questionFrame.frameId, "CAPTURE_VIDEO_QUESTION")] : [];
    const answers = await chrome.runtime.sendMessage({ type: "ANSWER", questions: [question], images });
    if (answers?.error) {
      if (typeof answers.code === "string" && answers.code.startsWith("ANSWER_")) {
        return saveTask(tabId, { state: "paused", status: answers.error });
      }
      throw new Error(answers.error);
    }
    await ensureRunning(tabId);
    await frameCommand(questionFrame.frameId, "FILL_VIDEO_QUESTION", { answer: answers[0] });
    await ensureRunning(tabId);
    const { autoSubmit } = await chrome.storage.local.get("autoSubmit");
    if (autoSubmit === false) {
      return saveTask(tabId, { state: "paused", status: "视频弹题已选好答案，请检查并手动提交" });
    }
    await saveTask(tabId, { phase: "videoQuestionSubmitting", questionSubmittedAt: Date.now(), questionCorrectAt: null,
      questionRetryCount: 0, questionAttempts: appendQuestionAttempt([], answers[0].choices), status: "正在提交视频弹题" });
    await frameCommand(questionFrame.frameId, "SUBMIT_VIDEO_QUESTION");
    return saveTask(tabId, { phase: "videoQuestionSubmitted", status: "视频弹题已提交，等待播放器恢复" });
  }
  if (task.phase === "videoQuestionSubmitting") {
    return saveTask(tabId, { state: "paused", status: "视频弹题提交过程被中断，请人工核对，避免重复提交" });
  }
  if (task.phase === "videoQuestionRetrying") {
    return saveTask(tabId, { state: "paused", status: "视频弹题改选过程被中断，请人工核对，避免重复提交" });
  }
  if (task.phase === "videoQuestionSubmitted") {
    const questionSurface = frames.find((frame) => frame.videoQuestionSurface);
    if (!questionSurface) {
      return saveTask(tabId, { phase: "video", playRetries: 0, lastProgressAt: Date.now(),
        questionContinueClickedAt: null, questionAttempts: [], status: "视频弹题已关闭，继续播放" });
    }
    const feedback = questionSurface.videoQuestionFeedback || "open";
    const elapsed = Date.now() - (task.questionSubmittedAt || Date.now());
    if (feedback === "incorrect") {
      recordDiagnostic("snapshot", { phase: task.phase, page: "video", videoQuestionFeedback: feedback });
      if (Number.isInteger(task.questionRetryCount) && task.questionRetryCount >= MAX_VIDEO_QUESTION_RETRIES) {
        return saveTask(tabId, { state: "paused", status: "视频弹题改选后仍显示答错，请人工核对" });
      }
      const retryIndex = (Number.isInteger(task.questionRetryCount) ? task.questionRetryCount : 0) + 1;
      await saveTask(tabId, { phase: "videoQuestionRetrying", questionRetryCount: retryIndex,
        status: `视频弹题答错，正在重试第 ${retryIndex}/${MAX_VIDEO_QUESTION_RETRIES} 次` });
      const excluded = Array.isArray(task.questionAttempts) ? task.questionAttempts : [];
      await ensureRunning(tabId);
      const shape = await frameCommand(questionSurface.frameId, "VIDEO_QUESTION_SHAPE");
      if (!shape || !Number.isInteger(shape.count) || shape.count < 2 || !["radio", "checkbox"].includes(shape.inputType)) {
        return saveTask(tabId, { state: "paused", status: "视频弹题选项结构无法确认，已停止自动重试，请人工完成" });
      }
      if (!(shape.count === 2 && shape.inputType === "radio")) {
        const question = await frameCommand(questionSurface.frameId, "READ_VIDEO_QUESTION");
        await ensureRunning(tabId);
        const images = question.needsImage ? [await frameCommand(questionSurface.frameId, "CAPTURE_VIDEO_QUESTION")] : [];
        await ensureRunning(tabId);
        const answers = await chrome.runtime.sendMessage({ type: "ANSWER", questions: [question], images,
          exclude: { choices: excluded, attempt: retryIndex } });
        if (answers?.error || !answers?.[0]?.choices?.length) {
          return saveTask(tabId, { state: "paused", status: `视频弹题重答失败：${displayError(answers?.error || "未返回有效选项")}` });
        }
        const nextKey = comboKey(answers[0].choices);
        if (!nextKey || excluded.some((combo) => comboKey(combo) === nextKey)) {
          return saveTask(tabId, { state: "paused", status: "视频弹题重答重复了已判错组合，已停止以免再次提交" });
        }
        await ensureRunning(tabId);
        await frameCommand(questionSurface.frameId, "FILL_VIDEO_QUESTION", { answer: answers[0] });
        await ensureRunning(tabId);
        const settings = await chrome.storage.local.get("autoSubmit");
        if (settings.autoSubmit === false) return saveTask(tabId, { state: "paused", status: "视频弹题已重新选好答案，请检查并手动提交" });
        const attempts = appendQuestionAttempt(excluded, answers[0].choices);
        await saveTask(tabId, { phase: "videoQuestionSubmitting", questionRetryCount: retryIndex,
          questionSubmittedAt: Date.now(), questionAttempts: attempts, status: "正在提交视频弹题重答" });
        await frameCommand(questionSurface.frameId, "SUBMIT_VIDEO_QUESTION");
        return saveTask(tabId, { phase: "videoQuestionSubmitted", questionRetryCount: retryIndex,
          questionAttempts: attempts, status: "已提交视频弹题重答，等待页面反馈" });
      }
      const settings = await chrome.storage.local.get("autoSubmit");
      const result = await frameCommand(questionSurface.frameId, "RETRY_VIDEO_QUESTION", {
        exclude: excluded, autoSubmit: settings.autoSubmit
      });
      if (result.action === "closed") {
        return saveTask(tabId, { phase: "video", playRetries: 0, lastProgressAt: Date.now(),
          questionAttempts: [], status: "改选后视频弹题已关闭，继续播放" });
      }
      if (result.action === "continued") {
        return saveTask(tabId, { phase: "videoQuestionSubmitted", questionRetryCount: retryIndex,
          questionAttempts: appendQuestionAttempt(excluded, result.choices), questionContinueClickedAt: Date.now(),
          status: "已改选并点击继续，等待弹题关闭" });
      }

      if (result.action === "duplicate") {
        return saveTask(tabId, { state: "paused", status: "视频弹题重试会重复已判错选项，已停止以免重复提交" });
      }
      if (result.action === "selected") {
        return saveTask(tabId, { state: "paused", questionRetryCount: retryIndex,
          questionAttempts: appendQuestionAttempt(excluded, result.choices), status: "视频弹题已重新选好答案，请检查并手动提交" });
      }
      if (result.action === "unsupported") {
        return saveTask(tabId, { state: "paused", status: "视频弹题选项超过两个或题型无法安全改选，请人工核对" });
      }
      if (!Array.isArray(result.choices) || !["submitted", "waiting"].includes(result.action)) {
        return saveTask(tabId, { state: "paused", status: "视频弹题重试状态无法确认，已停止，请人工检查后再开始" });
      }
      return saveTask(tabId, { phase: "videoQuestionSubmitted", questionRetryCount: retryIndex,
        questionAttempts: appendQuestionAttempt(excluded, result.choices), questionSubmittedAt: Date.now(),
        status: result.action === "submitted" ? "已改选并提交一次，等待反馈" : "已改选，等待页面反馈" });
    }
    if (task.questionContinueClickedAt) {
      if (Date.now() - task.questionContinueClickedAt > 20000) {
        recordDiagnostic("snapshot", { phase: task.phase, page: "video", videoQuestionFeedback: feedback });
        return saveTask(tabId, { state: "paused", status: "已点击视频弹题的继续按钮，但弹层仍未关闭，请人工检查" });
      }
      return saveTask(tabId, { status: "已点击继续，等待视频弹题关闭" });
    }
    if (feedback === "continue") {
      await saveTask(tabId, { questionContinueClickedAt: Date.now(), status: "正在关闭视频弹题" });
      await frameCommand(questionSurface.frameId, "CONTINUE_VIDEO_QUESTION");
      return;
    }
    if (feedback === "correct") {
      const since = task.questionCorrectAt || Date.now();
      if (Date.now() - since > 30000) {
        return saveTask(tabId, { state: "paused", status: "视频弹题已显示答对，但弹层仍未关闭，请人工检查播放器" });
      }
      return saveTask(tabId, { questionCorrectAt: since, status: "视频弹题显示答对，等待弹层关闭" });
    }
    const timeout = feedback === "submitting" ? 60000 : 30000;
    if (elapsed > timeout) {
      recordDiagnostic("snapshot", { phase: task.phase, page: "video", videoQuestionFeedback: feedback });
      const status = feedback === "submitting" ?
        "视频弹题持续显示提交中，请检查课程登录状态或网络后人工核对" :
        "视频弹题提交后反馈不明确，请人工检查；不会重复提交";
      return saveTask(tabId, { state: "paused", status });
    }
    if (feedback === "submitting") return saveTask(tabId, { status: "视频弹题仍在提交中，等待平台响应" });
    return;
  }
  if (task.phase === "quiz") {
    if (quizCompleted) {
      if (videoCompleted) return saveTask(tabId, { phase: "next", videoCompleted: true, quizCompleted: true, reloadAttempts: 0, status: "平台已确认两个任务点完成" });
      if (main?.hasDocumentEntry && !task.documentAttempted) {
        return saveTask(tabId, { phase: "document", documentStartedAt: Date.now(), status: "测验已完成，正在检查文档阅读任务" });
      }
      if (!main?.hasVideoEntry) {
        if (task.directoryUrl) return returnToDirectory(tabId, task, "测验任务点已完成，正在返回目录核对剩余任务");
        return saveTask(tabId, { state: "paused", quizCompleted: true, status: "测验已完成，但无法定位课程目录" });
      }
      await saveTask(tabId, { phase: "video", videoCompleted: false, quizCompleted: true,
        startedAt: Date.now(), lastVideoTime: 0, lastProgressAt: null, playRetries: 0,
        initialPlayAttemptedAt: null, status: "测验已完成，正在返回视频" });
      await frameCommand(main.frameId, "OPEN_VIDEO");
      return;
    }
    if (!quiz) {
      if (videoPage && !quizPage && !videoCompleted) return saveTask(tabId, {
        phase: "video", quizOpenedAt: null, quizLoadStartedAt: null, startedAt: Date.now(),
        lastVideoTime: 0, lastProgressAt: null, playRetries: 0, initialPlayAttemptedAt: null,
        status: "已切回视频，继续检测播放" });
      const entry = frames.find((frame) => frame.hasQuizEntry);
      if (videoCompleted && !quizPage && !entry && !task.quizOpenedAt) {
        const since = task.videoCompletedAt || Date.now();
        if (Date.now() - since < 10000) return saveTask(tabId, { videoCompletedAt: since, status: "视频已完成，正在确认本节是否有测验" });
        return saveTask(tabId, { state: "paused", videoCompletedAt: since,
          status: "视频已完成，但未能确认章节测验入口；已暂停，避免跳过未完成任务" });
      }
      if (quizPage) {
        const since = task.quizWaitStartedAt || task.quizLoadStartedAt || task.quizOpenedAt || Date.now();
        const elapsed = Date.now() - since;
        if (elapsed < QUIZ_LOAD_TIMEOUT_MS) {
          const seconds = Math.max(1, Math.floor(elapsed / 1000));
          return saveTask(tabId, { quizLoadStartedAt: since, quizWaitStartedAt: since,
            status: `正在等待章节测验加载（${seconds}秒）` });
        }
        return saveTask(tabId, { state: "paused", quizLoadStartedAt: since, quizWaitStartedAt: since,
          status: "章节测验页面已打开，但题目结构超过45秒仍未加载；已暂停。请刷新测验页后点开始，若页面明明有题目请复制页面探针" });
      }
      if (entry && !task.quizOpenedAt) {
        const opened = await frameCommand(entry.frameId, "OPEN_QUIZ");
        if (opened?.openedInNewTab) {
          return saveTask(tabId, { state: "paused", phase: "quiz", quizOpenedAt: null,
            quizLoadStartedAt: null, status: "章节测验已打开新标签页；请切换到该标签页后重新点开始" });
        }
        const openedAt = Date.now();
        return saveTask(tabId, { quizOpenedAt: openedAt, quizLoadStartedAt: openedAt,
          quizWaitStartedAt: openedAt, status: "已打开章节测验" });
      }
      if (task.quizOpenedAt) {
        const since = task.quizWaitStartedAt || task.quizLoadStartedAt || task.quizOpenedAt;
        const elapsed = Date.now() - since;
        if (elapsed < QUIZ_LOAD_TIMEOUT_MS) {
          return saveTask(tabId, { quizLoadStartedAt: since, quizWaitStartedAt: since,
            status: `正在等待章节测验加载（${Math.max(1, Math.floor(elapsed / 1000))}秒）` });
        }
        return saveTask(tabId, { state: "paused", quizLoadStartedAt: since, quizWaitStartedAt: since,
          status: "章节测验入口已点击，但当前标签页45秒内没有进入可识别的测验；已暂停。请检查是否已打开新标签页，切换到测验标签页或刷新课程页后点开始" });
      }
      return saveTask(tabId, { state: "paused", status: "未识别到章节测验页面；若测验已在新标签页打开，请切换过去后点开始，否则请复制页面探针" });
    }
    const read = await frameCommand(quiz.frameId, "READ_QUIZ");
    if (read.error) {
      if (read.unsupportedControls === true) {
        return saveTask(tabId, { state: "paused", status: read.error });
      }
      if (read.retryable === true) {
        const since = task.quizEditorWaitingAt || Date.now();
        if (Date.now() - since < 30000) {
          return saveTask(tabId, { quizEditorWaitingAt: since, status: "正在等待填空题编辑器加载" });
        }
        return saveTask(tabId, { state: "paused", status: "填空题编辑器长时间未加载，请刷新课程页后重试" });
      }
      if (task.documentAttempted && task.directoryUrl) {
        return returnToDirectory(tabId, task, "课后练习状态无法核对，正在返回目录处理其他小节");
      }
      throw new Error(read.error);
    }
    await saveTask(tabId, { quizEditorWaitingAt: null, status: `已识别 ${read.questions.length} 道题，正在读取题目` });
    const { answerMode } = await chrome.storage.local.get("answerMode");
    if (answerMode === "collect") {
      const saved = await rememberQuestions(tabId, read.questions, [], "collect");
      return saveTask(tabId, { state: "paused",
        status: `已收集 ${saved} 道题，可在面板点「导出待复习」查看；把答题方式改回「AI 作答」后再点开始` });
    }
    let answers = null;
    if (answerMode === "random") {
      answers = buildRandomAnswers(read.questions);
      await rememberQuestions(tabId, read.questions, answers, "random");
      await saveTask(tabId, { status: `已随机作答 ${answers.length} 道题（未调用接口）` });
    } else {
    const images = [];
    // A screenshot needs the course tab to be the visible one. When the window is
    // behind another screen the capture fails, which used to block an otherwise
    // text-answerable quiz; fall back to text unless the text is unusable.
    const imageFallback = [];
    let imageError = "";
    const captureTargets = read.questions.filter((question) => question.captureNeeded)
      .sort((left, right) => Number(right.textUsable === false) - Number(left.textUsable === false))
      .slice(0, MAX_CAPTURE_IMAGES);
    const captureIds = new Set(captureTargets.map((question) => question.id));
    for (const question of read.questions) {
      if (!question.captureNeeded) { imageFallback.push(question.id); continue; }
      if (!captureIds.has(question.id)) { imageFallback.push(question.id); continue; }
      await ensureRunning(tabId);
      try {
        images.push(await frameCommand(quiz.frameId, "CAPTURE_QUESTION", { id: question.id }));
      } catch (error) {
        // Never stop just because a screenshot failed: answer from the text and
        // let the model say so when a question really has nothing readable.
        imageFallback.push(question.id);
        if (!imageError) imageError = String(error?.message || "").slice(0, 50);
        recordDiagnostic("recovery", { phase: "quiz", reason: "image-unavailable" });
      }
    }
    await saveTask(tabId, { status: imageFallback.length ?
      (imageError
        ? `截图失败 ${imageFallback.length} 道（${imageError}），已改用文字作答，正在分析答案`
        : `${imageFallback.length} 道题按需跳过截图，已用文字作答，正在分析答案`) : "正在分析测验答案" });
    // The background splits long sheets into batches and rescues leftovers itself,
    // so one call is enough here.
    answers = await chrome.runtime.sendMessage({ type: "ANSWER", questions: read.questions, images, imageFallback });
    if (answers?.error) {
      if (typeof answers.code === "string" && answers.code.startsWith("ANSWER_")) {
        return saveTask(tabId, { state: "paused", status: answers.error });
      }
      throw new Error(answers.error);
    }
    }
    await ensureRunning(tabId);
    // The interface may only answer part of a long sheet. Report the gap instead of
    // silently filling an incomplete one, and let the toggle decide what happens.
    answers = Array.isArray(answers) ? answers : [];
    const answeredIds = new Set(answers.map((item) => String(item?.id ?? "")));
    const leftovers = read.questions.filter((question) => !answeredIds.has(String(question.id)));
    if (leftovers.length) {
      const { guessUnknown } = await chrome.storage.local.get("guessUnknown");
      if (guessUnknown !== true) {
        return saveTask(tabId, { state: "paused", phase: "quiz",
          status: `接口只为 ${answers.length}/${read.questions.length} 道题给出答案，已暂停；勾选「取不到答案时随机选一个」可自动补全并记为待复习` });
      }
      const guessed = guessMissingAnswers(read.questions, answers);
      if (!guessed.length) {
        return saveTask(tabId, { state: "paused", phase: "quiz",
          status: `有 ${leftovers.length} 道题没有答案且无可选项，已暂停；请人工作答后重试` });
      }
      await rememberQuestions(tabId, read.questions, answers, "guess");
      recordDiagnostic("recovery", { phase: "quiz", reason: "answer-guess" });
      await saveTask(tabId, { status: `有 ${guessed.length} 道题没有答案，已随机选择并记为待复习` });
    }
    await saveTask(tabId, { status: "正在填写测验答案" });
    await frameCommand(quiz.frameId, "FILL_QUIZ", { answers });
    await ensureRunning(tabId);
    await frameCommand(quiz.frameId, "VERIFY_QUIZ", { answers });
    await ensureRunning(tabId);
    const { autoSubmit } = await chrome.storage.local.get("autoSubmit");
    if (autoSubmit === false) {
      return saveTask(tabId, { state: "paused", phase: "quiz", status: "答案已填写，请检查并手动提交" });
    }
    await saveTask(tabId, { phase: "submitted", submittedAt: Date.now(), submissionChapterId: new URLSearchParams(location.search).get("chapterId"), status: "正在提交并核对测验状态" });
    await frameCommand(quiz.frameId, "SUBMIT_QUIZ");
    return;
  }
  if (task.phase === "submitted") {
    if (quizCompleted) return saveTask(tabId, { phase: "quiz", quizCompleted: true, status: "平台已确认测验完成，正在核对视频任务点" });
    const confirmations = frames.filter((frame) => frame.hasSubmitConfirm);
    if (confirmations.length > 1 || frames.some((frame) => frame.submitConfirmCandidateCount > 1)) {
      return saveTask(tabId, { state: "paused", phase: "awaitingVerification", status: "存在多个提交确认按钮，已暂停，请人工核对弹窗" });
    }
    const confirm = confirmations[0];
    if (confirm && !task.confirmedAt) {
      await saveTask(tabId, { phase: "confirming", confirmedAt: Date.now(), confirmAttempts: 1,
        confirmDetectAt: null, status: "正在确认提交" });
      await frameCommand(confirm.frameId, "CONFIRM_SUBMIT");
      return saveTask(tabId, { status: "已确认提交，等待平台完成标记" });
    }
    // A visible confirmation dialog whose button could not be matched must not be
    // reported as a silent submission timeout. Say what was actually seen instead.
    if (!confirm && frames.some((frame) => frame.submitConfirmDialogCount > 0)) {
      const since = task.confirmDetectAt || Date.now();
      if (Date.now() - since < CONFIRM_DETECT_GRACE_MS) {
        return saveTask(tabId, { confirmDetectAt: since, status: "检测到提交确认弹窗，正在识别确认按钮" });
      }
      const pane = frames.find((frame) => frame.submitConfirmDialogCount > 0);
      recordDiagnostic("snapshot", { phase: task.phase, page: "quiz",
        submitConfirmDialogCount: pane?.submitConfirmDialogCount || 0,
        submitConfirmCandidateCount: pane?.submitConfirmCandidateCount || 0 });
      return saveTask(tabId, { state: "paused", phase: "awaitingVerification", confirmDetectAt: since,
        status: "提交确认弹窗已弹出，但没能识别出弹窗里的确认按钮；请手工点一次『提交』，或复制页面探针反馈" });
    }
    if (Date.now() - task.submittedAt > SUBMISSION_WAIT_MS) {
      return saveTask(tabId, { state: "paused", phase: "awaitingVerification", status: "提交后仍未看到平台完成标记，请刷新目录并人工核对本节测验" });
    }
    return;
  }
  if (task.phase === "confirming") {
    if (quizCompleted) return saveTask(tabId, { phase: "quiz", quizCompleted: true, status: "平台已确认测验完成，正在核对视频任务点" });
    // The click may land before the layer finishes binding its handler; retry a
    // bounded number of times while the same confirmation dialog is still open.
    const stillOpen = frames.find((frame) => frame.hasSubmitConfirm);
    const attempts = Number(task.confirmAttempts) || 1;
    if (stillOpen && attempts < MAX_CONFIRM_ATTEMPTS &&
        Date.now() - (task.confirmedAt || 0) > CONFIRM_RETRY_INTERVAL_MS) {
      await saveTask(tabId, { confirmAttempts: attempts + 1, confirmedAt: Date.now(),
        status: `提交确认框仍未关闭，正在第 ${attempts + 1} 次点击确认` });
      await frameCommand(stillOpen.frameId, "CONFIRM_SUBMIT");
      return saveTask(tabId, { status: `已第 ${attempts + 1} 次点击确认提交，等待平台完成标记` });
    }
    if (Date.now() - task.confirmedAt > SUBMISSION_WAIT_MS) {
      const status = stillOpen ?
        "确认按钮已点击，但提交确认框仍未关闭；请手工点一次『提交』后刷新核对" :
        "确认后仍未看到测验完成标记，请人工核对";
      return saveTask(tabId, { state: "paused", phase: "awaitingVerification", status });
    }
    return;
  }
  if (task.phase === "next") {
    if (treeTask?.kind !== "complete" && (!videoCompleted || !quizCompleted)) {
      return saveTask(tabId, { state: "paused", status: "平台任务点尚未全部确认完成，已停止翻页，请人工核对" });
    }
    if (task.modernDirectoryMode) {
      return returnToDirectory(tabId, task, "当前项目已完成，正在返回新版目录寻找下一项");
    }
    if (task.directoryUrl) return returnToDirectory(tabId, task, "本节任务点已完成，正在返回目录寻找下一节");
    if (main?.jobBlocked) return saveTask(tabId, { state: "paused", status: "平台提示本节仍有任务点未完成，已停止翻页" });
    if (!main?.chapterId) throw new Error("无法识别当前章节，停止翻页");
    if (!main.hasNext) return saveTask(tabId, { state: "paused", status: "未发现下一节，请核对课程目录是否全部完成" });
    await saveTask(tabId, { phase: "advancing", previousChapterId: main.chapterId, advanceStartedAt: Date.now(), status: "已请求进入下一节，正在核对章节变化" });
    await frameCommand(main.frameId, "NEXT");
    return;
  }
  if (task.phase === "advancing") {
    if (main?.jobBlocked) return saveTask(tabId, { state: "paused", status: "平台阻止翻页：本节仍有未完成任务点" });
    if (main?.chapterId && main.chapterId !== task.previousChapterId) {
      return saveTask(tabId, {
        phase: "video", activeChapterId: main.chapterId, startedAt: Date.now(), videoCompleted: false, quizCompleted: false,
        lastVideoTime: 0, lastProgressAt: null, videoEndedAt: null, playRetries: 0,
        initialPlayAttemptedAt: null, questionSubmittedAt: null, questionCorrectAt: null, quizEditorWaitingAt: null, questionContinueClickedAt: null,
        questionRetryCount: 0,
        quizOpenedAt: null, submittedAt: null, confirmedAt: null, confirmAttempts: 0, confirmDetectAt: null,
        status: "已进入下一节，正在检测视频"
      });
    }
    if (Date.now() - task.advanceStartedAt > 20000) throw new Error("点击下一节后章节未变化，请人工检查是否已到课程末尾");
    return;
  }
}

async function startLoop(tabId) {
  if (loopActive) return;
  loopActive = true;
  try {
    while (true) {
      const key = `task:${tabId}`;
      const task = (await chrome.storage.local.get(key))[key];
      if (!task || task.state !== "running") break;
      try { await tick(tabId, task); }
      catch (error) {
        const latest = (await chrome.storage.local.get(key))[key];
        if (latest?.state === "paused") break;
        const message = error?.message || String(error);
        if (/验证码错误一次/.test(message)) {
          await saveTask(tabId, { state: "paused", status: "验证码错误一次，已暂停；请人工核对" });
          break;
        }
        if (/验证码弹窗待处理/.test(message)) {
          await saveTask(tabId, { phase: "captcha", captchaReturnPhase: latest?.phase || task.phase,
            status: "检测到验证码，正在尝试识别一次" });
          continue;
        }
        if (/新版页面|旧版页面结构/.test(message)) {
          await saveTask(tabId, { state: "paused", status: message });
          break;
        }
        // A dropped frame, a slow page or a flaky network is not a reason to stop.
        // Deterministic problems still stop at once; everything else is retried.
        const attempts = Number(latest?.retryAttempts) || 0;
        const plan = retryPlan(message, attempts);
        if (plan.retry) {
          recordDiagnostic("recovery", { phase: latest?.phase || task.phase, reason: "transient-retry" });
          await saveTask(tabId, { retryAttempts: plan.attempt, retryReason: message.slice(0, 120),
            retryingAt: Date.now(),
            status: `页面暂时没有响应：${retryReasonText(error)}；${Math.round(plan.delay / 1000)} 秒后进行第 ${plan.attempt}/${RETRY_DELAYS_MS.length} 次重试` });
          await wait(plan.delay);
          continue;
        }
        if (!plan.fatal) {
          recordDiagnostic("error", { source: "content", phase: task.phase, message, name: error?.name });
          await saveTask(tabId, { state: "paused", retryAttempts: 0, retryReason: null,
            status: `已连续重试 ${RETRY_DELAYS_MS.length} 次仍未成功（最后一次：${retryReasonText(error)}），已暂停；检查网络或刷新页面后再点开始` });
          break;
        }
        recordDiagnostic("error", { source: "content", phase: task.phase, message, name: error?.name });
        await saveTask(tabId, { state: "error", status: displayError(error) });
        break;
      }
      const settled = (await chrome.storage.local.get(key))[key];
      if (settled?.retryAttempts) await saveTask(tabId, { retryAttempts: 0, retryReason: null });
      await wait(3000);
    }
  } finally {
    loopActive = false;
    maybeAutoReload(tabId).catch(() => {});
  }
}

// Last-resort watchdog: when the run stopped by itself (not by the user) and a
// reload could plausibly help, reload the page and let the init hook resume.
// Capped so a genuinely broken page cannot loop forever.
function autoReloadPlan(task, enabled) {
  if (!task || !["paused", "error"].includes(task.state)) return "skip";
  if (enabled === false) return "skip";
  const status = String(task.status || "");
  if (status.includes("已由用户暂停")) return "skip";
  if (/验证码|人工|核对|请确认|尚未确认|手动提交|请检查并手动|接口只为|没有答案/.test(status)) return "skip";
  const attempts = Number(task.reloadAttempts) || 0;
  return attempts >= 3 ? "exhausted" : "reload";
}

async function maybeAutoReload(tabId) {
  const key = `task:${tabId}`;
  const task = (await chrome.storage.local.get(key))[key];
  const { autoRefresh } = await chrome.storage.local.get("autoRefresh");
  const plan = autoReloadPlan(task, autoRefresh);
  if (plan === "skip") return;
  const status = String(task.status || "");
  const attempts = Number(task.reloadAttempts) || 0;
  if (plan === "exhausted") {
    await chrome.storage.local.set({ [key]: { ...task, reloadAttempts: 0,
      status: `已自动刷新 3 次仍未恢复，已停止；请人工检查后重新点开始（上次原因：${status.slice(0, 60)}）` } });
    return;
  }
  await chrome.storage.local.set({ [key]: { ...task, state: "running", reloadAttempts: attempts + 1,
    retryAttempts: 0, autoResumedAt: Date.now(),
    status: `运行中断，正在自动刷新页面重试（第 ${attempts + 1}/3 次）` } });
  recordDiagnostic("recovery", { phase: task.phase, reason: "auto-reload" });
  await wait(1200);
  location.reload();
}

if (window === top && isChaoxingPage()) {
  chrome.runtime.sendMessage({ type: "TAB_ID" }).then(async (tabId) => {
    if (!tabId) return;
    const key = `task:${tabId}`;
    const task = (await chrome.storage.local.get(key))[key];
    if (task?.state === "running") startLoop(tabId);
  }).catch(() => {});
}

})();
