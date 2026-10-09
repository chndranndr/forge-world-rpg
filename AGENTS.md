# Panduan agen


- Baca [README.md](README.md) untuk kondisi aktual, perintah, dan verifikasi.
- Baca [prd.md](prd.md) untuk kebutuhan produk; PRD menggambarkan target, bukan fitur yang sudah tersedia.
- [Manifest Kuskus](.harness/manifest.json) mencatat profil dan bukti verifikasi.
- Pertahankan React + TypeScript + Vite, CSS biasa, dan backend lokal Node.js + SQLite sesuai [rencana backend](backend_agent_Implementation_plan.md). Jangan menambahkan login, cloud sync, akses jaringan umum, atau database remote.
- Init hanya menyiapkan scaffold. Implementasikan fitur produk ketika diminta; jangan membuat modul kosong untuk rencana masa depan.
- Gunakan origin aplikasi `http://127.0.0.1:5173` secara konsisten. Database server adalah sumber save aktif; IndexedDB hanya dibaca untuk migrasi/recovery dan bukan fallback writer ketika backend mati.
- Draft editor yang belum disimpan tetap berada di memory browser. Simpan credential provider hanya di environment server atau `.env` yang di-ignore; jangan masukkan credential ke source, bundle, log, atau export.
- Jalankan backend pada Node.js 24.13+ loopback. Jangan membuka bind publik atau menambahkan akses LAN tanpa perubahan kebutuhan.
- Pertahankan pekerjaan user; jangan push, atau memasukkan credential ke source/log/backup.
- Setelah perubahan, jalankan `npm run doctor` dan review diff. Di PowerShell gunakan `npm.cmd` jika shim `npm` diblokir.
- Solve the problem, not merely the prompt
- Test behavior, not implementation
- Reuse before creating
- Prefer code that is simple, explicit, cohesive, and consistent with the repository
- If an assumption is uncertain, verify it.
- If an approach fails, revise the hypothesis and continue.
- Never weaken tests or hide failures just to make the task pass.
