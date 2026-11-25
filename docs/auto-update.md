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
        │  hoặc nút "Cập nhật ngay" trong popup (native messaging)
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

### Nút "Cập nhật ngay"

`setup` đăng ký trình cập nhật làm *native messaging host* `com.abcstudio.cvat_event_hotkeys` cho Chrome và Edge (khóa `HKCU\Software\Google\Chrome\NativeMessagingHosts` và `HKCU\Software\Microsoft\Edge\NativeMessagingHosts`). Mỗi lần `check` chạy, đăng ký được làm mới, nên máy đã cài trình cập nhật từ trước sẽ có nút này sau lần kiểm tra kế tiếp.

1. Popup gửi `{ type: 'update' }` qua service worker tới host.
2. Chrome chạy `native-host.cmd`, rồi script ở chế độ `native`. Script kiểm tra origin do Chrome truyền vào, rồi khởi chạy `check` **tách khỏi Chrome** và trả lời ngay. Đóng popup không làm ngắt việc cài.
3. `check` chạy như khi theo lịch, cộng thêm `-Confirmed` (lần bấm nút là lời đồng ý, nên không hỏi lại ở chế độ Hỏi trước) và `-Force` (cài cả bản từng bị bỏ qua sau rollback). Nếu bản mới xin thêm quyền, script vẫn hiện hộp thoại hỏi.
4. Popup đọc `updater-state.json` để hiện kết quả, rồi kích hoạt bản mới.

Chỉ extension có ID nằm trong `allowed_origins` mới gọi được host. ID của bản cài unpacked được Chrome tính từ đường dẫn thư mục: SHA-256 của đường dẫn dạng UTF-16LE (ổ đĩa viết hoa), 16 byte đầu, mỗi nửa byte đổi thành chữ `a`–`p`. Script tính ID từ đường dẫn với đúng chữ hoa/thường trên đĩa.

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
| Trang web hoặc extension khác gọi trình cập nhật | Chrome chỉ cho extension có ID trong `allowed_origins` kết nối. Script kiểm tra lại origin, chỉ nhận `status` và `update`, không dùng nội dung thông điệp làm đường dẫn hay tham số dòng lệnh. `native-host.cmd` chỉ chuyển origin (`%1`). Lệnh `update` chỉ chạy đúng quy trình `check` với mọi bước kiểm tra ở trên. |
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
| `%LOCALAPPDATA%\CVATEventHotkeys\native-host.cmd`, `com.abcstudio.cvat_event_hotkeys.json` | Host cho nút "Cập nhật ngay" |
| `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.abcstudio.cvat_event_hotkeys` (và nhánh Edge tương ứng) | Đăng ký host với Chrome/Edge |

`uninstall` xóa tất cả các mục trên và giữ nguyên extension.

## Xử lý lỗi

| Hiện tượng | Cách xử lý |
| --- | --- |
| Cửa sổ extension báo "chưa được cài" dù đã setup | Thư mục đã chọn khác thư mục Chrome đang dùng. So đường dẫn trong `status` với thẻ extension trong `chrome://extensions`, rồi chạy lại `setup`. |
| Đã cài bản mới nhưng Chrome vẫn chạy bản cũ | Mở cửa sổ extension để kích hoạt ngay. Kiểm tra **Developer mode** còn bật. Nếu thẻ extension báo lỗi, xem `status` và cân nhắc `rollback`. |
| `GitHub trả về HTTP 403` | Đã chạm giới hạn yêu cầu của GitHub. Lần chạy sau sẽ tự thử lại. |
| `SHA-256 không khớp` | ZIP tải về khác file trên GitHub. Không cài. Báo cho người phát triển kiểm tra release. |
| `xin thêm quyền` | Release mới cần thêm quyền. Chỉ chọn Yes nếu bản phát hành có ghi chú giải thích lý do. |
| Popup không có nút **Cập nhật ngay**, chỉ có **Update** | Máy chưa cài trình cập nhật, hoặc trình cập nhật chưa chạy bản có nút này. Chạy `Setup-Updater.cmd setup` (hoặc `check`) một lần. |
| Popup báo "chưa nhận extension này (ID …)" | ID tính từ đường dẫn khác ID Chrome đang dùng, ví dụ do thư mục bị đổi tên hoặc chuyển chỗ. Chạy lại `setup` và chọn đúng thư mục đang nạp trong `chrome://extensions`. |
| Bản mới lỗi | Chạy `rollback`. Bản lỗi sẽ không tự cài lại. Khi có bản sửa mới hơn, trình cập nhật tự cài như bình thường. Muốn cài lại bản đã bỏ qua, chạy `check -Force`. |
| Muốn xem tác vụ | Mở Task Scheduler → Task Scheduler Library → `CVAT Event Hotkeys Updater`, hoặc chạy `status`. |

## Giới hạn

- Hiện chỉ hỗ trợ Windows (PowerShell 5.1 có sẵn trên Windows 10/11). macOS và Linux vẫn cập nhật thủ công.
- Trình cập nhật có từ v1.6.0, nút "Cập nhật ngay" có từ v1.6.2. Máy đang dùng v1.5.1 trở về trước cần tải thủ công một lần, rồi chạy `Setup-Updater.cmd`.
- v1.6.2 xin thêm quyền `nativeMessaging`. Vì vậy máy đang ở chế độ Tự động sẽ được hỏi một lần trước khi cài bản này. Đây là đúng thiết kế.
- Mỗi lần chạy theo lịch, một cửa sổ PowerShell có thể lóe lên rất nhanh. Đây là giới hạn của Task Scheduler khi chạy PowerShell.
- Hộp thoại ở chế độ Hỏi trước tự đóng sau 15 phút nếu không ai trả lời. Lần chạy sau sẽ hỏi lại.
