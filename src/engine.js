// =====================================================================
// Trello automation engine (n8n Code node, "Run Once for All Items")
//
// Input items: { mode: 'event' | 'tick', now: ISO, event: {...} | null, card: {...} }
// Output items:
//   { kind: 'trello', method, path, body, cardId, cardName, rules }   -> Apply to Trello
//   { kind: 'notify', subject, html, count }                          -> Send reminder
//
// Nguyên tắc (xem README > Bộ rule):
//   1. Rule KHÔNG gọi API. Mỗi rule sửa "trạng thái mong muốn" (state) của card,
//      chạy theo thứ tự ưu tiên trong CARD_RULES.
//   2. Engine so state với card hiện tại -> 1 lệnh PUT duy nhất cho phần khác biệt.
//      => không xung đột, idempotent, event do flow tự ghi không gây loop.
//   3. Thêm rule = thêm 1 object vào CARD_RULES / BOARD_RULES / NOTIFY_RULES.
// =====================================================================

// ------------------------------- CONFIG -------------------------------
const CFG = {
  TZ: 'Asia/Tokyo',
  LISTS: {
    TODO: '637f29dbd7cdb10180694cce',
    TOYO: '6a825255fe28002facc815cb',
    VNK: '6a80f84c6bbc2ef4df2421f1',
    JP_WORDS: '6a824653d005da17b4d01fb8',
    AI_ROADMAP: '6ab13c420ae451103845392f',
    LEARN: '63d22f6dd1986829fc5db0e1',
    RECURRING: '638415cef5d48401ebfba1a9', // 繰り返し
    DONE: '637f29fa92e3ce10340e4f31',
  },
  LIST_NAMES: {
    '637f29dbd7cdb10180694cce': 'To-do',
    '6a825255fe28002facc815cb': 'Toyo',
    '6a80f84c6bbc2ef4df2421f1': 'VNK',
    '6a824653d005da17b4d01fb8': 'JP new words',
    '6ab13c420ae451103845392f': 'AI資格ロードマップ',
    '63d22f6dd1986829fc5db0e1': 'Learn',
    '638415cef5d48401ebfba1a9': '繰り返し',
    '637f29fa92e3ce10340e4f31': 'Done',
  },
  // Label urgency do automation quản lý hoàn toàn -> đừng dùng 3 màu này cho mục đích khác.
  LABELS: {
    GREEN: '637ef8ef3ec9d20369bb91ad', // còn 2 ngày
    ORANGE: '637ef8f1e5fa560023eabbb0', // còn 1 ngày
    RED: '637ef8f319573c03e06380ac', // hôm nay / quá hạn
  },
  DEFAULT_DUE: { days: 3, hour: 9, minute: 0 }, // card mới không có ngày
  TITLE_DEFAULT_TIME: { hour: 9, minute: 0 }, // "@2026/8/9" không có giờ
  CLEAR_DUE_WHEN_TAG_REMOVED: false,
  REMINDERS: [
    { minutes: 2 * 24 * 60, text: 'còn 2 ngày' },
    { minutes: 24 * 60, text: 'còn 1 ngày' },
    { minutes: 60, text: 'còn 1 giờ' },
  ],
  TICK_MINUTES: 15, // phải khớp với Schedule Trigger
};
const L = CFG.LISTS;
// List công việc: default due, complete -> Done, sort hằng ngày.
const TASK_LISTS = [L.TODO, L.TOYO, L.VNK];
const SORTED_LISTS = TASK_LISTS;
// List "bị động": không gắn label urgency, không nhắc hạn.
const PASSIVE_LISTS = [L.DONE, L.RECURRING];
const URGENCY_LABELS = [CFG.LABELS.GREEN, CFG.LABELS.ORANGE, CFG.LABELS.RED];

// ------------------------------- HELPERS ------------------------------
const toDT = (iso) => (iso ? DateTime.fromISO(iso, { zone: CFG.TZ }) : null);
const sameInstant = (a, b) => (a ? toDT(a).toMillis() : null) === (b ? toDT(b).toMillis() : null);

// "@yyyy/m/d hh:mm", "@ yyyy/mm/dd @ hh:mm", "@m/d", "@2026年8月9日 13時30分", full-width...
const DATE_TAG =
  /@\s*(?:(\d{4})\s*[\/\-.年]\s*)?(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})(?!\d)日?(?:\s*@?\s*(\d{1,2})\s*[:時]\s*(\d{2})(?!\d)分?)?/g;

