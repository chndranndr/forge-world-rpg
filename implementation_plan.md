# Implementation Plan — Desain Mobile-First dan JSON Fworld

**Tanggal:** 30 September 2026.  
**Status:** Catatan historis: fase UI 1–6 dikerjakan. Batas browser-only di dokumen ini digantikan oleh [rencana backend lokal](backend_agent_Implementation_plan.md); bukti live-AI lama tidak memverifikasi jalur backend baru. OpenRouter authenticated turn pada jalur lama tertunda (credential tidak ada).  
**Target:** Terapkan desain mockup pada aplikasi yang sudah playable, tambahkan import/export template cerita, dan pertahankan save lama.

## 1. Acuan dan kondisi awal

[Mockup HTML](mockups/index.html), [CSS](mockups/styles.css), dan [JavaScript](mockups/app.js) menjadi acuan visual/navigasi terbaru. [Catatan mockup](mockups/README.md) menjelaskan batas simulasinya. Gambar imagegen menjadi referensi suasana; bila layout berbeda, gunakan mockup HTML terbaru.

[PRD](prd.md) tetap menjadi kebutuhan gameplay. Keputusan terbaru user menambahkan template JSON pada Create Game dan menetapkan desain mobile-first. [README](README.md), [AGENTS](AGENTS.md), dan [manifest](.harness/manifest.json) menjadi acuan stack, command, dan bukti historis.

| Area          | Kondisi berdasarkan inspeksi saat penyusunan rencana                              | Pekerjaan berikutnya                                              |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Gameplay      | Free Chat, Choice Mode, scene awal, RPG engine, penggunaan item, history tersedia | Sambungkan ke tampilan baru                                       |
| Editor        | Entity utama tersedia; draft tanpa session boleh disimpan sebelum lengkap         | Accordion, indikator kelengkapan, pengamanan draft, template JSON |
| Persistence   | IndexedDB, snapshot session, transaction turn, Web Locks tersedia                 | Pertahankan save; perkuat import validation dan gate write        |
| Backup        | `fworld-save` v1 berisi definition, session, messages                             | Pertahankan kompatibilitas; Restore di Settings                   |
| Template JSON | Belum ada format terpisah di produksi                                             | Tambahkan `fworld-template` v1                                    |
| UI produksi   | Library/editor/session dengan CSS sederhana; Settings tersebar                    | Integrasi jurnal mobile-first dan panel                           |
| Mockup        | Data contoh di localStorage, AI/check/item simulasi                               | Ambil desain; gunakan domain/storage produksi                     |
| Live AI       | Bukti historis Gemini tersedia; OpenRouter dengan key asli belum terbukti         | Acceptance ulang dari origin tetap, terpisah per provider         |

### Bukti lama yang dibawa ke rencana baru

Dokumen ini menggantikan backlog/log fase lama. Manifest mencatat implementasi persistence, editor, engine, dan turn flow, termasuk browser dua tab dan gameplay Gemini. Baseline saat penyusunan: 63 tes pada `npm test`; tes mockup terpisah melalui `node --test mockups/check.test.mjs`.

Bukti browser historis tanggal 29 September 2026 menggunakan `http://127.0.0.1:5199`, sesuai `evidence_gaps` manifest. Bukti itu bukan verifikasi UI baru pada origin canonical. Gate terbuka tetap turn OpenRouter berautentikasi dan pengulangan acceptance pada `http://127.0.0.1:5173`. Build/tes tiruan/mockup tidak menggantikan gate tersebut.

## 2. Batas implementasi

Bagian ini merekam batas implementasi UI saat itu. Untuk arsitektur dan pekerjaan saat ini, ikuti [rencana backend lokal](backend_agent_Implementation_plan.md); gunakan dokumen ini hanya sebagai bukti historis untuk desain UI, draft, dan kompatibilitas format.

Integrasikan data nyata ke komponen `src/App.tsx`, `src/components/GameLibrary.tsx`, `GameEditor.tsx`, `SessionView.tsx`, dan `src/styles.css`. Reuse `types.ts`, `db.ts`, `engine.ts`, `turn.ts`, `llm.ts`; pecah komponen hanya saat bagian tersebut benar-benar digunakan.

