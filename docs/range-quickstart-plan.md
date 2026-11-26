# Plan triển khai Quickstart chỉnh tag theo Start–End

## Kết quả cần đạt

Mở job là thấy bảng Start–End ở vị trí cụm Start/End/Edit hiện tại. Người dùng đặt hai mốc, bật các nút event cần chỉnh, đưa thao tác thêm hoặc xóa vào danh sách, xem lại rồi Apply ngay trên màn hình annotation. Nút **Nâng cao** mở dialog cho **Đổi tag** và **Xóa toàn bộ tag trong khoảng**. **Clear All Tags** ngoài toolbar vẫn xử lý toàn bộ job.

```text
[Start 6400] [End 6440]         [Nâng cao]
[event_smoke] [event_drinking] [event_phone]
                                  [+] [−]
+ event_smoke                        [×]
− event_phone                        [×]
Thêm 12 · Xóa 3                  [Apply]
```

## Mốc đọc code và ranh giới kiến trúc

Trước khi sửa, chạy `git status --short` và đọc diff. Tại thời điểm viết plan, worktree đã có bản chỉnh sửa chưa commit ở range editor, batch planner, CSS, Complete & Next và bộ test. Những chỉnh sửa này đã hỗ trợ mục tiêu thêm nhiều event trong một thao tác và đích đổi tag duy nhất. Triển khai trên worktree hiện tại và giữ các thay đổi sẵn có.

| File | Điểm tích hợp |
| --- | --- |
| [`complete-next.js`](../complete-next.js) | `showControls()` gắn range editor khi thấy slider và frame selector. `controls.controller` quản lý vòng đời theo job/menu. Complete & Next xóa cache và mốc của job sau khi xác nhận Completed. |
| [`range-editor.js`](../range-editor.js) | `attachCVATRangeEditor()` đọc frame từ ARIA của slider, lưu `cvat-event-range:<jobId>` trong sessionStorage và vẽ dải highlight. `openEditor()` đang sở hữu snapshot, operation cards, preview và Apply. Đây là nơi tách luồng dùng chung cho bảng và dialog. |
| [`range-plan.js`](../range-plan.js) | `planCVATRangeBatch({ tags, low, high, addFrames, operations })` là planner thuần. Các mode `add`, `remove`, `replace`, `all` chạy từ trên xuống. Planner trả diff tối thiểu và lỗi theo từng bước. |
| [`bridge-client.js`](../bridge-client.js) và [`cvat-bridge.js`](../cvat-bridge.js) | Content script gọi `rangeSnapshot` và `applyRange` qua DOM events. MAIN world sở hữu truy cập CVAT core/store, cache theo frame/history, đọc live trước khi Apply, kiểm tra plan và refresh annotation hiện tại. Dùng `describeCVATSave` cho trạng thái lưu. |
| [`hotkeys.js`](../hotkeys.js) | Tự chọn Tag annotation một lần khi mở job và cấu hình shortcut **CVAT native** cho slot `1/2/3`. Listener capture hiện tại chỉ chặn ba phím lúc extension đang cấu hình sidebar. |
| [`complete-next.css`](../complete-next.css) | Cụm điều khiển dùng `.cvat-range-buttons`, band dùng `.cvat-range-band`. Tận dụng CSS và vị trí hiện tại để tạo panel gọn. |

**Luồng dữ liệu cần giữ**  
Mốc + draft → `rangeSnapshot` (record trong bộ nhớ CVAT đã gồm thay đổi chưa Save) → `planCVATRangeBatch` → `applyRange` (live check rồi sửa CVAT core, refresh sidebar/canvas) → CVAT tự upload ở Save, Auto save hoặc Complete & Next theo cơ chế hiện tại. Apply giữ URL, frame, workspace và hai mốc. Dùng đường refresh `FETCH_ANNOTATIONS_SUCCESS` sẵn có. Gọi `changeFrameAsync` ngay tại frame hiện tại có thể làm `canvas.ready` kẹt ở false. Phạm vi chỉnh sửa chủ yếu là UI và routing phím. Luồng này dùng manifest, permission, API lưu và cache hiện có. Xem [hướng dẫn phát triển](development.md).

## Hành vi của bảng và dialog

