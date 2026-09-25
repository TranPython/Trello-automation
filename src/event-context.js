// Event context: ghép event (từ Normalize) với trạng thái card mới nhất (từ Get card).
return $input.all().map((item, i) => ({
  json: {
    mode: 'event',
    now: new Date().toISOString(),
    event: $('Normalize event').itemMatching(i).json.event,
    card: item.json,
  },
}));