Jangan mengganti produksi dengan iframe mockup, menyalin simulasi turn, memasukkan contoh dunia otomatis ke database user, atau mengganti IndexedDB game menjadi localStorage. localStorage boleh menyimpan preferensi baca yang tidak sensitif.

## 3. Desain dan peta layar

### Visual dan responsive

Gunakan paper `#faf8f3`, surface `#fffdf9`, ink `#202820`, forest green `#295840`, copper `#975333`, border `#dedbd2`. Serif seperti Georgia untuk heading/narasi; sans-serif terbaca untuk controls. Border tipis, radius kecil, fokus utama membaca dan mengambil aksi.

CSS dimulai satu kolom, diuji mulai 360 px. Input/body sekitar 16 px, target sentuh minimal 44 px, focus ring terlihat, safe-area padding, zoom/reduced-motion didukung. Desktop library dua kolom, editor/narasi dibatasi lebar baca. Panel desktop boleh berdampingan jika cukup lebar, memakai state/komponen yang sama.

Ilustrasi lokal hanya pendukung dengan fallback tanpa gambar. Jangan menjadikan Kamakura sebagai gambar semua dunia; tidak menambah upload/generate cover atau field cover dalam fase ini.

| Layar            | Isi dan aksi wajib                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library          | Continue session terbaru menurut `updatedAt`, search, list dunia, genre/status Draft/Siap/aktif, create, menu edit/export template/delete, pemilihan session jika lebih dari satu                   |
| Create/Edit Game | Overview, Scenario, Player, NPCs, Attributes, Resources, Relationships, Items, Starting Inventory, AI Settings; accordion bebas; Save draft/Save & start; Import JSON template/Export JSON template |
| Story            | Judul, lokasi/waktu nyata, history narrator/NPC/player/system, hasil check, scene awal, Free Chat/Choices, composer, loading/error/retry, status saved                                              |
| Player           | Deskripsi/background/notes, semua custom attributes/resources runtime, hasil check terakhir                                                                                                         |
| Inventory        | Item/quantity/description/tags/effects, detail/Use/status habis; seluruh efek melalui engine                                                                                                        |
| People           | NPC terdaftar/aktif, detail, seluruh custom relationships; private knowledge di editor, bukan informasi player/dialog bocor                                                                         |
| World & Facts    | Location/time/scene/active characters, facts sesuai visibility/knownBy, history penuh berurutan                                                                                                     |
| Settings         | Provider/model/key per provider, uji koneksi nyata, ukuran teks, status storage, Restore Save; konfigurasi session dibedakan dari defaults                                                          |
| Session menu     | Export Save, AI Settings session, kembali ke Library; navigasi panel tidak mereset session                                                                                                          |

Navigasi Library: **Library / Settings**. Navigasi session: **Story / Player / Inventory / People / Facts**. Editor memakai Back/Cancel dan area Save, tanpa navigasi bawah Library.

Semua metadata dari data nyata. Turn dihitung dari turn committed, bukan jumlah messages. Jangan mengarang Day/lokasi/genre/status saved/AI connected. Nilai kosong ditampilkan jujur. Tombol check manual mockup tidak masuk produksi: check berasal dari aksi dan dihitung engine.

### State UI

- Library kosong, search kosong, loading/error storage.
- Draft incomplete, error per field/entity, unsaved changes, import berhasil/invalid/versi asing/file besar, export gagal.
- No scene, no API key, choices kosong/loading, turn busy, input kosong, provider/timeout/output/storage error, retry dengan input tetap tersedia.
- Saved hanya setelah transaction selesai; tab read-only, menunggu lock, takeover memuat data terbaru.
- Inventory kosong/habis, NPC/relationships/facts/history kosong.
- Dialog Escape/focus return, label jelas, keyboard navigation, error terhubung field atau mendapat focus relevan.

## 4. Kontrak JSON

### A. Template cerita — Create New Game

Tambahkan format produksi terpisah dari backup:

```ts
type GameTemplateBundle = {
  format: "fworld-template";
  version: 1;
  exportedAt: string;
  game: Omit<GameDefinition, "id" | "updatedAt">;
  ai?: AiConfig;
};
```

`game` berisi scenario, player, NPC, custom attributes/resources/relationships, items/effects, starting inventory, dan genre/tone/language. Pertahankan ID entity internal agar references valid. Buat parent game ID dan timestamp lokal baru saat Save. `ai` hanya provider/model, tanpa key/test status.

