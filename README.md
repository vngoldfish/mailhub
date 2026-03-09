<<<<<<< HEAD
# MailHub Collector

Hệ thống quản lý và thu thập Email thời gian thực, tự động gửi Webhook tới N8N hoặc các dịch vụ khác.

## Hướng dẫn cài đặt nhanh

1. **Cài đặt thư viện**:
   ```bash
   npm install
   ```

2. **Cấu hình**:
   - Sao chép file `config.example.json` thành `config.json` và thay đổi Webhook URL của bạn.
   - Sao chép file `accounts.example.json` thành `accounts.json` (tùy chọn, bạn có thể thêm tài khoản qua giao diện Dashboard).

3. **Chạy ứng dụng**:
   ```bash
   npm start
   ```

4. **Truy cập Dashboard**:
   Mở trình duyệt và truy cập: `http://localhost:8899`

## Lưu ý bảo mật
Các file sau đã được đưa vào `.gitignore` để đảm bảo an toàn, bạn không nên xóa chúng khỏi danh sách chặn:
- `encryption.key`: Chìa khóa mã hóa mật khẩu.
- `accounts.json`: Chứa thông tin tài khoản email.
- `config.json`: Chứa cấu hình riêng.
- `notifications.json`: Lịch sử thông báo.
=======
# mailhub
>>>>>>> 27654e5bac9afe95e46c3eb70d2b128eb5b74f7f
