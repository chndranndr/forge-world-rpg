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

Untuk menjalankan build lokal:

```powershell
npm.cmd run build
npm.cmd run start
```

Backend menyajikan frontend dan API pada `http://127.0.0.1:5173`. Hentikan server development sebelum menjalankannya karena port harus tersedia dan tidak berpindah otomatis.

## Credential dan data

Opsional, buat `.env` dari `.env.example`, lalu isi `GEMINI_API_KEY` dan/atau `OPENROUTER_API_KEY`. File `.env` diabaikan Git. Settings juga bisa menerima atau mengganti API key; backend menyimpannya sebagai `FWORLD_GEMINI_API_KEY` atau `FWORLD_OPENROUTER_API_KEY` di `.env`, dan nilai ini diprioritaskan atas credential environment biasa. Backend hanya mengembalikan status configured; key tidak tersimpan permanen di browser, database game, log, backup, atau export. Request AI nyata memerlukan koneksi internet dan credential provider yang sesuai.

Provider dan model dipilih di Settings. Pilihan global disimpan lokal di browser dan menjadi default sesi baru; konfigurasi setiap sesi aktif disimpan terpisah dan dapat diubah dari Settings tanpa mengubah default global.

Uji koneksi memakai prompt singkat dan tidak memvalidasi ukuran context cerita. Narrator membatasi context wajib plus pesan terbaru hingga 24.000 karakter; nilai relasi aktif dikirim sekali, sedangkan detail NPC lain tersedia lewat tool. Jika context wajib masih terlalu besar, run berhenti sebelum memanggil provider dan menampilkan `CONTEXT_TOO_LARGE` beserta ukuran aktual dan batasnya, tanpa mengubah save. Restart backend setelah perubahan kode server; server development tidak memuat ulang handler yang sudah berjalan.

Gunakan **Settings → Migrasi data IndexedDB** dari origin canonical untuk mengunduh atau mentransfer data lama. Transfer memvalidasi seluruh store, memakai Web Lock, memverifikasi read-back, dan membiarkan IndexedDB lama utuh. Gunakan **Backup backend** untuk backup/pemulihan SQLite. Restore save JSON v1 membuat salinan dengan ID baru; template JSON tetap di alur Create Game.

## Format lorebook dan save

SQLite memakai schema v2. Database v1 dimigrasikan saat dibuka; restore memvalidasi dan memigrasikan salinan staging sebelum mengganti database aktif. Backup SQLite mencakup pack lore, indeks, pin session, history, dan ringkasan cerita. Credential provider tetap berada di luar backup.

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
| Build frontend + server   | `npm.cmd run build`      |
| Jalankan build lokal      | `npm.cmd run start`      |
| Seluruh pemeriksaan lokal | `npm.cmd run doctor`     |

`npm.cmd run doctor` menjalankan typecheck client/server, pemeriksaan format, seluruh tes, serta build frontend dan server. `node:sqlite` pada Node 24.13.x masih mengeluarkan peringatan experimental dari runtime.

## Panduan agen

[AGENTS.md](AGENTS.md) memuat aturan workspace. [.harness/manifest.json](.harness/manifest.json) mencatat capability dan evidence yang tersedia. [implementation_plan.md](implementation_plan.md) adalah catatan historis implementasi UI browser-only; gunakan [backend_agent_Implementation_plan.md](backend_agent_Implementation_plan.md) untuk scope dan acceptance saat ini.
