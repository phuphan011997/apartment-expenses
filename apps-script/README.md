# Apps Script: cho app ghi vào Google Sheet

Khi bấm **Đồng bộ** trên một note, máy chủ Vercel gửi các món của note tới script này.
Script ghi chúng vào khối **Người mua · Mô tả · SL · Số tiền · Dư lại · Ngày** của tab tuần.
Script chỉ ghi vào 6 cột đó. Người dùng app không cần đăng nhập Google.

## Cài đặt (làm một lần, cần quyền chỉnh sửa sheet)

1. Mở Google Sheet, chọn **Tiện ích mở rộng → Apps Script**.
2. Xoá hết code mẫu, dán toàn bộ nội dung `Code.gs` vào.
3. Sửa dòng `var SECRET = 'DOI-THANH-MA-BI-MAT';` thành một chuỗi bí mật của bạn, rồi lưu lại.
4. Bấm **Triển khai → Tùy chọn triển khai mới**:
   - Loại: **Ứng dụng web**
   - Thực thi dưới dạng: **Tôi**
   - Người có quyền truy cập: **Bất kỳ ai**
5. Bấm **Triển khai**, cấp quyền khi Google hỏi, rồi sao chép **URL ứng dụng web** (kết thúc bằng `/exec`).
6. Trên Vercel → project **apartment-expenses** → **Settings → Environment Variables**, thêm:
   - `SHEET_SCRIPT_URL` = URL vừa sao chép
   - `SHEET_SCRIPT_SECRET` = chuỗi bí mật ở bước 3
7. **Deployments → Redeploy** bản mới nhất.

Sửa `Code.gs` về sau: **Triển khai → Quản lý các lần triển khai → sửa (bút chì) →
Phiên bản: Phiên bản mới → Triển khai**. Làm vậy thì URL được giữ nguyên.

## Script ghi thế nào

- Tìm hàng tiêu đề "Người mua", rồi chèn các món **theo thứ tự ngày**: ngay sau dòng cuối
  cùng có ngày nhỏ hơn hoặc bằng ngày của note. Note ngày mới nhất thì ghi tiếp xuống cuối.
  Khi chèn giữa bảng, chỉ các ô của khối mua hàng (Người mua … cột H) bị đẩy xuống; bảng
  chia tiền bên phải đứng yên, Google tự sửa các công thức trỏ tới ô bị dời. Máy chủ cũng
  sửa số dòng đã lưu của các note khác để lần đồng bộ sau vẫn đúng chỗ.
- Tên người mua được đổi theo danh sách chọn của cột Người mua trong sheet. Ví dụ "Tân" thành "Anh Tân".
- Số tiền dạng `6*4000` được ghi thành công thức `=6*4000`.
- Ngày lấy theo ngày của note.
- **Đồng bộ lại** sau khi sửa note: script ghi đè đúng các dòng đã ghi lần trước. Thêm món thì
  chèn ngay sau dòng cuối của note; bớt món thì xoá hẳn dòng thừa (dòng bên dưới dời lên).
- Nếu các dòng đó đã bị sửa tay trên sheet, script dừng lại và app hỏi bạn có muốn ghi thành dòng mới không.
- **Bảng chia tiền:** mỗi note thêm một dòng vào bảng chia bên phải, xếp theo ngày.
  - Ngày: ngày của note.
  - Tổng cộng: công thức cộng các ô Số tiền vừa ghi, ví dụ `=E42+E43/2`. Món chọn
    "Tính vào chia" ½ thì thành `E43/2`; "Không tính" thì bỏ ra.
  - Phần từng người: `=$N18/4` theo số người tham gia. Cột ghép như "A.Phú + C.Vân" có
    cả hai người thì `=$N18/4*2`, một người thì `/4`, không ai thì `0`.
  - Người mua (nếu bảng có cột này): tên người mua các món.
  - Dòng mới chỉ đẩy các ô của bảng chia xuống, không đụng khối mua hàng. Nếu chèn
    ngay trên dòng tổng `=SUM(J4:J17)`, vùng SUM được kéo thêm dòng mới.
  - Đồng bộ lại: tìm đúng dòng cũ theo công thức Tổng cộng và ghi đè.
  - Người tham gia không có cột trong bảng chia thì script dừng, không ghi gì.

## Ghi chú ở ô Tổng cộng

Ô **Tổng cộng** của dòng chia tiền có ghi chú (note): tên note, ngày, danh sách người, số món.
Ô Số tiền của từng món không còn ghi chú (bản trước có ghi; đồng bộ lại sẽ xoá).

## Cột Chia (cột I, bạn tự chèn)

Chèn một cột mới ngay sau cột H (Insert column → cột I mới, bảng chia tiền dời sang phải). Từ lần
đồng bộ sau, script ghi vào cột đó số người và một chấm tròn cho mỗi người, ví dụ `4 ●●●●`, kèm
tiêu đề "Chia". Mỗi chấm tô **đúng màu nền ô tên người đó trên sheet** (chấm cỡ 14 để màu nhạt
vẫn thấy rõ). Người nào không có ô tên tô màu trong tab thì dùng màu của người đó trên app.

- Script chỉ ghi khi ô tiêu đề cột đó (cùng hàng "Người mua") đang trống hoặc là "Chia", và cột đó
  không phải cột Ngày của bảng chia tiền. Chưa chèn cột thì script bỏ qua, không ghi gì.
- Màu lấy theo màu nền ô có tên người trong tab; ô ghép "A.Phú + C.Vân" thì cả hai cùng màu.
  Muốn mỗi người một màu riêng, tô màu ô tên riêng của người đó; script lấy màu đậm nhất.
- Cột H giữ như cũ (đồ dư dùng tiếp ghi công thức phần dùng ở đây).
- Dấu vết "Chia" của các bản trước ở cột A hoặc cột H được tự dọn.

## Dùng tiếp đồ dư

Món mua hôm trước chỉ tính một phần vào chia (ví dụ Bí đỏ 30.000, "Tính vào chia" ½),
hôm sau dùng tiếp phần còn lại:

- Script ghi một dòng mới ngày hôm sau: `↳ Bí đỏ (dư 23/10)`, **Số tiền để trống** (tiền đã
  tính ở ngày mua), Dư lại ghi `hết` hoặc `còn ¼`.
- Cột ngay sau cột Ngày (cột H) của dòng đó là công thức trỏ về ô Số tiền gốc, ví dụ `=E43/2`.
  Món gốc ở tab khác thì có tên tab: `='8.10-15.10'!E43/2`.
- Tổng cộng của ngày dùng tiếp cũng cộng `E43/2`. Tổng các ngày không vượt quá giá món.
- Trước khi ghi, script kiểm tra dòng món gốc còn đúng chỗ (cột Mô tả khớp); không khớp thì dừng.

