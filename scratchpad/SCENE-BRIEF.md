# SCENE-BRIEF — otrip

## Sản phẩm

Bản đồ Việt Nam dựng bằng code. Bốn địa danh (Tà Xùa, Hội An, Tràng An, Hồ Tây), mỗi nơi
là một thế giới 3D sinh từ seed cố định, sống theo thời tiết + giờ thật của chính nơi đó.
Mục đích là "mở ra để thở" — ngắm cảnh, chờ ánh sáng, không phải game bắn súng.

## Chuẩn chất lượng (bắt buộc)

- **Chi tiết hơn số lượng.** Vài vật thể dựng kỹ ăn đứt nhiều vật thể rẻ tiền.
- **Chứng minh bằng chạy thật.** Không được báo xong nếu chưa chạy. Dev server ĐANG CHẠY:
  web http://localhost:3000, server ws://localhost:2567. KHÔNG khởi động lại, KHÔNG tự
  chạy `pnpm dev`/`build`/`install`. Verify bằng:
  - `cd /Users/macbook/Documents/self/otrip/apps/web && npx tsc --noEmit`
  - `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ho-tay`
  - Đọc log: /private/tmp/claude-501/-Users-macbook-Documents-self-otrip/adad3663-35ff-413c-af8a-9af878a3ac4b/scratchpad/web.log
- **Benchmark thị giác:** grandvalley.pages.dev. Đồ hoạ sinh bằng code, không tải model 3D.
- Code tự giải thích. KHÔNG thêm comment hiển nhiên / comment tiến độ. Chỉ comment cho
  logic không hiển nhiên — và viết theo đúng giọng comment đang có trong repo (giải thích
  _vì sao_, kèm bằng chứng đo được, thường dẫn cả cái đã thử và đã hỏng).
- Chuỗi hiển thị cho người dùng: **tiếng Việt**, giọng mộc, không hoa mỹ.
- Căn theo style sẵn có: Tailwind 4 token trong `@otrip/theme`, `cn()` từ `@/lib/utils`.

## Quy tắc file ownership — TUYỆT ĐỐI

Nhiều agent chạy song song. Sửa file không thuộc quyền mình là lỗi nặng nhất ở repo này.
Chỉ sửa đúng các file được giao. Cần đổi file khác → BÁO LẠI cho main, đừng tự sửa.

| Chủ sở hữu    | File                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------- |
| main          | `components/scene/location-scene.tsx`, `components/ui/scene-hud.tsx`, `scene/world-renderer.ts` |
| agent CAMERA  | `scene/walker.ts`                                                                               |
| agent WEATHER | `lib/weather-presets.ts` (mới), `components/ui/weather-picker.tsx` (mới)                        |

## Không làm

- Không commit, không push, không deploy. Người dùng chưa yêu cầu.
- Không backward-compat shim, không file migration. Code chưa merge — sửa thẳng.