- Dùng cùng handler cho nút Start/End và phím `4/5`. Giữ khoảng bao gồm cả hai đầu, cho phép đặt End trước Start và trường hợp hai mốc trùng frame. Bảng hiện sẵn khi vào job. Chọn tag, thêm action, mở Nâng cao và Apply chỉ hoạt động khi đã có hai mốc hợp lệ và snapshot sẵn sàng.
- Bảng Quickstart hiển thị đúng ba nút theo thứ tự **event_smoke**, **event_drinking**, **event_phone**. Mỗi nút bật/tắt độc lập, ban đầu ở trạng thái tắt. Nút tắt có nền trung tính, nút bật có nền màu và `aria-pressed="true"`. Trạng thái này thể hiện lựa chọn của người dùng. Nhãn thiếu trong job vẫn giữ vị trí và có nút disabled. Phần preview inline chỉ hiển thị các thao tác trong hàng đợi và tổng số thay đổi.
- Cả **+** và **−** dùng tập event đang bật, resolve ID từ snapshot của job. Một lần bấm xếp một dòng chứa toàn bộ event đang chọn, theo thứ tự các nút. **×** bỏ dòng tương ứng rồi tính preview lại. Ánh xạ `+` thành `{ mode: 'add', sources: [], targets: selectedIds }` và `−` thành `{ mode: 'remove', sources: selectedIds, targets: [] }`. Mỗi dòng lưu bản sao ID lúc xếp hàng, nên bật/tắt sau đó chỉ ảnh hưởng thao tác kế tiếp. Cả hai nút bị khóa khi chưa chọn event. **−** dùng nguồn theo trạng thái sau các dòng trước đó, nên có thể xóa event vừa được thêm trong hàng đợi. Dùng lỗi theo dòng từ planner. Apply bị khóa nếu draft có lỗi, diff rỗng hoặc đang xử lý.
- **Nâng cao** mở dialog hiện tại với hai mode nâng cao để thêm vào batch. Khi mở, dialog nhận bản sao draft inline theo đúng thứ tự, dùng nó làm các dòng đầu của preview và cho phép bổ sung thao tác **Đổi tag** hoặc **Xóa toàn bộ tag trong khoảng**. Mode nâng cao chỉ có trong dialog. **Hủy/Esc** bỏ thay đổi riêng của dialog và trả focus về nút mở. **Apply** trong dialog chạy toàn bộ batch đang xem, dùng chung đường Apply với bảng. Cách này giữ được các batch kết hợp thao tác nhanh và nâng cao.
- Sau Apply thành công, dọn draft đã áp dụng và giữ mốc/band. Cập nhật snapshot cho lần sửa tiếp theo bằng cache qua bridge. Khi bridge báo `stale`, thay snapshot, giữ draft, tính lại preview và đợi người dùng Apply lần nữa. Khi gặp lỗi hoặc CVAT đang Save, giữ draft và hiện trạng thái để người dùng thử lại.
- Draft gắn với `jobId/low/high` và nằm trong bộ nhớ. Đổi sang khoảng khác có draft thì hiện xác nhận bỏ draft trước khi ghi mốc mới, dùng cùng quy tắc cho chuột và phím. Chuyển frame hoặc gắn lại slider trong cùng job vẫn giữ draft. Đổi job hủy panel và draft cũ, rồi đọc mốc của job mới từ sessionStorage.

## Phím tắt và xung đột đã tìm thấy

