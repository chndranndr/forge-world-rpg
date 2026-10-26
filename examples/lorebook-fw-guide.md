# Panduan cerita FW di SCBD

Paket ini memakai bentuk yang sama dengan
[lorebook-evolving-guide.md](lorebook-evolving-guide.md). Aturan format ada di
sana. Berkas ini hanya urutan muat dan tangga cerita ini.

Semua orang, perusahaan, dan organisasi fiktif. SCBD hanya latar. Setiap
pasangan romantis atau seksual berusia 21 tahun atau lebih. Penolakan
mengakhiri quest sebagai gagal. Tahap mafia adalah peristiwa fiksi plus
akibatnya, bukan prosedur.

## Berkas

| Berkas                   | Isi                       | Peran                   |
| ------------------------ | ------------------------- | ----------------------- |
| `lorebook-fw-story.json` | `fworld-lorebook` versi 1 | Dunia, tempat, catatan. |
| `lorebook-fw-game.json`  | `fworld-template` versi 1 | Stat, item, peta, pin.  |
| `lorebook-fw-guide.md`   | dokumen ini               | Tidak dibaca aplikasi.  |

## Urutan memuat

1. Buka Editor, mulai **draf baru**. Ekspor dulu bila draf ini sudah berisi
   kerjaan, karena impor template mengganti isi game.
2. Di **Lorebook**, impor `lorebook-fw-story.json`. Periksa dry-run: pack
   `fworld-fw-scbd` versi `1`, 18 entri, 11 tautan.
3. Terbitkan pack tervalidasi.
4. Impor `lorebook-fw-game.json` lewat **Impor template JSON**, lalu terapkan.
5. Pastikan pin menunjuk `fworld-fw-scbd` versi `1` dan mulai di Kost Melati.
6. Simpan, lalu mulai sesi baru.

## Yang mesin tidak lakukan

Tidak ada jam harian, toko otomatis, atau daftar wanita di data awal. Narrator
memajukan `Hari N`, memberi koin, dan mendaftarkan wanita saat diajak bicara.
Wanita yang sama tidak diganti NPC baru; karier naik lewat fakta.

Flag tahap baru menjadi `true` setelah item tonggaknya **dipakai**. Koin toko
terpotong saat item toko dipakai, bukan saat diberikan. Pemakaian gagal utuh
bila koin kurang atau atribut sudah 10; item itu tetap di inventaris.

## Tangga

| Item                     | Setelah peristiwa ini                         | Membuka            |
| ------------------------ | --------------------------------------------- | ------------------ |
| `item:kontak-anonim`     | Wanita 21+ setuju bertemu, bukan chat pertama | Kafe Bawah Tanah   |
| `item:kunci-apartemen`   | Ia setuju FWB atau ONS                        | Apartemen Sudirman |
| `item:struk-hadiah`      | Ia setuju pinjam uang atau belikan barang     | tahap manfaat      |
| `item:jadwal-kerja`      | Ia setuju membantu kerja                      | tahap harem kerja  |
| `item:akses-studio`      | Partner masuk lingkaran kreator fiktif        | Studio Konten      |
| `item:kartu-fraksi`      | Politisi fiktif 21+ menyepakati aliansi       | Kantor Fraksi      |
| `item:undangan-panggung` | Reputasi publik sudah terjadi                 | tier puncak        |
| `item:mandat-sirkel`     | Usaha sudah jalan dan tawaran Sirkel diterima | Gudang Senayan     |

Tier wanita: karyawati atau mahasiswa 21+; sesudah studio, kreator fiktif;
sesudah fraksi, politisi fiktif; sesudah undangan panggung, model, artis lokal
fiktif, atau bintang tamu internasional fiktif.

## Toko FW

Quest berhasil memberi 5 koin. Gagal mengambil 2 koin bila saldo cukup; bila
tidak, hukumannya naratif. Harga dipotong saat dipakai: skrip chat 3, paket
anon 3, voucher kafe 4, kartu hotel 6, serum otot 8, modul logika 8, setelan
rapi 8, jimat lift 10, suplemen ukuran 12.

Atribut awal: Kekuatan 3, Kecerdasan 5, Karisma 3, Keberuntungan 3, Ukuran 3.
Maksimum masing-masing 10. Uang awal 8 juta.
