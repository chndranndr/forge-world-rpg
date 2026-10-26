# Fworld

Aplikasi cerita RPG pribadi dengan frontend React + TypeScript + Vite dan backend Node.js lokal. Backend memakai SQLite untuk save, session, history, run, dan ledger penggunaan AI. Kebutuhan produk ada di [prd.md](prd.md); batas arsitektur dan acceptance ada di [rencana backend](backend_agent_Implementation_plan.md).

Antarmuka production mengikuti arah visual `mockups/`, tanpa mengadopsi simulasi AI atau gameplay prototipe.

## Menjalankan

Gunakan Node.js 24.13.x sesuai `.nvmrc`. Setup dependency dari lockfile:

```powershell
npm.cmd run setup
```

Untuk development, jalankan dua terminal dari folder proyek:

```powershell
npm.cmd run dev:server
```

```powershell
npm.cmd run dev
```

Buka `http://127.0.0.1:5173`. Vite meneruskan `/api` ke backend `http://127.0.0.1:3001`. Jangan ganti ke `localhost`; browser menyimpan IndexedDB legacy berdasarkan origin.

Untuk membuka aplikasi dari ponsel di jaringan lokal tepercaya, set `server.host` di `vite.config.js` ke `"0.0.0.0"`, lalu akses `http://<IPv4-laptop>:5173`. Izinkan Node.js hanya pada profil Private Windows Firewall. Backend tetap bind ke loopback; saat development, pemeriksaan `Host`/`Origin` hanya mengizinkan origin exact dari alamat IPv4 private lokal pada port 5173. Perangkat lain di jaringan itu juga dapat mengakses aplikasi; jangan gunakan Wi-Fi publik. Browser modern menyediakan Web Crypto `getRandomValues()` pada HTTP LAN untuk membuat ID aksi yang aman. Restart kedua server setelah mengubah konfigurasi.

Untuk menjalankan build lokal:

```powershell
npm.cmd run build
npm.cmd run start
```

Backend menyajikan frontend dan API pada `http://127.0.0.1:5173`. Hentikan server development sebelum menjalankannya karena port harus tersedia dan tidak berpindah otomatis.

## Tampilan

Antarmuka memakai shell gelap bernuansa hutan dengan aksen kuningan: rail navigasi (Perpustakaan, Sesi, Pengaturan), header halaman, aksi `Buat dunia` yang selalu terlihat di perpustakaan, ringkasan sesi terakhir, grid dunia, panggung cerita, dan drawer **Catatan lapangan**. Setiap kartu dunia menampilkan jumlah sesi dan pintasan `Sesi baru`; halaman dunia menyediakan formulir untuk memulai sesi independen dari definisi tersimpan. Settings dan editor memakai sistem gelap yang sama. Rail selebar 248px berubah menjadi bar horizontal pada ≤1199px dan navigasi bawah pada ≤899px.

Panggung cerita memberi label **Adegan N · lokasi** (turn bukan bab) dan memakai judul dunia sebagai judul panggung. Dialog hanya diambil dari turn terakhir; percakapan turn lama tetap ada di riwayat. Kartu dunia memakai enam ilustrasi sampul 3:2 (`coast`, `lantern`, `archive`, `desert`, `mountain`, `rain`) yang dipilih secara deterministik dari genre dan judul.

Token warna, tipografi, spasi, radius, bayangan, dan gerak ada di `src/styles.css`. Font Newsreader, Public Sans, dan IBM Plex Mono dibundel di `src/assets/fonts` dan dideklarasikan lewat `@font-face`. Tekstur kulit memakai `src/assets/leather.svg`; token CSS asli dari desain tidak termasuk dalam distribusi aplikasi.

## Credential dan data

Opsional, buat `.env` dari `.env.example`, lalu isi `GEMINI_API_KEY` dan/atau `OPENROUTER_API_KEY`. File `.env` diabaikan Git. Settings juga bisa menerima atau mengganti API key; backend menyimpannya sebagai `FWORLD_GEMINI_API_KEY` atau `FWORLD_OPENROUTER_API_KEY` di `.env`, dan nilai ini diprioritaskan atas credential environment biasa. Backend hanya mengembalikan status configured; key tidak tersimpan permanen di browser, database game, log, backup, atau export. Request AI nyata memerlukan koneksi internet dan credential provider yang sesuai.

