# Asset credits

Toàn bộ asset âm thanh trong dự án này là **CC0 1.0 Universal (public domain)**.
CC0 không bắt buộc ghi credit — file này tồn tại để truy xuất nguồn gốc và kiểm chứng license.

## Ambience — Freesound (CC0)

Tải qua CDN preview công khai (`-hq.mp3`, đo được 48 kHz ~210 kbps). Bản gốc không nén cần đăng nhập Freesound.
License của **từng file** được kiểm bằng cách đọc trang sound và tìm `publicdomain/zero` — không tin tên bộ sưu tập.

| File                                       | Nguồn                                                     | Tác giả        | Dài   |
| ------------------------------------------ | --------------------------------------------------------- | -------------- | ----- |
| `birds-morning__fs546521.mp3`              | [freesound.org/s/546521](https://freesound.org/s/546521/) | trezz77        | 2:02  |
| `birds-village-morning__fs737615.mp3`      | [freesound.org/s/737615](https://freesound.org/s/737615/) | AshruKumarsEye | 7:46  |
| `wind-mountain-long__fs406951.mp3`         | [freesound.org/s/406951](https://freesound.org/s/406951/) | lotman         | 16:41 |
| `wind-trees-banff__fs574284.mp3`           | [freesound.org/s/574284](https://freesound.org/s/574284/) | TRP            | 2:45  |
| `wind-mountain-soundscape__fs577263.mp3`   | [freesound.org/s/577263](https://freesound.org/s/577263/) | BotanicalVan   | 2:59  |
| `water-stream-small__fs197023.mp3`         | [freesound.org/s/197023](https://freesound.org/s/197023/) | Yuval          | 2:23  |
| `water-stream-long__fs550756.mp3`          | [freesound.org/s/550756](https://freesound.org/s/550756/) | chrov\_        | 8:34  |
| `vn-cattien-night__fs806575.mp3`           | [freesound.org/s/806575](https://freesound.org/s/806575/) | marc.om        | 2:00  |
| `rain-prairie-wind__fs414113.mp3`          | [freesound.org/s/414113](https://freesound.org/s/414113/) | felix.blume    | 2:51  |
| `rain-side-yard-loopable__fs711337.mp3`    | [freesound.org/s/711337](https://freesound.org/s/711337/) | AderuMoro      | 1:29  |
| `rain-on-lake-ontario__fs572429.mp3`       | [freesound.org/s/572429](https://freesound.org/s/572429/) | TRP            | 5:49  |
| `water-lapping-lake-ontario__fs518467.mp3` | [freesound.org/s/518467](https://freesound.org/s/518467/) | robotjay       | 1:02  |

## Nhạc nền — archive.org (CC0)

| File                                   | Nguồn                                                                                                  | Tác giả    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------- |
| `HoliznaCC0-DreamScape.mp3`            | [archive.org/details/holizna-cc-0-cosmic-waves](https://archive.org/details/holizna-cc-0-cosmic-waves) | HoliznaCC0 |
| `HoliznaCC0-Rain-Sleep-Meditation.mp3` | [archive.org/details/holizna-cc-0-cosmic-waves](https://archive.org/details/holizna-cc-0-cosmic-waves) | HoliznaCC0 |

## Chờ bổ sung thủ công

33 bài lofi CC0 của HoliznaCC0 — [Lo-fi and Chill trên Free Music Archive](https://freemusicarchive.org/music/holiznacc0/lo-fi-and-chill).
FMA yêu cầu đăng nhập mới tải được nên không thể tự động hoá; tải về rồi đặt vào `assets/audio/raw/music/`.

## Nguồn bị loại

- **Pixabay Music** — license cấm dùng content trong sản phẩm mà content là giá trị chính; dự án có music player nên rơi vào vùng xám. Không dùng.
- **Nhạc cụ Việt (sáo, khèn, đàn tranh)** — không tìm được bản thu CC0 nào ở dạng bài nhạc. Ba file sáo
  (`flute-asian-improv`, `flute-dizi-chops`, `flute-bamboo-agadir`) từng tải về rồi bỏ: music player luôn
  phát một bài nền, nên thêm một lớp sáo có cao độ là cho hai nguồn có nhạc tính chạy song song mà không
  cùng khoá, cùng nhịp. Gió, mưa, chim là tiếng ồn nên trộn được; một câu sáo thì không.
- **`birds-swiss-mountain`** — bỏ cùng lúc. `ambience.ts` cho mọi lớp `birds` chung một gain, nên lớp chim
  thứ hai ở Tà Xùa chỉ làm chim to hơn, không làm chim chi tiết hơn.

## Dựng bed từ file gốc

Mỗi bed là AAC ~64 kbps stereo, chuẩn hoá về **-21 LUFS** để khớp bộ đang có (`wind-ridge` -21.8,
`wind-trees` -21.4, `stream` -21.0), dùng `loudnorm` ở chế độ `linear` để chỉ cộng một mức gain cố định —
nén động sẽ làm phẳng đúng cái cơn gió mà bed mưa sống nhờ. Đuôi được gập lại lên đầu bằng `acrossfade`
nên file là vòng lặp liền: engine đặt `source.loop` và không crossfade, bed chạy suốt phiên.

| Bed              | File gốc                                   | Cửa sổ        | Ghi chú                                      |
| ---------------- | ------------------------------------------ | ------------- | -------------------------------------------- |
| `rain-ridge.m4a` | `rain-prairie-wind__fs414113.mp3`          | 50s, dài 90s  | mưa đồng trống có gió — cho sống núi Tà Xùa  |
| `rain-roof.m4a`  | `rain-side-yard-loopable__fs711337.mp3`    | 0s, dài 86s   | mưa trên mái, máng, hiên — cho phố cổ Hội An |
| `rain-lake.m4a`  | `rain-on-lake-ontario__fs572429.mp3`       | 160s, dài 90s | mưa rơi xuống mặt nước — Tràng An, Hồ Tây    |
| `water-lap.m4a`  | `water-lapping-lake-ontario__fs518467.mp3` | 0s, dài 60s   | nước vỗ bờ — Hội An, Hồ Tây                  |

Cửa sổ chọn theo đoạn 90s có mức ngắn hạn đều nhất trong file gốc (chênh phân vị 5–95 nhỏ nhất), vì một
cơn gió nằm trong vòng lặp sẽ quay lại đúng mỗi 90 giây và tai nhận ra chu kỳ. `water-lap` chỉ dài 60s vì
file gốc dài 61.8s — trong năm bản thu nước vỗ bờ CC0 đã đo, đây là bản duy nhất liên tục (entropy 0.81)
thay vì một chuỗi tiếng vỗ rời rạc trên nền tĩnh.

## Mô hình 3D — CC0

| Nhóm                                                      | Nguồn                                                                                                  | License     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| 41 asset môi trường (cây, cỏ, bụi, đá, lau sậy, vách núi) | [Gobkit free kit](https://gobkit.com/freebies) — manifest máy đọc tại `gobkit.com/api/free`            | **CC0 1.0** |
| Nhân vật người có khung xương và animation                | [Animated Human by @Quaternius](https://opengameart.org/content/animated-human-low-poly) (OpenGameArt) | **CC0 1.0** |

Bản gốc nằm trong `assets/models/raw/` (gitignore). Bản dùng thật nằm trong `apps/web/public/models/`.
