/* ==========================================================================
   R9 黒潮医療人養成プロジェクト 希望調整 — V3 (クール表タイムテーブル UI)
   Frontend-only app. Talks directly to an already-provisioned Supabase
   backend (tables: app_settings, slots, students, change_log, admins;
   RPCs: student_snapshot, student_set_choice). No schema is created here.

   Column names are the real ones (see AGENTS.md). The 県内/県外 split,
   facility order and the per-facility conditions shown in the left column
   come from the official クール表 via FACILITY_GROUPS, because slots has no
   prefecture column.
   ========================================================================== */

const SUPABASE_URL = "https://zpdaxntmxvsygxdfblvp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_-jln75vzRr2xhfL3s3k4Ow_1jKLEAf_";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $main = document.getElementById("main");
const $headerSub = document.getElementById("header-sub");
const $headerTitle = document.getElementById("header-title");
const $toast = document.getElementById("toast");
const $modalOverlay = document.getElementById("modal-overlay");
const $modalBox = document.getElementById("modal-box");

/* ---------------------------------------------------------------- utils */

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function pick(obj, keys, fallback) {
  if (!obj) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function pickList(obj, keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function showToast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.classList.add("show");
  clearTimeout($toast._t);
  $toast._t = setTimeout(() => $toast.classList.remove("show"), ms);
}

function fmtDate(v) {
  if (!v) return "—";
  try {
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return String(v);
  }
}

function toDateInputValue(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/* app_settings.daily_open / daily_close are Postgres `time`, which serializes
   with seconds (and possibly fractional seconds); input[type=time] needs a
   bare HH:MM to populate, and Postgres needs HH:MM:SS back. */
function toTimeInputValue(v) {
  if (!v) return "";
  const m = /(\d{1,2}):(\d{2})/.exec(String(v));
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function fromTimeInputValue(v) {
  const t = toTimeInputValue(v);
  return t ? `${t}:00` : null;
}

/* starts_on / deadline_on are Postgres `date`. `new Date("2026-09-17")` is
   parsed as UTC midnight, which prints as "2026/09/17 09:00" in Asia/Tokyo —
   the reason the student banner used to show a phantom time. The date is
   therefore formatted straight from the string. */
function toIsoDate(v) {
  if (!v) return "";
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function fmtDateOnly(v) {
  const iso = toIsoDate(v);
  return iso ? iso.replace(/-/g, "/") : String(v || "");
}

function fmtDateTimeJst(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }) + " JST";
}

function timeToMinutes(v) {
  const t = toTimeInputValue(v);
  return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null;
}

/* Whether a student may edit is judged in Japan time, not the device's
   timezone, so an iPad set to another region still sees the same window. */
function tokyoNow(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  })
    .formatToParts(now || new Date())
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/* 「開始日+開始時刻」から「締切日+締切時刻」までの、一続きの期間として判定する。
   （毎日決まった時間帯だけ、という繰り返しの窓ではない。この期間内はいつでも
   編集可能で、期間外は常に不可。after_hours_mode は使わなくなったが、既存の
   DB 列・CHECK 制約はそのまま残しており、このアプリからは書き込まない。） */
function dateTimeKey(date, minutes) {
  return `${date} ${String(minutes).padStart(4, "0")}`;
}

function selectionWindow(settings, now) {
  const s = settings || {};
  const startsOn = toIsoDate(pick(s, ["starts_on", "start_on", "opens_on"], ""));
  const deadlineOn = toIsoDate(pick(s, ["deadline_on", "deadline", "ends_on"], ""));
  const openAt = toTimeInputValue(pick(s, ["daily_open", "open_time"], ""));
  const closeAt = toTimeInputValue(pick(s, ["daily_close", "close_time"], ""));
  const known = !!(startsOn || deadlineOn);
  const jst = tokyoNow(now);

  const nowKey = dateTimeKey(jst.date, jst.minutes);
  const startKey = startsOn ? dateTimeKey(startsOn, timeToMinutes(openAt) ?? 0) : null;
  const endKey = deadlineOn ? dateTimeKey(deadlineOn, timeToMinutes(closeAt) ?? 1439) : null;

  const inPeriod = (!startKey || nowKey >= startKey) && (!endKey || nowKey <= endKey);

  return {
    known, startsOn, deadlineOn, openAt, closeAt, inPeriod,
    open: inPeriod,
  };
}

/* app_settings.after_hours_mode is text guarded by the
   app_settings_after_hours_mode_check constraint, whose allowed literals are
   not readable from any client: RLS hides the row from the anon key, the
   constraint definition is not exposed by PostgREST, and no server-side
   credential exists in this app. The column is therefore left out of the
   UPDATE entirely unless the admin actually switches modes — a normal save
   never re-evaluates the constraint. Only when the mode is switched are these
   synonyms tried, in order; a rejected candidate (23514 / 22P02) writes
   nothing, and the save then falls back to leaving the column untouched so the
   remaining settings still persist. Once the two real literals are known,
   replace these lists with them. */
const AFTER_HOURS_CANDIDATES = {
  lock: ["lock", "locked", "readonly", "read_only", "closed", "block", "blocked", "disabled", "no_edit", "view_only", "frozen"],
  allow: ["allow", "allowed", "open", "editable", "edit", "enabled", "unlocked", "writable"],
};

function afterHoursKey(v) {
  const raw = String(v == null ? "" : v).trim().toLowerCase();
  return AFTER_HOURS_CANDIDATES.allow.includes(raw) ? "allow" : "lock";
}

function afterHoursValues(key, storedValue) {
  const stored = String(storedValue == null ? "" : storedValue).trim();
  const list = AFTER_HOURS_CANDIDATES[key] || AFTER_HOURS_CANDIDATES.lock;
  if (stored && afterHoursKey(stored) === key) return [stored, ...list.filter((v) => v !== stored)];
  return list.slice();
}

function capacityStatus(count, capacity) {
  if (capacity === null || capacity === undefined) return "available";
  if (count > capacity) return "over";
  if (count === capacity) return "full";
  return "available";
}

/* -------------------------------------------------------- modal helper */

function openModal(html) {
  $modalBox.innerHTML = html;
  $modalOverlay.classList.remove("hidden");
}

function closeModal() {
  $modalOverlay.classList.add("hidden");
  $modalBox.innerHTML = "";
}

$modalOverlay.addEventListener("click", (ev) => {
  if (ev.target === $modalOverlay) closeModal();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeModal();
});

/* -------------------------------------------------------- slot shaping */

/* Real slots columns (confirmed against the live project via PostgREST):
   id, code, facility, label, capacity, note, duration_weeks,
   start_course, end_course, sort_order, active, created_at.
   There is no area/prefecture column, so the 県内 / 県外 split and the
   per-facility notes below come from the official クール表 instead. */

const COURSES = [
  { no: 1, label: "①クール", dates: "1/25–2/12" },
  { no: 2, label: "②クール", dates: "2/15–3/5" },
  { no: 3, label: "③クール", dates: "3/8–3/26" },
  { no: 4, label: "④クール", dates: "4/12–4/30" },
  { no: 5, label: "⑤クール", dates: "5/10–5/28" },
  { no: 6, label: "⑥クール", dates: "5/31–6/18" },
];
const COURSE_COUNT = COURSES.length;

const FACILITY_GROUPS = [
  {
    area: "県内",
    facilities: [
      { name: "橋本市民病院", match: ["橋本"], notes: ["時間厳守、指定宿舎に宿泊できる学生のみとする", "6週間枠はホテル宿泊可"] },
      { name: "那智勝浦温泉病院", match: ["那智", "勝浦"], notes: ["指定宿舎に宿泊、もしくは実家が近く実家より通えるもの"] },
      { name: "紀北分院", match: ["紀北"], notes: ["宿直室に宿泊"] },
      { name: "野上厚生病院", match: ["野上"], notes: ["自宅から通い、時間厳守"] },
    ],
  },
  {
    area: "県外",
    facilities: [
      { name: "三重組合立紀南病院", match: ["紀南"], notes: ["要・自家用車／施設移動あり", "一棟貸、同性限定"] },
      { name: "三重南伊勢病院", match: ["南伊勢"], notes: ["官舎宿泊", "要・自家用車"] },
      { name: "三重県立志摩病院", match: ["志摩"], notes: ["官舎宿泊", "公共交通機関利用"] },
      { name: "高知県あき総合病院", match: ["あき"], notes: ["ホテル宿泊", "公共交通機関利用"] },
    ],
  },
];

function facilitySpecFor(facilityName) {
  const n = String(facilityName || "");
  for (const group of FACILITY_GROUPS) {
    for (const f of group.facilities) {
      if (f.match.some((m) => n.includes(m))) return { area: group.area, spec: f };
    }
  }
  return null;
}

function isBlueSlot(s) {
  return s.weeks != null && Number(s.weeks) >= 6;
}

function courseRangeText(slot) {
  const marks = "①②③④⑤⑥";
  if (!slot.start) return "";
  const a = marks[slot.start - 1] || String(slot.start);
  if (!slot.end || slot.end === slot.start) return `${a}クール`;
  const b = marks[slot.end - 1] || String(slot.end);
  return `${a}〜${b}クール`;
}

/* students.access_token is the student's personal-URL secret. It is
   generated here so a new row always carries one, whether or not the
   column has a database-side default. */
function generateAccessToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* students.student_code is NOT NULL and has no database-side default, so the
   admin form (which only asks for a name) has to supply one. The format is read
   off the rows already loaded for the logged-in admin rather than hard-coded:
   the most common "prefix + zero-padded number" shape wins and the sequence
   continues from its highest number. A unique-violation retry covers rows added
   by someone else since the last load. */
function parseStudentCode(code) {
  const m = String(code == null ? "" : code).match(/^(.*?)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], width: m[2].length, num: Number(m[2]) };
}

