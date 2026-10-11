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

Uji koneksi memakai prompt singkat dan tidak memvalidasi ukuran context cerita. Narrator membatasi context wajib plus pesan terbaru hingga 24.000 karakter; nilai relasi aktif dikirim sekali, sedangkan detail NPC lain tersedia lewat tool. Jika context wajib masih terlalu besar, run berhenti sebelum memanggil provider dan menampilkan `CONTEXT_TOO_LARGE` beserta ukuran aktual dan batasnya, tanpa mengubah save. Restart backend setelah perubahan kode server; server development tidak memuat ulang handler yang sudah berjalan.

Gunakan **Settings → Migrasi data IndexedDB** dari origin canonical untuk mengunduh atau mentransfer data lama. Transfer memvalidasi seluruh store, memakai Web Lock, memverifikasi read-back, dan membiarkan IndexedDB lama utuh. Gunakan **Backup backend** untuk backup/pemulihan SQLite. Restore save JSON v1 membuat salinan dengan ID baru; template JSON tetap di alur Create Game.

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
