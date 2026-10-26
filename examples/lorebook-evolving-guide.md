# Panduan cerita berkembang: preman → residivis → mafia → politisi

Paket contoh ini memperlihatkan cara membuat cerita yang bisa naik tahap tanpa
mengubah mesin game. Semua nama tokoh, tempat, dan organisasi fiktif. Isinya
boleh Anda ganti, tetapi pertahankan bentuk datanya.

## Berkas dalam paket ini

| Berkas                         | Isi                              | Peran                                                                                                 |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `lorebook-evolving-story.json` | format `fworld-lorebook` versi 1 | Artikel dunia, lokasi, item, faksi, dan aktivitas penemuan. Diimpor lewat bagian Lorebook.            |
| `lorebook-evolving-game.json`  | format `fworld-template` versi 1 | Definisi game: stat, sumber daya, item tonggak, peta, dan pin lorebook. Diimpor lewat toolbar editor. |
| `lorebook-evolving-guide.md`   | dokumen ini                      | Panduan penulis. Tidak dibaca aplikasi dan tidak boleh dimasukkan ke dalam JSON.                      |

## Urutan memuat di Editor

1. Buka Editor dan mulai **draf baru**. Jangan memakai game yang sedang Anda
   tulis tanpa mengekspornya lebih dahulu.
2. Buka bagian **Lorebook**, lalu tekan **Impor JSON lorebook (maks. 8 MiB)** dan
   pilih `lorebook-evolving-story.json`.
3. Periksa hasil validasi tanpa penulisan (dry-run). Pastikan nama, id, versi,
   jumlah entri, dan jumlah tautan sesuai.
4. Tekan **Terbitkan pack tervalidasi**. Versi yang diterbitkan bersifat tetap.
5. Buka toolbar editor, tekan **Impor template JSON**, pilih
   `lorebook-evolving-game.json`, lalu tinjau pratinjau dan terapkan
   penggantian.
6. Periksa bahwa pin lorebook menunjuk tepat `fworld-evolving-story` versi `1`,
   dan bahwa peta awal menampilkan lima lokasi dengan Kampung Tegal sebagai
   titik mulai.
7. Simpan game, lalu mulai sesi baru.

Impor template **mengganti** isi bidang game, bukan menggabungkan peta atau
daftar item milik game lain. Bila Anda sudah punya pekerjaan sendiri, ekspor
dulu lewat **Ekspor template JSON** sebelum menerapkan template ini.

## Format lorebook

Bidang tingkat atas hanya lima dan semuanya wajib:

| Bidang    | Aturan                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------- |
| `format`  | Harus `"fworld-lorebook"`.                                                                         |
| `version` | Versi format, harus `1`.                                                                           |
| `pack`    | `{ id, version, name, description? }`. `id` berupa penanda aman, `version` bilangan bulat positif. |
| `entries` | Array entri, maksimal 5.000.                                                                       |
| `links`   | Array tautan, maksimal 20.000.                                                                     |

Setiap entri wajib memuat `id`, `kind`, `name`, `aliases`, `summary`, `body`,
`tags`, `visibility`, `metadata`, dan `provenance`. Prosa `summary` dan `body`
tidak boleh kosong.

- `kind`: `world`, `region`, `location`, `place`, `npc`, `faction`, `history`,
  `monster`, `item`, `activity`, `other`.
- `visibility`: `public`, `narrator`, `discovery`.
- `parentId` opsional dan hanya untuk hierarki entri, misalnya lokasi di bawah
  entri dunia.
- `links[].relation`: `PARENT_OF`, `CONNECTED_TO`, `LOCATED_IN`, `PRESENT_AT`,
  `RELATED_TO`.
- `metadata` opsional berisi `actorId`, `itemId`, `discoverAt`,
  `discoveryKeywords`, `requiredFlag`, `blockedByFlag`.
- `provenance` memuat `sourceId` wajib, ditambah `sourceUrl`, `license`,
  `revision`, `canon`, `era` bila perlu.

Aturan penulisan:

- `id` entri harus berpenanda namespace, misalnya `loc:kampung` atau
  `activity:preman`, memakai huruf, angka, titik, garis bawah, titik dua, atau
  tanda hubung, maksimal 128 karakter.
- `aliases` dan `tags` harus array; `metadata` dan `provenance` harus object.
  Array kosong dan object kosong sah, dan lebih baik ditulis eksplisit daripada
  dihilangkan pada bidang wajib.
- Jangan memakai komentar, koma di akhir, atau bidang dokumentasi tambahan di
  dalam JSON. Bidang tak dikenal akan ditolak.
- Tautan harus menunjuk entri yang ada, tidak boleh menautkan entri ke dirinya
  sendiri, dan tidak boleh membentuk lingkaran `parentId`.

Contoh satu entri penemuan yang sah dan dapat disalin:

```json
{
  "id": "activity:preman",
  "kind": "activity",
  "name": "Catatan iuran kampung",
  "aliases": ["buku iuran"],
  "summary": "Buku iuran kampung yang mencatat siapa membayar untuk keamanan gang.",
  "body": "Halaman terakhir memuat nama pemuda yang mengumpulkan uang dan tanggal dua kali sebuah gang dibakar. Membacanya butuh izin warga.",
  "tags": ["preman", "catatan"],
  "visibility": "discovery",
  "metadata": {
    "discoverAt": ["loc:kampung"],
    "discoveryKeywords": ["catatan", "buku iuran"]
  },
  "provenance": {
    "sourceId": "fworld-original-evolving-story",
    "license": "CC0-1.0",
    "canon": "original",
    "era": "modern-fiction"
  }
}
```

Rujukan peta dan flag yang berpasangan dengan entri di atas:

```json
{
  "worldMap": {
    "locations": [
      {
        "id": "loc:kampung",
        "name": "Kampung Tegal",
        "aliases": ["Tegal", "kampung"],
        "summary": "Kampung padat tempat pekerja pelabuhan tinggal.",
        "npcIds": []
      }
    ],
    "connections": [],
    "flags": { "arc_residivis": false }
  }
}
```

`discoverAt` harus memakai `id` lokasi persis seperti pada peta (`loc:...`),
bukan nama tampilan. `requiredFlag` dan `blockedByFlag` pada entri penemuan
merujuk nama flag yang dideklarasikan pada `worldMap.flags` dan hanya diperiksa
saat penemuan dijalankan.

## Format template dunia

Bidang tingkat atas: `format` (`"fworld-template"`), `version` (`1`),
`exportedAt`, dan `game`. Bidang `ai` opsional dan boleh dihilangkan.

Di dalam `game`, yang dipakai contoh ini:

| Bidang                                                                     | Isi contoh                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `title`, `description`, `genre`, `tone`, `language`, `ageRating`           | Identitas cerita. Contoh memakai `adult-18-plus`.                                         |
| `scenario.setting`, `startingSituation`, `worldRules`, `additionalContext` | Latar, kondisi awal, aturan sebab-akibat, dan data yang harus terlihat narrator.          |
| `attributes`                                                               | `nyali`, `akal`, `karisma`: min 0, maks 10, default 5.                                    |
| `resources`                                                                | `uang`: min 0, nilai awal 100, tanpa maksimum. `pengaruh`: min 0, maks 100, nilai awal 0. |
| `relationships`                                                            | `percaya`: min -10, maks 10, default 0.                                                   |
| `items`                                                                    | Ponsel dan tiga item tonggak.                                                             |
| `startingInventory`                                                        | Hanya `item:ponsel` sebanyak 1.                                                           |
| `worldMap`                                                                 | Lima lokasi, lima sambungan, tiga flag tahap bernilai `false`.                            |
| `startingLocationId`                                                       | `loc:kampung`.                                                                            |
| `lorebookRefs`                                                             | `[{ "packId": "fworld-evolving-story", "version": 1 }]`.                                  |

`player.attributes` dan `player.resources` ditulis sebagai object kosong agar
nilai awal diambil dari definisi stat dan sumber daya. Daftar `npcs` kosong
karena contoh ini ingin NPC muncul dari perjumpaan langsung saat bermain.

## Tangga tahap dan item tonggak

| Item                     | Prasyarat cerita                                                                                         | Efek saat dipakai                                     | Membuka             |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| `item:catatan-residivis` | Hukuman kedua dan pembebasan setelah tahanan sudah terjadi dalam cerita, bukan hanya penangkapan pertama | `arc_residivis` menjadi `true`, fakta tonggak dicatat | `loc:rumah-singgah` |
| `item:mandat-keluarga`   | Setelah bebas, Raka diterima di organisasi fiksi Keluarga Hitam                                          | `arc_mafia` menjadi `true`, fakta tonggak dicatat     | `loc:dermaga`       |
| `item:mandat-politik`    | Dukungan warga dan partai fiksi mapan setelah tahap mafia                                                | `arc_politisi` menjadi `true`, fakta tonggak dicatat  | `loc:balai-kota`    |

Item tonggak tidak ada di inventaris awal. Saat narrator menyerahkannya,
jumlahnya 1. Saat dipakai, jumlah menjadi 0, definisi item tetap tersimpan di
snapshot sesi, dan flag tetap `true`. Karena itu item yang sama bisa diperoleh
lagi lewat `ADD_ITEM` tanpa definisi baru.

Contoh aksi hanya setelah gerbangnya terbuka: `pergi ke Rumah Singgah`, lalu
`periksa catatan berkas kepulangan`. Tidak ada pergantian bab otomatis, ambang
angka, atau kenaikan tahap yang dipaksakan mesin; semua bergerak dari pilihan
pemain, penilaian narrator, dan efek item yang sudah divalidasi.

## Item dinamis dengan `REGISTER_ITEM`

Teks cerita saja bukan inventaris. Bila cerita baru menetapkan bahwa pemain
menerima benda yang belum ada di katalog game, narrator boleh mengusulkan efek
`REGISTER_ITEM`. Efek ini membuat definisi item khusus sesi dan langsung
menambahkan `quantity` salinan ke inventaris. Efek di dalam item **disimpan**
dan baru diperiksa ketika item dipakai, jadi pendaftaran tidak mengubah stat,
sumber daya, fakta, atau flag.