function parseTitleDue(title, now) {
  if (!title) return null;
  let result = null;
  for (const m of title.normalize('NFKC').matchAll(DATE_TAG)) {
    const [, y, mo, d, h, mi] = m;
    const hour = h !== undefined ? +h : CFG.TITLE_DEFAULT_TIME.hour;
    const minute = h !== undefined ? +mi : CFG.TITLE_DEFAULT_TIME.minute;
    let dt = DateTime.fromObject({ year: y ? +y : now.year, month: +mo, day: +d, hour, minute }, { zone: CFG.TZ });
    if (!y && dt.isValid && dt < now.startOf('day')) dt = dt.plus({ years: 1 }); // không ghi năm & đã qua -> năm sau
    if (dt.isValid && hour < 24 && minute < 60) result = dt; // lấy tag hợp lệ cuối cùng
  }
  return result;
}

// Số ngày lịch (theo TZ) từ hôm nay tới ngày due. 0 = hôm nay, âm = quá hạn.
const calendarDaysLeft = (dueIso, now) =>
  Math.round(toDT(dueIso).startOf('day').diff(now.startOf('day'), 'days').days);

const isPassive = (s) => PASSIVE_LISTS.includes(s.idList);

// Event helpers (event = null khi chạy theo lịch)
const entered = (ctx, listId) =>
  !!ctx.event && ((ctx.event.created && ctx.card.idList === listId) ||
    (ctx.event.listAfter === listId && ctx.event.listBefore !== listId));
const left = (ctx, listId) => !!ctx.event && ctx.event.listBefore === listId && ctx.event.listAfter !== listId;

// ------------------------------ CARD RULES ----------------------------
// Chạy theo đúng thứ tự dưới đây. Rule sau thấy kết quả của rule trước.
const CARD_RULES = [
  {
    id: 'recurring-reset', // Vào 繰り返し -> xoá due + xoá toàn bộ label
    when: (ctx) => entered(ctx, L.RECURRING),
    apply: (ctx, s) => { s.due = null; s.labels.clear(); },
  },
  {
    id: 'due-from-title', // Tạo / đổi tên có "@ngày giờ" -> set due (không áp dụng trong 繰り返し)
    when: (ctx, s) => !!ctx.event && (ctx.event.created || ctx.event.nameChanged) && s.idList !== L.RECURRING,
    apply: (ctx, s) => {
      const due = parseTitleDue(ctx.card.name, ctx.now);
      if (due) s.due = due.toUTC().toISO();
      else if (CFG.CLEAR_DUE_WHEN_TAG_REMOVED && parseTitleDue(ctx.event.oldName, ctx.now)) s.due = null;
    },
  },
  {
    id: 'default-due', // Card mới trong list công việc, chưa có due -> +3 ngày 09:00
    when: (ctx, s) => !!ctx.event && ctx.event.created && TASK_LISTS.includes(s.idList) && !s.due,
    apply: (ctx, s) => {
      const d = CFG.DEFAULT_DUE;
      s.due = ctx.now.plus({ days: d.days }).set({ hour: d.hour, minute: d.minute, second: 0, millisecond: 0 }).toUTC().toISO();
    },
  },
  {
    id: 'complete-to-done', // Complete trong list công việc -> lên đầu Done
    when: (ctx, s) => !!ctx.event && ctx.event.completedNow && TASK_LISTS.includes(s.idList),
    apply: (ctx, s) => { s.idList = L.DONE; s.pos = 'top'; },
  },
  {
    id: 'done-marks-complete', // Vào Done -> complete
    when: (ctx) => entered(ctx, L.DONE),
    apply: (ctx, s) => { s.dueComplete = true; },
  },
  {
    id: 'reopen-on-leave-done', // Kéo ra khỏi Done -> bỏ complete (đề xuất thêm)
    when: (ctx, s) => left(ctx, L.DONE) && s.idList !== L.DONE && s.idList !== L.RECURRING,
    apply: (ctx, s) => { s.dueComplete = false; },
  },
  {
    id: 'urgency-labels', // Luôn chạy: label theo số ngày còn lại (idempotent)
    when: () => true,
    apply: (ctx, s) => {
      URGENCY_LABELS.forEach((l) => s.labels.delete(l));
      if (isPassive(s) || !s.due || s.dueComplete) return;
      const days = calendarDaysLeft(s.due, ctx.now);
      if (days <= 0) s.labels.add(CFG.LABELS.RED);
      else if (days === 1) s.labels.add(CFG.LABELS.ORANGE);
      else if (days === 2) s.labels.add(CFG.LABELS.GREEN);
    },
  },
];

// ------------------------------ BOARD RULES ---------------------------
// Chạy 1 lần/ngày (tick đầu tiên sau 00:00), trên toàn bộ card sau khi CARD_RULES đã áp dụng.
const BOARD_RULES = [
  {
    id: 'daily-sort', // Sort To-do / Toyo / VNK theo due tăng dần. Card due hôm nay/quá hạn tự lên đầu.
    when: (ctx) => ctx.daily,
    apply: (ctx, entries) => {
      for (const listId of SORTED_LISTS) {
        const inList = entries.filter((e) => e.state.idList === listId && e.state.pos === undefined);
        const current = [...inList].sort((a, b) => a.card.pos - b.card.pos);
        const rank = (e) => (e.state.dueComplete ? 2 : e.state.due ? 0 : 1); // có due < không due < đã complete
        const desired = [...current].sort((a, b) =>
          rank(a) - rank(b) ||
          (rank(a) === 0 ? toDT(a.state.due).toMillis() - toDT(b.state.due).toMillis() : 0) ||
          a.card.pos - b.card.pos);
        if (desired.every((e, i) => e === current[i])) continue;
        desired.forEach((e, i) => { e.state.pos = (i + 1) * 16384; e.rules.add('daily-sort'); });
      }
    },
  },
];

