// Test Engine + Normalize: chạy đúng mã nguồn trong src/, mock runtime n8n.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DateTime } from 'luxon';

const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const run = (file, inputs, refs = {}) => {
  const $input = { all: () => inputs.map((json) => ({ json })) };
  const $ = (node) => ({ itemMatching: (i) => ({ json: refs[node][i] }), first: () => ({ json: refs[node][0] }) });
  return new Function('$input', '$', 'DateTime', src(file))($input, $, DateTime).map((i) => i.json);
};

const LIST = {
  TODO: '637f29dbd7cdb10180694cce', TOYO: '6a825255fe28002facc815cb', LEARN: '63d22f6dd1986829fc5db0e1',
  AI: '6ab13c420ae451103845392f', RECURRING: '638415cef5d48401ebfba1a9', DONE: '637f29fa92e3ce10340e4f31',
};
const LB = { GREEN: '637ef8ef3ec9d20369bb91ad', ORANGE: '637ef8f1e5fa560023eabbb0', RED: '637ef8f319573c03e06380ac', BLUE: 'blue0000' };

// "Bây giờ" = 2026-09-25 10:00 JST
const NOW = '2026-09-25T01:00:00.000Z';
const jst = (s) => DateTime.fromFormat(s, 'yyyy/MM/dd HH:mm', { zone: 'Asia/Tokyo' }).toUTC().toISO();
const card = (o = {}) => ({ id: 'c1', name: 'Việc', idList: LIST.TODO, due: null, dueComplete: false, idLabels: [], pos: 1000, closed: false, shortUrl: 'https://trello.com/c/x', ...o });
const ev = (o = {}) => ({ type: 'updateCard', cardId: 'c1', created: false, nameChanged: false, oldName: null, dueChanged: false, completedNow: false, uncompletedNow: false, listBefore: null, listAfter: null, ...o });
// Các test rule khác bỏ qua dueReminder (có bộ test riêng ở cuối file)
const stripReminder = (out) => out
  .map((o) => { const { dueReminder, ...body } = o.body; return { ...o, body, rules: o.rules.filter((r) => r !== 'native-reminder') }; })
  .filter((o) => Object.keys(o.body).length > 0);
const rawEvent = (c, e, now = NOW) => run('engine.js', [{ mode: 'event', now, event: ev(e), card: card(c) }]);
const rawTick = (cards, now = NOW) => run('engine.js', cards.map((c) => ({ mode: 'tick', now, event: null, card: card(c) })));
const onEvent = (...a) => stripReminder(rawEvent(...a));
const onTick = (...a) => stripReminder(rawTick(...a));
const one = (out) => { assert.equal(out.length, 1, JSON.stringify(out)); return out[0]; };
// Áp body lên card như Trello sẽ làm -> dùng để kiểm tra idempotent
const applyBody = (c, body) => ({ ...card(c), ...body, due: body.due === '' ? null : body.due ?? card(c).due,
  idLabels: body.idLabels === undefined ? card(c).idLabels : body.idLabels ? body.idLabels.split(',') : [],
  pos: typeof body.pos === 'number' ? body.pos : body.pos === 'top' ? 0 : card(c).pos });

// ---------------------------- due-from-title ----------------------------
test('title: tạo card có "@yyyy/m/d hh:mm" -> due theo JST', () => {
  const a = one(onEvent({ name: 'Họp @2026/10/9 13:30' }, { created: true }));
  assert.equal(a.body.due, jst('2026/10/09 13:30'));
  assert.deepEqual(a.rules, ['due-from-title']);
});

test('title: các định dạng + chỉ có ngày -> 09:00', () => {
  for (const [t, want] of [
    ['A @ 2026/10/09 @ 13:30', '2026/10/09 13:30'], ['A ＠２０２６／１０／９　１３：３０', '2026/10/09 13:30'],
    ['会議 @2026年10月9日 13時30分', '2026/10/09 13:30'], ['A @10/9', '2026/10/09 09:00'], ['A @9/1 10:00', '2027/09/01 10:00'],
  ]) assert.equal(one(onEvent({ name: t }, { nameChanged: true })).body.due, jst(want), t);
});

test('title: tag sai hoặc không có tag khi đổi tên -> không đổi due', () => {
  assert.deepEqual(onEvent({ name: 'A @2026/2/30', due: jst('2026/10/20 09:00') }, { nameChanged: true }), []);
  assert.deepEqual(onEvent({ name: 'mail a@b.com', due: jst('2026/10/20 09:00') }, { nameChanged: true }), []);
});

