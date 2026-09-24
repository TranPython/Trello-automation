# Kết nối n8n ↔ Trello khi n8n nằm sau Cloudflare Access

## Tóm tắt

| Chiều | Luồng | Cách xử lý |
|---|---|---|
| n8n → Trello (đọc/ghi card, đăng ký webhook) | outbound tới `api.trello.com` | Credential **Trello API** (API key + token). Không đi qua Cloudflare Access, không cần callback |
| Trello → n8n (webhook) | inbound vào `https://n8n.example.com/webhook/...` | Tạo **Access application riêng cho đúng path webhook**, policy **Bypass** chỉ cho **IP của Trello**. Xác thực thật bằng **chữ ký HMAC** (OAuth Secret) mà n8n kiểm tra |

Không dùng được Service Token hay custom header: Trello không cho cấu hình header cho webhook, chỉ gửi header chữ ký `X-Trello-Webhook`.
**Không cần WAF custom rule.** Chỉ cần kiểm tra **Bot Fight Mode** (xem mục 4).

Về "OAuth ở cả 2 phía": Trello dùng **OAuth 1.0a**, không phải OAuth2. Trên n8n có 2 loại credential là *Trello API* và *Trello OAuth1 API*. Nên dùng **Trello API**, vì OAuth1 cần redirect callback về n8n, phức tạp hơn mà không có lợi gì thêm cho automation cá nhân. Các ô *Allowed origins* trên trang API key của Trello chỉ dùng cho flow authorize bằng redirect, nên bỏ trống cũng được khi tạo token bằng link thủ công ở bước 1.3.

---

## 1. Tạo API key, Secret, Token trên Trello

1. Vào https://trello.com/power-ups/admin → **New**
   - Name: `n8n automation`, chọn Workspace, điền email. *Iframe connector URL* để trống (chỉ cần khi làm Power-Up thật).
2. Mở Power-Up vừa tạo → tab **API key** → **Generate a new API key**. Trang hiển thị:
   - **API key**
   - **Secret** → dùng làm *OAuth Secret* trong n8n để verify chữ ký webhook
3. Tạo **Token**: mở URL dưới trên trình duyệt đã đăng nhập Trello (thay `YOUR_KEY`) → **Allow** → copy token.

   ```
   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=n8n-automation&key=YOUR_KEY
   ```

   - Token có quyền trên **mọi board mà tài khoản đó thấy**. Nếu muốn giới hạn, dùng một tài khoản Trello riêng cho bot và chỉ mời nó vào các board cần automation.
   - Thu hồi token: Trello → *Settings → Applications* → Revoke.

4. Kiểm tra token (chạy từ máy bất kỳ):

   ```bash
   export TRELLO_KEY=xxx TRELLO_TOKEN=yyy
   curl -s "https://api.trello.com/1/members/me?fields=username&key=$TRELLO_KEY&token=$TRELLO_TOKEN"
   ```

## 2. Credential trong n8n

*Credentials → Add credential → **Trello API***

| Field | Giá trị |
|---|---|
| API Key | API key |
| API Token | Token ở bước 1.3 |
| OAuth Secret | **Secret** ở bước 1.2 |

Bấm **Save**. n8n sẽ test bằng `GET /1/tokens/{token}/member`, đây là request outbound nên không liên quan tới Access.

> Có OAuth Secret thì node Trello Trigger tính `HMAC-SHA1(secret, rawBody + callbackURL)` rồi so với header `X-Trello-Webhook`. Nếu sai, node trả **401**. Nếu để trống thì bước verify bị bỏ qua, ai biết URL cũng POST giả được.

## 3. Biến môi trường của n8n

`callbackURL` trong chữ ký là URL webhook mà n8n tự tính. URL này **phải khớp từng ký tự** với URL Trello gọi, nếu không mọi request đều bị 401.

```yaml
# docker-compose.yml (service n8n)
environment:
  - N8N_HOST=n8n.example.com
  - N8N_PROTOCOL=https
  - WEBHOOK_URL=https://n8n.example.com/   # URL public, có dấu / ở cuối
  - N8N_PROXY_HOPS=1                        # đứng sau cloudflared / reverse proxy
```

Xem URL thật: mở node **Trello Trigger** → *Webhook URLs* → tab **Production**. Dạng URL:

```
https://n8n.example.com/webhook/<webhookId>/webhook
```

`webhookId` của workflow trong repo là `50bcc6ba-aff2-44da-bd84-3f45756d7bad`. n8n có thể đổi ID này khi import, nên hãy lấy đúng giá trị hiển thị trên UI.

## 4. Cloudflare

### 4.1 Access application cho path webhook (không cần WAF)

Access khớp application có path **cụ thể nhất** trước. Vì vậy app mới cho path webhook sẽ thắng app đang bảo vệ `n8n.example.com/*`, còn UI n8n vẫn yêu cầu login như cũ.

Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**:

