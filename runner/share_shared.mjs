// While a share page is being assembled, the raw answers of its reads, by route.
export const SHARE_READ_CONCURRENCY = 6;
export const SHARE_UPLOAD_CONCURRENCY = 6;
// Where a reader of a share page learns about the product.
export const SHARE_HOME = "https://codiscuss.com";
// The official share site that hosts published links (operator repository codiscuss_site/services/share/); changing the domain changes only this.
export const SHARE_SITE = "https://share.codiscuss.com";
// What a published link carries and how long it lives (the site enforces the same).
export const SHARE_FORMAT = 1;
export const SHARE_DAYS = [1, 3, 7];
export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_BYTES = 5 * 1024 * 1024;
// A downloaded page holds its attachments in memory as one string; past this the browser cannot build it.
export const SHARE_FILE_MAX_BYTES = 100 * 1024 * 1024;
// A published link's attachments (user 2026-11-23): sent as files after the page, not inside its 5 MB of text.
export const SHARE_SITE_FILE_MAX_BYTES = 100 * 1024 * 1024;
export const SHARE_SITE_FILES_MAX_BYTES = 300 * 1024 * 1024;
// HTML demos up to this size are read as a share page opens (warm_share_demos); larger ones wait to be seen.
export const SHARE_DEMO_WARM_BYTES = 2 * 1024 * 1024;
// The attachments the share site takes, by extension, each sent as this one type: every kind the page previews, since
// showing them is part of what a share is for (user 2026-11-22). Left out are kinds it cannot show and that could carry
// a program or macros (executables, old-format doc/xls/ppt): anyone may publish, and these would be handed out from the
// share site's own address. Zip archives go too, the preview listing them like a folder (user 2026-11-23). The share site checks the same list (SHARE_FILE_TYPES in codiscuss_site/services/share/worker.mjs).
// Scripts a desktop runs on a double click go as text under a name ending in .txt (SHARE_SITE_AS_TEXT).
export const SHARE_SITE_FILE_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/opus", flac: "audio/flac", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska",
  pdf: "application/pdf", html: "text/html", htm: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ods: "application/vnd.oasis.opendocument.spreadsheet",
  prproj: "application/gzip", zip: "application/zip",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", jsonc: "text/plain", jsonl: "text/plain",
  xml: "text/xml", yaml: "text/yaml", yml: "text/yaml", toml: "text/plain", ini: "text/plain", log: "text/plain", css: "text/css",
  srt: "text/plain", vtt: "text/vtt", ass: "text/plain", ssa: "text/plain", lrc: "text/plain",
  fcpxml: "text/xml", kdenlive: "text/xml", mlt: "text/xml", otio: "application/json", edl: "text/plain",
  py: "text/plain", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", java: "text/plain", c: "text/plain", h: "text/plain", cpp: "text/plain",
  hpp: "text/plain", cs: "text/plain", go: "text/plain", rs: "text/plain", rb: "text/plain", php: "text/plain", swift: "text/plain", kt: "text/plain", sql: "text/plain",
  sh: "text/plain", vue: "text/plain", diff: "text/plain", patch: "text/plain",
};
export const SHARE_SITE_AS_TEXT = /\.(?:js|mjs|cjs|ps1|bat|cmd|vbs)$/i;
// Fields a share page never carries: where things ran on this computer, sessions, credentials, the owner's own notes
// on the room and its members, the decision model's choices, messages still queued, attachments and refused commands.
export const SHARE_DROPPED_FIELDS = new Set(["cwd", "session_id", "reported_session", "reported_client", "client_id", "submission_id",
  "lease_until", "adopt_error", "token", "access_token", "descriptions", "extra_directories", "project_directory", "resets"]);
export const SHARE_ZEROED_FIELDS = ["quota_until", "held_until"];
export const SHARE_EMPTIED_FIELDS = new Set(["scheduler_decisions", "scheduler_routing", "recommendations", "denials", "queued_messages",
  "ended_externals", "attachments"]);
