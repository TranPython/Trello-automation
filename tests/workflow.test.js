// Chạy code của các Code node lấy trực tiếp từ workflow JSON, mock runtime của n8n.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DateTime, Settings } from 'luxon';

const wf = JSON.parse(fs.readFileSync(new URL('../workflows/trello-automation.json', import.meta.url)));
const nodeCode = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

function runCode(name, items, refs = {}) {
  const $input = { all: () => items.map((json) => ({ json })) };
  const $ = (node) => ({ itemMatching: (i) => ({ json: refs[node][i] }) });
  return new Function('$input', '$', 'DateTime', nodeCode(name))($input, $, DateTime).map((i) => i.json);
}

// "Hiện tại" cố định: 2026-09-23 10:00 JST
Settings.now = () => Date.parse('2026-09-23T01:00:00Z');

const rules = (name, { due = null, oldName = null } = {}) =>
  runCode('Rules', [{ id: 'c1', name, due }], { 'Normalize event': [{ event: 'updateCard', oldName }] });
const dueOf = (name, opts) => rules(name, opts)[0]?.body.due;

test('parse ví dụ chuẩn, convert JST -> UTC', () => {
  assert.equal(dueOf('tiêu đề @2026/8/9 13:30'), '2026-08-09T04:30:00.000Z');
});

test('các biến thể định dạng', () => {
  const want = '2026-10-09T04:30:00.000Z';
  for (const t of [
    'Họp @ 2026/10/09 @ 13:30',
    'Họp @2026-10-9 13:30',
    'Họp @2026.10.9 13:30',
    'Họp ＠２０２６／１０／９　１３：３０',
    '会議 @2026年10月9日 13時30分',
    'Họp @10/9 13:30',
  ]) assert.equal(dueOf(t), want, t);
});

test('chỉ có ngày -> giờ mặc định 09:00 JST', () => {
  assert.equal(dueOf('Nộp báo cáo @2026/10/1'), '2026-10-01T00:00:00.000Z');
});

test('không ghi năm và ngày đã qua -> năm sau; hôm nay vẫn giữ năm nay', () => {
  assert.equal(dueOf('X @9/1 10:00'), '2027-09-01T01:00:00.000Z');
  assert.equal(dueOf('X @9/23 08:00'), '2026-09-22T23:00:00.000Z');
});

test('nhiều tag -> lấy tag hợp lệ cuối cùng', () => {
  assert.equal(dueOf('dời @2026/10/1 -> @2026/10/5 15:00'), '2026-10-05T06:00:00.000Z');
});

test('không có tag / tag sai / email -> không action', () => {
  for (const t of ['Card thường', 'mail a@b.com', 'X @2026/13/1', 'X @2026/2/30', 'X @2026/10/1 25:00', 'X @2026/10/1 24:00'])
    assert.deepEqual(rules(t), [], t);
});

test('due đã đúng -> bỏ qua (chống loop / call thừa)', () => {
  assert.deepEqual(rules('X @2026/8/9 13:30', { due: '2026-08-09T04:30:00.000Z' }), []);
});

test('xoá tag: mặc định giữ nguyên due', () => {
  assert.deepEqual(rules('X', { due: '2026-08-09T04:30:00.000Z', oldName: 'X @2026/8/9 13:30' }), []);
});

test('action có method/path đúng', () => {
  const [a] = rules('X @2026/8/9 13:30');
  assert.equal(a.method, 'PUT');
  assert.equal(a.path, 'cards/c1');
  assert.equal(a.rule, 'due-from-title');
});

test('Normalize: chỉ nhận tạo card và đổi tên', () => {
  const ev = (type, data) => ({ action: { id: 'a', type, data: { card: { id: 'c1', name: 'n' }, ...data }, memberCreator: { username: 'u' } } });
  const out = runCode('Normalize event', [
    ev('createCard'),
    ev('updateCard', { old: { name: 'old' } }),
    ev('updateCard', { old: { due: null } }), // do chính flow set due -> phải bỏ
    ev('commentCard'),
    { action: { type: 'updateList', data: { list: {} } } },
  ]);
  assert.deepEqual(out.map((o) => [o.event, o.oldName]), [['createCard', null], ['updateCard', 'old']]);
});