function studentCodeSeries(existingCodes) {
  const parsed = existingCodes.map(parseStudentCode).filter(Boolean);
  if (!parsed.length) return { prefix: "S", width: 3, next: 1 };
  const tally = new Map();
  for (const p of parsed) {
    const key = `${p.prefix}\u0000${p.width}`;
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of tally) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  const [prefix, widthStr] = bestKey.split("\u0000");
  const width = Number(widthStr);
  const highest = parsed
    .filter((p) => p.prefix === prefix && p.width === width)
    .reduce((max, p) => Math.max(max, p.num), 0);
  return { prefix, width, next: highest + 1 };
}

function nextStudentCodes(existingCodes, count) {
  const taken = new Set(existingCodes.filter((c) => c != null && c !== "").map(String));
  const { prefix, width, next } = studentCodeSeries(existingCodes);
  const codes = [];
  let n = next;
  while (codes.length < count && n < next + 10000) {
    const code = `${prefix}${String(n).padStart(width, "0")}`;
    n += 1;
    if (taken.has(code)) continue;
    taken.add(code);
    codes.push(code);
  }
  return codes;
}

async function insertStudents(names, existingCodes) {
  const taken = (existingCodes || []).filter((c) => c != null && c !== "").map(String);
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const codes = nextStudentCodes(taken, names.length);
    if (codes.length < names.length) break;
    const rows = names.map((name, i) => ({
      name,
      student_code: codes[i],
      access_token: generateAccessToken(),
    }));
    const { data, error } = await sb.from("students").insert(rows).select();
    if (!error) return { data, error: null };
    lastError = error;
    if (error.code !== "23505") break;
    for (const code of codes) taken.push(code);
  }
  const detail = lastError
    ? [lastError.code, lastError.message, lastError.details, lastError.hint].filter(Boolean).join(" / ")
    : "student_code を生成できませんでした";
  return { data: null, error: lastError || { code: "generate_failed", message: detail }, detail };
}

function describeInsertError(error) {
  if (!error) return "";
  if (error.code === "42501") {
    return "RLSにより拒否されました（管理者としてログインしているか、admins テーブルに登録されているかご確認ください）。";
  }
  if (error.code === "23502") return "必須項目が不足しています（NOT NULL のカラムに値が入っていません）。";
  if (error.code === "23505") return "同じ値が既に登録されています。";
  if (error.code === "42703") return "カラム名が実際のテーブルと一致していません。";
  return "";
}

/* Names may arrive per slot (an array, an array of {name}, or a joined
   string) or as a roster of students carrying current_slot_id — the
   student_snapshot shape is unverified, so every form is accepted. Only name
   fields are ever read; tokens and student_code are never touched. */
function nameList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[、,\n]/);
  return list
    .map((n) => (n && typeof n === "object" ? pick(n, ["name", "student_name", "display_name"], "") : String(n)))
    .map((n) => String(n).trim())
    .filter(Boolean);
}

function slotRowNames(raw) {
  for (const k of ["student_names", "names", "occupants", "students", "occupant_names", "selected_names"]) {
    const got = nameList(raw && raw[k]);
    if (got.length) return got;
  }
  return [];
}

/* Multiset union: a name listed twice by either source stays listed twice, so
   two students sharing a name are not collapsed into one. */
function mergeNameLists(a, b) {
  const out = (a || []).slice();
  const spare = new Map();
  for (const n of out) spare.set(n, (spare.get(n) || 0) + 1);
  for (const n of b || []) {
    const left = spare.get(n) || 0;
    if (left > 0) spare.set(n, left - 1);
    else out.push(n);
  }
  return out;
}

function normalizeSlot(raw, occupantNamesOverride) {
  const rowNames = slotRowNames(raw);
  const names = occupantNamesOverride ? mergeNameLists(occupantNamesOverride, rowNames) : rowNames;
  const capacity = Number(pick(raw, ["capacity"], 1)) || 1;
  const rawCount = Number(pick(raw, ["current_count", "count"], NaN));
  const count = Number.isFinite(rawCount) ? Math.max(rawCount, names.length) : names.length;
  const weeks = Number(pick(raw, ["duration_weeks"], 0)) || null;
  const start = Number(pick(raw, ["start_course"], 0)) || null;
  const endRaw = Number(pick(raw, ["end_course"], 0)) || null;
  const end = endRaw && start && endRaw >= start ? endRaw : start;
  const facility = String(pick(raw, ["facility"], "")).trim();
  return {
    id: pick(raw, ["id", "slot_id"], null),
    code: pick(raw, ["code"], ""),
    facility,
    label: pick(raw, ["label"], ""),
    weeks,
    start,
    end,
    capacity,
    count,
    names,
    note: pick(raw, ["note"], ""),
    sortOrder: Number(pick(raw, ["sort_order"], 0)) || 0,
    active: pick(raw, ["active"], true) !== false,
    status: capacityStatus(count, capacity),
  };
}

/* --------------------------------------------------------- matching (1次/2次)
   The lottery itself lives in Supabase (see supabase/matching.sql): the
   finalize_first_matching() RPC is the only writer and is idempotent, so the
   client only ever reads a result it cannot change. finalize_first_matching /
   student_matching may not be deployed yet — a missing function answers with
   PGRST202 / 42883, which is treated as "not finalized" so the app keeps
   working exactly as before. */
const MATCH_RPC_MISSING = ["PGRST202", "PGRST205", "42883", "42P01"];

function isMissingMatchObject(error) {
  return !!error && MATCH_RPC_MISSING.includes(String(error.code));
}