1. **Import JSON template** berada di Create Game. Parse/validasi sebelum mengganti draft; tampilkan ringkasan judul/isi untuk review, lalu user Save. Import sendiri tidak menulis database atau membuat session.
2. Jika draft sudah diedit, konfirmasikan penggantian. Cancel chooser, parsing gagal, atau menolak penggantian mempertahankan seluruh input lama.
3. **Export JSON template** tersedia di Create/Edit Game. Export editor memakai draft saat ini, termasuk perubahan belum tersimpan; tidak melakukan Save/Start otomatis. Menu dunia boleh memakai aksi yang sama untuk definition tersimpan.
4. Template boleh belum playable, misalnya title/player/scenario kosong. Shape, tipe data, angka/range yang terisi, ID/references harus valid. Input angka yang belum dapat diparse perlu diperbaiki sebelum export.
5. Setelah import, konfigurasi incomplete ditandai Draft. Save draft tanpa session diperbolehkan; Start selalu memerlukan validasi gameplay lengkap.
6. Export memakai allowlist seluruh field/nested fields schema. Jangan menyalin raw JSON object dengan spread: session/state/history/facts runtime/key/parent ID/field asing tidak boleh ikut.
7. Sediakan `examples/game-template.json` saat implementasi: satu contoh produksi lengkap dengan player, NPC, custom stats/resource/relationship, item effect, dan starting inventory valid. Contoh bisa diedit manual untuk menulis cerita baru.
8. Gunakan file input, JSON parse, Blob download; sanitasi nama file, reset chooser agar file sama bisa diimpor lagi, revoke object URL.

Batas impor 2 MB/file, versi 1 saja. Validasi shape nested sebelum akses properti, enum provider/effect/operation, ID unik per domain, refs, finite numbers/bounds, stackability, integer quantities, dan player/NPC overrides. Tolak prototype-related keys berbahaya. Draft dengan references invalid perlu diperbaiki sebelum menjadi template export/import.

Entity ID internal dapat dipertahankan karena terscope pada definition game baru. Bila suatu jalur mengganti ID internal, remap semuanya sekaligus: player overrides, NPC attributes/initialRelationships, effect target/npcId, starting inventory. Jangan memakai nama tampilan sebagai primary key.

### B. Backup session — Settings / Session menu

Pertahankan `ExportBundle`: **`fworld-save` versi 1**, berisi game, session, messages. Export Save berada di session menu; Restore Save berada di Settings dan bisa dipakai tanpa session aktif.

Restore membuat IDs game/session/messages baru, tidak menimpa data lama, dan menulis definition/snapshot/state/history atomik. Sebelum write, validasi snapshot sesuai game, runtime references/ranges/quantity, facts visibility/knownBy, messages role/check/session/sequence, dan nextSequence. Perkuat validator existing yang baru mencakup shape dasar. Pastikan kegagalan tidak menyisakan data sebagian.

Backup valid lama tetap kompatibel. Perketat penolakan file corrupt tanpa mengganti format valid. Export menggunakan allowlist agar field credential dari input eksternal tidak ikut saat export ulang.

| Format                                     | Lokasi dan hasil                                                   |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `fworld-template` v1                       | Create Game → review draft baru, tanpa progress                    |
| `fworld-save` v1                           | Settings → restore salinan definition/session/history              |
| `fworld-mockup-template` / `fworld-mockup` | Prototipe saja; produksi menolak dengan pesan format yang diterima |

Tidak menerima JSON bebas atau mengonversi prototipe diam-diam. Schema mockup memiliki fields/references berbeda dari `GameDefinition`; contoh JSON produksi menjadi panduan user.

## 5. Fitur pendukung yang dibutuhkan

