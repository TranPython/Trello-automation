# Trello Automation (n8n)

Dùng n8n thay cho Butler của Trello (bản Free hết quota chạy tự động).
Rule đầu tiên: khi card được **tạo** hoặc **đổi tiêu đề**, đọc ngày giờ trong
tiêu đề rồi set **due date**.

```
Họp review @2026/8/9 13:30   →   due = 2026-08-09 13:30 JST
```

## Trạng thái triển khai

| Mục | Giá trị |
|---|---|
| n8n workflow | `Trello automation` (`6HoYhAFzL3s1yYNA`), **active** |
| Board | Honeys (`637ef8eeeb1d9a045fdcf98b`) |
| Webhook | `https://n8n.lanchala.org/webhook/d576bd61-1e19-499d-948c-e51694f2b665/webhook` |
| Cloudflare | Access app bypass cho path webhook, chỉ IP Trello `104.192.142.240/28` + `2401:1d80:321c::/48`; **Bot Fight Mode: OFF** (bắt buộc, xem [docs](docs/setup-trello-cloudflare.md)) |
| Báo lỗi | Cả 2 workflow đặt *Error workflow* = `Error Notify` (`BkcgU3Acs08Akk0T`, gửi email) |
| Giám sát | `Trello webhook monitor` (`VO5Hl6x03Om7fzyS`), **active**, chạy mỗi 6 giờ (phút :17): canary E2E, xem mục [Giám sát](#giám-sát-webhook-canary) |
| Kiểm thử E2E (2026-09-25) | Tạo card `@2026/12/1 10:00` → due 10:00 JST ✅ · Đổi tên `@ 2026/12/02 @ 15:45` → due 15:45 JST ✅ · Event do flow tự ghi bị lọc (không loop) ✅ · POST không chữ ký → 401 ✅ |

## Kiến trúc

```
Trello Trigger ─► Normalize event ─► Get card ─► Rules ─► Apply action
 (webhook board)   (lọc event)       (GET API)   (Code)    (Trello API)
```

| Node | Việc |
|---|---|
| **Trello Trigger** | n8n tự đăng ký webhook Trello cho board lúc activate, tự trả lời HEAD verify |
| **Normalize event** | Chỉ giữ `createCard`, `copyCard`, `convertToCardFromCheckItem`, `emailCard`, `moveCardToBoard`, và `updateCard` **có đổi tên**. Các event còn lại (comment, đổi due, label...) bị bỏ, nên thay đổi do chính flow ghi ra không kích hoạt lại flow (không bị loop) |
| **Get card** | Đọc trạng thái hiện tại của card từ API, không tin payload webhook. Rule có đủ dữ liệu (`due`, `idList`, `idLabels`...) |
| **Rules** | Mỗi rule là 1 hàm JS nhận `{ card, event, now }`, trả về list action. Thêm rule = thêm hàm |
| **Apply action** | 1 HTTP node chung chạy mọi action `{ method, path, body }` lên `https://api.trello.com/1/` |

Nhờ vậy, thêm rule mới thường chỉ cần sửa node **Rules** (và thêm event vào **Normalize event** nếu rule cần event khác), không phải nối thêm node.

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

Cấu hình ở đầu node **Rules**:

```js
const TZ = 'Asia/Tokyo';
const DEFAULT_TIME = { hour: 9, minute: 0 };   // khi chỉ có ngày
const CLEAR_DUE_WHEN_TAG_REMOVED = false;      // true: xoá "@ngày" khỏi tiêu đề thì xoá luôn due
```

Nếu due hiện tại đã đúng giá trị parse được thì flow không gọi API.
Tiêu đề không có tag thì due hiện có vẫn được giữ nguyên, nên card set due bằng tay không bị ảnh hưởng.

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
3. Node **Get card** và **Apply action**: chọn cùng credential Trello
4. **Activate** workflow. Lúc này n8n đăng ký webhook với Trello

Kiểm tra webhook đã được đăng ký:

```bash
curl -s "https://api.trello.com/1/tokens/$TRELLO_TOKEN/webhooks?key=$TRELLO_KEY"
```

### 5. Chạy thử
Tạo card `Test @2026/12/1 10:00` → due chuyển thành 2026/12/01 10:00 sau vài giây. Sửa tiêu đề thành `@2026/12/2 11:00` → due đổi theo.

### Nhiều board
Thêm một node **Trello Trigger** cho mỗi board, nối tất cả vào **Normalize event**. Không cần sửa gì thêm.

## Thêm rule mới

Trong node **Rules**:

```js
// Ví dụ: tiêu đề có "!!" -> gắn label khẩn cấp
const URGENT_LABEL_ID = 'xxxxxxxxxxxxxxxxxxxxxxxx';
function urgentLabel({ card }) {
  if (!card.name.includes('!!') || card.idLabels.includes(URGENT_LABEL_ID)) return [];
  return [{ rule: 'urgent-label', method: 'POST', path: `cards/${card.id}/idLabels`, body: { value: URGENT_LABEL_ID } }];
}

const RULES = [dueFromTitle, urgentLabel];
```

Nguyên tắc:
- **Idempotent**: kiểm tra trạng thái hiện tại trước khi trả về action (như `dueFromTitle` so sánh due cũ và mới).
- **Chống loop**: nếu rule phản ứng với event mà chính nó tạo ra (vd: rule "move card" phản ứng với `updateCard` có `old.idList`), phải có điều kiện dừng rõ ràng.
- Rule cần event mới (vd: chuyển list) → thêm điều kiện vào **Normalize event**, và nếu cần thì đưa thêm trường từ `action.data` (vd: `listAfter`) vào output.
- Rule chạy theo lịch (overdue, digest) → tạo workflow riêng với **Schedule Trigger**, tái sử dụng node **Apply action**.

## Test

Test chạy trực tiếp code của 2 Code node trong workflow JSON, mock runtime của n8n và cố định thời gian hiện tại:

```bash
npm install
npm test
```

Sau khi sửa workflow trong n8n UI: *Download* → ghi đè `workflows/trello-automation.json` → `npm test` → commit.

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

Error workflow chỉ chạy với execution **production** (theo lịch hoặc webhook), không chạy khi bấm *Execute workflow* thủ công.

## Bảo mật zone sau khi tắt Bot Fight Mode

Trên bản Free, Bot Fight Mode không skip được theo path, nên đã phải tắt cho cả zone. Bù lại bằng:

1. **Block AI bots**: *Security → Settings → Bot traffic → Block AI bots → Block on all pages*. Tính năng này chạy trên Ruleset Engine, không ảnh hưởng Trello.
2. **Rate limiting rule** (bản Free được 1 rule): *Security → Security rules → Create rule → Rate limiting rules → Edit expression*

   ```
   (http.host ne "n8n.lanchala.org") or (http.host eq "n8n.lanchala.org" and not starts_with(http.request.uri.path, "/webhook/"))
   ```

   Characteristics: IP · 100 requests / 10 seconds · Action: Block · Duration: 10 seconds.
3. Giữ nguyên Managed rules và Access cho các hostname khác.
4. Đừng bật lại Bot Fight Mode, và đừng bật Browser Integrity Check cho path webhook: cả hai đều challenge Trello.

## Vận hành

- **Webhook bị Trello tắt**: nếu callback lỗi liên tục (n8n down, URL đổi), Trello sẽ disable webhook. Deactivate rồi activate lại workflow để n8n đăng ký lại. Nên có 1 workflow Schedule kiểm tra `GET /tokens/{token}/webhooks` và báo khi `active: false`.
- **Execution log**: mỗi action trên board (kể cả comment) đều tạo 1 execution, phần lớn dừng ở Normalize. Nếu DB phình, đặt `EXECUTIONS_DATA_PRUNE=true` / `EXECUTIONS_DATA_MAX_AGE`, hoặc đổi *Workflow settings → Save successful executions* thành *Do not save*.
- **Rate limit Trello**: 100 request / 10 giây mỗi token. Mỗi event hợp lệ tốn 1–2 request, dư sức cho quy mô cá nhân/nhóm nhỏ.
- **Múi giờ**: parse theo `TZ` trong node Rules (Asia/Tokyo), không phụ thuộc timezone của server n8n.

## Gợi ý các rule tiếp theo

Mức ưu tiên dựa trên giá trị thực tế / công sức cho board cá nhân và nhóm nhỏ.

| # | Rule | Trigger | Công sức | Ưu tiên |
|---|---|---|---|---|
| 1 | **Chuyển vào list "Done" → `dueComplete=true`**; kéo ra khỏi Done → `false` | `updateCard` có `listAfter` | Thấp | ⭐⭐⭐ |
| 2 | **Nhắc trước due** (24h / 1h) qua Teams, LINE, email hoặc push | Schedule mỗi 15 phút | Thấp | ⭐⭐⭐ |
| 3 | **Digest buổi sáng**: card due hôm nay/ngày mai/quá hạn | Schedule 08:00 | Thấp | ⭐⭐⭐ |
| 4 | **Đánh dấu quá hạn**: gắn label "Overdue" hoặc chuyển sang list riêng | Schedule | Thấp | ⭐⭐ |
| 5 | **Ngày tương đối** trong tiêu đề: `@tomorrow 10:00`, `@+3d`, `@mon 9:00`, `@金 15:00`, `@明日` | như rule hiện tại | Trung bình | ⭐⭐ |
| 6 | **Khoảng ngày** `@2026/8/1~8/9` → set `start` + `due` | như rule hiện tại | Thấp | ⭐⭐ |
| 7 | **Tag → label / member**: `#urgent`, `[VNK]`, `+thomas` trong tiêu đề → gắn label/member (có thể xoá tag khỏi tiêu đề) | create/đổi tên | Thấp | ⭐⭐ |
| 8 | **Checklist template**: card vào list X hoặc tiêu đề có prefix Y → thêm checklist mẫu | createCard / chuyển list | Thấp | ⭐⭐ |
| 9 | **Card lặp lại**: `@every mon 9:00` → khi hoàn thành thì tạo card kỳ sau (hoặc Schedule tạo sẵn) | `dueComplete` / Schedule | Trung bình | ⭐⭐ |
| 10 | **Tick hoàn thành → tự chuyển sang Done** (ngược với #1, cần chống loop giữa 2 rule) | `updateCard` có `old.dueComplete` | Thấp | ⭐ |
| 11 | **Dọn dẹp**: archive card trong Done quá N ngày | Schedule hằng tuần | Thấp | ⭐ |
| 12 | **Lệnh qua comment**: comment `/due 8/9 13:30`, `/move Doing`, `/assign me` | `commentCard` | Trung bình | ⭐ |
| 13 | **Đồng bộ lịch**: card có due → tạo/cập nhật event Outlook (Microsoft Graph) hoặc Google Calendar | due thay đổi | Cao (xử lý update/delete) | ⭐ |
| 14 | **AI (Dify/LLM)**: sinh checklist từ description, phân loại label, tóm tắt board hằng tuần | createCard / Schedule | Trung bình | ⭐ |
| 15 | ✅ **Giám sát webhook** (đã làm, xem trên): báo khi webhook Trello bị disable | Schedule hằng ngày | Thấp | ⭐⭐ (nên có) |

**Đề xuất làm tiếp:** #1 + #2/#3 + #15. #1 chỉ là thêm 1 hàm vào node Rules. #2/#3 là lý do chính để có due date. #15 giúp phát hiện sớm khi automation ngừng chạy. Nếu board có nhiều người dùng chung thì ưu tiên #7 và #8 hơn #2/#3.
