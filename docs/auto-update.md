# Trình cập nhật tự động

Tài liệu này mô tả `updater/cvat-hotkey-updater.ps1`: cách nó cập nhật extension, các bước kiểm tra bảo mật và cách xử lý lỗi. Hướng dẫn cài đặt nhanh có trong [README](../README.md#cập-nhật-tự-động-windows).

## Vì sao cần trình cập nhật riêng

Chrome chỉ tự cập nhật extension cài từ Chrome Web Store hoặc qua chính sách doanh nghiệp. Bản cài **Load unpacked** chạy trực tiếp từ một thư mục trên máy. Extension không tự ghi được vào thư mục đó. Vì vậy cần một chương trình chạy trên Windows để thay file, còn extension chỉ cần kích hoạt bản mới.

## Cách hoạt động

```
GitHub Release (tag vX.Y.Z)
  ├─ cvat-event-hotkeys-vX.Y.Z.zip
  └─ cvat-event-hotkeys-vX.Y.Z.zip.sha256
        │  Task Scheduler: khi đăng nhập + mỗi 3 giờ
        ▼
cvat-hotkey-updater.ps1 check
  1. Đọc release mới nhất qua api.github.com
  2. Tải ZIP, kiểm tra SHA-256 và nội dung
  3. Chế độ "Hỏi trước": hiện hộp thoại Yes/No
  4. Sao lưu bản đang dùng, ghi file mới, ghi manifest.json sau cùng
        ▼
Thư mục extension (Load unpacked)
        │  updates.js đọc manifest.json trên đĩa mỗi phút
        ▼
chrome.runtime.reload(): Chrome nạp bản mới
```

Extension tự kích hoạt bản mới khi `version` trong `manifest.json` trên đĩa khác bản đang chạy. Việc kiểm tra diễn ra mỗi phút, khi Chrome khởi động và khi mở cửa sổ extension. Bản rollback có phiên bản thấp hơn cũng được kích hoạt theo cách này. Tải lại extension không tải lại tab CVAT. Tab đang mở tiếp tục chạy mã cũ cho đến khi bạn tải lại trang, và annotation chưa lưu vẫn còn nguyên.

Chrome chỉ nạp lại được extension unpacked khi **Developer mode** đang bật. Nếu tắt Developer mode, Chrome vô hiệu hóa extension ở lần tải lại tiếp theo.

## Thiết lập lần đầu

`Setup-Updater.cmd` chạy lệnh `setup`:

1. Hiện mô tả những việc trình cập nhật sẽ làm: kết nối tới đâu, ghi vào đâu, chạy dưới quyền nào.
2. Xác nhận thư mục extension. Thư mục phải chứa `manifest.json` có tên `CVAT Event Hotkeys`. Trình cập nhật từ chối nếu thư mục là symlink/junction hoặc là bản mã nguồn có `.git`.
3. Chọn chế độ **Tự động** hoặc **Hỏi trước** (mặc định).
4. Hỏi đồng ý lần cuối. Nếu bạn không gõ `y`, không có thay đổi nào.
5. Chép script vào `%LOCALAPPDATA%\CVATEventHotkeys`, lưu cấu hình, tạo tác vụ `CVAT Event Hotkeys Updater` trong Task Scheduler, rồi kiểm tra bản mới ngay.

Muốn đổi chế độ, chạy lại `setup`. Có thể thiết lập không cần tương tác, ví dụ khi triển khai cho nhiều máy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\updater\cvat-hotkey-updater.ps1 setup -ExtensionDir "C:\Users\me\cvat-event-hotkeys" -Mode confirm -IntervalHours 3 -Yes
```

## Kiểm tra bảo mật

| Rủi ro | Biện pháp |
| --- | --- |
| Tải file từ máy chủ giả mạo | Chỉ dùng HTTPS (TLS 1.2+). Script tự xử lý từng bước chuyển hướng và chỉ chấp nhận `api.github.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`. Tên repository được ghi cố định trong script. |
| ZIP bị hỏng hoặc bị thay trên đường truyền | So SHA-256 của ZIP với `digest` do GitHub API trả về. Nếu release có file `.sha256`, so cả với file đó. Release không có SHA-256 nào sẽ bị từ chối. |
| ZIP chứa đường dẫn độc hại (zip-slip) | Chỉ chấp nhận tên file an toàn, tối đa một cấp thư mục con, không có `..`, `\`, ổ đĩa, file ẩn, tên dành riêng của Windows hay thư mục `_` của Chrome. Chỉ chấp nhận các đuôi `.js .css .html .json .md .txt .png .svg .ps1 .cmd`. Script giải nén vào thư mục tạm và kiểm tra lại đường dẫn tuyệt đối. |
| ZIP quá lớn (zip bomb) | ZIP tối đa 5 MB, sau giải nén tối đa 20 MB, tối đa 200 file. |
| Cài nhầm gói hoặc hạ phiên bản | `manifest.json` trong ZIP phải có `name` đúng, Manifest V3, `version` trùng tag. Script chỉ cài bản mới hơn bản đang dùng. Release nháp và prerelease bị bỏ qua. |
| Bản mới lặng lẽ xin thêm quyền | Script so sánh `permissions`, `host_permissions`, các quyền optional, `content_scripts.matches`, `externally_connectable` và `web_accessible_resources`. Nếu có mục mới, script luôn hỏi người dùng và liệt kê từng mục, kể cả ở chế độ Tự động. |
| Ghi đè nhầm thư mục | Thư mục phải chứa đúng manifest của extension. Script từ chối symlink/junction và thư mục git. Chỉ file thuộc bản phát hành mới được ghi hoặc xóa. |
| Cài dở dang | Script sao lưu trước khi ghi (giữ 3 bản). Mỗi file được ghi qua file tạm rồi đổi tên. `manifest.json` ghi sau cùng nên Chrome chỉ kích hoạt khi đủ file. Nếu lỗi, script tự khôi phục bản sao lưu. Mutex ngăn hai lần cập nhật chạy cùng lúc. |
| Leo thang đặc quyền | Tác vụ chạy dưới tài khoản người dùng hiện tại, `RunLevel Limited`, không cần Administrator. Script không dùng token GitHub và không gửi dữ liệu cá nhân, chỉ gửi User-Agent `cvat-event-hotkeys-updater`. |
| Popup hiển thị dữ liệu giả | `updater-state.json` chỉ để hiển thị. Popup đọc nó như dữ liệu và gán bằng `textContent`. Extension không dựa vào file này để quyết định gì. |

### Rủi ro còn lại

- **Niềm tin đặt vào repository GitHub.** SHA-256 chỉ chứng minh ZIP đúng là file đã đăng lên release. Nó không chứng minh người đăng là bạn. Ai chiếm được tài khoản có quyền push tag, hoặc sửa được workflow, đều có thể phát hành mã độc. Mã đó sẽ đến mọi máy, ngay lập tức ở chế độ Tự động. Chế độ Hỏi trước cho người dùng quyền từ chối, nhưng người dùng thường không tự đọc mã. Muốn chặn hoàn toàn trường hợp này cần ký bản phát hành bằng khóa nằm ngoài GitHub. Hiện chưa làm.
- **Script chạy với `-ExecutionPolicy Bypass`.** Cờ này chỉ áp dụng cho tác vụ của trình cập nhật. Thư mục `%LOCALAPPDATA%\CVATEventHotkeys` thuộc quyền ghi của chính người dùng, nên phần mềm độc hại đã chạy dưới tài khoản đó có thể sửa script. Nhưng phần mềm đó vốn đã sửa được thư mục extension, nên trình cập nhật không mở thêm quyền nào mới.
- **Script tự cập nhật.** Khi release có `updater/cvat-hotkey-updater.ps1` mới, bản chép trong `%LOCALAPPDATA%` được thay sau khi cài thành công. Script mới đã qua cùng các bước kiểm tra như phần còn lại của ZIP.
- **GitHub API giới hạn 60 yêu cầu/giờ cho mỗi IP** khi không đăng nhập. Mỗi lần kiểm tra dùng 1 yêu cầu, nên đủ cho cả văn phòng dùng chung một IP.

### Bảo vệ repository

Vì release đi thẳng tới máy người dùng, nên bật các thiết lập sau trên `thunguyen-abc/cvat-hotkey`:

1. Bắt buộc 2FA cho mọi tài khoản có quyền ghi.
2. Tạo ruleset cho tag `v*`: chỉ admin được tạo, cấm xóa và cấm cập nhật tag.
3. Bảo vệ nhánh `main`: bắt buộc pull request, không cho force-push.
4. Bảo vệ `.github/workflows/`: thêm CODEOWNERS và bắt buộc review khi workflow thay đổi.
5. Settings → Actions: chỉ cho phép action được pin theo commit SHA, như `actions/checkout` hiện tại.

## Vị trí dữ liệu

| Đường dẫn | Nội dung |
| --- | --- |
| `%LOCALAPPDATA%\CVATEventHotkeys\updater.json` | Cấu hình: thư mục, chế độ, chu kỳ, file đã cài, bản bị bỏ qua |
| `%LOCALAPPDATA%\CVATEventHotkeys\updater.log` | Nhật ký (tự rút gọn khi quá 256 KB) |
| `%LOCALAPPDATA%\CVATEventHotkeys\backups\` | 3 bản sao lưu gần nhất |
| `%LOCALAPPDATA%\CVATEventHotkeys\cvat-hotkey-updater.ps1` | Bản script mà Task Scheduler chạy |
| `<thư mục extension>\updater-state.json` | Trạng thái để cửa sổ extension hiển thị |
| Task Scheduler → `CVAT Event Hotkeys Updater` | Lịch chạy |

`uninstall` xóa tất cả các mục trên và giữ nguyên extension.

## Xử lý lỗi

| Hiện tượng | Cách xử lý |
| --- | --- |
| Cửa sổ extension báo "chưa được cài" dù đã setup | Thư mục đã chọn khác thư mục Chrome đang dùng. So đường dẫn trong `status` với thẻ extension trong `chrome://extensions`, rồi chạy lại `setup`. |
| Đã cài bản mới nhưng Chrome vẫn chạy bản cũ | Mở cửa sổ extension để kích hoạt ngay. Kiểm tra **Developer mode** còn bật. Nếu thẻ extension báo lỗi, xem `status` và cân nhắc `rollback`. |
| `GitHub trả về HTTP 403` | Đã chạm giới hạn yêu cầu của GitHub. Lần chạy sau sẽ tự thử lại. |
| `SHA-256 không khớp` | ZIP tải về khác file trên GitHub. Không cài. Báo cho người phát triển kiểm tra release. |
| `xin thêm quyền` | Release mới cần thêm quyền. Chỉ chọn Yes nếu bản phát hành có ghi chú giải thích lý do. |
| Bản mới lỗi | Chạy `rollback`. Bản lỗi sẽ không tự cài lại. Khi có bản sửa mới hơn, trình cập nhật tự cài như bình thường. Muốn cài lại bản đã bỏ qua, chạy `check -Force`. |
| Muốn xem tác vụ | Mở Task Scheduler → Task Scheduler Library → `CVAT Event Hotkeys Updater`, hoặc chạy `status`. |

## Giới hạn

- Hiện chỉ hỗ trợ Windows (PowerShell 5.1 có sẵn trên Windows 10/11). macOS và Linux vẫn cập nhật thủ công.
- Trình cập nhật có từ v1.6.0. Máy đang dùng v1.5.1 trở về trước cần tải thủ công v1.6.0 một lần, rồi chạy `Setup-Updater.cmd`.
- Mỗi lần chạy theo lịch, một cửa sổ PowerShell có thể lóe lên rất nhanh. Đây là giới hạn của Task Scheduler khi chạy PowerShell.
- Hộp thoại ở chế độ Hỏi trước tự đóng sau 15 phút nếu không ai trả lời. Lần chạy sau sẽ hỏi lại.