function matchingSlotIndex(entries) {
  const map = new Map();
  for (const e of entries || []) {
    const id = pick(e, ["slot_id", "id"], null);
    if (id === null) continue;
    const capacity = Number(pick(e, ["capacity"], 0)) || 0;
    const confirmedNames = nameList(pick(e, ["confirmed_names", "names"], []));
    const confirmedCount = Number(pick(e, ["confirmed_count"], confirmedNames.length)) || confirmedNames.length;
    const remaining = Number(pick(e, ["remaining"], Math.max(capacity - confirmedCount, 0)));
    map.set(String(id), {
      capacity,
      confirmedCount,
      confirmedNames,
      remaining: Number.isFinite(remaining) ? Math.max(remaining, 0) : Math.max(capacity - confirmedCount, 0),
    });
  }
  return map;
}

function decorateMatching(slots, index) {
  if (!index) return slots;
  for (const slot of slots) {
    const info = index.get(String(slot.id));
    if (!info) continue;
    slot.confirmedNames = info.confirmedNames;
    slot.confirmedCount = info.confirmedCount;
    slot.remaining = info.remaining;
    slot.finalized = info.confirmedCount > 0;
  }
  return slots;
}

function outcomeLabel(outcome) {
  if (outcome === "confirmed") return "確定";
  if (outcome === "second_matching") return "2次マッチング対象";
  return "希望なし";
}

/* ----------------------------------------------------- timetable build */

/* Overlapping course ranges (e.g. 橋本市民病院 has both a ①クール 3週 slot
   and a ①〜②クール 6週 slot) cannot share one table row, so each facility
   is packed into as many sub-rows ("lanes") as it needs. */
function packLanes(slots) {
  const lanes = [];
  const ordered = slots
    .slice()
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.sortOrder - b.sortOrder);
  for (const s of ordered) {
    let lane = lanes.find((L) => L.every((x) => s.end < x.start || s.start > x.end));
    if (!lane) {
      lane = [];
      lanes.push(lane);
    }
    lane.push(s);
  }
  return lanes;
}

function buildTimetable(slots) {
  const usable = slots.filter((s) => s.active && s.start != null);
  const unclassified = slots.filter((s) => !(s.active && s.start != null));

  const byFacility = new Map();
  for (const s of usable) {
    const key = s.facility || "(施設未設定)";
    if (!byFacility.has(key)) byFacility.set(key, []);
    byFacility.get(key).push(s);
  }

  const groups = FACILITY_GROUPS.map((g) => ({ area: g.area, rows: [] }));
  const other = { area: "その他", rows: [] };

  for (const [facilityName, facilitySlots] of byFacility) {
    const matched = facilitySpecFor(facilityName);
    const spec = matched ? matched.spec : null;
    const entry = {
      facility: facilityName,
      displayName: spec ? spec.name : facilityName,
      notes: spec ? spec.notes : [],
      spec,
      lanes: packLanes(facilitySlots),
      capacityTotal: facilitySlots.reduce((n, s) => n + s.capacity, 0),
    };
    if (matched) {
      const g = groups.find((x) => x.area === matched.area);
      g.rows.push(entry);
    } else {
      other.rows.push(entry);
    }
  }

  for (const g of groups) {
    const order = FACILITY_GROUPS.find((x) => x.area === g.area).facilities.map((f) => f.name);
    g.rows.sort((a, b) => order.indexOf(a.displayName) - order.indexOf(b.displayName));
  }
  if (other.rows.length) groups.push(other);

  return { groups: groups.filter((g) => g.rows.length), unclassified };
}

function legendHTML(opts) {
  return `
    <div class="legend">
      <span class="legend-item"><span class="legend-swatch yellow"></span>3週間枠</span>
      <span class="legend-item"><span class="legend-swatch blue"></span>6週間枠（2クール分・内科系選択）</span>
      <span class="legend-item"><span class="legend-swatch empty"></span>選択できません</span>
      <span class="legend-item"><span class="legend-swatch st-full"></span>定員ちょうど</span>
      <span class="legend-item"><span class="legend-swatch st-over"></span>定員超過（調整中は可）</span>
      ${opts && opts.finalized ? `<span class="legend-item"><span class="legend-swatch finalized"></span>1次マッチング確定</span>` : ""}
    </div>`;
}

function cellHTML(slot, span, opts) {
  const blue = isBlueSlot(slot);
  const selectable = !opts.canSelectSlot || opts.canSelectSlot(slot);
  const clickable = opts.interactive && opts.canEdit && selectable;
  /* confirmed names are consumed as a multiset so a second student with the
     same name is not marked confirmed by mistake */
  const pendingConfirmed = new Map();
  for (const n of slot.confirmedNames || []) pendingConfirmed.set(n, (pendingConfirmed.get(n) || 0) + 1);
  const namesHtml = slot.names.length
    ? `<div class="cell-names">${slot.names
        .map((n) => {
          const left = pendingConfirmed.get(n) || 0;
          if (left > 0) pendingConfirmed.set(n, left - 1);
          const cls = [
            "cell-name",
            opts.highlightName && n === opts.highlightName ? "me" : "",
            left > 0 ? "confirmed" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<div class="${cls}">${escapeHtml(n)}</div>`;
        })
        .join("")}</div>`
    : `<div class="cell-names cell-empty-note">希望者なし</div>`;
  return `<td
      class="cell ${blue ? "blue" : "yellow"} st-${slot.status} ${slot.finalized ? "finalized" : ""} ${clickable ? "tappable" : ""}"
      colspan="${span}"
      ${clickable ? `data-slot-id="${escapeHtml(slot.id)}"` : ""}
    >
      <div class="cell-top">
        <span class="cell-weeks">${slot.finalized ? "確定" : blue ? "6週間" : ""}</span>
        <span class="cell-count">${slot.finalized ? `${slot.confirmedCount}/${slot.capacity}` : `${slot.count}/${slot.capacity}`}</span>
      </div>
      ${namesHtml}
    </td>`;
}

function laneCellsHTML(lane, opts) {
  const byStart = new Map();
  for (const s of lane) byStart.set(s.start, s);
  let html = "";
  let col = 1;
  while (col <= COURSE_COUNT) {
    const slot = byStart.get(col);
    if (!slot) {
      html += `<td class="cell empty"></td>`;
      col += 1;
      continue;
    }
    let span = Math.max(1, (slot.end || slot.start) - slot.start + 1);
    if (col + span - 1 > COURSE_COUNT) span = COURSE_COUNT - col + 1;
    html += cellHTML(slot, span, opts);
    col += span;
  }
  return html;
}

function timetableHTML(groups, opts) {
  if (!groups.length) {
    return `<div class="card"><p class="muted">クール表に表示できる枠がありません。</p></div>`;
  }
  const heads = COURSES.map(
    (c) => `<th class="course-col"><div class="course-no">${c.label}</div><div class="course-dates">${c.dates}</div></th>`
  ).join("");

  const bodyHtml = groups
    .map((g) => {
      const rows = g.rows
        .map((entry) => {
          const lanes = entry.lanes.length ? entry.lanes : [[]];
          return lanes
            .map((lane, i) => {
              const first = i === 0;
              const facilityCell = first
                ? `<th class="hosp-col" rowspan="${lanes.length}">
                     <div class="hosp-name">${escapeHtml(entry.displayName)}</div>
                     ${entry.notes.map((n) => `<div class="hosp-note">${escapeHtml(n)}</div>`).join("")}
                   </th>`
                : "";
              return `<tr>${facilityCell}${laneCellsHTML(lane, opts)}</tr>`;
            })
            .join("");
        })
        .join("");
      return `<tr class="area-row"><th class="area-head" colspan="${COURSE_COUNT + 1}">${escapeHtml(g.area)}</th></tr>${rows}`;
    })
    .join("");

  return `
    <div class="timetable-wrap">
      <table class="timetable">
        <thead><tr><th class="corner">病院</th>${heads}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

function unclassifiedHTML(unclassified) {
  if (!unclassified.length) return "";
  return `
    <div class="card">
      <h3>クール表に配置できなかった枠</h3>
      <p class="muted">${unclassified
        .map((s) => escapeHtml(`${s.facility || "(施設未設定)"} ${s.label || s.code || s.id}`))
        .join("、")}</p>
    </div>`;
}

