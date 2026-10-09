# Fworld interactive mockup

Buka `http://127.0.0.1:5173/mockups/index.html` saat `npm run dev` aktif, atau buka `index.html` langsung untuk preview standalone. Tidak memakai dependency, backend, atau request provider.

Layar: library (search, create, edit, delete, resume), editor (overview, scenario, player, NPC, attributes, resources, relationships, items/effects, starting inventory, AI), story (free chat, choices, failed turn/retry), player/check preview, inventory/item detail/use, people/relationships, world/facts/history, settings, export/import.

Data contoh disimpan dalam localStorage dengan key `fworld-design-prototype-v1`, terpisah dari IndexedDB aplikasi utama. Format backup `fworld-mockup` hanya untuk prototipe ini. API key hanya di memory. Respons AI, connection test, check, dan efek penggunaan item adalah simulasi; prototipe bukan pengganti engine produksi. Penggunaan item mensimulasikan efek resource saja; semua tipe efek tersedia di editor untuk review desain.

Mobile: satu kolom dan navigasi bawah. Desktop: library dua kolom, editor dan narasi dibatasi lebarnya. Ilustrasi SVG lokal adalah aset preview.

Create Game menyediakan **Import JSON template** untuk mengisi editor sebelum disimpan, dan **Export JSON template** untuk mengunduh konfigurasi saat ini (termasuk draft belum lengkap). Format `fworld-mockup-template`, versi 1, hanya mencakup konfigurasi game; tanpa ID, session, history, atau API key. Restore backup beserta progress tetap tersedia di Settings. Template ini menggunakan schema prototipe, bukan schema save produksi.

Verifikasi: `node --test mockups/check.test.mjs` dan `npm run doctor`.