Provider ketiga adalah **OpenAI-compatible** melalui profil AI. Endpoint custom memakai HTTPS, atau HTTP khusus loopback (`localhost`, `127.0.0.1`, `[::1]`) untuk fixture lokal; Base URL wajib memuat prefix API seperti `https://api.example.com/v1` dan tidak boleh berakhir dengan `/chat/completions`. Key endpoint boleh kosong untuk endpoint tanpa autentikasi.

Profil AI menyimpan nama, provider, model, prompt narrator, dan Base URL custom di SQLite; API key disimpan terpisah di `.env` sebagai `FWORLD_AI_KEY_<credentialId>` dan hanya dikembalikan sebagai status configured. Metadata dan key disimpan lewat tombol berbeda. Mengubah nama/model/prompt mempertahankan identitas credential; mengubah provider atau Base URL membuat identitas baru tanpa menyalin key lama. Sesi menyimpan snapshot saat profil dimulai atau diterapkan, jadi mengedit profil tidak mengubah sesi berjalan sampai **Terapkan profil** ditekan; key yang dirotasi pada identitas yang sama dipakai run berikutnya. Profil default sesi baru dipilih di Settings dan baru tersimpan setelah **Simpan pengaturan AI**. Profil tidak ikut template, save JSON, atau export; backup SQLite membawa metadata dan binding tanpa key.

Provider, model, dan prompt sistem narrator diatur melalui Settings. Prompt bawaan dikemas dari `shared/narrator-system-prompt.json`; teks yang diedit menggantikan seluruh prompt bawaan dan dapat dipulihkan kapan saja. Perubahan default global baru disimpan setelah tombol **Simpan pengaturan AI** ditekan, lalu disalin ke sesi baru. Preferensi ukuran teks langsung diterapkan dan disimpan. Prompt sesi aktif tersimpan terpisah di konfigurasi sesi serta ikut save/export; template game tidak membawa prompt. Prompt wajib berisi teks non-whitespace dan dibatasi 8.000 karakter.

**Editor** memuat ringkasan, skenario, pemain, peta dunia, NPC, item, inventaris awal, lorebook, atribut, sumber daya, relasi, dan pratinjau. Bagian dikelompokkan tetapi tetap bebas dipilih. Draft dunia baru belum tersimpan sampai **Simpan dunia** ditekan. Menerapkan template mengganti bidang konten draft dan menghapus bidang opsional yang tidak disertakan template. Mengedit dunia tersimpan memperbarui definisi untuk sesi baru; sesi yang telah dimulai mempertahankan snapshot awal. Perubahan draft harus disimpan sebelum **Mulai sesi baru** aktif di Editor; sesi yang sudah ada dapat dilanjutkan tanpa mengubah progresnya.

Untuk request OpenRouter `google/gemini-*`, provider dipin ke `google-ai-studio` tanpa fallback agar signature reasoning tetap pada endpoint yang sama selama lanjutan tool. Jika endpoint itu tidak tersedia, run gagal alih-alih berpindah ke provider Google lain.

Uji koneksi memakai prompt singkat yang independen dari prompt narrator dan tidak memvalidasi ukuran context cerita. Prompt narrator terhitung dalam batas input narrator 512.000 karakter dan sekitar 128.000 token; nilai relasi aktif dikirim sekali, sedangkan detail NPC lain tersedia lewat tool. Jika context wajib masih terlalu besar, run berhenti sebelum memanggil provider dan menampilkan `CONTEXT_TOO_LARGE` beserta ukuran aktual dan batasnya, tanpa mengubah save. Mengubah prompt dapat memengaruhi perilaku narrator, tetapi engine dan API tetap memvalidasi perubahan state secara deterministik. Kegagalan run yang tak terduga mencatat ID session/run, jenis aksi, provider/model jika tersedia, tipe/kode error, dan status HTTP di terminal backend tanpa mencatat prompt, isi respons, atau credential. Restart backend setelah perubahan kode server; server development tidak memuat ulang handler yang sudah berjalan.

Masing-masing permintaan model narrator dibatasi 4.096 token output; satu permintaan perbaikan tetap dibatasi 1.800 token.

### Runtime agen dan cache konteks

Narator dijalankan melalui modul internal di `server/agent/`. `context.ts` membangun konteks dan memisahkan snapshot stabil (game, scenario, player) dari konteks dinamis (aksi, state, history, lore terpilih); `knowledge.ts` memuat history, peta, lore, dan ringkasan dari SQLite; `harness.ts` memiliki empat tool tetap serta validasi domain; `runtime.ts` menegakkan batas 60 detik, tiga panggilan model, dan satu perbaikan; `gemini-cache.ts` mengelola cache eksplisit Google. Tool tetap dieksekusi lokal dan tidak pernah menulis langsung ke database.