test('title: event khác (không phải tạo/đổi tên) không ghi đè due đặt tay', () => {
  assert.deepEqual(onEvent({ name: 'A @2026/10/9 13:30', due: jst('2026/10/20 09:00') }, { dueChanged: true }), []);
});

// ------------------------------ default-due -----------------------------
test('default due: card mới trong To-do không tag -> +3 ngày 09:00, không label', () => {
  const a = one(onEvent({ name: 'Việc mới' }, { created: true }));
  assert.equal(a.body.due, jst('2026/09/28 09:00'));
  assert.equal(a.body.idLabels, undefined);
});

test('default due: title tag thắng default; list không phải list công việc -> không default', () => {
  assert.equal(one(onEvent({ name: 'X @2026/9/26 08:00' }, { created: true })).body.due, jst('2026/09/26 08:00'));
  assert.deepEqual(onEvent({ name: '単語', idList: LIST.LEARN }, { created: true }), []);
  assert.deepEqual(onEvent({ name: 'copy', due: jst('2026/10/20 09:00') }, { created: true, type: 'copyCard' }), []);
});

// ---------------------------- urgency-labels ----------------------------
test('urgency: due đổi sang ngày mai -> orange ngay lập tức (không chờ tới đêm)', () => {
  const a = one(onEvent({ due: jst('2026/09/26 18:00'), idLabels: [LB.GREEN] }, { dueChanged: true }));
  assert.equal(a.body.idLabels, LB.ORANGE);
});

test('urgency: theo ngày lịch JST; giữ label khác màu', () => {
  const cases = [
    ['2026/09/28 09:00', ''], ['2026/09/27 23:59', LB.GREEN], ['2026/09/26 00:00', LB.ORANGE],
    ['2026/09/25 23:59', LB.RED], ['2026/09/20 09:00', LB.RED],
  ];
  for (const [due, want] of cases) {
    const out = onTick([{ due: jst(due), idLabels: [LB.BLUE] }]);
    if (!want) { assert.deepEqual(out, [], due); continue; }
    assert.equal(one(out).body.idLabels, [LB.BLUE, want].join(','), due);
  }
});

test('urgency: complete / Done / 繰り返し -> gỡ label urgency', () => {
  for (const c of [{ dueComplete: true }, { idList: LIST.DONE }, { idList: LIST.RECURRING }]) {
    assert.equal(one(onTick([{ due: jst('2026/09/25 12:00'), idLabels: [LB.RED, LB.BLUE], ...c }])).body.idLabels, LB.BLUE);
  }
});

test('urgency: list roadmap / Learn vẫn có label, không bị di chuyển', () => {
  const a = one(onTick([{ idList: LIST.AI, due: jst('2026/09/26 10:00') }], '2026-09-24T15:05:00.000Z')); // 00:05 JST (daily)
  assert.deepEqual(a.body, { idLabels: LB.ORANGE });
});

// ------------------------- complete / Done / reopen ---------------------
test('complete trong To-do -> lên đầu Done, gỡ label urgency', () => {
  const a = one(onEvent({ due: jst('2026/09/25 12:00'), dueComplete: true, idLabels: [LB.RED, LB.BLUE] }, { completedNow: true }));
  assert.deepEqual(a.body, { idList: LIST.DONE, pos: 'top', idLabels: LB.BLUE });
  assert.deepEqual(a.rules.sort(), ['complete-to-done', 'urgency-labels']);
});

test('complete trong Learn -> KHÔNG chuyển sang Done (giữ thói quen của list Learn)', () => {
  assert.deepEqual(onEvent({ idList: LIST.LEARN, dueComplete: true }, { completedNow: true }), []);
});

test('kéo vào Done -> complete + gỡ label; card nằm yên vị trí được thả', () => {
  const a = one(onEvent({ idList: LIST.DONE, due: jst('2026/09/25 12:00'), idLabels: [LB.RED] }, { listBefore: LIST.TODO, listAfter: LIST.DONE }));
  assert.deepEqual(a.body, { dueComplete: true, idLabels: '' });
});

test('tạo card thẳng trong Done -> complete', () => {
  assert.deepEqual(one(onEvent({ idList: LIST.DONE, name: 'x' }, { created: true })).body, { dueComplete: true });
});

