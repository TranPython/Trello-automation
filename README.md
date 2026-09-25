# Trello Automation (n8n)

Dùng n8n thay cho Butler của Trello (bản Free hết quota chạy tự động) cho board **Honeys**.
Một workflow duy nhất chạy toàn bộ bộ rule: set due từ tiêu đề, due mặc định, label theo hạn,
Done/complete, 繰り返し, sort hằng ngày và reminder gốc của Trello (2 ngày / 1 ngày / 1 giờ).

```
Họp review @2026/8/9 13:30   →   due = 2026-08-09 13:30 JST
```

## Trạng thái triển khai

| Mục | Giá trị |
|---|---|
| n8n workflow | `Trello automation` (`6HoYhAFzL3s1yYNA`), **active**: webhook Trello + lịch mỗi 15 phút |
| Board | Honeys (`637ef8eeeb1d9a045fdcf98b`) |
| Webhook | `https://n8n.lanchala.org/webhook/d576bd61-1e19-499d-948c-e51694f2b665/webhook` |
| Cloudflare | Access app bypass cho path webhook, chỉ IP Trello `104.192.142.240/28` + `2401:1d80:321c::/48`; **Bot Fight Mode: OFF** (bắt buộc, xem [docs](docs/setup-trello-cloudflare.md)) |
| Nhắc hạn | Reminder gốc của Trello (`dueReminder`), thông báo qua Trello app. Không dùng dịch vụ ngoài |
| Báo lỗi | Cả 2 workflow đặt *Error workflow* = `Error Notify` (`BkcgU3Acs08Akk0T`, gửi email) |
| Giám sát | `Trello webhook monitor` (`VO5Hl6x03Om7fzyS`), **active**, chạy mỗi 6 giờ (phút :17): canary E2E, xem mục [Giám sát](#giám-sát-webhook-canary) |

## Bộ rule

Tổng hợp từ rule Butler cũ và rule "@ngày" trong tiêu đề, chỉnh lại để không xung đột với cách board đang được dùng.

**Nhóm list** (cấu hình ở đầu node `Engine` / [`src/engine.js`](src/engine.js)):

| Nhóm | List | Ý nghĩa |
|---|---|---|
| `TASK_LISTS` | To-do, Toyo, VNK | List công việc: due mặc định, complete → Done, sort hằng ngày |
| `PASSIVE_LISTS` | Done, 繰り返し | Không gắn label hạn, không đặt reminder |
| còn lại | JP new words, AI資格ロードマップ, Learn | Có label hạn + reminder, **không** bị di chuyển hay sort |

**Rule theo event** (chạy khi có webhook, theo thứ tự ưu tiên):

| # | Rule | Khi nào | Làm gì |
|---|---|---|---|
| 1 | `recurring-reset` | Card vào (hoặc được tạo trong) **繰り返し** | Xoá due + xoá **tất cả** label |
| 2 | `due-from-title` | Tạo card / đổi tên, có `@ngày giờ` (trừ 繰り返し) | Set due theo tiêu đề |
| 3 | `default-due` | Tạo card trong list công việc, chưa có due | Due = **+3 ngày 09:00** |
| 4 | `complete-to-done` | Đánh dấu complete trong list công việc | Chuyển lên **đầu Done** |
| 5 | `done-marks-complete` | Card vào (hoặc được tạo trong) **Done** | Mark complete |
| 6 | `reopen-on-leave-done` *(mới)* | Kéo card ra khỏi Done | Bỏ complete |
| 7 | `urgency-labels` | **Mọi** event + mỗi 15 phút | Label theo số ngày lịch còn lại (bên dưới) |
| 8 | `native-reminder` | **Mọi** event + mỗi 15 phút | `dueReminder` của Trello = mốc gần nhất chưa qua: **2 ngày → 1 ngày → 1 giờ** |

**Label hạn** (`urgency-labels`, tính theo ngày lịch JST, automation quản lý hoàn toàn 3 màu này):

| Còn lại | Label |
|---|---|
| ≥ 3 ngày / không có due / complete / ở Done, 繰り返し | không có |
| 2 ngày | 🟩 green |
| 1 ngày | 🟧 orange |
| hôm nay hoặc quá hạn | 🟥 red |

**Rule theo lịch** (trigger `Every 15 min`):

| Rule | Khi nào | Làm gì |
|---|---|---|
| `daily-sort` | Tick 00:00–00:14 | Sort To-do / Toyo / VNK: due tăng dần → không due → đã complete. Card hôm nay/quá hạn tự lên đầu |

### Xử lý xung đột so với rule gốc

| Rule gốc | Vấn đề | Cách xử lý |
|---|---|---|
| "when a due date is set → remove red/orange/green" | Gỡ hết label rồi chờ tới đêm mới gắn lại → sai trạng thái trong ngày | Thay bằng tính lại label **ngay** theo due mới (rule 7) |
| 3 rule "2 ngày / 1 ngày / hôm nay" chạy theo lịch | Trùng việc với rule trên, dễ lệch nhau | Gộp thành 1 hàm trạng thái `urgency-labels`, dùng chung cho event và lịch |
| "on the day due → move to top of the list" | Với To-do/Toyo/VNK thì sort đã làm việc này; với AI roadmap/Learn thì phá thứ tự roadmap | Chỉ thực hiện qua `daily-sort` (card hôm nay/quá hạn luôn đứng đầu); không di chuyển list khác |
| "marked complete → move to Done" | List Learn có 12/14 card complete mà bạn cố ý giữ lại | Chỉ áp dụng cho To-do/Toyo/VNK |
| "complete → Done" + "added to Done → complete" | Hai rule kích hoạt lẫn nhau | Engine idempotent: event do flow tự ghi ra không tạo thay đổi mới |
| "繰り返し → remove due" + rule "@ngày" | Đổi tên card 繰り返し có `@ngày` sẽ set lại due | `due-from-title` bỏ qua 繰り返し |
| "default due in 3 days" | Card mới trong JP new words / Learn / 繰り返し không cần due; card copy đã có due | Chỉ áp dụng khi **tạo** card trong To-do/Toyo/VNK và **chưa có** due; tag `@ngày` được ưu tiên |
| "set reminder 2d/1d/1h" | Trello chỉ cho **1** reminder (`dueReminder`) mỗi card | Engine **xoay vòng**: đặt 2880 phút; khi mốc qua, tick kế tiếp (≤ 15 phút) đổi sang 1440, rồi 60. Card đã quá hạn hoặc còn < 1 giờ thì giữ nguyên, không đặt lại để tránh Trello bắn notification cho card cũ |

## Kiến trúc

```
Trello Trigger → Normalize event → Get card → Event context ─┐
                                                             ├→ Engine → Apply to Trello (PUT, 5 req/s)
Every 15 min  → Get board cards → Tick context ──────────────┘
```

- **Engine** là một Code node chứa CONFIG + 2 loại rule:
  - `CARD_RULES`: mỗi rule `{ id, when(ctx, state), apply(ctx, state) }`, sửa *trạng thái mong muốn* của card.
  - `BOARD_RULES`: chạy trên toàn board (ví dụ sort).
- Rule **không gọi API**. Engine so trạng thái mong muốn với card thật và sinh **1 lệnh PUT** cho phần khác biệt. Nhờ vậy các rule không ghi đè nhau, chạy lại bao nhiêu lần kết quả vẫn như nhau, và event do flow tự ghi ra không gây loop.
- Mã nguồn nằm trong [`src/`](src/); `npm run build` sinh [`workflows/trello-automation.json`](workflows/trello-automation.json).

## Định dạng tiêu đề được hỗ trợ

| Tiêu đề | Kết quả (JST) |
|---|---|
| `Việc A @2026/8/9 13:30` | 2026/08/09 13:30 |
| `Việc A @ 2026/08/09 @ 13:30` | 2026/08/09 13:30 |
| `Việc A @2026-8-9 13:30`, `@2026.8.9 13:30` | 2026/08/09 13:30 |
| `会議 @2026年8月9日 13時30分` | 2026/08/09 13:30 |
| `Việc A ＠２０２６／８／９　１３：３０` (full-width) | 2026/08/09 13:30 |
| `Việc A @2026/8/9` (không có giờ) | 2026/08/09 **09:00** |
| `Việc A @8/9 13:30` (không có năm) | năm nay; nếu ngày đã qua thì **năm sau** |
| `dời @2026/8/1 -> @2026/8/5 15:00` | lấy tag hợp lệ **cuối cùng**: 2026/08/05 15:00 |
| `@2026/2/30`, `@2026/8/9 25:00`, `a@b.com` | bỏ qua, không đổi due |

Tag chỉ được đọc khi **tạo** hoặc **đổi tên** card, nên due chỉnh tay sau đó không bị ghi đè.

## Cài đặt

> Hướng dẫn chi tiết tạo credential và cấu hình Cloudflare Access/Tunnel để Trello gọi được webhook:
> **[docs/setup-trello-cloudflare.md](docs/setup-trello-cloudflare.md)**

### 1. Yêu cầu
- n8n có **URL HTTPS mà Trello gọi tới được**, và `WEBHOOK_URL` là URL public đó. Nếu n8n đứng sau Cloudflare Access, bypass đúng path webhook cho IP Trello (xem doc trên).
- Trello API key, Secret, Token.

### 2. Tạo credential trong n8n
*Credentials → New → **Trello API*** (không dùng OAuth1/OAuth2, lý do xem doc bên dưới)

| Field | Giá trị |
|---|---|
| API Key | API key |
| API Token | token |
| OAuth Secret | **Secret** trên trang API key. Nên điền: có Secret thì Trello Trigger sẽ kiểm tra chữ ký `X-Trello-Webhook` và trả 401 cho request giả mạo |

### 3. Lấy Board ID (24 ký tự, không phải shortLink trên URL)

```bash
export TRELLO_KEY=xxx TRELLO_TOKEN=yyy
# shortLink là phần sau /b/ trên URL board, vd: https://trello.com/b/AbCd1234/...
curl -s "https://api.trello.com/1/boards/AbCd1234?fields=id,name&key=$TRELLO_KEY&token=$TRELLO_TOKEN"
```

### 4. Import workflow
1. n8n → *Workflows → Import from File* → chọn [`workflows/trello-automation.json`](workflows/trello-automation.json)
2. Node **Trello Trigger**: điền Board ID vào `Model ID`, chọn credential
3. Các node **Get card**, **Get board cards**, **Apply to Trello**: chọn cùng credential Trello
4. **Activate** workflow. Lúc này n8n đăng ký webhook với Trello

Kiểm tra webhook đã được đăng ký:

```bash
curl -s "https://api.trello.com/1/tokens/$TRELLO_TOKEN/webhooks?key=$TRELLO_KEY"
```

### 5. Chạy thử
Tạo card `Test @2026/12/1 10:00` → due chuyển thành 2026/12/01 10:00 sau vài giây. Sửa tiêu đề thành `@2026/12/2 11:00` → due đổi theo.

### Nhiều board
Thêm một node **Trello Trigger** cho mỗi board, nối vào **Normalize event**. Sau đó thêm list/label ID của board mới vào CONFIG.

## Thay đổi / thêm rule

1. Sửa [`src/engine.js`](src/engine.js). Ví dụ, muốn card có `!!` trong tiêu đề được gắn label vàng:

   ```js
   // thêm vào CARD_RULES, trước 'urgency-labels'
   {
     id: 'bang-bang-yellow',
     when: (ctx) => !!ctx.event && (ctx.event.created || ctx.event.nameChanged),
     apply: (ctx, s) => { if (ctx.card.name.includes('!!')) s.labels.add('637ef8f0e86863027e7b9acb'); },
   },
   ```

   - Đổi phạm vi list: sửa `TASK_LISTS`, `SORTED_LISTS`, `PASSIVE_LISTS`.
   - Đổi mốc nhắc: sửa `CFG.REMINDER_MINUTES` (giá trị Trello chấp nhận: 5, 10, 15, 60, 120, 1440, 2880). Đổi due mặc định: sửa `CFG.DEFAULT_DUE`.
   - Rule cần event mới (ví dụ đổi member): thêm field vào `WATCHED_FIELDS` trong [`src/normalize.js`](src/normalize.js).
2. Viết test trong [`tests/engine.test.js`](tests/engine.test.js), rồi chạy `npm test`.
3. Chạy `npm run build`, rồi dán code vào node tương ứng trên n8n (hoặc nhờ Claude deploy qua n8n MCP). Nhớ **Publish**.
4. Sau khi publish, chờ khoảng 1 phút để Trello đăng ký lại webhook.

Nguyên tắc để không phá vỡ tính idempotent:
- `apply` chỉ sửa `state` (`due`, `dueComplete`, `idList`, `pos`, `labels`), không gọi API.
- Rule chỉ nên chạy một lần tại thời điểm xảy ra chuyện (ví dụ "khi tạo card") thì phải kiểm tra `ctx.event.*` trong `when`. Rule dạng trạng thái (ví dụ label) thì cho chạy luôn.

## Test

```bash
npm install
npm test        # 27 test: từng rule, xung đột, chống loop, idempotent, sort, reminder
npm run build   # src/*.js -> workflows/trello-automation.json
```

## Giám sát webhook (canary)

Chỉ kiểm tra HEAD tới webhook là không đủ. Lỗi hay gặp nhất (Cloudflare chặn Trello, Trello disable webhook, n8n báo active nhưng Trigger không đăng ký được) chỉ phát hiện được bằng cách kiểm tra **end-to-end**.

Workflow `Trello webhook monitor`:

```
Schedule (6h) → Build canary → PUT tên card canary "… @<+30 ngày, giờ hiện tại>" → Wait 60s → GET card → Check due
```

- Card canary: `[n8n canary] webhook monitor – đừng xoá/archive` ở list **Passed Task** (board Honeys, id `6ab672a12485df8dbec08e6e`). **Đừng xoá hoặc archive card này.**
- Nếu due không khớp, hoặc card đã bị archive, node `Check due` throw lỗi. Workflow lỗi thì `Error Notify` gửi email kèm hướng xử lý.
- Lỗi runtime của `Trello automation` (ví dụ Trello API trả 4xx/5xx) cũng gửi email qua `Error Notify`.
- Đã test 2026-09-25: nhánh thành công ✅; tạm tắt workflow chính → monitor lỗi → Error Notify gửi email ✅.

Sau khi publish lại `Trello automation`, Trello cần vài giây để tạo lại webhook. Event xảy ra trong khoảng đó sẽ bị mất: lần test ngày 2026-09-25, chạy canary ngay sau khi publish thì báo lỗi, chạy lại 1 phút sau thì đạt. Vì vậy sau mỗi lần publish, hãy chờ khoảng 1 phút rồi mới kiểm tra.

Error workflow chỉ chạy với execution **production** (theo lịch hoặc webhook), không chạy khi bấm *Execute workflow* thủ công.

## Bảo mật zone sau khi tắt Bot Fight Mode

Trên bản Free, Bot Fight Mode không cho tạo ngoại lệ theo path, nên đã phải tắt cho cả zone. Các lớp bảo vệ còn lại:

1. **AI bot policy**: *Security → Settings → Bot traffic → Configure AI bot policies → Block on all pages*. Không ảnh hưởng Trello. AI Labyrinth giữ nguyên.
2. **Access** đứng trước các hostname. Path webhook chỉ cho IP Trello (`104.192.142.240/28`, `2401:1d80:321c::/48`), và n8n kiểm tra chữ ký HMAC.
3. **Cloudflare Managed Ruleset** giữ bật.
4. **Không dùng rate limiting rule**: bản Free chỉ match được theo URI path, không theo hostname, nên rule sẽ áp cho mọi hostname (immich, windmill…) và dễ block chính người dùng. Các hostname đó đã có Access nên lợi ích thấp. Chỉ nên thêm khi có hostname public không có Access, và khi đó giới hạn đúng path đăng nhập, ví dụ `(http.request.uri.path wildcard r"/api/auth/*")`.
5. Đừng bật lại Bot Fight Mode, và đừng bật Browser Integrity Check cho `/webhook/`: cả hai đều challenge Trello.

## Vận hành

- **Webhook bị Trello tắt**: nếu callback lỗi liên tục (n8n down, URL đổi), Trello sẽ disable webhook. Deactivate rồi activate lại workflow để n8n đăng ký lại. Nên có 1 workflow Schedule kiểm tra `GET /tokens/{token}/webhooks` và báo khi `active: false`.
- **Execution log**: mỗi action trên board (kể cả comment) đều tạo 1 execution, phần lớn dừng ở Normalize. Nếu DB phình, đặt `EXECUTIONS_DATA_PRUNE=true` / `EXECUTIONS_DATA_MAX_AGE`, hoặc đổi *Workflow settings → Save successful executions* thành *Do not save*.
- **Rate limit Trello**: 100 request / 10 giây mỗi token. Mỗi event hợp lệ tốn 1–2 request, dư sức cho quy mô cá nhân/nhóm nhỏ.
- **Múi giờ**: parse theo `TZ` trong node Rules (Asia/Tokyo), không phụ thuộc timezone của server n8n.

### Reminder của Trello đã kiểm chứng thực tế (2026-09-25)

- Card **không có member, không watch** vẫn nhận `cardDueSoon`: bạn nhận reminder của mọi card trên board, nên không cần gán member.
- Đổi `dueReminder` sau khi mốc cũ đã qua: Trello **lên lịch lại** theo giá trị mới và **không bắn bù** mốc đã qua. Vì vậy xoay vòng 2 ngày → 1 ngày → 1 giờ hoạt động đúng.
- Thông báo đi qua Trello (app/web; email theo cài đặt notification của chính Trello). Muốn giảm email, vào *Trello → Settings → Email notifications → Never*, vẫn còn push trên app.

## Gợi ý tiếp theo

**Đã làm** (xem [Bộ rule](#bộ-rule)): Done ↔ complete, nhắc hạn, label quá hạn, giám sát webhook, sort.

| # | Gợi ý | Lý do | Công sức |
|---|---|---|---|
| 1 | **Đặt tên cho 3 label** trong Trello: 🟩 `2 ngày`, 🟧 `Ngày mai`, 🟥 `Hôm nay/Quá hạn` | Nhìn là hiểu ngay; engine dùng ID nên đổi tên không ảnh hưởng | 1 phút, làm tay |
| 3 | **Backfill 1 lần**: card có `@ngày` trong tiêu đề nhưng due trống hoặc lệch (ví dụ "piano giáng sinh @ 2026/12/12") | Card tạo trước khi có automation | Thấp |
| 4 | **Dọn Done**: 34 card chưa complete (dữ liệu cũ) | Rule chỉ chạy khi card được *thêm vào* Done | Thấp, 1 lần |
| 5 | **Sort ngay khi due đổi** (không chờ 00:00) | Card mới có due gần sẽ nằm cuối list tới đêm | Trung bình |
| 6 | **Card lặp lại** từ 繰り返し: `@every mon 9:00` → mỗi kỳ copy sang To-do với due tương ứng | 繰り返し hiện chỉ là list mẫu | Trung bình |
| 8 | **Ngày tương đối**: `@tomorrow 10:00`, `@+3d`, `@金 15:00`, `@明日` | Gõ nhanh trên điện thoại | Trung bình: mở rộng `parseTitleDue` |
| 9 | **Archive Done cũ** > 90 ngày | Done đang có 349 card | Thấp: thêm `BOARD_RULES` |