Cache eksplisit hanya aktif jika environment server `FWORLD_GEMINI_CONTEXT_CACHE=explicit`; nilai kosong atau `off` memakai jalur uncached. Hanya model Gemini 2.5/3 langsung yang memenuhi syarat. Resource memakai TTL 300 detik tanpa perpanjangan, handle hanya disimpan di memori proses dan tidak masuk SQLite, save, atau backup, dan maksimal 32 resource aktif per proses. Penolakan pembuatan cache 400/404 dicatat sementara sebagai bypass; kegagalan cache lain menghentikan run dengan `CONTEXT_CACHE_UNAVAILABLE`. Respons provider yang dilaporkan tetap menjadi sumber token cache dan reasoning; cache implisit provider tidak dimatikan saat mode `off`.

Jejak runtime dibatasi 128 event dan disimpan di `context_telemetry.trace_json` tanpa prompt, credential, nama resource, atau handle discovery. Jejak bukan pengganti status run tersimpan: proposal yang divalidasi belum tentu berhasil di-commit. `npm.cmd run eval` menjalankan verifikasi HTTP terisolasi dan protokol Google offline; hasilnya membuktikan integrasi terhadap fixture, bukan cache cloud, kualitas bahasa, atau penghematan biaya nyata.

Gunakan **Settings → Migrasi data IndexedDB** dari origin canonical untuk mengunduh atau mentransfer data lama. Transfer memvalidasi seluruh store, memakai Web Lock, memverifikasi read-back, dan membiarkan IndexedDB lama utuh. Gunakan **Backup backend** untuk backup/pemulihan SQLite. Menghapus cerita menghapus seluruh sesi dan riwayatnya setelah konfirmasi; penghapusan ditolak saat run AI masih aktif. Restore save JSON v1 membuat salinan dengan ID baru; template JSON tetap di alur Create Game.

## NPC dalam sesi

Jika ingin cerita dimulai tanpa NPC, hapus NPC awal di **Editor** sebelum memulai session. Saat karakter player berinteraksi langsung dengan orang baru, narrator dapat mendaftarkannya sebagai NPC pada sesi itu. Sekadar menyebut atau melihat orang tidak cukup untuk membuat NPC.

NPC yang didaftarkan tersimpan bersama sesi dan tidak mengubah template game. Mereka dapat muncul lagi dalam cerita dan tercakup dalam ekspor serta pemulihan save. Tab **Orang** menampilkan karakter yang hadir di adegan saat ini.

NPC yang terikat lokasi hanya hadir di lokasi itu. Pemain yang kembali ke lokasi tersebut menemui NPC itu lagi, kecuali kehadirannya pernah disetel eksplisit absen. Pada turn perjalanan, sapaan langsung kepada NPC di lokasi tujuan sudah dihitung sebagai interaksi di tujuan; sekadar menyebut nama tetap tidak membuka detail atau pengetahuan pribadinya. Efek `NPC_PRESENCE` yang menandai hadir mengikat NPC ke lokasi adegan saat itu, sehingga narator dapat memunculkannya kembali setelah perpindahan lokasi. Untuk itu narator menerima daftar identitas publik (nama dan ID) NPC yang pernah ditemui tetapi sedang di luar adegan; daftar ini tidak memuat detail, pengetahuan pribadi, relasi, atau lokasi, dan tidak membuka tool detail NPC. Tanpa efek itu, NPC yang tetap terikat di lokasi lain tidak otomatis hadir hanya karena namanya disebut.

## Format cerita

Pesan narator dan NPC mendukung Markdown untuk paragraf, heading, penekanan, daftar, kutipan, kode, dan tautan. HTML mentah tidak dirender; gambar Markdown hanya menampilkan teks alternatif dan tidak mengambil gambar eksternal. Narasi tampil italic kuning pada panel gelap; teks di antara tanda kutip ganda tampil normal. Pesan pemain dan event sistem tetap teks biasa.

## Format lorebook dan save

SQLite memakai schema v5. Database versi 1 sampai 4 dimigrasikan saat dibuka; tabel schema yang hilang dibuat ulang saat startup tanpa menghapus tabel lain. Isi tabel yang terhapus tidak dapat dipulihkan dari schema—restore backup untuk mendapatkan kembali datanya; indeks pencarian turunan dibangun ulang dari data yang masih ada. Restore memvalidasi dan memigrasikan salinan staging sebelum mengganti database aktif. Backup SQLite mencakup pack lore, indeks, pin session, history, ringkasan cerita, telemetri konteks, serta metadata profil AI dan binding session. Credential provider selalu berada di luar backup.