// ------------------------------ NOTIFY RULES --------------------------
// Chạy mỗi tick. Không lưu state: 1 mốc nhắc thuộc đúng 1 tick (slot 15 phút) nên không gửi trùng.
const NOTIFY_RULES = [
  {
    id: 'due-reminders', // Nhắc trước 2 ngày, 1 ngày, 1 giờ
    when: (ctx) => ctx.mode === 'tick',
    collect: (ctx, entries) => {
      const slotMs = CFG.TICK_MINUTES * 60 * 1000;
      const slot = Math.floor(ctx.now.toMillis() / slotMs);
      const hits = [];
      for (const { card, state } of entries) {
        if (card.closed || isPassive(state) || !state.due || state.dueComplete) continue;
        const due = toDT(state.due);
        for (const r of CFG.REMINDERS) {
          if (Math.floor(due.minus({ minutes: r.minutes }).toMillis() / slotMs) === slot) {
            hits.push({ card, due, text: r.text });
          }
        }
      }
      return hits;
    },
  },
];

// -------------------------------- ENGINE ------------------------------
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const items = $input.all().map((i) => i.json);
if (items.length === 0) return [];
const now = DateTime.fromISO(items[0].now ?? new Date().toISOString()).setZone(CFG.TZ);
const mode = items[0].mode;
const daily = mode === 'tick' && now.hour === 0 && now.minute < CFG.TICK_MINUTES;
const baseCtx = { mode, now, daily };

const entries = [];
for (const it of items) {
  const card = it.card;
  if (!card?.id || card.closed) continue;
  const ctx = { ...baseCtx, event: it.event ?? null, card };
  const state = {
    due: card.due ?? null,
    dueComplete: !!card.dueComplete,
    idList: card.idList,
    pos: undefined,
    labels: new Set(card.idLabels ?? []),
  };
  const rules = new Set();
  for (const rule of CARD_RULES) {
    if (!rule.when(ctx, state)) continue;
    const before = JSON.stringify({ ...state, labels: [...state.labels] });
    rule.apply(ctx, state);
    if (JSON.stringify({ ...state, labels: [...state.labels] }) !== before) rules.add(rule.id);
  }
  entries.push({ card, state, rules });
}

for (const rule of BOARD_RULES) if (rule.when(baseCtx)) rule.apply(baseCtx, entries);

const out = [];
for (const { card, state, rules } of entries) {
  const body = {};
  if (!sameInstant(state.due, card.due ?? null)) body.due = state.due ?? '';
  if (state.dueComplete !== !!card.dueComplete) body.dueComplete = state.dueComplete;
  if (state.idList !== card.idList) body.idList = state.idList;
  if (state.pos !== undefined && state.pos !== card.pos) body.pos = state.pos;
  const oldLabels = card.idLabels ?? [];
  const newLabels = [...state.labels];
  if (newLabels.length !== oldLabels.length || newLabels.some((l) => !oldLabels.includes(l))) {
    body.idLabels = newLabels.join(',');
  }
  if (Object.keys(body).length === 0) continue;
  out.push({ json: { kind: 'trello', method: 'PUT', path: `cards/${card.id}`, body, cardId: card.id, cardName: card.name, rules: [...rules] } });
}

for (const rule of NOTIFY_RULES) {
  if (!rule.when(baseCtx)) continue;
  const hits = rule.collect(baseCtx, entries);
  if (hits.length === 0) continue;
  hits.sort((a, b) => a.due.toMillis() - b.due.toMillis());
  const rows = hits.map((h) =>
    `<li><b>${esc(h.text)}</b> · [${esc(CFG.LIST_NAMES[h.card.idList] ?? '?')}] ` +
    `<a href="${esc(h.card.shortUrl ?? '')}">${esc(h.card.name)}</a> — due ${h.due.toFormat('yyyy/MM/dd HH:mm')}</li>`);
  out.push({
    json: {
      kind: 'notify',
      rule: rule.id,
      count: hits.length,
      subject: `⏰ Trello: ${hits.length === 1 ? `${hits[0].card.name} (${hits[0].text})` : `${hits.length} card sắp tới hạn`}`,
      html: `<p>Nhắc hạn Trello (${now.toFormat('yyyy/MM/dd HH:mm')} JST):</p><ul>${rows.join('')}</ul>`,
    },
  });
}
return out;