- **Draft aman:** Create membuka draft di memory, bukan langsung menyimpan game kosong seperti jalur saat ini. Save eksplisit; Cancel tidak meninggalkan record kosong. Back/Cancel saat berubah memberi Simpan/Buang/Tetap mengedit. Key tidak diperlukan untuk menyimpan konfigurasi/membuat session.
- **Validasi bersama:** bedakan struktur draft/template dan readiness Start; reuse/perkuat `validateDefinition`. Error menyebut field/entity. Jangan menggandakan schema atau aturan per layar. ADD_FACT/REMOVE_FACT memvalidasi teks fakta, bukan item reference.
- **Settings konsisten:** state key per provider di app selama tab hidup; perpindahan panel tidak menghapusnya. Defaults session baru dibedakan dari config session aktif. Provider/model boleh persist, key hanya memory dan diisi ulang setelah reload. Perubahan config invalidasi test status, busy turn membekukan config.
- **Navigasi mempertahankan state:** panel tidak mereset state/history/choices/composer, dan tidak memicu request tanpa aksi. Choices terikat sequence terbaru. Hash/Back boleh memakai parser kecil jika diperlukan, tanpa router dependency.
- **Write gating:** gate pada batas operasi create/save/start/submit/use/import/update AI, bukan hanya banner. Read/export tetap tersedia di tab read-only; takeover membaca data terbaru. Busy mencegah klik beruntun; stale request dari session yang ditinggalkan tidak mengubah UI baru.
- **Delete aman:** konfirmasi dengan judul game; pertahankan penolakan `deleteGame` bila masih mempunyai session. Jangan menyalin cascade delete dari mockup. Penghapusan seluruh session bukan scope fase ini.
- **Preferensi baca:** Normal/Besar, persist tanpa credential, CSS variables; labels/nav tetap terbaca. Soft keyboard tidak menutupi composer/aksi; respect zoom dan reduced motion.

Randomness OFF/LOW/NORMAL/HIGH tidak ditambahkan sebagai setting kosmetik. Jika dibangun, wajib masuk contract session/check dan teruji; awalnya tampilkan mode dari hasil check tersimpan. Streaming, manual state edit, cover upload, portrait/voice, community templates, dan cloud library di luar pekerjaan ini.

## 6. Tahapan implementasi

Urutan **1 → 2 → 3 → 4 → 5 → 6**. Checklist berikut masih pending untuk produksi. Setelah setiap fase: checks relevan, review diff, update bukti aktual.

### Fase 1 — JSON dan validasi

- [x] Tambahkan type/format/versi template di `src/types.ts` (`TEMPLATE_FORMAT`/`TEMPLATE_VERSION`/`GameTemplateBundle`).
- [x] Parse/import draft dan export template di `src/template.ts` (murni tanpa DB; `exportTemplate` allowlist via `pickGameDefinition`, `parseTemplate` menolak format mockup/save).
- [x] Perkuat nested shape/enums/finite/bounds/refs/overrides/stackability dan seluruh effect types di `validateDefinition` (shape dulu, abort bila struktur rusak; `REMOVE_FACT` tidak dicek terhadap pool item).
- [x] Pisahkan valid draft dari konfigurasi playable: `validateDefinition` struktural (draft/kerangka lolos), `validatePlayability` readiness Start (title/scenario/player.name), `handleStart` memakai keduanya.
- [x] Perkuat backup snapshot/state/history/allowlist: `collectSessionProblems` (snapshot deep-equal, refs/range state, facts visibility/knownBy, check record, sequence/nextSequence) + rebuild `importBundle`/`exportBundle` lewat field allowlist; `fworld-save` v1 tetap diterima.
- [x] Contoh `examples/game-template.json` + `tests/template.test.mjs` sesuai pola `node:test` existing.

**Gate:** template lengkap/kerangka round-trip; IDs/refs konsisten; key/state/history tidak masuk template; backup lama valid restore; invalid input tidak mengubah draft/DB; contoh lolos Start.

**Bukti Fase 1 (30 Sep 2026):** `npm.cmd run doctor` lulus (check + 69 tes + build). Template lengkap dan kerangka round-trip; ids/updatedAt/apiKey/state tidak masuk template (tes assert). Backup lama valid restore dengan ids baru; payload corrupt/dangerous-key/snapshot-mismatch/state-invalid ditolak tanpa menulis. Smoke browser pada origin canonical `127.0.0.1:5173` (viewport 390 px): library render, create, `Mulai Permainan` pada draft kosong menampilkan error playability per field. UI import/export editor sendiri adalah pekerjaan Fase 3.

### Fase 2 — Shell, navigasi, Settings