test('chống loop: event do chính flow ghi ra -> không làm gì', () => {
  // sau complete-to-done, Trello bắn event đổi list vào Done
  assert.deepEqual(onEvent({ idList: LIST.DONE, dueComplete: true, due: jst('2026/09/25 12:00') }, { listBefore: LIST.TODO, listAfter: LIST.DONE }), []);
  // sau done-marks-complete, Trello bắn event dueComplete=true (card đã ở Done)
  assert.deepEqual(onEvent({ idList: LIST.DONE, dueComplete: true }, { completedNow: true }), []);
  // sau khi flow set due, Trello bắn event đổi due
  assert.deepEqual(onEvent({ name: 'A @2026/10/9 13:30', due: jst('2026/10/09 13:30') }, { dueChanged: true }), []);
});

test('kéo ra khỏi Done -> bỏ complete, label theo due', () => {
  const a = one(onEvent({ idList: LIST.TODO, dueComplete: true, due: jst('2026/09/25 20:00') }, { listBefore: LIST.DONE, listAfter: LIST.TODO }));
  assert.deepEqual(a.body, { dueComplete: false, idLabels: LB.RED });
});

// -------------------------------- 繰り返し -------------------------------
test('vào 繰り返し -> xoá due + xoá TẤT CẢ label', () => {
  const a = one(onEvent({ idList: LIST.RECURRING, due: jst('2026/09/26 09:00'), idLabels: [LB.ORANGE, LB.BLUE] }, { listBefore: LIST.TODO, listAfter: LIST.RECURRING }));
  assert.deepEqual(a.body, { due: '', idLabels: '' });
});

test('繰り返し: đổi tên có tag / tạo mới -> không set due, không default due', () => {
  assert.deepEqual(onEvent({ idList: LIST.RECURRING, name: 'Rác @2026/10/1 7:00' }, { nameChanged: true }), []);
  assert.deepEqual(onEvent({ idList: LIST.RECURRING, name: 'Rác' }, { created: true }), []);
});

// ------------------------------ daily sort ------------------------------
const DAILY = '2026-09-24T15:05:00.000Z'; // 2026-09-25 00:05 JST
test('daily sort: có due tăng dần -> không due -> complete; chỉ ở tick 00:00-00:14', () => {
  const cards = [
    { id: 'a', pos: 1, due: jst('2026/10/10 09:00') },
    { id: 'b', pos: 2 },
    { id: 'c', pos: 3, due: jst('2026/09/20 09:00'), idLabels: [LB.RED] }, // quá hạn -> lên đầu
    { id: 'd', pos: 4, due: jst('2026/10/01 09:00'), dueComplete: true },
    { id: 'e', pos: 5, due: jst('2026/10/05 09:00') },
  ];
  const out = onTick(cards, DAILY);
  const pos = Object.fromEntries(out.map((o) => [o.cardId, o.body.pos]));
  const order = Object.keys(pos).sort((x, y) => pos[x] - pos[y]);
  assert.deepEqual(order, ['c', 'e', 'a', 'b', 'd']);
  assert.deepEqual(onTick(cards, '2026-09-25T01:00:00.000Z'), []); // 10:00 -> không sort
});

test('daily sort: đã đúng thứ tự -> không ghi; list không sort (AI) không bị động tới', () => {
  const sorted = [{ id: 'a', pos: 1, due: jst('2026/10/01 09:00') }, { id: 'b', pos: 2, due: jst('2026/10/02 09:00') }, { id: 'z', pos: 3 }];
  assert.deepEqual(onTick(sorted, DAILY), []);
  const ai = [{ id: 'm1', idList: LIST.AI, pos: 1, due: jst('2026/12/01 09:00') }, { id: 'm2', idList: LIST.AI, pos: 2, due: jst('2026/10/01 09:00') }];
  assert.deepEqual(onTick(ai, DAILY), []);
});

// --------------------------- native reminder ---------------------------
const reminderOf = (out) => out.find((o) => 'dueReminder' in o.body)?.body.dueReminder;
test('reminder Trello: xoay vòng 2 ngày -> 1 ngày -> 1 giờ theo thời gian còn lại', () => {
  const cases = [
    ['2026/09/28 10:00', 2880], // còn ~3 ngày
    ['2026/09/27 09:59', 1440], // còn < 2 ngày
    ['2026/09/26 09:59', 60], // còn < 1 ngày
  ];
  for (const [due, want] of cases) assert.equal(reminderOf(rawTick([{ due: jst(due) }])), want, due);
});

