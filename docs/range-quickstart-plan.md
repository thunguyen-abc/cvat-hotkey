# Quickstart chỉnh tag trong khoảng Start–End

## Luồng hiện tại

1. Đặt hai mốc bằng Start và End hoặc phím `4` và `5`. Số đếm dưới hai mốc tính tag ở cả Start và End. Chỉ số Frame là vị trí tính từ 0 trên tổng số frame của job. Bảng **Toàn job** nằm cạnh Quickstart và xếp dưới Quickstart trên màn hình hẹp.
2. Ở hàng **+**, chọn các event cần thêm. Ở hàng **−**, chọn các event cần xóa. Bấm lại để bỏ chọn. Một event chỉ có một hướng trong lần Apply hiện tại. Hai hàng dùng cùng thứ tự Smoke, Drinking, Phone.
3. Áp dụng khi snapshot sẵn sàng và planner có diff. Khi đang xử lý, nút có chỉ báo quay và các điều khiển khóa lại. Thành công xóa lựa chọn và cập nhật tag ngay tại frame hiện tại. Lỗi giữ bản nháp. Khi snapshot cũ, bảng đọc kết quả kiểm tra trực tiếp và chờ người dùng áp dụng lại.
4. Nâng cao nhận lựa chọn dưới dạng tối đa hai bước thêm và xóa. Người dùng có thể nối bước đổi tag, xóa toàn bộ tag hoặc các bước khác theo thứ tự. Hủy trả lại bản nháp ban đầu.

## Điểm tích hợp

- `range-editor.js` giữ mốc, snapshot và Map từng event theo job, dùng chung hàm chuyển trạng thái cho chuột và bàn phím. Phím Alt+1/2/3 bật hoặc tắt hàng thêm. Giữ thêm Shift cho hàng xóa. Enter trên canvas chạy Apply.
- `range-plan.js` tính diff tối thiểu. `cvat-bridge.js` kiểm tra lại tag hiện tại và frame hợp lệ trước khi sửa bộ sưu tập tag trong bộ nhớ. CVAT Save, Autosave hoặc Complete & Next tải thay đổi lên.
- `complete-next.js` quản lý số đếm và nút toàn job cùng Undo Apply và Redo Apply. `hotkeys.js` tiếp tục cấu hình ba slot đơn của CVAT cho frame hiện tại.
- `complete-next.css` định kiểu hai hàng bằng cùng hệ cột. Dấu tích thể hiện lựa chọn, dấu cộng/trừ biểu thị hướng và gạch ngang thể hiện nhãn thiếu.

## Kiểm tra khi sửa tiếp

Chạy `node tests/range_plan_test.js`, `python -X utf8 tests/simulated_cvat.py` và kiểm tra cú pháp JavaScript. Kiểm tra chọn chéo bằng chuột và bàn phím, frame 0, diff rỗng, bấm Apply lặp, lỗi rồi thử lại, snapshot cũ, Nâng cao tuần tự và Undo/Redo sau thao tác hỗn hợp. Kiểm tra lại trên job thử nghiệm được phép khi có quyền truy cập.

Ảnh Chromium trên trang CVAT mô phỏng ghi lại [giao diện cũ](quickstart/before.png), [hai hàng mới](quickstart/after.png), [trạng thái mặc định](quickstart/default.png), [một lựa chọn](quickstart/single.png), [đang áp dụng](quickstart/applying.png), [lỗi có thể thử lại](quickstart/error.png), [sau thành công](quickstart/success.png), [Nâng cao](quickstart/advanced.png) và [cửa sổ 390 px](quickstart/narrow-390.png).