- [x] Token desain/typography/form controls/focus/safe area/breakpoints di `src/styles.css` (paper/surface/ink/forest/copper dari mockup, min-height sentuh 44 px, focus ring, `env(safe-area-inset-*)`, breakpoint 768 px).
- [x] Shell Library/Settings + header nav di `App.tsx`; komponen baru `SettingsPanel`; state view sederhana tanpa router.
- [x] Credential/test state disatukan di `App.tsx` (satu key store per provider, hanya memory, diturunkan ke SessionView); defaults Settings dibedakan dari config session aktif (`session.ai`).
- [x] Status storage/lock + gate write: `readOnly` diturunkan ke Library/Editor/SessionView; read/export tetap tersedia di tab read-only.
- [x] Ukuran teks Normal/Besar (localStorage `fworld-text-size`, `data-text-size` di root), uji koneksi nyata `runConnectionTest`, Restore Save di Settings tanpa session aktif, focus error tetap di SessionView.

**Gate:** responsive 360/390 px dan desktop; Settings terbuka dari seluruh layar; key tetap saat navigasi dan tidak masuk storage/export; read-only tidak dapat menulis.

**Bukti Fase 2 (30 Sep 2026):** `npm.cmd run doctor` lulus (check + 71 tes + build). Browser origin canonical `127.0.0.1:5173`, viewport 390 px lalu 360 px: nav Library/Settings diverifikasi dari keempat layar (Library, Editor, Settings, SessionView via seeded probe); key API bertahan Library→Settings→Library; localStorage hanya berisi `fworld-text-size` (audit Object.keys: tidak ada material key), sessionStorage kosong; preferensi teks Besar persist dan apply ke `data-text-size`; dua tab: tab kedua otomatis read-only (Buat game baru + file restore disabled, banner status); editor tanpa overflow horizontal pada 360 px. Probe session dihapus sesudahnya; library kembali kosong.

### Fase 3 — Library dan Create/Edit Game

- [x] Continue session terbaru (`Lanjutkan sesi terbaru`), list/search nyata (filter judul), pemilihan multi-session (list sisa session).
- [x] Create draft sementara di memory (`onCreateDraft` → `initialDraft`, tanpa `saveGame`); Cancel tanpa save tidak menambah game kosong (dibuktikan: 0 record).
- [x] Semua section editor accordion (`details/summary` via codemod AST), termasuk optional NPC attributes dan seluruh efek item.
- [x] Import/export template di editor (`parseTemplate`/`exportTemplate`), review sebelum diterapkan, peringatan penggantian draft teredit, error import spesifik, export dari draft tanpa Save otomatis; menu library `Export template` memakai definition tersimpan.
- [x] Draft/Siap badge (`validatePlayability`), error per field/entitas, dialog Simpan & keluar / Buang / Tetap mengedit; guard id `initialDraft.id === gameId`.
- [x] Entity IDs stabil (index-based card keys) dan functional updates (`patchFn`); perbaikan klik cepat dibuktikan triple-click → 3 entri.
- [x] Aturan §32 via `validateDefinitionUpdate`/`applyDefinitionUpdate`; penolakan tidak menulis; dibuktikan live: hapus atribut dengan sesi aktif → error bernama entitas.
- [x] Menu edit/export template/delete dengan `deleteGame` produksi (menolak bila ada session).

**Gate:** dua game dengan schema RPG berbeda dibuat manual/dari JSON, draft reload, cancel bersih, import tidak overwrite cerita, perubahan session mengikuti §32.

**Bukti Fase 3 (30 Sep 2026):** `npm.cmd run doctor` lulus (71 tes + build). Browser origin canonical 390 px: create→cancel = 0 record; create→save muncul di library; import `examples/game-template.json` → review (judul + jumlah entitas + ai) → apply → Simpan; dialog unsaved-changes (Tetap mengedit / Buang) berfungsi dan judul tak tersimpan hilang dari library; dua game schema berbeda (template lengkap vs atribut tunggal) reload setelah reload halaman, search "Hutan" memfilter; status Draft/Aktif akurat; §32: `Hapus atribut` + `Simpan` dengan sesi aktif menampilkan `Atribut "semangat" tidak boleh dihapus karena masih ada sesi berjalan` plus error referensi turunannya. Seluruh data probe dihapus; library kosong kembali.

### Fase 4 — Story dan pilihan aksi

