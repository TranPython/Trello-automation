// Normalize event: chuyển webhook Trello thành event gọn cho Engine.
// Chỉ giữ event có thể làm thay đổi kết quả của rule. Event do chính flow ghi ra
// (đổi due/label/list/pos) vẫn đi qua, nhưng Engine là idempotent nên sẽ không làm gì thêm.
const CREATE_EVENTS = ['createCard', 'copyCard', 'convertToCardFromCheckItem', 'emailCard', 'moveCardToBoard'];
const WATCHED_FIELDS = ['name', 'due', 'dueComplete', 'idList'];

const out = [];
for (const item of $input.all()) {
  const action = item.json.action;
  const data = action?.data ?? {};
  if (!data.card?.id) continue;

  const created = CREATE_EVENTS.includes(action.type);
  const old = data.old ?? {};
  const changed = action.type === 'updateCard' ? WATCHED_FIELDS.filter((f) => f in old) : [];
  if (!created && changed.length === 0) continue;

  out.push({
    json: {
      event: {
        type: action.type,
        actionId: action.id,
        cardId: data.card.id,
        by: action.memberCreator?.username ?? null,
        created,
        nameChanged: changed.includes('name'),
        oldName: changed.includes('name') ? old.name : null,
        dueChanged: changed.includes('due'),
        completedNow: changed.includes('dueComplete') && old.dueComplete === false && data.card.dueComplete === true,
        uncompletedNow: changed.includes('dueComplete') && old.dueComplete === true && data.card.dueComplete === false,
        listBefore: changed.includes('idList') ? (data.listBefore?.id ?? old.idList ?? null) : null,
        listAfter: changed.includes('idList') ? (data.listAfter?.id ?? data.card.idList ?? null) : null,
      },
    },
  });
}
return out;