`examples/lorebook-prontera.json` adalah pack kecil dengan 21 entri berprosa asli, berlisensi CC0-1.0. `examples/lorebook-game.json` adalah template playable yang merujuk versi pack tersebut. Artikel lore tidak otomatis menjadi NPC playable, item inventory, atau effects. Pemetaan memakai `metadata.actorId` atau `metadata.itemId` yang harus menunjuk definisi game.

Pack memakai `format: "fworld-lorebook"` dan `version: 1`. Header `pack` memiliki `id`, versi publikasi numerik, dan nama. Setiap entri memiliki ID ber-namespace, jenis, nama/alias, summary, body, tags, visibility, metadata, serta provenance. Links memakai ID entri yang sama. `CONNECTED_TO` sudah bidirectional; jangan menambahkan pasangan reverse yang sama. Parent lore boleh menunjuk region atau world tanpa menjadikannya tujuan perjalanan.

Simpan sumber, lisensi, revisi, canon, dan era pada provenance. Gunakan konten asli atau sumber yang izinnya sudah diperiksa. Field lisensi mencatat atribusi, bukan memverifikasi hak penggunaan. Jangan memasukkan credential, executable HTML, atau artikel pihak ketiga tanpa izin.

Import JSON lorebook dibatasi 8 MiB, 5.000 entri, dan 20.000 links. Batas request HTTP juga mencakup envelope JSON. Dry-run hanya memvalidasi. Publikasi bersifat atomic dan versi yang sudah terbit tidak dapat diubah. Import ulang konten identik bersifat idempotent; revisi konten memerlukan nomor versi baru. Tidak ada crawler, wiki ingestion, atau CLI corpus besar.

Di **Editor**, jalankan dry-run pada file JSON, terbitkan versi, lalu ikat versi itu ke game. Pencarian dan preview menampilkan entri sesuai lokasi. Turn narator menggabungkan lore lokal dengan hasil yang cocok dengan aksi sebelum menerapkan batas konteks. Lore ber-metadata `actorId` hanya tersedia saat NPC cocok menjadi principal narator, kecuali entri discovery yang sudah ditemukan. Untuk entri discovery yang belum ditemukan, model menerima ID acak sementara, bukan isi lore. Isi lengkap baru dikirim pada pemanggilan narator berikutnya setelah `DISCOVER_LORE` berhasil di-commit.

Game dan session mengikat `{packId, version}` secara tepat. Session menyimpan pin versi dan peta lokasi saat mulai; perubahan template tidak mengganti pin session aktif. Save tanpa lore tetap memakai `fworld-save` v1. Save dengan lore memakai v2 dan manifest `loreDependencies` berisi versi serta digest, bukan body seluruh pack.

Untuk memindahkan save v2, pindahkan juga export JSON setiap versi pack. Install pack terlebih dahulu, lalu restore save. `LORE_DEPENDENCY_MISSING` berarti versi belum tersedia; ketidakcocokan digest ditolak tanpa menulis sebagian save. Jangan mengganti versi yang hilang dengan versi terbaru. Template lama dan save v1 tanpa lore tetap dapat dipakai.

## Perintah

| Tujuan                    | Perintah                 |
| ------------------------- | ------------------------ |
| Setup                     | `npm.cmd run setup`      |
| Frontend development      | `npm.cmd run dev`        |
| Backend development       | `npm.cmd run dev:server` |
| Typecheck dan format      | `npm.cmd run check`      |
| Tes                       | `npm.cmd test`           |
| Verifikasi offline        | `npm.cmd run eval`       |
| Build frontend + server   | `npm.cmd run build`      |
| Jalankan build lokal      | `npm.cmd run start`      |
| Seluruh pemeriksaan lokal | `npm.cmd run doctor`     |

`npm.cmd run doctor` menjalankan typecheck client/server, pemeriksaan format, seluruh tes, serta build frontend dan server. `node:sqlite` pada Node 24.13.x masih mengeluarkan peringatan experimental dari runtime.

## Panduan agen

[AGENTS.md](AGENTS.md) memuat aturan workspace. [.harness/manifest.json](.harness/manifest.json) mencatat capability dan evidence yang tersedia. [implementation_plan.md](implementation_plan.md) adalah catatan historis implementasi UI browser-only; gunakan [backend_agent_Implementation_plan.md](backend_agent_Implementation_plan.md) untuk scope dan acceptance saat ini.