/*  ROUTING                                                            */
/* ================================================================== */

function routeParams() {
  if (location.search && location.search.length > 1) {
    return new URLSearchParams(location.search);
  }
  const hash = location.hash || "";
  const q = hash.indexOf("?");
  if (q !== -1) return new URLSearchParams(hash.slice(q));
  return new URLSearchParams("");
}

function wantsAdmin(params) {
  if (!params.has("admin")) return false;
  const v = String(params.get("admin")).trim().toLowerCase();
  return v === "" || v === "1" || v === "true" || v === "yes";
}

function route() {
  const params = routeParams();

  if (wantsAdmin(params)) {
    $headerSub.textContent = "管理者モード";
    try {
      bootAdmin();
    } catch (e) {
      $main.innerHTML = `
        <div class="card">
          <h2>管理画面の読み込みに失敗しました</h2>
          <p class="error-text">${escapeHtml(e && e.message ? e.message : String(e))}</p>
        </div>`;
    }
    return;
  }

  const tok = params.get("token");
  if (tok) {
    bootStudent(tok);
    return;
  }

  $main.innerHTML = `
    <div class="card">
      <h2>アクセス方法が見つかりません</h2>
      <p class="muted">学生の方は配布されたURL（?token=... を含むリンク）からアクセスしてください。</p>
      <p class="muted">管理者の方は <a href="?admin=1">?admin=1</a> からアクセスしてください。</p>
    </div>`;
}

route();

/* ================================================================== */
/*  STUDENT MODE                                                       */
/* ================================================================== */