test('reminder Trello: đã đúng mốc -> không ghi; mọi mốc đã qua / quá hạn -> không đụng tới', () => {
  assert.deepEqual(rawTick([{ due: jst('2026/09/28 10:00'), dueReminder: 2880 }]), []);
  assert.equal(reminderOf(rawTick([{ due: jst('2026/09/25 10:30'), idLabels: [LB.RED] }])), undefined); // còn 30 phút
  assert.equal(reminderOf(rawTick([{ due: jst('2026/09/20 10:00'), idLabels: [LB.RED] }])), undefined); // quá hạn
});

test('reminder Trello: complete / Done / 繰り返し -> không đặt', () => {
  for (const c of [{ dueComplete: true }, { idList: LIST.DONE }, { idList: LIST.RECURRING }]) {
    assert.equal(reminderOf(rawTick([{ due: jst('2026/09/28 10:00'), ...c }])), undefined, JSON.stringify(c));
  }
});

test('reminder Trello: card mới (default due +3 ngày) -> 2 ngày, cùng 1 lệnh PUT', () => {
  const a = one(rawEvent({ name: 'Việc mới' }, { created: true }));
  assert.deepEqual(a.body, { due: jst('2026/09/28 09:00'), dueReminder: 2880 });
  assert.deepEqual(a.rules, ['default-due', 'native-reminder']);
});

// ----------------------------- idempotent -------------------------------
test('idempotent: áp kết quả rồi chạy lại -> không còn action', () => {
  const scenarios = [
    [{ name: 'Việc mới' }, { created: true }],
    [{ name: 'Họp @2026/9/26 9:00' }, { nameChanged: true }],
    [{ due: jst('2026/09/25 12:00'), dueComplete: true, idLabels: [LB.RED] }, { completedNow: true }],
    [{ idList: LIST.RECURRING, due: jst('2026/09/26 09:00'), idLabels: [LB.ORANGE] }, { listBefore: LIST.TODO, listAfter: LIST.RECURRING }],
  ];
  for (const [c, e] of scenarios) {
    const a = one(onEvent(c, e));
    const after = applyBody(c, a.body);
    assert.deepEqual(onEvent(after, { dueChanged: true }), [], JSON.stringify(c));
    assert.deepEqual(onTick([after]), [], 'tick ' + JSON.stringify(c));
    const raw = one(rawEvent(c, e));
    const after2 = { ...applyBody(c, raw.body), dueReminder: raw.body.dueReminder ?? c.dueReminder ?? null };
    assert.deepEqual(rawTick([after2]), [], 'raw tick ' + JSON.stringify(c));
  }
});

test('card canary ở Done: đổi tên -> set due, không label', () => {
  const a = one(onEvent({ idList: LIST.DONE, name: '[n8n canary] @2026/10/25 22:10' }, { nameChanged: true }));
  assert.deepEqual(a.body, { due: jst('2026/10/25 22:10') });
});

// ------------------------------ normalize -------------------------------
test('normalize: phân loại event', () => {
  const act = (type, { card: c = {}, ...rest }) => ({ action: { id: 'a', type, data: { ...rest, card: { id: 'c1', name: 'n', ...c } }, memberCreator: { username: 'u' } } });
  const out = run('normalize.js', [
    act('createCard', { list: { id: LIST.TODO } }),
    act('updateCard', { old: { name: 'old' } }),
    act('updateCard', { old: { dueComplete: false }, card: { dueComplete: true } }),
    act('updateCard', { old: { idList: LIST.TODO }, listBefore: { id: LIST.TODO }, listAfter: { id: LIST.DONE } }),
    act('updateCard', { old: { pos: 1 } }), // bỏ qua
    act('commentCard', {}), // bỏ qua
    act('addLabelToCard', {}), // bỏ qua
  ]).map((o) => o.event);
  assert.equal(out.length, 4);
  assert.equal(out[0].created, true);
  assert.equal(out[1].nameChanged, true);
  assert.equal(out[2].completedNow, true);
  assert.deepEqual([out[3].listBefore, out[3].listAfter], [LIST.TODO, LIST.DONE]);
});