Ở CVAT v2.56.1, `ShortcutsSelect` đăng ký các slot số trong Tag annotation. `GlobalHotKeys` gắn Mousetrap ở `keydown` và tra keymap đã cấu hình. Vì vậy `4/5` là xung đột thực với thao tác gắn/gỡ tag trên frame. Kiểm tra thêm `-`, `=`, Enter và tổ hợp chọn nhãn trong **Settings → Shortcuts** của bản triển khai, kể cả cấu hình đã tùy biến. [CVAT ShortcutsSelect](https://github.com/cvat-ai/cvat/blob/v2.56.1/cvat-ui/src/components/annotation-page/tag-annotation-workspace/tag-annotation-sidebar/shortcuts-select.tsx) · [CVAT GlobalHotKeys](https://github.com/cvat-ai/cvat/blob/v2.56.1/cvat-ui/src/utils/mousetrap-react.tsx) · [Tài liệu phạm vi phím tắt CVAT](https://docs.cvat.ai/docs/manual/advanced/shortcuts/)

| Phím | Hành vi trong Quickstart |
| --- | --- |
| `4`, `5` | Đặt Start, End tại frame đang hiển thị. Khi Quickstart có quyền bắt phím, mốc được đặt một lần và CVAT không toggle tag slot 4/5. |
| `Ctrl+1`, `Ctrl+2`, `Ctrl+3` | Tổ hợp người dùng đề xuất để bật/tắt nút `event_smoke`, `event_drinking`, `event_phone` tương ứng. |
| `=` | Xếp action **+** cho các event đang bật. |
| `-` | Xếp action **−** cho các event đang bật. |
| `Enter` | Apply một lần nếu có batch hợp lệ. Khi focus ở nút hoặc control có hành vi Enter riêng, giữ hành vi của control đó. |

Chrome trên Windows dùng `Ctrl+1…8` để chuyển tab. Thử bằng phím thật trong Chrome có ít nhất ba tab và đặt CVAT ở tab khác. Nếu Chrome giữ tổ hợp này, chọn **Alt+1/2/3** làm phương án dự phòng và xác minh trên keymap CVAT đang dùng trước khi chốt. Chỉ ghi tổ hợp đã được xác minh lên panel và README. Ba nút event vẫn dùng được bằng chuột. Sự kiện Playwright chỉ kiểm tra được routing phía trang. [Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179?hl=en)

- Gắn một `keydown` capture trên `window` cho range editor đang sống, cùng `AbortSignal` của lần mount. Chuột và phím gọi cùng các handler `mark`, bật/tắt event, xếp action và Apply. Dùng một mapping event dùng chung với cấu hình slot 1/2/3 ở `hotkeys.js`. Lưu ID theo job, resolve từ tên sau khi nạp snapshot.
- Cho phép Quickstart bắt phím tại job hiện hành trong **Tag annotation** khi panel đang gắn và focus ở vùng annotation hoặc vùng panel phù hợp. `4/5` phải hoạt động từ canvas để đánh dấu trong lúc di chuyển frame. Các phím chọn nhãn, xếp hàng và Apply chỉ dùng khi thao tác tương ứng hợp lệ. Trong Standard, ngoài job, khi dialog đang mở, khi nhập liệu (kể cả IME), dùng dropdown hoặc focus ở form/toolbar khác, trả quyền phím về CVAT/trình duyệt. Bỏ qua `event.repeat` với hành động một lần và chặn việc phím giữ xuống rơi sang handler native sau khi Quickstart đã nhận.
- Chỉ `preventDefault()` và chặn propagation khi Quickstart nhận phím. Không sửa keymap Redux hay cấu hình shortcut 4/5 của người dùng. Giữ các phím native `1/2/3`, điều hướng, Save và Undo/Redo. Giữ Enter mặc định cho frame input, nút đang focus và dialog để tránh Apply nhầm hoặc kích hoạt kép.

## Thứ tự triển khai

1. **Chạy baseline.** Chạy planner và mô phỏng ở cuối tài liệu. Kiểm tra trên checkout hiện tại các selector, job lifecycle, menu remount và các chế độ workspace. Rà shortcut người dùng trên một job test được phép trước khi chọn tổ hợp cuối.
2. **Tách luồng snapshot/preview/Apply trong `range-editor.js`.** Giữ một đường chuyển đổi planner → bridge với payload `{ jobId, low, high, key, create, remove }`, trong đó `remove` là danh sách client ID. Dùng chung trạng thái đang Apply giữa panel và dialog. Chụp job, khoảng, draft và snapshot key trước khi gọi bridge. Đọc snapshot khi hai mốc hợp lệ hoặc khi cần refresh, gộp request trùng và bỏ kết quả đến muộn nếu job, khoảng hoặc lần mount đã đổi. Giữ phần đọc live/fingerprint làm bước xác minh cuối. Nếu bridge timeout, giữ draft và đọc lại trạng thái để người dùng đối chiếu trước khi thử lại.
3. **Gắn panel và chuyển dialog sang Nâng cao.** Tái dùng render preview, cảnh báo lỗi và thông báo lưu. Dùng layout nhiều hàng, label rõ cho nút `+`, `−`, `×`, status cho loading/lỗi và focus ổn định khi render lại. Giới hạn chiều cao danh sách để panel gọn. Kiểm tra panel trên viewport 1366 px và 390 px để vẫn dùng được slider, sidebar, canvas và các nút toolbar.
4. **Nối hotkey và vòng đời.** Khi slider/anchor remount trong cùng job, tháo panel, band và listener cũ trước khi gắn mới. Tránh tích lũy listener qua mutation observer. Dùng guard của toolbar hiện tại để ngăn chồng Apply với Clear All/Complete & Next và bỏ các callback UI sau abort. Sau Clear All, làm mới preview của draft đang mở trước lần Apply tiếp theo. Bridge hiện kiểm tra Save/fetching và fingerprint; nếu test dài phát hiện frame mất hiệu lực sau preview (fingerprint hiện chỉ gồm tag), bổ sung kiểm tra frame hợp lệ ở bước preflight trước khi có mutation đầu tiên.
5. **Cập nhật hồi quy và README.** Chuyển helper test từ nút Edit sang panel và dialog tương ứng. Giữ kiểm tra batch hỗn hợp, cache, Save, Clear All và Complete & Next. README mô tả flow mới và shortcut đã qua kiểm tra thật.

## Điều kiện bàn giao

Baseline trên worktree ngày 2026-11-26: 11 test planner và toàn bộ bài mô phỏng CVAT đã pass. Phím tắt vẫn cần kiểm tra trên Chrome thật với job test.

- Đặt mốc bằng chuột và bằng phím. Thử Start trước, End trước, cùng frame, thiếu mốc, nhãn event thiếu trong job và job có tag ngoài ba event để xác nhận bảng vẫn chỉ hiển thị đúng ba nút. Thử đổi mốc giữa lúc snapshot đang đọc và đổi job/menu/slider.
- Bật/tắt bằng chuột và phím, kiểm tra màu và `aria-pressed` đồng bộ. Thử chọn hai event cùng lúc rồi `=` / `-` để xác nhận mỗi phím tạo một dòng đúng dấu với hai event. Tắt một event và kiểm tra dòng cũ giữ nguyên. Thử bỏ dòng ở giữa, thêm rồi xóa cùng nhãn, nguồn bị thao tác trước xóa, diff rỗng và bấm Enter liên tiếp. Thử **Đổi tag** và **Xóa toàn bộ tag trong khoảng** trong dialog, gồm nhãn nguồn ngoài ba event, draft trộn và Hủy.
- Test mô phỏng thêm native listener ở pha bubble nếu fixture chưa mô phỏng shortcut CVAT. Kiểm tra mỗi `4/5` được Quickstart nhận không tạo tag native. Kiểm tra focus ở frame input, nút event, nút có Enter riêng, form/dialog, Standard, cùng job sau remount và khi ra khỏi job. Kiểm tra `1/2/3`, điều hướng frame, Save và Undo/Redo trên job test thật.
- Đối chiếu collection và request log: Apply chỉ cập nhật tag trong khoảng, bỏ qua frame bị xóa/lọc khi thêm, giữ shape/track và tránh duplicate. Không phát request annotation khi đặt mốc, preview hoặc Apply. Sidebar cập nhật ngay, frame/URL giữ nguyên, `canvas.ready` vẫn true. Diff được upload ở lần Save, Auto save hoặc bước Save của Complete & Next. Kiểm tra Undo, fingerprint stale, lỗi khi đang Save và khả năng thử lại khi draft còn nguyên.
- Chạy `node tests/range_plan_test.js`, `python -X utf8 tests/simulated_cvat.py` và `node --check` cho các file JavaScript đã sửa. Cờ UTF-8 giúp in chuỗi preview tiếng Việt trên Windows. Mở job test được phép trên Chrome thật để chốt tổ hợp phím, hành vi canvas và Save. Ghi rõ phần kiểm tra thực tế còn thiếu nếu môi trường không có job test.