- [x] Narrative mobile, metadata nyata (lokasi/waktu/scene/turn committed dari state + messages), role/system/check dari committed messages.
- [x] Composer/choices memakai `submitTurn`/`requestChoices`, opening memakai `beginOpeningScene`.
- [x] Composer sticky dengan `env(safe-area-inset-bottom)`; history scroll tidak menutupi aksi.
- [x] Loading/no-key/choices empty/provider/output/storage error/retry jelas (tombol "Coba lagi" muncul saat error, input dipertahankan).
- [x] Satu turn aktif (busy guard), sequence choices terikat `nextSequence`, input tetap saat gagal, Saved hanya setelah commit (`savedNote` hanya di-set setelah outcome ok).

**Gate:** mode/panel switch tidak kehilangan input/state, turn applied sekali, error menjaga save, retry berhasil, opening tidak diulang karena navigasi.

**Bukti Fase 4 (30 Sep 2026):** Gemini request asli pada origin canonical (key dari env, tidak dipersist): opening scene commit (narasi Hujan rintik…), turn kedua kena HTTP 503 transient → error tampil, input terisi tetap ada, tombol Coba lagi muncul → retry commit sukses ("Turn tersimpan.", 4 pesan); choices asli dari model (3 pilihan tentang mercusuar) setelah cooldown 503. Metadata jujur: lokasi/waktu "(belum ditentukan)", Turn committed: 2. Panel switch mempertahankan input composer.

### Fase 5 — Panel dan backup

- [x] Story/Player/Inventory/People/Facts sebagai panel tab membaca state runtime yang sama, seluruh custom schema.
- [x] Use melalui `useSessionItem`: efek engine (RESOURCE/ATTRIBUTE/RELATIONSHIP/ADD_FACT), konsumsi, transaction asli.
- [x] NPC/detail/relasi; `privateKnowledge` tidak dirender di panel People (diverifikasi tanpa bocor).
- [x] Facts difilter `visibility === public || knownBy.includes(PLAYER_ID)`; history penuh berurutan di panel Facts.
- [x] Export session di session menu; Restore di Settings tanpa session aktif.

**Gate:** panel mengikuti perubahan turn/item, habis/invalid effects tertangani, nilai bukan fixtures, backup round-trip dengan IDs baru tanpa merusak session lama.

**Bukti Fase 5 (30 Sep 2026):** Browser origin canonical: pakai Kopi Hangat via `useSessionItem` → qty 2→1, Semangat 7→8, Energi 80→95 (panel Player mengikuti); pakai Kamera Tua → fakta baru muncul di panel Facts, Keakraban Bima 3→5 di panel People, `privateKnowledge` "surat wasiat" tidak bocor. Restore file `fworld-save` valid dari Settings → salinan baru "Save Terrestore" muncul berdampingan dengan game asli. Input composer bertahan lintas panel. Seluruh probe dihapus.

### Fase 6 — Acceptance dan dokumentasi

- [x] `npm.cmd run doctor` lulus; tes produksi baru tercakup `npm test` (71 tes: template + persistence F1d). Mockup tidak diubah sehingga tes mockup tidak relevan sesi ini.
- [x] Browser origin canonical: mobile 360/390 px, tablet 768 px, desktop 1280 px, zoom (deviceScaleFactor 2) — tanpa overflow horizontal, nav hadir di semua ukuran.
- [x] Skenario acceptance dijalankan pada origin canonical dengan cleanup probe setelah tiap fase (library kosong kembali); bukan profile browser terpisah tapi DB origin yang sama dibersihkan hingga 0 record.
- [x] Gemini request asli (opening, turn, retry pasca-503, choices) pada origin canonical. OpenRouter authenticated turn BELUM terverifikasi — credential tidak tersedia.
- [x] Update README/manifest dengan status produksi, desain, dan posisi import/export JSON (`json_template` capability, `SettingsPanel`/`template.ts`). PRD tidak diubah.
- [x] Review diff dan credential sweep: tidak ada API key/probe/seed tertinggal di `src/`, `tests/`, `examples/`, atau `index.html`.

**Gate:** desain/JSON acceptance lengkap, save/turn tanpa regresi, checks lulus, bukti browser/live AI terpisah dari tes deterministik.

