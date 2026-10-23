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

- Tìm hàng tiêu đề "Người mua" rồi ghi vào dòng ngay sau dòng cuối cùng đang có dữ liệu.
- Tên người mua được đổi theo danh sách chọn của cột Người mua trong sheet. Ví dụ "Tân" thành "Anh Tân".
- Số tiền dạng `6*4000` được ghi thành công thức `=6*4000`.
- Ngày lấy theo ngày của note.
- **Đồng bộ lại** sau khi sửa note: script ghi đè đúng các dòng đã ghi lần trước. Nếu note bớt món,
  các dòng thừa bị xoá trắng.
- Nếu các dòng đó đã bị sửa tay trên sheet, script dừng lại và app hỏi bạn có muốn ghi thành dòng mới không.
- Khối chia tiền (cột Tổng cộng, công thức `/4`, `/6`…) vẫn do bạn tự điền trong sheet.
