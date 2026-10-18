# Chi Tiêu Nhà Chung

Web app xem chi tiêu nhà chung trên điện thoại, đọc dữ liệu từ Google Sheet.
Một file HTML tĩnh, không cần build, không cần server, không có database.

## Cấu trúc

```
index.html   toàn bộ app: giao diện, logic đọc sheet, và bản sao dữ liệu dự phòng
```

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

- **Tổng quan** — tổng chi, chi theo ngày, ai đang ứng tiền, bảng chia tiền theo ngày
- **Giao dịch** — lọc theo người mua và theo ngày, tìm theo tên món
- **Thanh toán** — đối chiếu tiền đã ứng với phần phải chia, gợi ý ai chuyển cho ai
- **Thống kê** — tỉ lệ theo người, khoản lớn nhất, đồ còn dư trong bếp
- **Sheet** — chọn tab, thêm tab mới, đổi nguồn dữ liệu

## Thêm tab mới

Google không cho đọc danh sách tab từ bên ngoài. Có hai cách: gõ đúng tên tab
vào ô "Thêm tab mới" (app kiểm tra trước khi thêm), hoặc bấm "Tự dò tab theo
tuần" để app thử các tên dạng `16.10-22.10`. Danh sách tab đã thêm được nhớ
trên máy người dùng qua `localStorage`.

## Khi số liệu lệch

App không tự sửa số trong sheet. Nếu tổng tiền ứng không khớp tổng các cột chia,
tab Thanh toán hiện ô "Chưa chia" màu cam, liệt kê những ngày lệch, và chia phần
thiếu theo tỉ lệ cho những người đã ứng tiền thay vì dồn hết vào một người.
