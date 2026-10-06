# otrip

Bản đồ Việt Nam dựng bằng code. Mỗi địa danh là một thế giới 3D sinh ra từ một seed cố định, sống
theo **thời tiết và giờ thật của chính nơi đó**. Mở ra để thở, nghe gió, và chờ mây.

Bốn điểm đến, toạ độ thật, thời tiết thật:

| Nơi          | Vùng                    | Địa hình                 | Nước          | Phố                      |
| ------------ | ----------------------- | ------------------------ | ------------- | ------------------------ |
| **Tà Xùa**   | Bắc Yên, Sơn La · 1602m | sống núi + biển mây      | —             | bản nhỏ                  |
| **Hội An**   | Đà Nẵng · 13m           | đồng bằng + sông Thu Bồn | sông          | phố cổ, đèn lồng ban đêm |
| **Tràng An** | Hoa Lư, Ninh Bình · 7m  | núi đá vôi               | mặt nước lặng | —                        |
| **Hồ Tây**   | Tây Hồ, Hà Nội · 10m    | đồng bằng                | hồ lớn        | thành phố                |

## Chạy thử

```bash
pnpm install
pnpm dev          # web ở http://localhost:3000, phòng đi chung ở cổng 2567
```

Yêu cầu Node 24 (`.nvmrc`) và pnpm 10.

`pnpm dev:web` chỉ bật web. Khi đó **Đi cùng bạn sẽ không vào được phòng**: không đặt
`NEXT_PUBLIC_REALTIME_URL` thì client tìm phòng ở `ws://localhost:2567`, và chỗ đó
không có ai nghe.

| Lệnh               | Việc                             |
| ------------------ | -------------------------------- |
| `pnpm dev`         | chạy mọi app qua turbo           |
| `pnpm build`       | build toàn workspace             |
| `pnpm check-types` | `tsc --noEmit` ở mọi package     |
| `pnpm lint`        | kiểm tra định dạng bằng Prettier |
| `pnpm format`      | tự định dạng lại                 |

## Cấu trúc

```
apps/web           @otrip/web        Next 16 · React 19 · Tailwind 4 · Three.js
apps/server        @otrip/server     Colyseus — phòng đi chung, kiểm vị trí người chơi
packages/world     @otrip/world      generator địa hình, recipe từng địa danh
packages/contracts @otrip/contracts  schema thời tiết + suy ra trạng thái trời
packages/theme     @otrip/theme      token giao diện
assets/audio/raw   nguồn âm thanh gốc (gitignore, tải lại được từ assets/CREDITS.md)
```

Chạy phần đi chung: `pnpm --filter @otrip/server dev` (cổng 2567) cùng với web.

### Asset

Toàn bộ mô hình là **CC0**, tải bằng script từ nguồn công khai (xem `assets/CREDITS.md`): bộ thiên nhiên
41 món của Gobkit (336KB) và nhân vật người có rig của Quaternius (2.3MB). Bản gốc nằm trong
`assets/models/raw/` và được gitignore; bản dùng thật nằm trong `apps/web/public/models/`.

### Vì sao `packages/world` là package riêng

Server realtime (giai đoạn sau) phải sinh **đúng cùng một địa hình** để kiểm tra vị trí người chơi.
Generator vì thế không thể nằm trong app web. Package này là source-only và import có đuôi `.ts`, nên
chạy được cả trong Turbopack lẫn Node thuần (`node --experimental-strip-types`).

### Thêm một địa danh

Thêm một `LocationRecipe` vào `packages/world/src/locations.ts`. Không phải đụng vào code render:
địa hình, cây cối, biển mây, bảng màu theo giờ đều là tham số của recipe.

## Những quyết định đáng nhớ

- **Đồ hoạ sinh bằng code, không tải asset 3D nào.** Site tham chiếu (grandvalley.pages.dev) cũng vậy:
  kiểm tra bundle của họ thấy 20 `InstancedMesh`, 14 `ShaderMaterial` và **không có** `GLTFLoader` hay
  `TextureLoader`. Cái tạo ra vẻ đẹp là shader và hậu kỳ, không phải model tải về.
- **Hậu kỳ pixel-art cũng chính là chiến lược hiệu năng.** Render ở 40–60% độ phân giải rồi phóng to
  bằng nearest-neighbour: máy yếu vẽ ít pixel hơn mà kết quả trông là có chủ ý.
- **Chỉ dùng asset CC0.** Pixabay bị loại vì license cấm dùng content trong sản phẩm mà content là giá
  trị chính — site này có music player nên rơi vào vùng xám. Chi tiết trong `assets/CREDITS.md`.
- **Dữ liệu thật là nội dung, không phải cổng chặn.** Ngày trời xấu vẫn kéo được thanh giờ để xem lại
  bình minh sắp tới, nên không ai mở trang ra gặp một màn xám.
- **Điểm săn mây bị khống chế bởi mây thấp.** Bản đầu tính trung bình cộng nên 1% mây thấp vẫn ra 64
  điểm — vô lý, vì không có mây thấp thì không có biển mây.

## Tính năng

- **Bản đồ điểm đến** ở trang chủ: ghim đặt theo toạ độ thật, mỗi ghim hiện giờ địa phương, nhiệt độ và
  điểm săn mây ngay lúc đó.
- **Thời tiết thật** (Open-Meteo) lái mặt trời, sương, mây, màu trời và mặt nước của từng nơi.
- **Thanh kéo 48 giờ** kèm nút nhảy tới bình minh sắp tới, và nút **nhắc tôi** tải file lịch `.ics` để
  dậy đúng giờ săn mây.
