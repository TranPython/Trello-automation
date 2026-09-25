// Tick context: mỗi 15 phút, đưa toàn bộ card đang mở của board vào Engine.
// Lấy thời điểm từ Schedule Trigger để kết quả tất định (dễ test bằng pin data).
const ts = $('Every 15 min').first().json.timestamp;
const now = ts ? new Date(ts).toISOString() : new Date().toISOString();
return $input.all().map((item) => ({ json: { mode: 'tick', now, event: null, card: item.json } }));