// Template parameters a notice fills with the software's own words, and what a share page says instead.
// The room's own background and boundaries are text; executions use "background" as a flag, which stays.
export const SHARE_DROPPED_TEXT = new Set(["background", "boundaries"]);
// Text that looks like a key, a token, a person's folder on a computer or contact details: flagged for the owner, never rewritten.
export const SHARE_SENSITIVE_PATTERNS = [/\bsk[-_](?:live_)?[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /\b(?:hf|npm)_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g, /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/g, /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"]+/g, /\/(?:home|Users)\/[^/\s"]+/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, /(?<!\d)1[3-9]\d{9}(?!\d)/g, /\bresets?\s+(?:in\s+)?\d[^\n]{0,40}/gi, /\(\s*[A-Z][a-z]+\/[A-Za-z_]+\s*\)/g];
// "<" and the two line separators JSON allows but a script must not carry raw.
export const SHARE_SCRIPT_UNSAFE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, "g");
// A person's home folder on any computer, in Windows, Git Bash, WSL or Unix spelling; a share page writes it as "~".
export const SHARE_HOME_FOLDERS = [/(?<![\w./-])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|*?]+/gi, /(?<![\w./-])\/(?:mnt\/)?[a-z]\/Users\/[^/\s"'`]+/gi,
  /(?<![\w./-])\/(?:home|Users)\/[^/\s"'`]+/g];
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;
// A folder named by fewer parts ("C:", "/home") is too broad to rewrite in text.
export const SHARE_FOLDER_MIN_PARTS = 2;
/** Identify the receipt headings produced by answering, recommending or delegating a room question. */
export function is_share_question_receipt(text) {
  const heading = String(text || "").trimStart().split("\n", 1)[0].trimEnd();
  return /^(?:回答问题\s*#?\d+|Answer to question #\d+)(?:[：:]|$)/iu.test(heading)
    || /^(?:请主持人先讨论并给推荐|交给主持人决定)（问题 #\d+）$/u.test(heading)
    || /^(?:Host, please discuss and recommend first|Leaving it to the host to decide) \(question #\d+\)$/iu.test(heading);
}
// Attachments whose text is scanned for keys and folders before sharing: plain text up to this size, not packed office files.
export const TEXT_ATTACHMENT = /\.(md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|xml|html?|css|vue|[cm]?js|jsx|tsx?|py|sql|sh|ps1|bat|srt|vtt|ass|ssa|lrc|fcpxml|kdenlive|mlt|otio|edl|docx|xlsx|xls|ods|pptx|prproj|zip)$/i;
export const SHARE_SCAN_BYTES = 2 * 1024 * 1024;
export const SHARE_PACKED_TEXT = /\.(docx|xlsx|xls|ods|pptx|prproj|zip)$/i;
export const SHARE_SNIPPET_CHARS = 20;

// The kinds the share dialog lets the owner leave out, in the order it lists them (user 2026-11-23: a room's zips, which
// repackage its other files, took it past the 100 MB a link carries).
export const SHARE_FILE_KINDS = [
  ["archive", /\.(zip|rar|7z|tar|gz|tgz)$/i], ["video", /\.(mp4|m4v|webm|mov|mkv|avi|wmv|ogv)$/i],
  ["audio", /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i], ["image", /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i],
  ["document", /\.(pdf|docx?|xlsx?|ods|pptx?|prproj)$/i], ["page", /\.html?$/i]];

// What an answer delivers, found as frontend/AnswerFiles.vue finds it (this classic script cannot import it): a file the
// answer names in inline code or a link, of a document or media kind, changed on the computer after its execution began.
export const SHARE_DELIVERABLE = /\.(docx?|xlsx?|ods|csv|tsv|pptx?|pdf|md|txt|html?|png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|webm|mov|srt|vtt)$/i;
export const SHARE_DELIVERED_MAX = 6;


/** Bind an offline download to the full cleaned material that was reviewed, independently of parallel read order. */
export async function share_fingerprint(responses, responses_with_files) {
  const sorted = values => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const data = new TextEncoder().encode(JSON.stringify([sorted(responses), sorted(responses_with_files)]));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
}

export function create_share_core({ t, display_name, collapse_visual_fences, is_text_attachment }) {
  const server_text = (value, fallback) => value?.template ? t(value.template, value.params) : fallback;
  const SHARE_TEMPLATE_PARAMS = { reason: () => t('执行失败'), resets: () => t('未公开') };
  /** A changed file's path as a share page shows it: inside the run's own folder, or the last two parts of the path. */
  function share_path(path, folder) {
    if (typeof path !== "string") return path;
    const normal = path.replaceAll("\\", "/");
    if (!ABSOLUTE_PATH.test(normal)) return path;
    const base = String(folder || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    if (base && normal.toLowerCase().startsWith(`${base}/`)) return normal.slice(base.length + 1);
    return `…/${normal.split("/").filter(Boolean).slice(-2).join("/")}`;
  }

  /** Copy an answer for a share page, leaving out what only this computer and its owner should see; attachments only when `keep_files`. */
  function share_clean(value, keep_files = false) {
    if (Array.isArray(value)) return value.map(item => share_clean(item, keep_files));
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (SHARE_DROPPED_FIELDS.has(key) || SHARE_DROPPED_TEXT.has(key) && typeof item === "string") continue;
      result[key] = SHARE_EMPTIED_FIELDS.has(key) && !(keep_files && key === "attachments") ? (Array.isArray(item) ? [] : null) : share_clean(item, keep_files);
    }
    // When a member's quota comes back is the same fact as a quota notice's reset time, as a timestamp.
    for (const field of SHARE_ZEROED_FIELDS) if (field in result) result[field] = 0;
    // Another person's computer: only that the member is external stays.
    if (value.external && typeof value.external === "object") result.external = true;
    // A failure's own text comes from the software and can name the account, its plan or its time zone.
    if (value.status === "failed" || value.failure_class) {
      if (typeof result.result === "string" && result.result) result.result = t('执行失败');
      if (typeof result.reason === "string" && result.reason) result.reason = t('执行失败');
    }
    if (result.retry?.reason) result.retry = { ...result.retry, reason: "" };
    // A system notice about a failed run quotes the same text, or its quota's reset time, through its template: the notice
    // keeps its wording, not the quote. Read from the original, since "resets" itself is a dropped field.
    for (const [field, metadata] of Object.entries(value.texts || {})) {
      const params = metadata?.params || {};
      const replaced = Object.fromEntries(Object.keys(SHARE_TEMPLATE_PARAMS).filter(key => params[key]).map(key => [key, SHARE_TEMPLATE_PARAMS[key]()]));
      if (!Object.keys(replaced).length) continue;
      result.texts = { ...result.texts, [field]: { ...metadata, params: { ...result.texts?.[field]?.params, ...replaced } } };
      if (typeof result[field] === "string") result[field] = server_text(result.texts[field], result[field]);
    }
    for (const field of ["changes", "edited"]) if (Array.isArray(result[field])) result[field] = result[field].map(item => share_path(item, value.cwd));
    if (Array.isArray(result.diff_stats)) result.diff_stats = result.diff_stats.map(item => item?.path ? { ...item, path: share_path(item.path, value.cwd) } : item);
    return result;
  }

  /** Process a bounded number of reads at a time and drain in-flight work before reporting a failure. */
  async function share_parallel(items, concurrency, operation) {
    const results = [];
    const queue = items.entries();
    let failure;
    await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      for (const [index, item] of queue) {
        if (failure) break;
        try { results[index] = await operation(item); }
        catch (error) { failure ??= error; break; }
      }
    }));
    if (failure) throw failure;
    return results;
  }

  /** A history batch without retracted or rewound messages. */
  function share_batch(body) {
    return { ...body, messages: (body.messages || []).filter(message => !message.withdrawn) };
  }

  /** Every string inside an answer, so a scan reads text as written rather than JSON with its escapes. */
  function share_strings(value, out = []) {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) share_strings(item, out);
    else if (value && typeof value === "object") for (const item of Object.values(value)) share_strings(item, out);
    return out;
  }

  /**
   * Where the share page has text that looks like a key, a token, a personal folder or contact details, one entry per place
   * (a message, a run's notes, the room's details) with how many it has and the first of them in its context. `extra` adds
   * texts read elsewhere, as [{ texts, where }] (an attachment's own text).
   */
  function share_sensitive_spots(responses, extra = []) {
    const places = new Map();
    const scan = (texts, where) => {
      for (const text of texts) {
        for (const pattern of SHARE_SENSITIVE_PATTERNS) {
          for (const match of text.matchAll(pattern)) {
            const place = places.get(where) || places.set(where, { where, count: 0, text: "" }).get(where);
            place.count++;
            if (!place.text) {
              const from = Math.max(0, match.index - SHARE_SNIPPET_CHARS);
              place.text = `${from ? "…" : ""}${text.slice(from, match.index + match[0].length + SHARE_SNIPPET_CHARS).replace(/\s+/g, " ")}…`;
            }
          }
        }
      }
    };
    for (const [path, body] of Object.entries(responses)) {
      if (/\/messages\?/.test(path)) for (const message of body.messages || []) scan([message.text || "", message.summary || ""], `#${message.id}`);
      else if (/\/notes$/.test(path)) scan(share_strings(body), t('执行 #{id} 的过程说明', { id: path.match(/executions\/(\d+)/)[1] }));
      else scan(share_strings(body), t('房间与执行信息'));
    }
    for (const { texts, where } of extra) scan(texts, where);
    return [...places.values()];
  }

  /**
   * The attachments a share page could carry: those of the messages it shows, each once, by the route that reads it. Only
   * this room's own: the share site takes no route outside the shared room.
   */
  function share_files(responses, room_id) {
    const files = new Map();
    for (const [path, body] of Object.entries(responses)) {
      if (!/\/messages\?/.test(path)) continue;
      for (const message of body.messages || []) for (const file of message.attachments || []) {
        if (file.room_id !== room_id) continue;
        const route = share_file_route(file);
        // A data URL names the plain type; parameters such as a charset would not survive the share site's check.
        files.set(route, { route, room_id, id: file.id, created_at: message.created_at, author: message.author_label || message.author, file_name: file.file_name, size: Number(file.size) || 0, message_id: message.id, ...share_site_file(file.file_name),
          content_type: String(file.content_type || "").split(";")[0].trim() || "application/octet-stream" });
      }
    }
    return [...files.values()];
  }

  /** Where an attachment's content is read; the key it has in a share page. */
  function share_file_route(file) {
    return `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content`;
  }

  /**
   * How the share site takes a file of this name: { site_name, site_type }, the type "" for a kind it does not take. A
   * script a desktop would run on a double click is named as text, so a reader who downloads it opens it to read.
   */
  function share_site_file(file_name) {
    const site_name = SHARE_SITE_AS_TEXT.test(file_name || "") ? `${file_name}.txt` : String(file_name || "");
    const extension = /\.([^./\\]+)$/.exec(site_name)?.[1].toLowerCase() || "";
    return { site_name, site_type: Object.hasOwn(SHARE_SITE_FILE_TYPES, extension) ? SHARE_SITE_FILE_TYPES[extension] : "" };
  }

  /** The attachments a page carries: none unless included; on the share site (`site`) only the kinds it takes. */
  function share_carried_files(draft, site) {
    if (!draft.include_files) return [];
    const chosen = draft.files.filter(file => !draft.left_files?.has(file.route));
    return site ? chosen.filter(file => file.site_type) : chosen;
  }

  /** Which kind a file counts as in the share dialog: one of SHARE_FILE_KINDS, else "text". */
  function share_file_kind(file_name) {
    return SHARE_FILE_KINDS.find(([, pattern]) => pattern.test(file_name || ""))?.[0] || "text";
  }

  /**
   * The dialog's attachment kinds: how many of each and how large, whether they go in (true, false, or "indeterminate"
   * when only some do), and the files themselves, largest first, to pick one by one (user 2026-11-23).
   */
  function share_file_kinds(draft) {
    const labels = { archive: t('压缩包'), video: t('视频'), audio: t('音频'), image: t('图片'), document: t('文档'), page: t('网页'), text: t('文本与代码') };
    const kinds = new Map();
    for (const file of draft.files || []) {
      const kind = share_file_kind(file.file_name);
      const entry = kinds.get(kind) || kinds.set(kind, { kind, label: labels[kind], count: 0, bytes: 0, files: [] }).get(kind);
      entry.count++;
      entry.bytes += file.size;
      entry.files.push({ ...file, name: file.file_name, included: !draft.left_files?.has(file.route) });
    }
    return [...SHARE_FILE_KINDS.map(([kind]) => kind), "text"].filter(kind => kinds.has(kind)).map(kind => {
      const entry = kinds.get(kind), chosen = entry.files.filter(file => file.included);
      const selected_count = chosen.length, selected_bytes = chosen.reduce((sum, file) => sum + file.size, 0);
      entry.files.sort((a, b) => b.message_id - a.message_id);
      return { ...entry, selected_count, selected_bytes, included: selected_count === entry.count ? true : selected_count ? "indeterminate" : false };
    });
  }

  /**
   * The answers a page carries. For the share site, a file it does not take is left out of its message (its tag then reads
   * "not included"), and the rest are listed by the type they are sent as.
   */
  function share_responses(draft, site) {
    if (!draft.include_files) return draft.responses;
    if (!site && !draft.left_files?.size) return draft.responses_with_files;
    // A file left out is taken out of its message too, so its tag reads "not included in the share".
    const taken = new Map(share_carried_files(draft, site).map(file => [file.route, site ? file : { ...file, site_name: file.file_name, site_type: file.content_type }]));
    const responses = structuredClone(draft.responses_with_files);
    for (const [path, body] of Object.entries(responses)) {
      if (!/\/messages\?/.test(path)) continue;
      for (const message of body.messages || []) if (message.attachments) message.attachments = message.attachments
        .filter(file => taken.has(share_file_route(file)))
        .map(file => ({ ...file, file_name: taken.get(share_file_route(file)).site_name, content_type: taken.get(share_file_route(file)).site_type }));
    }
    return responses;
  }

  /** The paths an answer names in inline code or links, outside code blocks (AnswerFiles.vue `named_paths`). */
  function share_named_paths(text) {
    const prose = String(text || "").replace(/```[\s\S]*?```/g, "");
    const named = [...prose.matchAll(/`([^`\n]+)`|\]\(([^)\n]+)\)/g)].map(match => (match[1] || match[2]).trim());
    return [...new Set(named)].filter(path => SHARE_DELIVERABLE.test(path) && !/^[a-z][a-z0-9+.-]+:\/\//i.test(path)).slice(0, SHARE_DELIVERED_MAX);
  }

  /** A folder of this computer as a pattern for any spelling of it in text: either slash, any letter case, with the separator after it. */
  function share_folder_pattern(folder) {
    const parts = String(folder).split(/[\\/]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (parts.length < SHARE_FOLDER_MIN_PARTS) return null;
    // A drive is also written /d or /mnt/d (Git Bash, WSL).
    const drive = parts[0].match(/^([A-Za-z]):$/);
    const first = drive ? `(?:${drive[1]}:|/${drive[1]}|/mnt/${drive[1]})` : `${String(folder).startsWith("/") ? "/" : ""}${parts[0]}`;
    // Whole path parts only: D:\Work\X is not the start of D:\Work\X-wt, nor of a path inside an address.
    return new RegExp(`(?<![\\w./-])${[first, ...parts.slice(1)].join("[\\\\/]+")}(?![\\w-])([\\\\/]+)?`, "gi");
  }

  /**
   * What a share page carries, from the answers its reads got: only this room in the directory, no messages the owner took
   * back, none of the fields only this computer and its owner should see, and the room's project folders written as paths
   * inside the project. `folders` adds folders the page knows beyond those its runs worked in.
   */
  function share_payload(raw, room_id, folders = [], { attachments = false } = {}) {
    const known = new Set(folders.filter(Boolean));
    JSON.stringify(raw, (key, item) => { if (key === "cwd" && typeof item === "string" && item) known.add(item); return item; });
    // Longer folders first, so a project inside another one keeps its own relative paths.
    const patterns = [...known].sort((a, b) => b.length - a.length).map(share_folder_pattern).filter(Boolean);
    const strip = (value) => {
      if (typeof value === "string") {
        const prose = value.includes("visual") ? collapse_visual_fences(value, t('交互式可视化')) : value;
        return SHARE_HOME_FOLDERS.reduce((text, pattern) => text.replace(pattern, () => "~"),
          patterns.reduce((text, pattern) => text.replace(pattern, (match, separator) => separator ? "" : t('项目目录')), prose));
      }
      if (Array.isArray(value)) return value.map(strip);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]));
    };
    // Messages the owner took back, and the runs that asked or answered them: their text also sits in the timeline and notes.
    const withdrawn = new Set(Object.entries(raw).filter(([path]) => /\/messages\?/.test(path))
      .flatMap(([, body]) => (body.messages || []).filter(message => message.withdrawn).map(message => message.id)));
    const on_withdrawn = (run) => [run.task_id, run.request_message_id, run.answer_id].some(id => withdrawn.has(id));
    const dropped_runs = new Set();
    JSON.stringify(raw, (key, item) => { if (key === "executions" && Array.isArray(item)) for (const run of item) if (run && on_withdrawn(run)) dropped_runs.add(run.id); return item; });
    const without_runs = (value) => {
      if (Array.isArray(value)) return value.map(without_runs);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "executions" && Array.isArray(item) ? item.filter(run => !dropped_runs.has(run?.id)).map(without_runs) : without_runs(item)]));
    };
    const responses = {};
    for (const [path, body] of Object.entries(raw)) {
      const run = path.match(/\/executions\/(\d+)\/notes$/);
      if (run && dropped_runs.has(Number(run[1]))) continue;
      let kept = body;
      if (path === "/api/rooms") kept = { rooms: (body.rooms || []).filter(room => room.id === room_id).map(room => ({ ...room, folder_id: "", archived: false })),
        folders: [], uncategorized_position: 0, participants: [], last_room: room_id };
      else if (/\/messages\?/.test(path)) kept = share_batch(body);
      responses[path] = strip(share_clean(without_runs(kept), attachments));
    }
    return responses;
  }

  /** Markdown reduced to plain words for a one-glance excerpt. */
  function share_plain(text) {
    return String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_>#|~-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function share_card_messages(responses) {
    return Object.entries(responses).filter(([path]) => /\/messages\?/.test(path)).flatMap(([, body]) => body.messages || [])
      .filter(message => message.kind !== "system" && message.text).sort((a, b) => a.id - b.id);
  }

  function share_card_materials_info(responses) {
    const messages = share_card_messages(responses);
    return { through: messages.at(-1)?.id ?? null, count: messages.length };
  }

  /** What the share card shows of a prepared page: members, the first question, the latest outcome and the counts. */
  function share_card(draft, link) {
    const room = draft.responses[`/api/rooms/${draft.room_id}`] || {};
    const members = (room.members || []).filter(member => member.status !== "removed").map(member => member.label || display_name(member.name));
    const messages = share_card_messages(draft.responses);
    const question = messages.find(message => message.author === "用户" && !is_share_question_receipt(message.text)
      && !/^\/?(?:继续|好的?|同意|continue|ok)[。.!！\s]*$/iu.test(message.text.trim()));
    const answers = messages.filter(message => message.author !== "用户" && message.author !== "系统" && message.id > (question?.id ?? 0));
    const outcome = answers.findLast(message => message.summary) || answers.at(-1);
    // Text the owner was asked to check stays off the card, which cannot be taken back once posted; it can be typed in.
    const flagged = new Set((draft.spots || []).map(spot => spot.where));
    const text = (message, value) => message && !flagged.has(`#${message.id}`) ? share_plain(value) : "";
    const result = text(outcome, outcome?.summary || outcome?.text);
    const sentences = result.match(/[^。！？.!?]+(?:[。！？]|[.!?](?=\s|$)|$)/gu) || [];
    const complete = sentences[0]?.trim();
    return { title: draft.title, members, materials: { through: messages.at(-1)?.id ?? null, count: messages.length },
      question: text(question, question?.text).slice(0, 600),
      outcome: (complete && result.startsWith(complete) ? complete : result).slice(0, 600),
      stats: t('{members} 位 AI · {messages} 条消息 · {runs} 次执行', { members: members.length, messages: room.message_count ?? messages.length, runs: draft.runs ?? 0 }),
      url: link.url, expires: t('{time} 前有效', { time: new Date(link.expires_at).toLocaleString(undefined, { hour12: false }) }) };
  }

  async function share_collect_reads(room_id, history_batch_path, keep) {
    const base = `/api/rooms/${room_id}`;
    await Promise.all([keep("/api/rooms"), keep(base)]);
    const noted = new Set(), runs = new Set();
    for (let after = 0, more = true; more;) {
      const batch = await keep(history_batch_path(room_id, "", after));
      for (const execution of batch.cards?.executions || []) {
        runs.add(execution.id);
        if (execution.notes > 0) noted.add(execution.id);
      }
      more = Boolean(batch.has_more) && batch.messages.length > 0;
      after = batch.messages.at(-1)?.id || after;
    }
    const timeline = await keep(`${base}/timeline`);
    for (const execution of timeline.executions || []) {
      if (execution.source === "external") continue;
      runs.add(execution.id);
      if (execution.notes?.length || execution.last_note) noted.add(execution.id);
    }
    // Notes are read only for runs that have some; one that cannot be read stops the page rather than leaving it short.
    await share_parallel([...noted], SHARE_READ_CONCURRENCY, id => keep(`${base}/executions/${id}/notes`));
    return runs.size;
  }
  async function share_find_delivered(responses, room_id, folders, stat) {
    const delivered = new Map();
    const executions = responses[`/api/rooms/${room_id}`]?.free?.executions || [];
    const started = new Map(executions.map(execution => [execution.id, execution.created_at]));
    const roots = folders.filter(Boolean).length || 1;
    const candidates = [], locations = new Map();
    for (const [path, body] of Object.entries(responses)) {
      if (!/\/messages\?/.test(path)) continue;
      for (const message of body.messages || []) {
        if (!started.has(message.execution_id)) continue;
        for (const named of share_named_paths(message.text)) {
          const relative = named.replaceAll("\\", "/").replace(/^\.\//, "");
          if (/^([a-z]:)?\//i.test(relative) || relative.split("/").includes("..")) continue;
          // An answer attaching a file of the same name shows only the attachment, as in the room (user 2026-11-22).
          const name = relative.split("/").at(-1).toLowerCase();
          if ((message.attachments || []).some(file => String(file.file_name).toLowerCase() === name)) continue;
          const keys = [];
          for (let root = 0; root < roots; root++) {
            const key = JSON.stringify([root, relative]);
            locations.set(key, { root, path: relative });
            keys.push(key);
          }
          candidates.push({ message, relative, keys });
        }
      }
    }
    if (!locations.size) return delivered;
    const items = [...locations.values()];
    const stats = await stat(items);
    const by_location = new Map([...locations.keys()].map((key, index) => [key, stats[index]]));
    for (const { message, relative, keys } of candidates) {
      const key = keys.find(key => by_location.get(key)?.kind === "file" && Date.parse(by_location.get(key).modified_at) >= started.get(message.execution_id) * 1000);
      if (!key) continue;
      const file_name = relative.split("/").at(-1);
      if (message.attachments?.some(file => file.file_name.toLowerCase() === file_name.toLowerCase())) continue;
      const file = { room_id, id: `delivered-${message.id}-${delivered.size}`, file_name, size: by_location.get(key).size,
        content_type: share_site_file(relative).site_type || "application/octet-stream" };
      message.attachments = [...message.attachments || [], file];
      delivered.set(share_file_route(file), locations.get(key));
    }
    return delivered;
  }
  async function share_scan_files(files, read) {
    const candidates = files.filter(file => is_text_attachment(file) && !SHARE_PACKED_TEXT.test(file.file_name) && file.size <= SHARE_SCAN_BYTES);
    const scanned = await share_parallel(candidates, SHARE_READ_CONCURRENCY, async file => {
      const where = t('#{id} 的附件 {name}', { id: file.message_id, name: file.file_name });
      try { return { texts: [new TextDecoder().decode(await read(file))], where }; }
      catch { return { where, count: 1, text: t('读取失败，没能检查，请自己核对') }; }
    });
    const extra = scanned.filter(item => item.texts), unread = scanned.filter(item => !item.texts);
    return [...share_sensitive_spots({}, extra), ...unread];
  }
  return { share_path, share_clean, share_parallel, share_batch, share_strings, share_sensitive_spots, share_files, share_file_route, share_site_file, share_carried_files, share_file_kind, share_file_kinds, share_responses, share_named_paths, share_folder_pattern, share_payload, share_plain, share_card, share_card_materials_info, share_collect_reads, share_find_delivered, share_scan_files };
}