1. **Application name**: `n8n – Trello webhook`
2. **Destinations / Public hostname**: thêm 2 dòng:
   - Domain `n8n.example.com`, Path `webhook/<webhookId>/webhook`
   - Domain `n8n.example.com`, Path `webhook-test/<webhookId>/webhook` (URL cho nút *Listen for test event*; có thể bỏ nếu chỉ chạy production)
3. **Policy** → Create new policy:
   - Action: **Bypass**
   - Include → Selector **IP ranges** → `104.192.142.240/28` (dải IP webhook Trello công bố)
4. Session duration và các thiết lập khác để mặc định → Save.

Kết quả:
- Request tới path này từ IP Trello đi thẳng vào n8n, rồi n8n kiểm tra chữ ký.
- Request từ IP khác tới path này không khớp policy nào, nên bị Access chặn (chuyển tới trang login). Không cần WAF.
- Mọi path còn lại vẫn đi qua Access như cũ.

> **Lưu ý về dải IP**: Atlassian đã đổi dải IP webhook của Trello vài lần, và có báo cáo nhận request từ IP ngoài dải công bố. Nếu Trello đổi IP, webhook sẽ bị Access chặn và Trello sẽ disable webhook sau một thời gian lỗi liên tục. Có 2 cách chọn:
> - **Chặt**: giữ policy IP như trên và làm rule #15 (monitor webhook) để phát hiện sớm.
> - **Thoáng**: đổi Include thành **Everyone**. Chữ ký HMAC cùng `webhookId` (UUID khó đoán) đã đủ chống giả mạo. Trade-off là n8n sẽ nhận request rác tới path đó (bị 401).
>
> Mình khuyên dùng **Chặt**. Chuyển sang Thoáng nếu thấy webhook bị disable do IP.

### 4.2 Bot Fight Mode

Trello không nằm trong danh sách verified bot của Cloudflare. Nếu zone bật **Bot Fight Mode** (bản Free), webhook POST có thể bị challenge, và **không có cách skip** bằng WAF custom rule hay Access Bypass, vì Bot Fight Mode chạy ngoài Ruleset Engine.

Kiểm tra: dashboard zone → **Security → Settings** (dashboard cũ: *Security → Bots*) → *Bot Fight Mode*.

- Đang **Off** → không cần làm gì.
- Đang **On** → sau khi activate workflow, xem **Security → Events (Analytics)**, lọc theo path `/webhook/`. Nếu có event *Bot Fight Mode* chặn request từ `104.192.142.x` thì:
  - tắt Bot Fight Mode, hoặc
  - đưa webhook sang một hostname thuộc zone khác không bật Bot Fight Mode. Khi đó `WEBHOOK_URL` trỏ về hostname mới.

  Plan Pro trở lên có *Super Bot Fight Mode*, loại này skip được bằng custom rule.

### 4.3 Nếu vẫn muốn thêm WAF (không bắt buộc)

Access policy ở 4.1 đã giới hạn theo IP. WAF chỉ cần khi bạn chọn **Thoáng** mà vẫn muốn chặn ở edge. Trên dashboard mới: zone → **Security → Security rules → Create rule → Custom rules**. Đổi sang **Edit expression** rồi dán:

```
(http.host eq "n8n.example.com" and starts_with(http.request.uri.path, "/webhook") and not ip.src in {104.192.142.240/28})
```

Action: **Block**. Dán expression trực tiếp thì không phải dò menu Field/Operator.

## 5. Activate và kiểm tra

1. Activate workflow. Lúc này n8n gọi `POST /1/tokens/{token}/webhooks`, và Trello **gửi ngay một request HEAD** tới callbackURL.
   - Activate lỗi với thông báo kiểu *"URL ... did not return 200"* → request HEAD bị chặn ở Cloudflare. Kiểm tra lại path trong Access app (4.1) và Bot Fight Mode (4.2).
2. Xác nhận webhook đã đăng ký và đang active:

   ```bash
   curl -s "https://api.trello.com/1/tokens/$TRELLO_TOKEN/webhooks?key=$TRELLO_KEY"
   # thấy callbackURL đúng, "active": true
   ```

3. Kiểm tra request từ ngoài bị chặn (chạy từ máy của bạn, không phải IP Trello):

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -X POST "https://n8n.example.com/webhook/<webhookId>/webhook"
   # mong đợi: 302 + URL *.cloudflareaccess.com (hoặc 403), KHÔNG phải 200/401 từ n8n
   ```

4. Tạo card `Test @2026/12/1 10:00` → trong n8n *Executions* có một lần chạy và due được set.

### Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Activate báo lỗi HEAD / không 200 | Access chưa bypass đúng path; Bot Fight Mode; `WEBHOOK_URL` sai host |
| Webhook đăng ký được nhưng không có execution | Xem Security Events và Access logs; IP Trello nằm ngoài dải đã khai báo |
| n8n log 401 Unauthorized cho mọi webhook | `WEBHOOK_URL` khác URL Trello gọi (http/https, thiếu `/`, sai host) nên chữ ký lệch; hoặc OAuth Secret sai |
| `"active": false` trong danh sách webhook | Trello đã disable sau nhiều lần lỗi → sửa nguyên nhân, rồi deactivate/activate lại workflow |
