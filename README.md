# Chi Tiêu Nhà Chung

Web app xem chi tiêu nhà chung trên điện thoại. Phần số liệu đọc từ Google Sheet
(chỉ đọc, không bao giờ ghi vào sheet). Tab **Note** lưu riêng vào MongoDB.

## Cấu trúc

```
index.html     toàn bộ giao diện, logic đọc sheet, và bản sao dữ liệu dự phòng
api/index.js   API cho tab Note, chạy như một serverless function trên Vercel
vercel.json    chuyển mọi đường dẫn /api/* về api/index.js
package.json   khai thư viện mongodb cho API
```

## Nối MongoDB (làm một lần)

1. Vercel → project **apartment-expenses** → tab **Storage**.
2. **Create Database** → **MongoDB Atlas**, gói miễn phí là đủ.
3. Nối database vào project này. Vercel tự thêm biến `MONGODB_URI`.
   Nếu biến có tiền tố (ví dụ `STORAGE_MONGODB_URI`) API vẫn tự tìm ra.
4. **Deployments** → **Redeploy** bản mới nhất để biến có hiệu lực.

Dữ liệu nằm trong database `apartment_expenses` (đổi bằng biến `MONGODB_DB`),
gồm hai collection `members` và `items`. Chưa nối database thì tab Note hiện
hướng dẫn này, các tab đọc sheet vẫn chạy bình thường.

### Khoá bằng mã (nên làm)

Link Vercel ai có cũng mở được, nên ai có link cũng ghi được vào database.
Đặt thêm biến `APP_TOKEN` trên Vercel (một chuỗi tuỳ ý) rồi redeploy: mọi lệnh
gọi API phải kèm mã này. Mỗi máy nhập mã một lần, app tự nhớ.

## API

| Đường dẫn | Việc |
| --- | --- |
| `GET /api/health` | kiểm tra kết nối database, có cần mã không |
| `GET /api/members` | danh sách người |
| `PUT /api/members/:id` | thêm hoặc sửa một người `{ name, order }` |
| `DELETE /api/members/:id` | xoá người; bị chặn nếu người đó còn trong note |
| `GET /api/items` | danh sách note, mới nhất trước |
| `PUT /api/items/:id` | thêm hoặc sửa `{ title, date: "YYYY-MM-DD", participants: [id], amount?, payer?, note? }` |
| `DELETE /api/items/:id` | xoá note |

Mã do app tự tạo (`it_…`, `m_…`), nên PUT gửi lại nhiều lần cũng không sinh bản ghi trùng.

## Hai nguồn dữ liệu

App gọi Google Sheet trước. Gọi được thì dùng số trực tiếp; bị chặn thì tự rơi
về bản sao nhúng sẵn trong `index.html`. Nhãn ở góc trên cho biết đang chạy nguồn
nào: **Trực tiếp** (kèm giờ đọc) hay **Bản sao**.

Trong tab Sheet có thể ép một trong ba chế độ: Tự động, Chỉ Google Sheet,
Chỉ bản sao.

Khi chạy trên Vercel, app luôn đọc trực tiếp — bản sao chỉ là lưới an toàn khi
mất mạng hoặc môi trường chặn tên miền `docs.google.com`.

## Đổi sang sheet khác

Mở `index.html`, sửa hằng số ở đầu khối `<script>` thứ hai:

```js
var SHEET_ID = "...";   // ID trong URL Google Sheet
```

Sheet phải ở chế độ **ai có link cũng xem được**, vì app đọc ẩn danh qua
endpoint `gviz/tq`, không dùng API key.

## App đọc được hai kiểu bảng

**Bảng mua hàng theo tuần** — nhận ra nhờ ô ghi "Người mua". Đọc các cột
Người mua, Mô tả, SL, Số tiền, Dư lại, Ngày. Khối chia tiền bên phải nhận ra nhờ
ô "Ngày", lấy mọi cột từ đó tới "Tổng cộng" làm cột của từng người, và cột
"CK mỗi người" làm ghi chú chuyển khoản.

**Bảng chi phí nhà** — nhận ra nhờ ô "Danh mục". Đọc danh mục theo hàng,
người theo cột, gom nhóm theo phòng ở hàng tiêu đề phía trên.

Vị trí cột không cố định cứng, nên tab mới làm theo cùng mẫu sẽ chạy ngay,
kể cả khi số người hoặc thứ tự cột khác đi.

## Các tab

Thanh menu dưới cùng:

- **Tổng quan** — tổng chi, chi theo ngày, ai đang ứng tiền, bảng chia tiền theo ngày
- **Giao dịch** — lọc theo người mua và theo ngày, tìm theo tên món
- **Thanh toán** — chọn **Cả nhà** để xem ai chuyển cho ai, hoặc chọn một người để
  xem người đó chuyển cho ai, phần phải trả từng ngày gồm những món nào, và đã ứng
  những gì. Ở tab Nhà, chọn một người sẽ ra các khoản tiền nhà người đó phải đóng.
  Lựa chọn được nhớ trên máy. Chế độ **Lịch** hiện lưới người × ngày: ô có màu là
  người đó có phần chia hôm đó; bấm một ngày để xem ai tham gia, các món đã mua và
  dòng CK. Đầu tab có thẻ **Kiểm tra sheet** báo sheet chia đủ hay lệch, lệch ở đâu.
- **Thống kê** — tỉ lệ theo người, khoản lớn nhất, đồ còn dư trong bếp
- **Note** — ghi chú chi tiêu (ví dụ "Ăn trưa 18/10"), chọn người tham gia, tuỳ chọn
  số tiền và người trả; lọc theo người để xem phần mình. Mỗi note một thẻ, ghi số
  người tham gia. Chế độ **Lịch** theo tháng hiện số note và số người mỗi ngày. Lưu vào MongoDB.

Màu của từng người lấy theo màu nền tên trong sheet (bảng tổng hợp cuối tab tuần),
ghép theo tên kể cả viết tắt ("Chị VAnh" = "Chị Vân Anh"). Google không trả màu khi
đọc trực tiếp, nên màu được lấy từ file sheet lúc đóng gói app.

**Nâng cao** (nút ở đầu trang, hoặc bấm vào tên tab sheet): chọn tab sheet đang xem,
thêm tab mới, đổi nguồn dữ liệu. Chọn xong app quay lại đúng màn hình đang xem.

## Thêm tab mới

Google không cho đọc danh sách tab từ bên ngoài. Trong trang Nâng cao có hai cách: gõ đúng tên tab
vào ô "Thêm tab mới" (app kiểm tra trước khi thêm), hoặc bấm "Tự dò tab theo
tuần" để app thử các tên dạng `16.10-22.10`. Danh sách tab đã thêm được nhớ
trên máy người dùng qua `localStorage`.

## Khi số liệu lệch

App không tự sửa số trong sheet. Nếu tổng tiền ứng không khớp tổng các cột chia,
tab Thanh toán hiện ô "Chưa chia" màu cam, liệt kê những ngày lệch, và chia phần
thiếu theo tỉ lệ cho những người đã ứng tiền thay vì dồn hết vào một người.