- **Điểm săn mây 0–100** có nút "vì sao" mở ra đủ ba yếu tố (độ ẩm, mây thấp, gió) và lời giải thích.
- **Đi bộ** ngôi thứ ba hoặc thứ nhất (phím `V`): chuột xoay nhìn — ngẩng, cúi, quay quanh — `WASD` đi,
  `Shift` chạy, cuộn đổi cự ly, nhấn vào cảnh để khoá chuột như game. Camera tự tránh địa hình, nhà cửa
  và tán cây; nhân vật không đi xuyên tường.
- **Điểm tham quan**: mỗi nơi có 3–4 địa điểm có thật, vị trí do chính địa hình quyết định (đỉnh cao
  nhất, mép nước, giữa phố, đảo). Cột sáng chỉ đường, la bàn và bản đồ nhỏ dẫn tới, tới nơi thì hiện
  thẻ giới thiệu. Đã ghé rồi thì bấm tên để quay lại ngay.
- **Cài đặt**: chọn Sắc nét hay Pixel, bốn mức chi tiết, độ nhạy chuột — lưu theo máy.
- **Đi cùng bạn**: tạo phòng, gửi link mời, tối đa 8 người, thấy avatar và chat nhóm. Server kiểm vị trí
  bằng chính generator địa hình nên độ cao không giả được.
- **Chụp ảnh** xuất bưu thiếp PNG kèm tên nơi, giờ, thời tiết và điểm săn mây.
- **Sự sống**: người đi lại trong phố, thuyền trên sông, chim bay, đèn lồng tự lên khi trời tối.
- **Bóng đổ** theo mặt trời thật, khung chiếu bám theo chỗ đang nhìn.
- **Thảm cỏ** hàng chục nghìn khóm quanh người chơi, lay theo gió, tự trải lại khi bạn đi — cộng cây,
  bụi và đá từ bộ asset CC0 thay cho hình nón.
- **Người thật**: nhân vật có khung xương, animation đứng / đi / chạy — cả bạn lẫn dân làng.
- Âm thanh phản ứng theo thời tiết thật; ảnh preview khi chia sẻ link.

## Deploy

GitHub Actions (`.github/workflows/build.yml`) build hai image Linux amd64 khi push
lên `main`: `ghcr.io/tun2g/otrip-web` và `ghcr.io/tun2g/otrip-server`, với tag
`latest` và `sha-<commit>`. Có thể chạy lại bằng `workflow_dispatch`.

Web chạy Next.js standalone; server chạy Node 24. Build context của cả hai
Dockerfile là thư mục gốc repo. GitHub repository Variables có thể ghi đè:

| Variable                   | Mặc định                      |
| -------------------------- | ----------------------------- |
| `NEXT_PUBLIC_SITE_URL`     | `https://otrip.chamee.site`   |
| `NEXT_PUBLIC_REALTIME_URL` | `wss://otrip-api.chamee.site` |

Hai giá trị được nhúng lúc build, đổi domain cần build lại image.

Cấu hình VPS nằm ở repo `devops`, thư mục `projects/otrip/`. Sau khi tạo env
từ file mẫu và trỏ DNS, chạy `./deploy.sh pull otrip-web otrip-server`; lần đầu
cần cập nhật domain và recreate Caddy theo README của repo đó. Kiểm tra web tại
`https://otrip.chamee.site/` và server tại `https://otrip-api.chamee.site/health`.
Phòng đi chung lưu trong RAM, khởi động lại server sẽ ngắt các phòng hiện tại.

### Kiểm tra multiplayer

`pnpm test:multiplayer` khởi động server tạm, tạo hai client thật và kiểm tra
vị trí lúc vào phòng, chuyển động hai chiều, chat, đi nhanh, người vào sau và rời phòng
ở cả bốn địa điểm. Kiểm tra trực quan trên VPS bằng hai cửa sổ vào cùng link mời.

Phòng đồng bộ vị trí/hướng nhân vật, xe đang cưỡi và tốc độ, đi nhanh, chat, **giờ
mô phỏng, thời tiết chọn tay và cả cái đồng hồ đang chạy** — giờ được _suy ra_ từ một
mốc thời gian của máy chủ chứ không phải mỗi máy tự đếm, nên hai người không lệch nhau
cả một giờ tuỳ lúc ai mở trang trước.

NPC, thuyền, dân làng và thú vẫn chạy riêng trên từng máy: tất cả đều sinh từ
`recipe.seed` rồi tích phân theo delta của chính máy đó, nên muốn khớp thì phải hoặc
đồng bộ hàng trăm phép biến đổi mười lần một giây, hoặc viết lại mọi module cho độc lập
khung hình. Chúng là phông cảnh; giờ và thời tiết mới là _nơi này_.

Mã phòng nằm trong URL dưới dạng `?r=`, nên tải lại trang không mất phòng và cái link
trên thanh địa chỉ chính là lời mời.

Bản đồ lớn có danh sách **Xe máy & thuyền**: chọn điểm để phóng tới vị trí,
xem khoảng cách và hướng dẫn tương tác. Điểm xe lấy từ cùng danh sách bãi đỗ
mà thế giới 3D sử dụng.

## Chưa làm

Tài khoản, lưu trữ lâu dài, phòng công khai và
bộ máy kiểm duyệt đi kèm. Kế hoạch đầy đủ trong `plans/`.
