// Build workflows/trello-automation.json từ src/*.js.
// Chạy: npm run build   (sau đó dán/deploy lên n8n, xem README)
import fs from 'node:fs';

const src = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const TRELLO = { trelloApi: { id: 'ZOC2kIWcaWRbHaD9', name: 'Trello Api' } };
const BOARD_ID = '637ef8eeeb1d9a045fdcf98b';
const CARD_FIELDS = 'id,name,idList,due,dueComplete,dueReminder,idLabels,pos,closed,shortUrl';
const code = (name, file, position) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { jsCode: src(file) } });

const nodes = [
  { name: 'Trello Trigger', type: 'n8n-nodes-base.trelloTrigger', typeVersion: 1, position: [0, 0],
    webhookId: 'd576bd61-1e19-499d-948c-e51694f2b665', parameters: { id: BOARD_ID }, credentials: TRELLO },
  code('Normalize event', 'normalize.js', [220, 0]),
  { name: 'Get card', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, 0], credentials: TRELLO,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
    parameters: { url: '=https://api.trello.com/1/cards/{{ $json.event.cardId }}', authentication: 'predefinedCredentialType',
      nodeCredentialType: 'trelloApi', sendQuery: true, specifyQuery: 'keypair',
      queryParameters: { parameters: [{ name: 'fields', value: CARD_FIELDS }] }, options: {} } },
  code('Event context', 'event-context.js', [660, 0]),
  { name: 'Every 15 min', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 240],
    parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
  { name: 'Get board cards', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, 240], credentials: TRELLO,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000,
    parameters: { url: `https://api.trello.com/1/boards/${BOARD_ID}/cards`, authentication: 'predefinedCredentialType',
      nodeCredentialType: 'trelloApi', sendQuery: true, specifyQuery: 'keypair',
      queryParameters: { parameters: [{ name: 'fields', value: CARD_FIELDS }] }, options: {} } },
  code('Tick context', 'tick-context.js', [660, 240]),
  code('Engine', 'engine.js', [900, 120]),
  { name: 'Apply to Trello', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1120, 120], credentials: TRELLO,
    retryOnFail: true, maxTries: 3, waitBetweenTries: 3000,
    parameters: { method: '={{ $json.method }}', url: '=https://api.trello.com/1/{{ $json.path }}',
      authentication: 'predefinedCredentialType', nodeCredentialType: 'trelloApi', sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { batching: { batch: { batchSize: 5, batchInterval: 1000 } } } } },
];
const link = (a, b, idx = 0) => [a, idx, b];
const edges = [
  link('Trello Trigger', 'Normalize event'), link('Normalize event', 'Get card'), link('Get card', 'Event context'),
  link('Event context', 'Engine'), link('Every 15 min', 'Get board cards'), link('Get board cards', 'Tick context'),
  link('Tick context', 'Engine'), link('Engine', 'Apply to Trello'),
];
const connections = {};
for (const [a, idx, b] of edges) {
  const main = ((connections[a] ??= { main: [] }).main);
  while (main.length <= idx) main.push([]);
  main[idx].push({ node: b, type: 'main', index: 0 });
}
const wf = {
  name: 'Trello automation',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'Asia/Tokyo', errorWorkflow: 'BkcgU3Acs08Akk0T' },
  pinData: {},
};
fs.writeFileSync(new URL('../workflows/trello-automation.json', import.meta.url), JSON.stringify(wf, null, 2) + '\n');
console.log('built workflows/trello-automation.json');
