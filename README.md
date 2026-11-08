# Triển khai máy chủ cấp gói trên Cloudflare (Workers + KV)

Chức năng: khi SePay báo tiền về, Worker tự cấp gói cho đúng thiết bị; app bấm "kiểm tra" là kích hoạt, không cần gửi mã tay.
Gói Free của Cloudflare đủ dùng (100.000 request/ngày).

## Cách A: làm hoàn toàn trên điện thoại/trình duyệt (không cần cài gì)
1. Vào dash.cloudflare.com → đăng ký/đăng nhập → **Workers & Pages** → **Create** → **Create Worker** → đặt tên `vila-license` → **Deploy**.
2. Bấm **Edit code** → xóa code mẫu → dán toàn bộ file `cloudflare/src/index.js` → **Deploy**.
3. Tạo KV: **Storage & Databases** → **KV** → **Create** → tên `LICENSES`.
4. Quay lại Worker → **Settings** → **Bindings** → **Add** → **KV namespace** → Variable name đúng `LICENSES`, chọn KV vừa tạo → Deploy.
5. **Settings** → **Variables and Secrets** → thêm 2 **Secret**: `ADMIN_TOKEN` (chuỗi dài bạn tự đặt) và `SEPAY_API_KEY` (chuỗi dài bạn tự đặt, sẽ dán vào SePay ở bước dưới).
6. Lấy địa chỉ Worker (dạng `https://bitter-sun-751a.nene09821z.workers.dev`), mở thử, thấy `{"ok":true,"service":"vila-license"}` là chạy.

## Cách B: bằng dòng lệnh
```
cd cloudflare
npx wrangler login
npx wrangler kv namespace create LICENSES     # dán id vào wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SEPAY_API_KEY
npx wrangler deploy
```

## Nối SePay (tự xác nhận tiền)
1. Đăng ký sepay.vn, liên kết tài khoản ngân hàng nhận tiền.
2. Mục **Tích hợp WebHooks** → thêm: URL `https://<worker>/webhook/sepay`, kiểu chứng thực **API Key**, dán đúng `SEPAY_API_KEY`, sự kiện: có tiền vào.
3. Nội dung chuyển khoản app tạo ra dạng `VILA A1B2C3D4 GOLDY`. Worker nhận cả khi ngân hàng bỏ dấu cách. Chuyển thiếu tiền thì không cấp gói (xem trong `/api/admin/list`).
(Định dạng webhook SePay mình viết theo hiểu biết của mình, bạn đối chiếu lại với tài liệu SePay lúc cấu hình.)

## Nối vào app
Trong `BillingCatalog.kt` đặt `ManualPay.SERVER_URL = "https://bitter-sun-751a.nene09821z.workers.dev"`, build lại. App sẽ tự hỏi server khi mở màn Nâng cấp và có nút "Tôi đã chuyển khoản — kiểm tra".
**Bảng giá** trong `src/index.js` (PRICES) phải trùng `BillingCatalog.priceVnd`.

## Admin (cấp tay / xem khách)
```
# xem khách + giao dịch thiếu tiền
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<worker>/api/admin/list
# cấp tay
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"device":"A1B2C3D4","tier":"gold","period":"yearly"}' https://<worker>/api/admin/grant
# thu hồi
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"device":"A1B2C3D4"}' https://<worker>/api/admin/revoke
```

## Cách C: tự động deploy bằng GitHub Actions
Đã có `.github/workflows/cloudflare.yml`. Tạo 4 GitHub Secrets (Repo → Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers"), `CLOUDFLARE_ACCOUNT_ID`, `WORKER_ADMIN_TOKEN`, `WORKER_SEPAY_API_KEY`. Mỗi lần push vào `cloudflare/**` hoặc bấm Run workflow, nó tự tạo KV, deploy và đặt secrets. Worker phải tên `bitter-sun-751a` (trong `wrangler.toml`).