Contoh muatan lengkap setelah rekomendasi yang pantas sudah terjadi dalam
cerita:

```json
{
  "type": "REGISTER_ITEM",
  "id": "item-surat-rekomendasi",
  "name": "Surat rekomendasi",
  "description": "Rekomendasi dari kontak yang telah ditemui.",
  "stackable": false,
  "consumable": true,
  "effects": [
    {
      "type": "RESOURCE_CHANGE",
      "target": "pengaruh",
      "operation": "ADD",
      "value": 5
    }
  ],
  "tags": ["dokumen"],
  "quantity": 1
}
```

Bidang wajib: `type`, `id`, `name`, `stackable`, `consumable`, `effects`,
`tags`, `quantity`. Bidang opsional: `description` dan `maxStack`. `effects`
dan `tags` harus array dan boleh kosong. `quantity` dan `maxStack` bilangan
bulat minimal 1.

Aturannya:

- `id` baru, aman, dan tidak dipakai entitas lain. Pola yang disarankan:
  `item-` diikuti slug nama, misalnya `item-surat-rekomendasi`, ditambah akhiran
  angka bila bentrok.
- Bila `id` yang dimaksud sudah ada di snapshot sesi, gunakan `ADD_ITEM`
  dengan id itu, bukan definisi kedua. Nama yang sama juga ditolak dan pesan
  galat menyebut id yang sudah terdaftar.
- Efek hanya boleh memakai bentuk efek yang sudah ada dan menargetkan stat,
  sumber daya, hubungan, NPC, item, flag, atau id lore yang sudah dikenal.
  `REGISTER_ITEM` dan `REGISTER_NPC` tidak boleh disarangkan di dalam `effects`.
- Item yang didaftarkan berlaku hanya pada sesi itu. Game sumber dan sesi lain
  tidak berubah.

Pada contoh di atas pemain langsung memperoleh satu surat, sedangkan
`pengaruh` baru bertambah 5 saat surat dipakai.

Item tonggak contoh sengaja ditulis di katalog game, bukan didaftarkan saat
bermain, karena narrator hanya melihat inventaris, bukan seluruh katalog.
Karena itu id persisnya ditulis di `scenario.additionalContext` supaya narrator
dapat menyerahkannya lewat `ADD_ITEM`.

## Penemuan lore

Entri `discovery` tidak tampil sebagai teks pada permintaan pertama. Syaratnya:

1. Lokasi saat ini termasuk dalam `metadata.discoverAt`.
2. Aksi pemain menunjukkan niat mencari, memeriksa, atau membaca, atau memuat
   salah satu `metadata.discoveryKeywords`.

Bila syaratnya terpenuhi, narrator hanya menerima handle buram, bukan isi
entri. Teks lengkap baru diterima pada permintaan model berikutnya setelah
penemuan tersimpan. Jangan menebak isi handle.

Untuk efek `DISCOVER_LORE` yang disimpan di dalam item, pendaftaran hanya boleh
memakai handle yang ditampilkan pada giliran itu atau id yang sudah ditemukan.
Saat item dipakai, aksi yang dikirim adalah `use <nama item>`, sehingga nama
item harus memuat salah satu `discoveryKeywords`. Contoh: item bernama
`Catatan ujian` dengan kata kunci `catatan` pada entri penemuan yang sesuai.
Gerbang lokasi dan flag tetap berlaku saat pemakaian.

`requiredFlag` dan `blockedByFlag` adalah pemeriksaan izin, bukan pengatur
pengambilan bersyarat atau pergantian bab. Penemuan yang diblokir tidak
menghapus pengetahuan yang sudah diperoleh. Visibilitas `narrator` adalah
konteks untuk model, bukan `privateKnowledge` milik NPC.

## Versi, imutabilitas, dan pemindahan save

`version` di tingkat atas adalah versi **format** dan selalu `1`. Versi di
dalam `pack` adalah versi **penerbitan** dan boleh naik, misalnya `2`. Versi
yang sudah diterbitkan tidak berubah. Bila memperbarui isi, terbitkan versi
baru dengan `id` pack yang sama dan `version` lebih tinggi.

Sesi yang sudah berjalan memegang pin versi dan peta yang dibekukan saat sesi
dimulai. Mengubah atau mengimpor pack baru tidak memperbarui sesi lama secara
otomatis. Save format v2 membawa dependensi lore, sehingga pemindahan save
memerlukan versi pack yang sama beserta digest yang cocok; tanpa itu impor
ditolak dan tidak ada perubahan yang ditulis.

Simpan berkas asli Anda di luar aplikasi. Jangan menaruh kredensial, kunci API,
atau data pribadi pengguna di lorebook maupun template.

## Batas ukuran

- Pack lorebook: 8 MiB, maksimal 5.000 entri dan 20.000 tautan.
- Template game: 2 MiB.
- Artikel lore tidak otomatis membuat NPC, item, efek, atau inventaris. Semua
  hal itu harus ditulis di definisi game atau diusulkan lewat efek yang sah.