**Bukti Fase 6 (30 Sep 2026):** `npm.cmd run doctor` lulus (check + 71 tes + build). Browser origin canonical `127.0.0.1:5173`: overflow bersih pada 360/390/768/1280 px dan deviceScaleFactor 2, nav ada di semua ukuran. Live AI: Gemini opening + turn + retry + choices asli; OpenRouter tertunda (tanpa key). Credential sweep `grep -rlE "AIza…|sk-…|probe-|fworldA" src tests examples index.html` mengembalikan 0 file. Manifest + README diperbarui. Probe DB dihapus (library kosong).

**Bukti tambahan Fase 6 (30 Sep 2026, skenario tertunda):** A12 dua tab: tab kedua read-only otomatis (`Buat game baru` disabled), melihat data baru writer tanpa reload, `Ambil alih kunci tulis` menunggu sampai tab writer ditutup lalu menjadi writer (`Buat game baru` aktif). A11: saat opening scene busy, select provider dan input model disabled (config frozen); setelah reload key kosong (`""`) dan history tetap utuh. A10 dibuktikan dua jalur asli: (1) emulasi offline → error "Jaringan gagal atau provider tidak terjangkau (Failed to fetch)", input tersimpan, tidak ada "Turn tersimpan", tombol `Coba lagi` muncul → setelah online kembali, retry commit sukses (6 pesan, tombol retry hilang); (2) model session diset ke id tidak ada (`gemini-0-doesnotexist`) → HTTP 404 asli dari Gemini tampil, input tersimpan, `Coba lagi` muncul; setelah model diperbaiki, error terhapus (perilaku `handleAiChange`) dan resend lewat composer yang dipertahankan commit sukses. Catatan metode: injeksi kegagalan pertama memakai bentuk opsi `{fulfill}` yang diterima tapi diabaikan; bentuk flat `{status, contentType, body}` mencegat request same-origin (probe mengembalikan body injeksi), tetapi request cross-origin ke provider tidak dicegat bridge — failure leg memakai offline emulation + model 404 asli. Snapshot `retryVisible: false` pertama diambil saat turn masih in-flight sebelum commit sukses. A7: template berjudul `<img src=x onerror=alert(1)> Kedai Senja di Tepi Laut` lolos review, tersimpan, dan dirender sebagai teks literal (tanpa elemen `img` di DOM); nama duplikat hidup berdampingan sebagai salinan. Dialog unsaved-changes: Escape menutup dan fokus kembali ke tombol Kembali. Fix formula badge/statusOf: `validateDefinition && validatePlayability`. Seluruh probe dihapus (count pasca-hapus 0/0/0) dan file `.tmp-*` dihapus dari disk.

**Addendum (setelah itu):** (1) Tombol "Muat contoh" di editor memuat `examples/game-template.json` yang di-bundle lewat review `parseTemplate`. (2) "Buat game baru" kini membuat draft terisi contoh cerita lengkap (`seededGame` dari contoh yang sama; entity ids stabil sehingga bisa diedit) dengan hint penjelasan di library; setiap bagian bebas diedit/dihapus sebagai bahan contoh bagi user. (3) `verbatimModuleSyntax` yang tidak sengaja terganti saat menambah `resolveJsonModule` dikembalikan. Dibuktikan live: Buat game baru → editor langsung berisi judul, pemain Dian, 3 atribut, 3 sumber daya, 3 relasi, 7 item, 3 NPC, 4 inventaris, badge Siap. Probe dibersihkan; doctor hijau (71 tes + build).

**Addendum desain (setelah itu):** Produksi kini memakai bahasa visual mockup penuh: header brand serif `♧ Fworld` (68 px), navigasi bawah fixed (Library/Settings; panel sesi Story/Player/Inventory/People/Facts + Kembali + Settings saat session), section editor sebagai accordion `details/summary` serif terbuka dengan border-bottom, kolom story 680 px, composer sticky di atas nav dengan safe-area, tombol primary hijau untuk CTA (Buat game baru, Lanjutkan sesi terbaru, Mulai Permainan, Kirim, Terapkan), grid dua kolom library pada ≥700 px. Dibuktikan lewat screenshot 390 px dan 1280 px pada origin canonical; overflow bersih; doctor hijau (71 tes).