function bootStudent(tok) {
  const state = {
    loading: true,
    error: null,
    snapshot: null,
    matching: null,
    busySlotId: null,
    pollTimer: null,
  };

  async function fetchMatching() {
    const { data, error } = await sb.rpc("student_matching", { p_token: tok });
    if (error) {
      if (!isMissingMatchObject(error)) console.warn("student_matching failed", error);
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    state.matching = row && pick(row, ["finalized"], false) ? row : null;
  }

  async function fetchSnapshot(silent) {
    if (!silent) state.loading = true;
    try {
      const [snapRes] = await Promise.all([
        sb.rpc("student_snapshot", { p_token: tok }),
        fetchMatching(),
      ]);
      const { data, error } = snapRes;
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("該当するデータが見つかりませんでした。");
      state.snapshot = row;
      state.error = null;
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function chooseSlot(slotId) {
    if (state.busySlotId) return;
    state.busySlotId = slotId;
    render();
    try {
      const { error } = await sb.rpc("student_set_choice", {
        p_token: tok,
        p_slot_id: slotId,
      });
      if (error) throw error;
      showToast("希望を更新しました");
      await fetchSnapshot(true);
    } catch (e) {
      showToast("更新に失敗しました: " + (e.message || e));
    } finally {
      state.busySlotId = null;
      render();
    }
  }

  function confirmChoice(slot, canEdit) {
    if (!canEdit) {
      showToast("現在は希望の変更ができません");
      return;
    }
    openModal(`
      <h3>希望の変更確認</h3>
      <p>「${escapeHtml(slot.facility)}　${escapeHtml(courseRangeText(slot))}」に変更しますか？</p>
      <p class="muted">${escapeHtml(slot.weeks ? slot.weeks + "週間" : "")}${slot.note ? "／" + escapeHtml(slot.note) : ""}</p>
      <p class="muted">現在の人数: ${slot.count} / ${slot.capacity ?? "?"} 名${slot.status === "over" ? "（定員超過）" : ""}</p>
      <div class="modal-actions">
        <button class="btn-secondary" id="modal-cancel">キャンセル</button>
        <button class="btn-primary" id="modal-confirm">変更する</button>
      </div>
    `);
    document.getElementById("modal-cancel").addEventListener("click", closeModal);
    document.getElementById("modal-confirm").addEventListener("click", () => {
      closeModal();
      chooseSlot(slot.id);
    });
  }

  function render() {
    if (state.loading && !state.snapshot) {
      $main.innerHTML = `<div class="card"><p class="muted">読み込み中...</p></div>`;
      return;
    }
    if (state.error && !state.snapshot) {
      $main.innerHTML = `
        <div class="card">
          <h2>読み込みエラー</h2>
          <p class="error-text">${escapeHtml(state.error)}</p>
          <p class="muted">URLのトークンが正しいかご確認ください。しばらくしてから再度お試しください。</p>
        </div>`;
      return;
    }

    const snap = state.snapshot || {};
    const student = pick(snap, ["student"], snap) || {};
    const studentName = pick(student, ["name", "student_name"], "");
    /* student_snapshot returns app_settings either nested or flattened onto the
       row; both shapes are read so the banner always reflects the settings as
       they are right now (the snapshot is re-fetched every 5s, never cached). */
    const settings = Object.assign(
      {},
      snap,
      pick(snap, ["settings", "app_settings"], {}) || {}
    );
    const title = pick(settings, ["title"], "R9 黒潮医療人養成プロジェクト 希望調整");
    const win = selectionWindow(settings);
    const canEdit = win.known
      ? win.open || !!pick(snap, ["can_edit", "canEdit"], false)
      : !!pick(snap, ["can_edit", "canEdit"], false);
    const rawSlots = pickList(snap, ["slots", "all_slots"]);
    const byChoice = new Map();
    const addOccupant = (slotId, name) => {
      if (slotId === null || slotId === undefined || slotId === "" || !name) return;
      const key = String(slotId);
      byChoice.set(key, [...(byChoice.get(key) || []), String(name).trim()]);
    };
    for (const st of pickList(snap, ["students", "all_students", "student_choices", "choices", "selections"])) {
      addOccupant(
        pick(st, ["current_slot_id", "slot_id", "chosen_slot_id", "selected_slot_id"], null),
        pick(st, ["name", "student_name", "display_name"], "")
      );
    }
    const mySlotId = pick(student, ["current_slot_id", "slot_id", "chosen_slot_id"], null);
    if (mySlotId !== null && studentName && !(byChoice.get(String(mySlotId)) || []).includes(studentName)) {
      addOccupant(mySlotId, studentName);
    }
    /* after finalization the confirmed roster comes from student_matching, so
       every student keeps seeing the confirmed names even if student_snapshot
       carries no roster of its own */
    const matching = state.matching;
    const matchIndex = matching ? matchingSlotIndex(pickList(matching, ["slots"])) : null;
    const slots = rawSlots.map((raw) => {
      const key = String(pick(raw, ["id", "slot_id"], ""));
      const info = matchIndex ? matchIndex.get(key) : null;
      const rosterNames = info
        ? mergeNameLists(byChoice.get(key) || [], info.confirmedNames)
        : byChoice.get(key);
      return normalizeSlot(raw, rosterNames);
    });
    decorateMatching(slots, matchIndex);
    const bySlotId = new Map(slots.map((s) => [String(s.id), s]));

    const myOutcome = matching ? pick(matching, ["my_outcome"], null) : null;
    const iAmConfirmed = myOutcome === "confirmed";
    const inSecondMatching = !!matching && !iAmConfirmed;
    /* 2次マッチングは1次確定後に始まるので、受付期間の判定では開かない。
       確定した学生は以後いっさい変更できない。 */
    const canEditNow = matching ? inSecondMatching : canEdit;
    const canSelectSlot = matching
      ? (slot) => inSecondMatching && (matchIndex.get(String(slot.id)) || { remaining: 0 }).remaining > 0
      : null;

    $headerTitle.textContent = title || "R9 黒潮医療人養成プロジェクト 希望調整";
    $headerSub.textContent = studentName ? `${studentName} さん` : "";

    const { groups, unclassified } = buildTimetable(slots);

    const startLabel = win.startsOn
      ? `${fmtDateOnly(win.startsOn)} ${win.openAt || "00:00"}`
      : "指定なし";
    const endLabel = win.deadlineOn
      ? `${fmtDateOnly(win.deadlineOn)} ${win.closeAt || "23:59"}`
      : "指定なし";
    const periodLine =
      win.startsOn || win.deadlineOn
        ? `<div class="banner-detail">受付期間：${escapeHtml(startLabel)} ～ ${escapeHtml(endLabel)}</div>`
        : "";
    const lockedReason = !win.known
      ? ""
      : !win.inPeriod
      ? "（受付期間外です）"
      : "";
    const banner = `
      <div class="status-banner ${canEdit ? "ok" : "locked"}">
        <div class="banner-lines">
          <div class="banner-status">${
            canEdit ? "現在、希望の変更が可能です。" : "現在は希望の変更ができません。" + lockedReason
          }</div>
          ${periodLine}
        </div>
      </div>`;

    const mySlot = matching ? bySlotId.get(String(pick(matching, ["my_slot_id"], ""))) : null;
    const mySlotText = matching
      ? [
          pick(matching, ["my_slot_facility"], mySlot ? mySlot.facility : ""),
          mySlot ? courseRangeText(mySlot) : "",
          pick(matching, ["my_slot_label"], ""),
        ]
          .filter(Boolean)
          .join("　")
      : "";
    const resultBanner = !matching
      ? ""
      : iAmConfirmed
      ? `<div class="result-banner won">
           <div class="result-title">当選しました。この枠で確定しました。</div>
           ${mySlotText ? `<div class="result-slot">確定した枠：${escapeHtml(mySlotText)}</div>` : ""}
           ${pick(matching, ["is_test"], false) ? `<div class="result-note">※これはテスト実行の結果です。</div>` : ""}
         </div>`
      : `<div class="result-banner lost">
           <div class="result-title">申し訳ありません。抽選の結果、今回は選外となりました。空いている枠から2次マッチングをお願いします。</div>
           ${myOutcome === null ? `<div class="result-note">1次マッチングの時点で希望が登録されていませんでした。</div>` : ""}
           ${pick(matching, ["is_test"], false) ? `<div class="result-note">※これはテスト実行の結果です。</div>` : ""}
         </div>`;

    const secondStartsOn = pick(settings, ["second_starts_on"], "");
    const secondDeadlineOn = pick(settings, ["second_deadline_on"], "");
    const secondPeriodLine =
      secondStartsOn || secondDeadlineOn
        ? `<div class="banner-detail">2次マッチング期間目安：${escapeHtml(fmtDateOnly(secondStartsOn) || "指定なし")} ～ ${escapeHtml(fmtDateOnly(secondDeadlineOn) || "指定なし")}</div>`
        : "";
    const matchingStatus = !matching
      ? banner
      : iAmConfirmed
      ? `<div class="status-banner locked"><div class="banner-lines"><div class="banner-status">1次マッチングで確定したため、希望の変更はできません。</div></div></div>`
      : `<div class="status-banner ok"><div class="banner-lines"><div class="banner-status">2次マッチング中です。空きのある枠のみ選択できます。</div>${secondPeriodLine}</div></div>`;

    $main.innerHTML = `
      ${resultBanner}
      ${matchingStatus}
      ${legendHTML({ finalized: !!matching })}
      ${timetableHTML(groups, {
        interactive: true,
        canEdit: canEditNow,
        canSelectSlot,
        highlightName: studentName,
      })}
      ${unclassifiedHTML(unclassified)}
    `;

    $main.querySelectorAll(".cell.tappable").forEach((td) => {
      td.addEventListener("click", () => {
        if (state.busySlotId) return;
        const id = td.getAttribute("data-slot-id");
        const slot = bySlotId.get(String(id));
        if (!slot) return;
        confirmChoice(slot, canEditNow);
      });
    });
  }

  render();
  fetchSnapshot(false);
  state.pollTimer = setInterval(() => fetchSnapshot(true), 5000);
}

/* ================================================================== */
/*  ADMIN MODE                                                         */
/* ================================================================== */

function bootAdmin() {
  const state = {
    session: null,
    tab: "timetable",
    students: [],
    slots: [],
    changeLog: [],
    settings: null,
    matchRound: null,
    matchResults: [],
    matchTablesMissing: false,
    matchPreview: null,
    matchBusy: false,
    loadingData: false,
    dataError: null,
  };

  async function init() {
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    sb.auth.onAuthStateChange((_event, session) => {
      state.session = session;
      renderRoot();
    });
    renderRoot();
  }

  async function login(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showToast("ログインに失敗しました: " + error.message);
      return false;
    }
    return true;
  }

  async function logout() {
    await sb.auth.signOut();
    renderRoot();
  }

  async function loadAll() {
    state.loadingData = true;
    state.dataError = null;
    renderRoot();
    try {
      const [settingsRes, slotsRes, studentsRes, logRes, roundRes, matchRes] = await Promise.all([
        sb.from("app_settings").select("*").limit(1),
        sb.from("slots").select("*"),
        sb.from("students").select("*"),
        sb.from("change_log").select("*").order("changed_at", { ascending: false }).limit(200),
        sb.from("match_rounds").select("*").limit(1),
        sb.from("match_results").select("*"),
      ]);
      if (settingsRes.error) throw settingsRes.error;
      if (slotsRes.error) throw slotsRes.error;
      if (studentsRes.error) throw studentsRes.error;

      state.settings = (settingsRes.data && settingsRes.data[0]) || {};
      state.slots = (slotsRes.data || []).slice().sort(
        (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
      );
      state.students = studentsRes.data || [];
      state.changeLog = logRes.error ? [] : logRes.data || [];
      /* supabase/matching.sql may not be applied yet; the dashboard then keeps
         working and the マッチング tab explains what to run */
      state.matchTablesMissing = isMissingMatchObject(roundRes.error) || isMissingMatchObject(matchRes.error);
      state.matchRound = roundRes.error ? null : (roundRes.data && roundRes.data[0]) || null;
      state.matchResults = matchRes.error ? [] : matchRes.data || [];
    } catch (e) {
      state.dataError = e.message || String(e);
    } finally {
      state.loadingData = false;
      renderRoot();
    }
  }

  function renderRoot() {
    if (!state.session) {
      renderLogin();
    } else {
      if (!state.settings && !state.loadingData && !state.dataError) {
        loadAll();
        return;
      }
      renderDashboard();
    }
  }

  function renderLogin() {
    $headerSub.textContent = "管理者ログイン";
    $main.innerHTML = `
      <div class="login-wrap">
        <div class="card login-card">
          <h2>管理者ログイン</h2>
          <form id="login-form">
            <div class="field">
              <label>メールアドレス</label>
              <input type="email" id="login-email" required autocomplete="username" />
            </div>
            <div class="field">
              <label>パスワード</label>
              <input type="password" id="login-password" required autocomplete="current-password" />
            </div>
            <div id="login-error" class="error-text hidden"></div>
            <button type="submit" class="btn-primary" style="width:100%;margin-top:6px;">ログイン</button>
          </form>
        </div>
      </div>`;
    document.getElementById("login-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const email = document.getElementById("login-email").value.trim();
      const password = document.getElementById("login-password").value;
      const ok = await login(email, password);
      if (ok) {
        await loadAll();
      }
    });
  }

  function studentUrl(tok) {
    const base = `${location.origin}${location.pathname}`;
    return `${base}?token=${encodeURIComponent(tok)}`;
  }

  function renderDashboard() {
    $headerSub.innerHTML = `管理者: ${escapeHtml(state.session.user.email)} <button class="btn-small btn-secondary" id="logout-btn" style="margin-left:8px;">ログアウト</button>`;

    const tabs = [
      ["timetable", "クール表"],
      ["students", "学生管理"],
      ["matching", "マッチング"],
      ["settings", "設定"],
      ["log", "変更履歴"],
    ];

    $main.innerHTML = `
      <div class="tabs">
        ${tabs
          .map(
            ([k, label]) =>
              `<button class="tab-btn ${state.tab === k ? "active" : ""}" data-tab="${k}">${label}</button>`
          )
          .join("")}
        <span class="spacer"></span>
        <button class="btn-small btn-secondary" id="reload-btn">再読み込み</button>
      </div>
      <div id="tab-body"></div>
    `;

    document.getElementById("logout-btn").addEventListener("click", logout);
    document.getElementById("reload-btn").addEventListener("click", loadAll);
    $main.querySelectorAll(".tab-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.tab = btn.getAttribute("data-tab");
        renderDashboard();
      })
    );

    const body = document.getElementById("tab-body");

    if (state.dataError) {
      body.innerHTML = `<div class="card"><p class="error-text">読み込みエラー: ${escapeHtml(
        state.dataError
      )}</p><p class="muted">admins テーブルへの権限、またはRLS設定をご確認ください。</p></div>`;
      return;
    }
    if (state.loadingData) {
      body.innerHTML = `<div class="card"><p class="muted">読み込み中...</p></div>`;
      return;
    }

    if (state.tab === "timetable") renderTimetableTab(body);
    else if (state.tab === "students") renderStudents(body);
    else if (state.tab === "matching") renderMatching(body);
    else if (state.tab === "settings") renderSettings(body);
    else if (state.tab === "log") renderLog(body);
  }

  function matchSummary() {
    const nameById = new Map(state.students.map((st) => [String(pick(st, ["id"], "")), pick(st, ["name"], "(無名)")]));
    const rows = state.matchResults.map((r) => ({
      studentId: String(pick(r, ["student_id"], "")),
      studentName: nameById.get(String(pick(r, ["student_id"], ""))) || "(削除された学生)",
      slotId: String(pick(r, ["slot_id"], "")),
      outcome: pick(r, ["outcome"], ""),
      rank: Number(pick(r, ["lottery_rank"], 0)) || 0,
    }));
    const perSlot = new Map();
    for (const raw of state.slots) {
      const id = String(pick(raw, ["id"], ""));
      const capacity = Number(pick(raw, ["capacity"], 0)) || 0;
      const confirmed = rows.filter((r) => r.slotId === id && r.outcome === "confirmed");
      perSlot.set(id, {
        slot_id: id,
        capacity,
        confirmed_count: confirmed.length,
        remaining: Math.max(capacity - confirmed.length, 0),
        confirmed_names: confirmed.map((r) => r.studentName),
      });
    }
    return { rows, perSlot };
  }

  function renderTimetableTab(body) {
    const finalized = !!state.matchRound;
    const summary = matchSummary();
    const normalized = state.slots.map((raw) => {
      const id = pick(raw, ["id", "slot_id"], null);
      const occupantNames = state.students
        .filter((st) => String(pick(st, ["current_slot_id", "slot_id", "chosen_slot_id"], "")) === String(id))
        .map((st) => pick(st, ["name", "student_name"], "(無名)"));
      const confirmedNames = finalized ? (summary.perSlot.get(String(id)) || { confirmed_names: [] }).confirmed_names : [];
      return normalizeSlot(raw, mergeNameLists(occupantNames, confirmedNames));
    });
    if (finalized) decorateMatching(normalized, matchingSlotIndex([...summary.perSlot.values()]));
    const { groups, unclassified } = buildTimetable(normalized);
    body.innerHTML = `
      <div class="card">
        <h2>クール表（全 ${state.slots.length} 枠）</h2>
        ${legendHTML({ finalized })}
      </div>
      ${timetableHTML(groups, { interactive: false, canEdit: false, highlightName: null })}
      ${unclassifiedHTML(unclassified)}
    `;
  }

  async function runFinalize(opts) {
    if (state.matchBusy) return;
    state.matchBusy = true;
    renderDashboard();
    const { data, error } = await sb.rpc("finalize_first_matching", {
      p_dry_run: !!opts.dryRun,
      p_force: !!opts.force,
      p_is_test: !!opts.isTest,
    });
    state.matchBusy = false;
    if (error) {
      showToast(
        isMissingMatchObject(error)
          ? "supabase/matching.sql が未適用です（SQL Editor で実行してください）"
          : "実行に失敗しました: " + error.message,
        5000
      );
      renderDashboard();
      return;
    }
    const res = Array.isArray(data) ? data[0] : data;
    const status = pick(res, ["status"], "");
    state.matchPreview = res;
    if (status === "not_due") {
      showToast(`締切前です（締切 ${pick(res, ["due_at"], "?")} / 現在 ${pick(res, ["now_jst"], "?")} JST）`, 5000);
    } else if (status === "no_deadline") {
      showToast("設定タブで締切日を設定してください", 5000);
    } else if (status === "dry_run") {
      showToast("テスト抽選を計算しました（保存していません）");
    } else if (status === "already_finalized") {
      showToast("既に確定済みです。保存済みの結果を表示します");
    } else if (status === "finalized") {
      showToast("1次マッチングを確定しました");
    }
    if (status === "finalized" || status === "already_finalized") {
      await loadAll();
    }
    state.tab = "matching";
    renderDashboard();
  }

  async function resetTestMatching() {
    const { data, error } = await sb.rpc("reset_test_matching", { p_confirm: "RESET-TEST" });
    if (error) {
      showToast("テスト結果の削除に失敗しました: " + error.message, 5000);
      return;
    }
    const res = Array.isArray(data) ? data[0] : data;
    showToast(`テスト実行の結果を削除しました（${pick(res, ["deleted_rounds"], 0)} 件）`);
    state.matchPreview = null;
    await loadAll();
    state.tab = "matching";
    renderDashboard();
  }

  function renderMatching(body) {
    if (state.matchTablesMissing) {
      body.innerHTML = `
        <div class="card">
          <h2>1次マッチング</h2>
          <p class="error-text">マッチング用のテーブル・関数がまだ作成されていません。</p>
          <p class="muted">Supabase の SQL Editor で <code>supabase/matching.sql</code> を実行してください。既存のテーブル・関数・RLS は変更されません。</p>
        </div>`;
      return;
    }

    const finalized = !!state.matchRound;
    const isTest = finalized && pick(state.matchRound, ["is_test"], false) === true;
    const summary = matchSummary();
    const confirmed = summary.rows.filter((r) => r.outcome === "confirmed");
    const second = summary.rows.filter((r) => r.outcome === "second_matching");
    const preview = state.matchPreview;
    const previewStatus = preview ? pick(preview, ["status"], "") : "";
    const previewRows = preview ? pickList(preview, ["results"]) : [];

    const slotRow = (info) => `
        <tr>
          <td>${escapeHtml(slotDescription(info.slot_id))}</td>
          <td>${info.capacity}</td>
          <td>${info.confirmed_count}</td>
          <td class="${info.remaining > 0 ? "remaining-open" : "remaining-none"}">${info.remaining}</td>
          <td>${escapeHtml(info.confirmed_names.join("、") || "—")}</td>
        </tr>`;

    body.innerHTML = `
      <div class="card">
        <h2>1次マッチング</h2>
        <p class="muted">
          締切（${escapeHtml(fmtDateOnly(pick(state.settings, ["deadline_on"], "")) || "未設定")}
          ${escapeHtml(toTimeInputValue(pick(state.settings, ["daily_close"], "")) || "")} 日本時間）に達した後、
          管理者が実行したときだけ抽選が行われます。自動実行はしません。
        </p>
        ${
          finalized
            ? `<p class="status-banner ${isTest ? "info" : "locked"}" style="display:block;">
                 ${isTest ? "テスト実行として" : ""}確定済み：${escapeHtml(fmtDateTimeJst(pick(state.matchRound, ["finalized_at"], "")))}
                 （確定 ${confirmed.length} 名 / 2次マッチング ${second.length} 名）<br />
                 <span class="muted">再実行しても結果は変わりません（同じ結果を返します）。</span>
               </p>`
            : `<p class="status-banner info" style="display:block;">まだ確定していません。</p>`
        }
        <div class="match-actions">
          <button class="btn-secondary" id="match-dry" ${state.matchBusy ? "disabled" : ""}>抽選をテスト計算（保存しない）</button>
          <button class="btn-primary" id="match-run" ${state.matchBusy || finalized ? "disabled" : ""}>1次マッチングを確定する</button>
          <button class="btn-secondary" id="match-test" ${state.matchBusy || finalized ? "disabled" : ""}>テストとして確定（締切前でも可）</button>
          ${isTest ? `<button class="btn-danger" id="match-reset">テスト確定を取り消す</button>` : ""}
        </div>
        <p class="muted" style="margin-top:8px;">
          「確定する」は一度だけ実行できます。二重実行しても新しい抽選は行われません。
          締切前の検証は「テストとして確定」を使うと、あとから取り消せます（本番の確定結果は取り消せません）。
        </p>
      </div>

      ${
        previewRows.length && (previewStatus === "dry_run" || !finalized)
          ? `<div class="card">
               <h3>抽選テスト結果${previewStatus === "dry_run" ? "（未保存）" : ""}</h3>
               <div class="table-wrap"><table>
                 <thead><tr><th>氏名</th><th>希望枠</th><th>抽選順位</th><th>結果</th></tr></thead>
                 <tbody>${previewRows
                   .map(
                     (r) => `<tr>
                       <td>${escapeHtml(pick(r, ["student_name"], ""))}</td>
                       <td>${escapeHtml(slotDescription(pick(r, ["slot_id"], "")))}</td>
                       <td>${escapeHtml(String(pick(r, ["lottery_rank"], "")))}</td>
                       <td>${escapeHtml(outcomeLabel(pick(r, ["outcome"], "")))}</td>
                     </tr>`
                   )
                   .join("")}</tbody>
               </table></div>
             </div>`
          : ""
      }

      ${
        finalized
          ? `<div class="card">
               <h3>確定した学生（${confirmed.length} 名）</h3>
               <div class="table-wrap"><table>
                 <thead><tr><th>氏名</th><th>確定枠</th><th>抽選順位</th></tr></thead>
                 <tbody>${
                   confirmed.length
                     ? confirmed
                         .map(
                           (r) => `<tr><td>${escapeHtml(r.studentName)}</td><td>${escapeHtml(slotDescription(r.slotId))}</td><td>${r.rank}</td></tr>`
                         )
                         .join("")
                     : `<tr><td colspan="3" class="muted">なし</td></tr>`
                 }</tbody>
               </table></div>
             </div>
             <div class="card">
               <h3>2次マッチング対象（${second.length} 名）</h3>
               <p class="muted">
                 期間目安：${escapeHtml(fmtDateOnly(pick(state.settings, ["second_starts_on"], "")) || "指定なし")}
                 ～ ${escapeHtml(fmtDateOnly(pick(state.settings, ["second_deadline_on"], "")) || "指定なし")}
                 （表示のみです。自動ロックはされません。設定タブで変更できます）
               </p>
               <div class="table-wrap"><table>
                 <thead><tr><th>氏名</th><th>1次で希望した枠</th><th>抽選順位</th></tr></thead>
                 <tbody>${
                   second.length
                     ? second
                         .map(
                           (r) => `<tr><td>${escapeHtml(r.studentName)}</td><td>${escapeHtml(slotDescription(r.slotId))}</td><td>${r.rank}</td></tr>`
                         )
                         .join("")
                     : `<tr><td colspan="3" class="muted">なし</td></tr>`
                 }</tbody>
               </table></div>
             </div>`
          : ""
      }

      <div class="card">
        <h3>枠ごとの残り定員</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>枠</th><th>定員</th><th>確定</th><th>残り</th><th>確定者</th></tr></thead>
          <tbody>${[...summary.perSlot.values()].map(slotRow).join("")}</tbody>
        </table></div>
      </div>
    `;

    const bind = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", fn);
    };
    bind("match-dry", () => runFinalize({ dryRun: true, force: true }));
    bind("match-run", () => {
      openModal(`
        <h3>1次マッチングの確定</h3>
        <p>抽選を実行し、結果を保存します。<strong>この操作は一度だけ実行でき、あとから抽選をやり直すことはできません。</strong></p>
        <div class="modal-actions">
          <button class="btn-secondary" id="modal-cancel">キャンセル</button>
          <button class="btn-primary" id="modal-confirm">確定する</button>
        </div>`);
      document.getElementById("modal-cancel").addEventListener("click", closeModal);
      document.getElementById("modal-confirm").addEventListener("click", () => {
        closeModal();
        runFinalize({});
      });
    });
    bind("match-test", () => runFinalize({ force: true, isTest: true }));
    bind("match-reset", () => resetTestMatching());
  }

  function reportStudentError(prefix, error, detail) {
    const hint = describeInsertError(error);
    const full = `${prefix}: ${detail || error.message}${hint ? " — " + hint : ""}`;
    console.error("student insert failed", error);
    showToast(`${prefix}: ${error.message}`, 5000);
    const box = document.getElementById("student-error");
    if (box) {
      box.textContent = full;
      box.classList.remove("hidden");
    }
  }

  function renderStudents(body) {
    body.innerHTML = `
      <div class="card">
        <h2>学生の追加</h2>
        <form id="add-student-form" class="form-grid two-col">
          <div class="field">
            <label>氏名</label>
            <input type="text" id="new-student-name" required />
          </div>
          <div class="field" style="align-self:end;">
            <button type="submit" class="btn-primary" style="width:100%;">追加</button>
          </div>
        </form>
        <div id="student-error" class="error-text hidden"></div>
      </div>
      <div class="card">
        <h2>CSVインポート（学生28名）</h2>
        <p class="muted">1行に氏名を1名ずつ記載したCSV/テキストファイルを選択してください（氏名のみ）。</p>
        <div class="form-grid two-col">
          <div class="field">
            <input type="file" id="csv-file" accept=".csv,text/csv,text/plain" />
          </div>
          <div class="field">
            <button type="button" class="btn-primary" id="csv-import-btn" style="width:100%;">インポート実行</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="toolbar">
          <h2 style="margin:0;">学生一覧（全 ${state.students.length} 名）</h2>
          <span class="spacer"></span>
          <input type="text" id="student-search" placeholder="氏名で検索" style="max-width:220px;" />
          <button type="button" class="btn-secondary" id="reset-all-choices-btn">全員の選択をリセット</button>
        </div>
        <p class="muted">テストで動かした選択を消して、まっさらな状態に戻したいときに使ってください。1次マッチングの結果は消えません（別途「マッチング」タブのテスト確定取り消しを使ってください）。</p>
        <div class="table-wrap">
          <table id="students-table">
            <thead><tr><th>氏名</th><th>学生コード</th><th>現在の選択</th><th>個人URL</th><th>操作</th></tr></thead>
            <tbody>
              ${state.students
                .map((s) => {
                  const slotId = pick(s, ["current_slot_id"], null);
                  const slotLabel = slotDescription(slotId) || "未選択";
                  const tok = pick(s, ["access_token"], "");
                  const name = pick(s, ["name"], "(無名)");
                  return `<tr data-name="${escapeHtml(String(name).toLowerCase())}">
                    <td>${escapeHtml(name)}</td>
                    <td>${escapeHtml(pick(s, ["student_code"], "—"))}</td>
                    <td>${escapeHtml(slotLabel)}</td>
                    <td>
                      <div class="token-box">
                        <input type="text" readonly value="${escapeHtml(studentUrl(tok))}" style="width:220px;" />
                        <button class="btn-small btn-secondary copy-btn" data-token="${escapeHtml(tok)}">コピー</button>
                      </div>
                    </td>
                    <td><button class="btn-small btn-danger del-student-btn" data-id="${escapeHtml(pick(s, ["id"], ""))}">削除</button></td>
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById("reset-all-choices-btn").addEventListener("click", async () => {
      if (!confirm("全員の選択を空欄に戻します。テストで動かした分を消す場合に使ってください。元に戻せません。よろしいですか？")) return;
      const { error } = await sb.from("students").update({ current_slot_id: null }).not("id", "is", null);
      if (error) {
        showToast("リセットに失敗しました: " + error.message);
        return;
      }
      showToast("全員の選択をリセットしました");
      await loadAll();
      state.tab = "students";
      renderDashboard();
    });

    document.getElementById("add-student-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = document.getElementById("new-student-name").value.trim();
      if (!name) return;
      const { error, detail } = await insertStudents([name], state.students.map((s) => s.student_code));
      if (error) {
        reportStudentError("追加に失敗しました", error, detail);
        return;
      }
      document.getElementById("new-student-name").value = "";
      showToast("学生を追加しました");
      await loadAll();
      state.tab = "students";
      renderDashboard();
    });

    document.getElementById("csv-import-btn").addEventListener("click", async () => {
      const fileInput = document.getElementById("csv-file");
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showToast("CSVファイルを選択してください");
        return;
      }
      const text = await file.text();
      const names = text
        .split(/\r?\n/)
        .map((line) => line.split(",")[0].trim().replace(/^"|"$/g, ""))
        .filter((name) => name && !/^(name|氏名)$/i.test(name));
      if (!names.length) {
        showToast("インポートできる氏名が見つかりませんでした");
        return;
      }
      const { error, detail } = await insertStudents(names, state.students.map((s) => s.student_code));
      if (error) {
        reportStudentError("インポートに失敗しました", error, detail);
        return;
      }
      showToast(`${names.length}名をインポートしました`);
      await loadAll();
      state.tab = "students";
      renderDashboard();
    });

    document.getElementById("student-search").addEventListener("input", (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      body.querySelectorAll("#students-table tbody tr").forEach((tr) => {
        const name = tr.getAttribute("data-name") || "";
        tr.style.display = !q || name.includes(q) ? "" : "none";
      });
    });

    body.querySelectorAll(".copy-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const tok = btn.getAttribute("data-token");
        try {
          await navigator.clipboard.writeText(studentUrl(tok));
          showToast("URLをコピーしました");
        } catch {
          showToast("コピーに失敗しました");
        }
      })
    );

    body.querySelectorAll(".del-student-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (!confirm("この学生を削除しますか？この操作は取り消せません。")) return;
        const { error } = await sb.from("students").delete().eq("id", id);
        if (error) {
          showToast("削除に失敗しました: " + error.message);
          return;
        }
        showToast("削除しました");
        await loadAll();
        state.tab = "students";
        renderDashboard();
      })
    );
  }

  function renderSettings(body) {
    const s = state.settings || {};
    body.innerHTML = `
      <div class="card">
        <h2>設定</h2>
        <form id="settings-form" class="form-grid two-col">
          <div class="field">
            <label>タイトル</label>
            <input type="text" id="s-title" value="${escapeHtml(pick(s, ["title"], ""))}" />
          </div>
          <div class="field">
            <label>受付開始日</label>
            <input type="date" id="s-starts" value="${escapeHtml(toDateInputValue(pick(s, ["starts_on"], "")))}" />
          </div>
          <div class="field">
            <label>受付開始時刻</label>
            <input type="time" id="s-open" value="${escapeHtml(toTimeInputValue(pick(s, ["daily_open"], "")))}" />
          </div>
          <div class="field">
            <label>受付終了日</label>
            <input type="date" id="s-deadline" value="${escapeHtml(toDateInputValue(pick(s, ["deadline_on"], "")))}" />
          </div>
          <div class="field">
            <label>受付終了時刻</label>
            <input type="time" id="s-close" value="${escapeHtml(toTimeInputValue(pick(s, ["daily_close"], "")))}" />
          </div>
          <p class="muted" style="grid-column:1/-1;margin:-4px 0 0 0;">
            上の「開始日時」から「終了日時」までの間は、いつでも希望の変更ができます
            （毎日決まった時間帯だけ、という制限ではありません）。
          </p>
          <div class="field">
            <label>2次マッチング開始日の目安 (second_starts_on)</label>
            <input type="date" id="s-second-starts" value="${escapeHtml(toDateInputValue(pick(s, ["second_starts_on"], "")))}" />
          </div>
          <div class="field">
            <label>2次マッチング締切日の目安 (second_deadline_on)</label>
            <input type="date" id="s-second-deadline" value="${escapeHtml(toDateInputValue(pick(s, ["second_deadline_on"], "")))}" />
            <p class="muted" style="margin-top:4px;">どちらも表示のみです。過ぎても自動ロックはされません（人が判断してください）。</p>
          </div>
          <div class="field" style="grid-column:1/-1;">
            <button type="submit" class="btn-primary">保存</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById("settings-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const payload = {
        title: document.getElementById("s-title").value,
        starts_on: document.getElementById("s-starts").value || null,
        deadline_on: document.getElementById("s-deadline").value || null,
        second_deadline_on: document.getElementById("s-second-deadline").value || null,
        second_starts_on: document.getElementById("s-second-starts").value || null,
        daily_open: fromTimeInputValue(document.getElementById("s-open").value),
        daily_close: fromTimeInputValue(document.getElementById("s-close").value),
      };
      const idField = pick(s, ["id"], undefined);
      const q = sb.from("app_settings").update(payload);
      const { data, error } =
        idField !== undefined
          ? await q.eq("id", idField).select()
          : await q.not("id", "is", null).select();
      if (error) {
        showToast("保存に失敗しました: " + error.message);
        return;
      }
      if (!data || !data.length) {
        showToast("保存対象の設定行が見つかりませんでした");
        return;
      }
      showToast("設定を保存しました");
      await loadAll();
      state.tab = "settings";
      renderDashboard();
    });
  }

  function slotDescription(id) {
    if (id == null || id === "") return null;
    const raw = state.slots.find((sl) => String(pick(sl, ["id"], "")) === String(id));
    if (!raw) return String(id);
    const n = normalizeSlot(raw, []);
    const range = courseRangeText(n);
    return [n.facility, range, n.weeks ? n.weeks + "週間" : ""].filter(Boolean).join(" ");
  }

  function studentNameById(id) {
    if (id == null || id === "") return "";
    const st = state.students.find((x) => String(pick(x, ["id"], "")) === String(id));
    return st ? pick(st, ["name"], String(id)) : String(id);
  }

  function renderLog(body) {
    body.innerHTML = `
      <div class="card">
        <h2>変更履歴</h2>
        <div class="table-wrap">
          <table>
            <thead><tr><th>日時</th><th>学生</th><th>変更前</th><th>変更後</th></tr></thead>
            <tbody>
              ${
                state.changeLog.length
                  ? state.changeLog
                      .map((l) => {
                        const when = pick(l, ["changed_at", "created_at"], "");
                        const who = pick(l, ["student_name"], null) || studentNameById(pick(l, ["student_id"], null));
                        const oldSlot = slotDescription(pick(l, ["old_slot_id"], null));
                        const newSlot = slotDescription(pick(l, ["new_slot_id"], null));
                        return `<tr>
                          <td>${escapeHtml(fmtDate(when))}</td>
                          <td>${escapeHtml(who || "—")}</td>
                          <td>${escapeHtml(oldSlot || "未選択")}</td>
                          <td>${escapeHtml(newSlot || "未選択")}</td>
                        </tr>`;
                      })
                      .join("")
                  : `<tr><td colspan="4" class="muted">ログはまだありません。</td></tr>`
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  init();
}
