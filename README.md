# CVAT Event Hotkeys

Extension Chrome dành cho `cvat-tai.abcstudio.online`. Khi mở hoặc tải lại một job đang ở **Standard**, extension tự chuyển sang **Tag annotation** rồi gán các phím nếu nhãn tương ứng có trong job. Nếu bạn chuyển lại **Standard** để vẽ box, extension giữ lựa chọn đó cho đến khi bạn mở job khác hoặc tải lại trang.

| Phím | Nhãn |
| --- | --- |
| 1 | `event_smoke` |
| 2 | `event_drinking` |
| 3 | `event_phone` |

Bấm một lần để gắn tag vào frame hiện tại. Bấm lại để gỡ. Lưu annotation bằng **Save** của CVAT.

## Hoàn tất rồi mở job tiếp theo

Bấm **Complete & Next** cạnh **Menu**. Extension tự bấm **Continue** trong hộp xác nhận hoàn tất của CVAT. CVAT lưu annotation và chuyển job hiện tại sang **Completed**. Extension mở job chưa hoàn tất có ID lớn hơn gần nhất được giao cho bạn trong cùng task. Nếu chỉ còn job có ID nhỏ hơn, extension quay về job chưa hoàn tất đầu tiên của bạn. Khi không còn job nào phù hợp, extension mở trang task.

Nút yêu cầu job hiện tại được giao cho tài khoản đang đăng nhập. Nếu CVAT báo lỗi hoặc chưa xác nhận hoàn tất, bạn vẫn ở job hiện tại.

## Xóa toàn bộ tag của job hiện tại

Bấm **Clear All Tags** để xem số tag đã lưu. Bấm **Xóa toàn bộ tag** trong hộp xác nhận để lưu các chỉnh sửa hiện tại và xóa tag ở mọi frame của job. Các box, shape và track vẫn giữ nguyên. Extension kiểm tra lại kết quả rồi tải lại job. Thao tác xóa không thể hoàn tác bằng Undo của CVAT.

## Cài trên Chrome

1. Mở `chrome://extensions` trong Chrome và bật **Developer mode**.
2. Chọn **Load unpacked**, rồi chọn thư mục `cvat-event-hotkeys` chứa `manifest.json`.
3. Tải lại tab CVAT hoặc mở một job. Kiểm tra **Tag annotation** và ba dòng đầu ở **Shortcuts for labels**.

Nếu đã cài bản cũ, thay các file trong thư mục extension bằng bản mới, bấm **Reload** trên thẻ extension trong `chrome://extensions`, rồi tải lại tab CVAT.

## Cập nhật từ GitHub

Mở biểu tượng **CVAT Event Hotkeys** trong Chrome. Extension kiểm tra [GitHub Releases](https://github.com/thunguyen-abc/cvat-event-hotkeys/releases/latest) khi mở cửa sổ này và định kỳ mỗi sáu giờ. Khi có bản mới, biểu tượng hiện **NEW** và nút **Update** tải ZIP phát hành. Giải nén đè vào thư mục đang dùng, bấm **Reload** trong `chrome://extensions`, rồi tải lại CVAT. Chrome yêu cầu bước này với bản **Load unpacked**.

Khi phát hành, GitHub release cần có tag dạng `v1.4.0` và file đính kèm cùng phiên bản dạng `cvat-event-hotkeys-v1.4.0.zip`.

Extension dùng giao diện CVAT để gắn, gỡ và lưu annotation khi bạn thao tác. Nút Complete & Next sử dụng phiên đăng nhập hiện tại để đọc thông tin tài khoản và danh sách job từ API trên cùng tên miền CVAT.