**Addendum pengukuran & guard (setelah itu):** Rect scan layar session @360 menemukan penyebab kiri-terpotong: `.bottom-nav` memakai `justify-content: center` sehingga konten yang overflow terpotong di KEDUA sisi dan item pertama ("Kembali") tidak terjangkau scroll — diperbaiki menjadi `justify-content: safe center`. Pasca-perbaikan: delta dokumen 0; pada scroll awal Kembali–People terlihat penuh, Facts/Settings berada di kanan container; scroll ke ujung membuktikan keduanya terlihat penuh (semua 7 label terjangkau). Scrollbar nav kini terlihat sebagai affordance (`scrollbar-width: none` dihapus). Scan dialog discard @360 (editor, draft kotor → Settings): tidak ada tombol keluar viewport. Tombol Settings di editor melewati guard perubahan belum disimpan yang sama dengan Kembali (`requestExit` + `pendingExit`); dibuktikan live. Probe dibersihkan; doctor hijau.

## 7. Skenario penerimaan

| ID  | Skenario                                                          | Hasil wajib                                                                |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1  | Library kosong/beberapa dunia/session; search/resume              | Empty state, Continue terbaru, session lain bisa dipilih                   |
| A2  | Konfigurasi lengkap, Save draft, reload, Start                    | Definition/overrides persist, incomplete belum playable                    |
| A3  | Create lalu Cancel/Back saat berubah                              | Perlindungan input; tidak ada game kosong otomatis                         |
| A4  | Export draft/game lengkap → import → review → Save                | Config round-trip, parent ID baru, refs utuh; tanpa key/state/history      |
| A5  | Export perubahan belum tersimpan                                  | Memakai draft sekarang, tidak Save/Start otomatis                          |
| A6  | JSON rusak/besar/versi asing/enum/range/ref/nested invalid        | Error spesifik; input/DB tetap utuh                                        |
| A7  | Import nama sama dengan existing, teks HTML dalam judul           | Salinan baru, IDs scoped, render aman                                      |
| A8  | Restore backup valid lama/corrupt/transaction abort               | Valid atomik; invalid tidak menulis sebagian                               |
| A9  | Chat → Choices → panel → Story; check/item/resource/relation/fact | State engine bersama, applied sekali, input/history terjaga                |
| A10 | Timeout/repair gagal/output invalid/storage failure, Retry        | Save lama utuh; input ada; tidak Saved palsu                               |
| A11 | Switch provider/model, navigasi, reload                           | Key sesuai provider di memory; config frozen saat busy; reload meminta key |
| A12 | Dua tab create/save/start/import/use/submit/update AI, takeover   | Satu writer; read/export tersedia; takeover data terbaru                   |
| A13 | Edit session: teks/tambah entity vs delete/bounds invalid         | §32 terjaga; reject tidak menulis template/snapshot                        |
| A14 | Ukuran layar/zoom/keyboard/soft keyboard                          | Tanpa overflow/overlap, labels/focus/error jelas                           |
| A15 | Turn/check/switch nyata pada Gemini dan OpenRouter                | Bukti terpisah dari origin tetap; satu provider tidak menggantikan lainnya |

## 8. Progres dan bukti baru

| Fase              | Status                       | Bukti saat implementasi                             |
| ----------------- | ---------------------------- | --------------------------------------------------- |
| 1. JSON/validasi  | Selesai                      | 71 tes lulus, doctor hijau, smoke origin canonical  |
| 2. Shell/Settings | Selesai                      | 71 tes, nav 4 layar, key memory-only, gating 2 tab  |
| 3. Library/editor | Selesai                      | 71 tes, import/review/§32/cancel/search live        |
| 4. Story          | Selesai                      | Chat/choices/retry/commit asli Gemini, 503 recovery |
| 5. Panel/backup   | Selesai                      | Runtime/item/facts/restore, privateKnowledge aman   |
| 6. Acceptance     | Selesai (OpenRouter pending) | Doctor, 4 viewport, live Gemini, sweep              |

Catatan bukti baru memuat tanggal, fase/skenario, command/tindakan UI, origin/viewport/provider relevan, hasil, dan gap. “Desain tersedia”/“mockup berfungsi” tidak berarti integrasi produksi selesai. Menyelesaikan dokumen rencana ini tidak menandai checklist implementasi selesai.
