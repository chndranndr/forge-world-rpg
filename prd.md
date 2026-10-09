# Product Requirements Document
## Configurable AI Roleplay RPG Chatbot

**Status:** Draft  
**Version:** 0.3  
**Target:** MVP — personal local use, single user  
**Product Type:** Stateful AI Roleplay / Interactive Fiction / RPG Sandbox

---

# 1. Product Summary

Aplikasi ini adalah platform **AI roleplay RPG sandbox** yang memungkinkan user membuat dan memainkan cerita interaktif dengan NPC berbasis LLM.

MVP berjalan sebagai aplikasi browser untuk pemakaian pribadi di satu perangkat, dengan backend Node.js loopback dan SQLite lokal sebagai sumber konfigurasi, progress, dan history. Tidak ada login atau sinkronisasi cloud. IndexedDB lama hanya dipakai untuk migrasi dan recovery. Koneksi internet diperlukan saat backend memanggil provider LLM online.

User mendefinisikan:

- setting dan skenario awal cerita
- player character
- NPC
- character attributes/stats
- relationship attributes
- resources/currency
- items
- inventory awal

Setelah game dimulai, **tidak ada storyboard, chapter, quest graph, atau ending yang ditentukan sebelumnya**.

Cerita berkembang secara emergent berdasarkan:

- tindakan player
- dialog player
- NPC personality
- NPC relationship
- player stats
- inventory
- resources
- fakta yang sudah terjadi
- state dunia saat ini

Pada setiap scene, AI menampilkan **3 pilihan aksi** dan kolom **aksi bebas** sekaligus. Pilihan yang diklik masuk ke alur aksi pemain yang sama dengan teks yang diketik.

---

# 2. Product Vision

Membuat pengalaman:

> “Create your own role-playing world, then let the story evolve naturally.”

User tidak hanya membuat karakter, tetapi juga mendefinisikan **aturan dasar RPG-nya sendiri**.

Contoh satu game:

```text
Stats:
STR
AGI
INT
CHA

Currency:
Gold

Relationship:
Trust
Affection
```

Game lain dapat menggunakan:

```text
Stats:
Hacking
Engineering
Street Cred
Combat

Resources:
Credits
Energy

Relationship:
Respect
Fear
Loyalty
```

Tidak ada stat, currency, relationship type, atau item type yang di-hardcode berdasarkan genre tertentu.

---

# 3. Core Design Principles

## 3.1 Data Driven

Game engine hanya mengenal primitive seperti:

```text
Attribute
Resource
Character
Relationship
Item
Inventory
Fact
Effect
World State
```

Engine tidak mengenal konsep spesifik seperti:

```text
Strength
Agility
Gold
Mana
Affection
Sword
Potion
```

Semua konsep tersebut adalah konfigurasi game.

---

## 3.2 Stateful

LLM tidak menjadi source of truth.

Game state disimpan oleh aplikasi.

Contoh:

```text
Player CHA = 7
Money = 1200
Aiko Trust = 14
Inventory contains Camera
```

LLM menerima state tersebut sebagai context.

---

## 3.3 Emergent Storytelling

User hanya menentukan:

- dunia
- premis
- karakter awal
- kondisi awal

User tidak wajib menentukan:

- chapter
- ending
- story branch
- quest line
- storyboard

Cerita berkembang berdasarkan interaction history dan state.

---

## 3.4 AI Narrates, Engine Validates

LLM bertanggung jawab terhadap:

- narasi
- dialog NPC
- interpretasi tindakan player
- perkembangan situasi
- proposal state change
- proposal relationship change

Game engine bertanggung jawab terhadap:

- validasi state
- inventory
- stat
- resource
- relationship
- item effect
- stat check
- persistence

---

# 4. Goals

MVP harus memungkinkan user:

1. Membuat satu roleplay game dari nol.
2. Mendefinisikan skenario awal.
3. Membuat player character.
4. Membuat satu atau lebih NPC.
5. Membuat custom stats.
6. Membuat custom resources/currency.
7. Membuat custom relationship properties.
8. Membuat custom items.
9. Menentukan inventory awal.
10. Memulai cerita tanpa predefined plot.
11. Berinteraksi melalui free chat.
12. Berinteraksi melalui selectable choices.
13. Menggunakan stats dalam penyelesaian aksi.
14. Mengubah relationship melalui cerita.
15. Mendapatkan, kehilangan, dan menggunakan item.
16. Mendapatkan atau menggunakan resource.
17. Menyimpan progress.
18. Melanjutkan session di kemudian hari.

---

# 5. Non-Goals — MVP

MVP **tidak** mencakup:

- akun, login, OAuth, atau multi-user access control
- cloud sync, hosted database, atau public deployment
- analytics service, distributed tracing, atau infrastructure monitoring
- backend remote/hosted, server database remote, dan sinkronisasi antarperangkat
- multi-agent architecture
- dedicated NPC agents
- autonomous story director
- story graph
- quest graph
- chapter editor
- visual storyboard
- combat grid
- map exploration
- real-time multiplayer
- voice chat
- image generation
- AI-generated character portraits
- mod marketplace
- user scripting language
- complex rule engine
- multiplayer party
- real-time NPC simulation ketika player offline
- autonomous NPC-to-NPC background simulation

Fitur tersebut dapat dipertimbangkan setelah core gameplay terbukti.

---

# 6. Primary User Flow

```text
Create Game
    ↓
Configure Scenario
    ↓
Configure Game System
    ├── Attributes
    ├── Resources
    └── Relationships
    ↓
Create Player
    ↓
Create NPCs
    ↓
Create Items
    ↓
Configure Starting Inventory
    ↓
Start Game
    ↓
Play
    ├── Pilih satu dari 3 aksi
    └── Tulis aksi bebas
    ↓
State Updated
    ↓
Continue Story
```

---

# 7. Game Creation

## 7.1 Create Game

User dapat membuat game baru.

Fields:

```text
Title
Description
Genre
Tone
Language
```

Example:

```text
Title:
Summer in Kamakura

Genre:
Slice of Life
Romance
Mystery

Tone:
Relaxed
Melancholic
Grounded
```

---

# 8. Scenario Configuration

Scenario hanya menentukan initial world context.

Required:

```text
Setting Description
Starting Situation
```

Optional:

```text
World Rules
Tone
Genre
Additional Context
```

Example:

```text
Setting:

Modern-day Kamakura, Japan.

The player recently moved to the city and started working
at a small cafe near the beach.

The story should focus on everyday life, interpersonal
relationships, and occasional mystery.
```

Starting situation:

```text
It is the player's first evening shift.

Heavy rain begins shortly before closing time.

A young woman enters the cafe carrying an old camera.
```

Setelah itu AI bebas mengembangkan cerita berdasarkan gameplay.

---

# 9. Attribute System

Attributes sepenuhnya configurable.

Example:

```text
Strength
Agility
Intelligence
Charm
```

atau:

```text
Hacking
Combat
Engineering
Negotiation
```

## Attribute Definition

Fields:

```text
ID
Name
Description
Minimum Value
Maximum Value
Default Value
```

Example:

```json
{
  "id": "charm",
  "name": "Charm",
  "description": "Ability to socially influence other characters.",
  "min": 0,
  "max": 20,
  "defaultValue": 5
}
```

---

# 10. Resource System

Resources digunakan untuk nilai numerik yang dapat bertambah dan berkurang.

Examples:

```text
Gold
Money
Mana
Energy
Guild Points
Reputation
Action Points
```

Fields:

```text
ID
Name
Description
Minimum
Maximum
Initial Value
```

Example:

```json
{
  "id": "yen",
  "name": "Yen",
  "min": 0,
  "initialValue": 5000
}
```

Tidak ada entity khusus bernama `Currency`.

Currency adalah resource.

---

# 11. Relationship System

User menentukan sendiri relationship attributes.

Examples:

```text
Affection
Trust
Respect
Fear
Rivalry
Loyalty
```

Fields:

```text
ID
Name
Description
Minimum
Maximum
Default Value
```

Example:

```json
{
  "id": "trust",
  "name": "Trust",
  "min": -100,
  "max": 100,
  "defaultValue": 0
}
```

Relationship disimpan per NPC.

Example:

```json
{
  "characterId": "aiko",
  "values": {
    "trust": 12,
    "affection": 7
  }
}
```

---

# 12. Player Character

User membuat player character.

Fields:

```text
Name
Description
Background
Personality
Optional Notes
```

Player juga memiliki:

```text
Attributes
Resources
Inventory
```

Example:

```json
{
  "name": "Ren",
  "description": "A quiet software engineer who recently moved from Tokyo.",
  "attributes": {
    "intelligence": 8,
    "charm": 4
  },
  "resources": {
    "yen": 5000,
    "energy": 100
  }
}
```

---

# 13. NPC System

User dapat membuat sejumlah NPC awal.

NPC fields:

```text
Name
Description
Personality
Background
Role
Goals
Private Knowledge
Initial Relationship
Optional Attributes
```

Example:

```json
{
  "name": "Aiko",
  "description": "A freelance photographer living near the beach.",
  "personality": [
    "quiet",
    "observant",
    "sarcastic"
  ],
  "goals": [
    "find her missing brother"
  ],
  "privateFacts": [
    "she knows something about the abandoned lighthouse"
  ]
}
```

NPC tidak wajib memiliki attribute yang sama dengan player.

---

# 14. Item System

Items juga configurable.

Fields:

```text
ID
Name
Description
Stackable
Max Stack
Value
Effects
Tags
```

Example:

```json
{
  "id": "energy_drink",
  "name": "Energy Drink",
  "stackable": true,
  "effects": [
    {
      "type": "RESOURCE_CHANGE",
      "target": "energy",
      "operation": "ADD",
      "value": 20
    }
  ]
}
```

---

# 15. Generic Effect System

Engine menggunakan generic effects.

Initial supported effects:

```text
ATTRIBUTE_CHANGE

RESOURCE_CHANGE

RELATIONSHIP_CHANGE

ADD_ITEM

REMOVE_ITEM

ADD_FACT

REMOVE_FACT
```

Generic structure:

```json
{
  "type": "ATTRIBUTE_CHANGE",
  "target": "charm",
  "operation": "ADD",
  "value": 2
}
```

Supported operation MVP:

```text
ADD
SUBTRACT
SET
```

---

# 16. Inventory System

Player memiliki inventory.

Inventory menyimpan:

```text
Item Definition
Quantity
Optional Equipped State
```

Example:

```json
[
  {
    "itemId": "old_camera",
    "quantity": 1
  },
  {
    "itemId": "energy_drink",
    "quantity": 3
  }
]
```

MVP tidak perlu:

- inventory slot limitation
- weight
- durability
- nested containers

---

# 17. World State

Setiap game session memiliki current world state.

Minimal:

```text
Current Location
Current Time
Current Scene Summary
Active Characters
Recent Events
```

Example:

```json
{
  "location": "Cafe Nami",
  "time": "19:45",
  "scene": "Ren and Aiko are alone inside the cafe while heavy rain continues outside.",
  "activeCharacters": [
    "ren",
    "aiko"
  ]
}
```

---

# 18. Fact System

Facts digunakan sebagai long-term story memory.

Examples:

```text
Ren works at Cafe Nami.

Aiko is a photographer.

Ren promised to meet Aiko on Saturday.

Aiko knows about the abandoned lighthouse.

Ren discovered a hidden basement.
```

Fact memiliki:

```text
ID
Text
Visibility
Created At
Source
```

Visibility:

```text
public
player-only
NPC-specific
system
```

MVP dapat dimulai hanya dengan:

```text
public
private
```

---

# 19. Conversation History

Game menyimpan semua messages.

Message type:

```text
PLAYER
NPC
NARRATOR
SYSTEM_EVENT
```

Example:

```json
{
  "role": "PLAYER",
  "content": "I hand the coffee to Aiko.",
  "createdAt": "..."
}
```

Namun LLM tidak perlu menerima seluruh transcript setiap turn.

Context dapat terdiri dari:

```text
Scenario
Current world state
Relevant characters
Current stats
Relevant relationships
Inventory
Resources
Facts
Recent N messages
```

---

# 20. Aksi Bebas

User bebas memasukkan:

- dialogue
- action
- narration
- combination

Example:

```text
I put the coffee on Aiko's table.

"Looks like the rain isn't stopping anytime soon."
```

Kolom aksi bebas selalu tersedia bersama tiga pilihan yang dibuat AI. AI merespons dalam karakter, melanjutkan scene, lalu menyediakan tiga pilihan untuk langkah berikutnya.

---

# 21. Tiga Pilihan Aksi

Setiap scene menyediakan tepat tiga opsi tindakan yang relevan dengan keadaan terbaru.

Example:

```text
Aiko looks toward the rain outside.

1. Offer her your umbrella.
2. Ask why she came this late.
3. Make a sarcastic joke.
```

User dapat memilih salah satu opsi atau menulis tindakan sendiri lewat kolom aksi bebas yang tetap tersedia.

Game engine mengubah selection menjadi player action biasa.

Contoh:

```text
PLAYER_ACTION:
Offer Aiko your umbrella.
```

---

# 22. Pilihan dan Aksi Bebas

Tiga pilihan aksi dan kolom untuk menulis aksi bebas tampil bersamaan setelah scene tersedia. Tidak ada perpindahan mode input. Memilih satu opsi mengirim labelnya sebagai aksi pemain biasa.

---

# 23. Action Interpretation

Setiap player message dianalisis LLM.

LLM menentukan apakah tindakan:

```text
normal interaction

requires attribute check

uses item

changes resource

potentially changes relationship
```

Example player action:

```text
I try to convince Aiko that I never entered the storage room.
```

AI may produce:

```json
{
  "action": {
    "requiresCheck": true,
    "attribute": "deception",
    "difficulty": 7
  }
}
```

---

# 24. Attribute Checks

Game engine melakukan resolution.

Basic MVP formula:

```text
attribute value
+
random modifier
vs
difficulty
```

Possible result:

```text
CRITICAL_FAILURE
FAILURE
PARTIAL_SUCCESS
SUCCESS
CRITICAL_SUCCESS
```

MVP dapat disederhanakan menjadi:

```text
FAILURE
PARTIAL_SUCCESS
SUCCESS
```

LLM kemudian menerima result.

Example:

```json
{
  "action": "lie_to_aiko",
  "result": "FAILURE"
}
```

LLM tidak menentukan sendiri hasil check setelah result dihitung engine.

---

# 25. Relationship Updates

LLM boleh mengusulkan perubahan relationship.

Example:

```json
{
  "relationshipChanges": [
    {
      "characterId": "aiko",
      "attribute": "trust",
      "operation": "SUBTRACT",
      "value": 2,
      "reason": "Player was caught lying."
    }
  ]
}
```

Game engine memvalidasi:

```text
attribute exists

NPC exists

value remains within configured range
```

Setelah valid, state disimpan.

---

# 26. Resource Updates

Example:

Player membeli kopi:

```json
{
  "resourceChanges": [
    {
      "resource": "yen",
      "operation": "SUBTRACT",
      "value": 500
    }
  ]
}
```

Game engine harus menolak jika:

```text
current yen < 500
```

kecuali resource mengizinkan negative value.

---

# 27. Inventory Updates

Example:

Player menemukan key:

```json
{
  "inventoryChanges": [
    {
      "operation": "ADD",
      "itemId": "storage_key",
      "quantity": 1
    }
  ]
}
```

Game engine memvalidasi item definition terlebih dahulu.

---

# 28. AI Response Contract

LLM sebaiknya menggunakan structured output.

Conceptual response:

```json
{
  "narrative": "Aiko raises an eyebrow...",

  "stateChanges": {
    "relationships": [],
    "resources": [],
    "inventory": [],
    "attributes": [],
    "facts": []
  },

  "worldState": {
    "location": "Cafe Nami",
    "time": "19:50"
  },

  "choices": [
    {
      "id": "offer_umbrella",
      "label": "Offer her your umbrella"
    },
    {
      "id": "ask_late_visit",
      "label": "Ask why she came this late"
    },
    {
      "id": "make_joke",
      "label": "Make a sarcastic joke"
    }
  ]
}
```

Setiap respons pembuka dan turn menyediakan tepat tiga pilihan; kolom aksi bebas selalu tampil di UI.

---

# 29. AI Context

Setiap turn AI menerima context terstruktur.

Example:

```text
SYSTEM
You are the narrator and NPC roleplayer for this game.

SCENARIO
...

PLAYER
...

ACTIVE NPC
...

ATTRIBUTES
...

RESOURCES
...

RELATIONSHIPS
...

INVENTORY
...

WORLD STATE
...

RELEVANT FACTS
...

RECENT MESSAGES
...
```

LLM harus diberi aturan:

```text
Do not invent items the player owns.

Do not change numeric state directly without proposing a state update.

Respect existing facts.

Stay consistent with NPC personality and known information.

Characters must not know private facts they have never learned.

Continue the story naturally.

Do not force a predetermined storyline.
```

---

# 30. NPC Knowledge Boundary

NPC tidak boleh otomatis mengetahui seluruh world state.

Context untuk NPC harus membedakan:

```text
Global facts

Facts known by player

Facts known by current NPC
```

Contoh:

```text
Aiko knows:
- Ren works at the cafe.
- Ren owns an old camera.

Aiko does NOT know:
- Ren entered the lighthouse last night.
```

Model tidak boleh menggunakan fakta kedua dalam dialog Aiko.

---

# 31. Save / Resume

Game state harus persistent.

Simpan otomatis melalui backend lokal setelah setiap turn valid. State terbaru, messages, revision, dan hasil run harus disimpan dalam satu transaction SQLite; UI baru menyatakan tersimpan setelah commit berhasil.

Data aktif tersimpan di file SQLite lokal yang lokasinya dapat dikonfigurasi. Membuka aplikasi pada perangkat atau instalasi lain tidak otomatis membawa save sebelumnya.

Sediakan **Export Save** dan **Import Save** dalam format JSON yang mencakup game definition, session state, dan conversation history, dengan versi format. API key tidak ikut diekspor. Validasi format dan references sebelum import; import sebagai salinan baru agar save lama tidak tertimpa.

IndexedDB dari versi browser-only tetap tersedia selama migrasi dan recovery. Sediakan backup database serta export save manual. Tampilkan error jika backend atau penyimpanan gagal; jangan mengaku progress sudah tersimpan.

User dapat:

```text
close game

return later

continue from latest state
```

Persisted data:

```text
Game configuration

Characters

Attribute values

Resources

Relationships

Inventory

Facts

World state

Conversation history
```

---

# 32. Game Configuration Editing

Sebelum session dimulai, semua konfigurasi bebas diedit.

Setelah game berjalan:

Allowed:

```text
add NPC

add item definition

add optional attribute

edit descriptions
```

Potentially dangerous:

```text
delete existing attribute

delete resource

change min/max drastically
```

Untuk MVP, destructive configuration changes setelah game dimulai dapat dibatasi.

---

# 33. Suggested UI

## Main Screen

```text
┌─────────────────────────────────────────────────┐
│ Summer in Kamakura                    Day 3      │
├───────────────┬─────────────────────────────────┤
│               │                                 │
│ PLAYER        │           STORY                 │
│               │                                 │
│ INT  8        │ Aiko closes the camera and      │
│ CHA  5        │ looks toward you...             │
│               │                                 │
│ ¥ 4,500       │                                 │
│ Energy 80     │                                 │
│               │                                 │
│ INVENTORY     │                                 │
│ Camera        │                                 │
│ Umbrella      │                                 │
│               │                                 │
│ Aiko          │                                 │
│ Trust 14      │                                 │
│ Affection 8   │                                 │
│               ├─────────────────────────────────┤
│               │ [ Type your action... ]         │
└───────────────┴─────────────────────────────────┘
```

---

# 34. Game Creator UI

Suggested sections:

```text
Overview

Scenario

Player

NPCs

Attributes

Resources

Relationships

Items

Starting Inventory

AI Settings
```

Tidak perlu wizard mandatory.

User boleh berpindah section bebas.

---

# 35. MVP Screens

Required screens:

```text
Game Library

Create Game

Edit Game

Player Configuration

NPC Configuration

Attribute Configuration

Resource Configuration

Relationship Configuration

Item Configuration

Game Session

Inventory Panel

Character / Relationship Panel
```

---

# 36. Domain Model

Core entities:

```text
GameDefinition

GameSession

Character

AttributeDefinition

ResourceDefinition

RelationshipDefinition

ItemDefinition

InventoryEntry

RelationshipState

Fact

WorldState

Message
```

---

# 37. Suggested Data Relationship

```text
GameDefinition
│
├── AttributeDefinitions
├── ResourceDefinitions
├── RelationshipDefinitions
├── ItemDefinitions
├── CharacterDefinitions
└── Scenario

GameSession
│
├── PlayerState
├── CharacterStates
├── Relationships
├── Inventory
├── Resources
├── Facts
├── WorldState
└── Messages
```

Pemisahan `Definition` dan `State` penting.

Contoh:

```text
AttributeDefinition:
Charm
0–20

PlayerState:
Charm = 7
```

---

# 38. Definition vs Runtime State

## Definition

Immutable-ish configuration:

```text
Charm:
min = 0
max = 20
description = social influence
```

## State

Current value:

```text
Charm = 8
```

Konsep sama untuk:

```text
resources

items

relationships
```

---

# 39. Local Function Calls

UI memanggil API lokal untuk operasi domain game:

```text
saveGame(definition)
listGames()
startSession(gameId)
loadSession(sessionId)
submitTurn(sessionId, input)
useItem(sessionId, itemId)
exportSave(sessionId)
importSave(file)
```

Backend memvalidasi request, menjalankan game engine, dan menyimpan hasil di SQLite. Provider LLM hanya dipanggil backend; browser mengirim aksi pemain dan tidak mengirim authoritative state.

---

# 40. Chat Turn Flow

```text
Player sends message
        ↓
Load Session State
        ↓
Build AI Context
        ↓
LLM interprets action
        ↓
Optional Game Check
        ↓
LLM produces narrative + proposed changes
        ↓
Validate Changes
        ↓
Apply Changes
        ↓
Persist State
        ↓
Return Response
```

---

# 41. Two-Step LLM Flow — Optional

Untuk reliability lebih tinggi:

```text
1. Interpret player action

2. Resolve deterministic state

3. Generate narrative
```

Example:

```text
Player Input
     ↓
LLM Action Parser
     ↓
Game Engine
     ↓
LLM Narrator
```

Untuk interaksi tanpa attribute check, gunakan **satu model call** yang menghasilkan narrative dan proposed changes.

Jika model meminta attribute check, engine menghitung hasilnya terlebih dahulu, lalu call kedua menghasilkan narrative berdasarkan hasil tersebut. Jangan menampilkan hasil check buatan model sebelum engine menghitungnya.

Ini tetap satu model dengan dua request bila diperlukan, bukan multi-agent architecture.

---

# 42. Config Validation

Saat user membuat game:

Engine harus memastikan:

```text
ID unique

min <= default <= max

relationship attributes valid

resources valid

item effect target exists

starting inventory item exists

character references valid
```

Game tidak dapat dimulai jika configuration invalid.

---

# 43. Error Handling

Contoh invalid AI proposal:

```text
AI:
subtract 10000 yen
```

Current:

```text
yen = 500
```

Engine menolak.

AI harus mendapatkan feedback:

```text
RESOURCE_CHANGE_REJECTED:
Insufficient yen.
```

Kemudian narrative disesuaikan melalui maksimal satu repair request dan divalidasi ulang. Jika tetap invalid, tampilkan error dan tombol Retry; state dan history yang sudah tersimpan tidak berubah.

Respons AI, perubahan state, dan messages satu turn disimpan bersama setelah semuanya valid. Jika request gagal, input player tetap tersedia untuk dicoba lagi. Hanya satu turn boleh berjalan pada satu waktu agar perubahan tidak diterapkan dua kali.

---

# 44. AI Hallucination Protection

Engine harus mencegah AI mengubah authoritative state sembarangan.

Contoh:

AI mengatakan:

```text
You pull your revolver from your inventory.
```

Padahal revolver tidak ada.

Untuk MVP:

System prompt harus melarang hal tersebut.

Jika model tetap melakukannya, response validation dapat mendeteksi references terhadap unavailable item jika terdapat structured item action.

Perfect semantic validation belum diperlukan di MVP.

---

# 45. Randomness

Game dapat mempunyai optional randomness.

Setting:

```text
Randomness:
OFF
LOW
NORMAL
HIGH
```

Digunakan untuk stat checks.

MVP default:

```text
NORMAL
```

User juga dapat memilih deterministic mode:

```text
Randomness OFF
```

Sehingga success lebih bergantung pada stat.

---

# 46. AI Model Configuration

Tahap awal wajib mendukung Gemini (Google Gemini API langsung) dan OpenRouter melalui Vercel AI SDK pada backend. User memilih satu provider dan satu model aktif per session; tidak ada pemanggilan kedua provider bersamaan atau fallback otomatis lintas provider.

Gunakan satu modul agent/provider dengan percabangan `gemini` / `openrouter` dan output contract aplikasi yang sama. Gemini langsung dan model Gemini lewat OpenRouter tetap merupakan dua jalur integrasi berbeda.

AI Settings menampilkan pilihan provider (`Gemini` / `OpenRouter`), model ID, status credential terkonfigurasi, penggunaan token, tombol uji koneksi, dan input API key. UI hanya menyimpan draft masked di memory sampai dikirim ke backend loopback; backend menyimpan key pada environment server atau `.env` lokal yang di-ignore, lalu hanya mengembalikan status configured. Key tidak disimpan di browser storage, game database, log, backup, atau export. Simpan pilihan provider/model pada session. Pergantian provider/model hanya di antara turn, mempertahankan state/history, dan membatalkan status uji koneksi sebelumnya. Semua request tool, narasi, dan repair dalam satu run memakai konfigurasi yang sama.

| Provider | Integrasi awal |
| --- | --- |
| Gemini | Google provider AI SDK, credential server-side |
| OpenRouter | OpenRouter AI SDK provider, credential server-side |

Mapping mengikuti [referensi Gemini API](https://ai.google.dev/api) dan [OpenRouter Quickstart](https://openrouter.ai/docs/quickstart). Normalisasi text, token usage jika tersedia, serta error/refusal/response kosong sebelum diteruskan ke engine; jangan berasumsi format response keduanya sama.

**Gate provider:** request nyata melalui backend lokal harus diuji untuk masing-masing provider sebelum integrasi gameplay dinyatakan lengkap. Jika credential salah satu belum tersedia, catat provider itu belum terverifikasi; keberhasilan provider lainnya tidak memenuhi acceptance keduanya. Browser hanya berkomunikasi dengan API lokal.

API key disimpan terpisah per provider di environment backend atau file `.env` lokal yang di-ignore. Settings mengirim key hanya ke backend lokal untuk penyimpanan; backend tidak mengirimkan nilainya kembali. Jangan mengirim key Gemini ke OpenRouter atau sebaliknya. Key tidak ditanam dalam source, browser bundle, log, backup, database game, atau export save.

Gunakan structured output sesuai kemampuan model yang dipilih; khusus OpenRouter, dukungannya bergantung pada model, bukan hanya nama provider. Jika mode schema tidak didukung, gunakan instruksi JSON dan validasi lokal dengan batas repair yang sama, tanpa berpindah model/provider otomatis. Validasi JSON dan semua proposed changes tetap dilakukan oleh engine lokal. Timeout, kegagalan jaringan, dan limit provider menampilkan error dengan Retry, tanpa mengubah save terakhir. Lihat [structured outputs Gemini](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) dan [structured outputs OpenRouter](https://openrouter.ai/docs/guides/features/structured-outputs).

---

# 47. Functional Requirements

## FR-01

User dapat membuat game.

## FR-02

User dapat menentukan scenario initial.

## FR-03

User dapat membuat custom attributes.

## FR-04

User dapat membuat custom resources.

## FR-05

User dapat membuat custom relationship attributes.

## FR-06

User dapat membuat player character.

## FR-07

User dapat membuat NPC.

## FR-08

User dapat membuat items.

## FR-09

User dapat menentukan starting inventory.

## FR-10

User dapat memulai game session.

## FR-11

User dapat bermain menggunakan free text kapan saja.

## FR-12

Setiap scene menyediakan tiga pilihan aksi bersama kolom free text.

## FR-13

AI dapat memainkan semua NPC.

## FR-14

AI dapat melanjutkan cerita tanpa predefined storyline.

## FR-15

Player actions dapat memicu configurable attribute check.

## FR-16

Relationship value dapat berubah berdasarkan interaction.

## FR-17

Resources dapat bertambah dan berkurang.

## FR-18

Inventory dapat berubah selama game.

## FR-19

Game menyimpan long-term facts.

## FR-20

Game dapat dilanjutkan setelah session ditutup.

---

# 48. Non-Functional Requirements

## NFR-01 — Consistency

AI harus mempertahankan:

```text
character personality

inventory

relationship

known facts

world state
```

semaksimal mungkin.

---

## NFR-02 — State Integrity

LLM tidak boleh menjadi source of truth untuk numeric state.

---

## NFR-03 — Extensibility

Menambah custom stat/resource/item tidak membutuhkan deployment atau schema migration.

---

## NFR-04 — Minimal LLM Integration

Detail Gemini dan OpenRouter berada dalam satu file `llm.ts`; game engine menerima contract aplikasi yang sama. Kedua provider wajib didukung dan diuji dari browser untuk MVP. Provider tambahan di luar keduanya tidak termasuk scope awal.

---

## NFR-05 — Response Time

Target MVP:

```text
typical turn:
< 10 seconds
```

Respons lengkap tanpa streaming cukup untuk MVP. Streaming dapat ditambahkan setelah save/resume dan validasi turn stabil. Target waktu ini bergantung pada provider dan jumlah model call; bukan syarat untuk memaksakan hasil sebelum validasi selesai.

---

## NFR-06 — Persistence

State yang sudah tersimpan tidak boleh hilang ketika user refresh atau membuka kembali aplikasi pada browser profile dan origin yang sama. Export/import save diperlukan untuk backup manual; penghapusan data browser tidak bisa dicegah oleh aplikasi.

---

# 49. MVP Tech Stack — Browser UI dan Backend Lokal

| Bagian | Pilihan |
| --- | --- |
| UI | React + TypeScript |
| Development / build | Vite |
| Styling | CSS biasa |
| Backend | Node.js 24.13+, `node:http`, loopback |
| Game engine | Fungsi TypeScript bersama; validasi authoritative di server |
| Persistence | SQLite melalui `node:sqlite`; IndexedDB hanya untuk migrasi/recovery |
| LLM | Vercel AI SDK: Gemini atau OpenRouter; satu provider/model per run |
| AI output | Tools terbatasi + output terstruktur dan validasi server |
| Backup | Backup SQLite dan export/import `fworld-save` v1 |
| Auth | Tidak ada |

Tidak menggunakan Next.js, backend framework, SQLite/WASM, ORM, database remote, atau SSE server. Database SQLite berada di direktori data lokal yang dapat dikonfigurasi.

Saat development, frontend memakai `http://127.0.0.1:5173` dan meneruskan `/api` ke backend `http://127.0.0.1:3001`. Saat pemakaian production lokal, backend menyajikan build frontend pada origin canonical `http://127.0.0.1:5173`. Port harus strict agar tidak diam-diam pindah origin.

Save berada pada file database backend, bukan pada browser profile atau origin. Gunakan backup/export saat memindahkan instalasi. Tidak perlu Docker, cloud hosting, atau deployment pipeline untuk MVP.

---

# 50. Recommended Architecture

```text
Browser
  React UI → /api
      ↓
  Node.js local backend
      ├── Shared RPG engine + validation
      ├── SQLite: definitions, state, messages, turns, usage
      └── AI SDK → Gemini atau OpenRouter (pilihan session)
```

Semua aturan gameplay berjalan pada proses lokal. Provider hanya menerima context yang dipilih backend dan mengembalikan proposal; provider tidak memiliki akses langsung ke database.

---

# 51. Minimal Code Organization

```text
shared/          domain types, validation, template, dan RPG engine murni
server/          HTTP API, SQLite, AI agent, tools, dan turn lifecycle
src/
  App.tsx        UI dan navigasi
  api.ts         fungsi HTTP konkret yang dipakai komponen
  components/    editor, library, gameplay, settings
  db.ts          baca/export IndexedDB legacy untuk migrasi saja
  styles.css     tampilan aplikasi
```

Tidak perlu service per entity, repository abstraction, dependency injection, atau global state library. Mulai dengan React state; pecah file hanya jika kode yang benar-benar ada sudah sulit dibaca.

---

# 52. Minimal Storage Model

Gunakan SQLite sebagai database aktif. `games`, `sessions`, `messages`, `turns`, `ai_requests`, dan `migrations` menyimpan definition, snapshot, state, history, idempotency, usage, dan receipt migrasi. IndexedDB versi lama tetap tidak diubah hingga transfer terverifikasi.

| Tabel | Isi |
| --- | --- |
| `games` | ID, definition JSON, revision, updatedAt |
| `sessions` | ID, gameId, definition snapshot, state, AI config, sequence, revision, updatedAt |
| `messages` | ID, sessionId, turnId, sequence, role, content, createdAt |
| `turns` | Request ID, input hash, expected revision, status, result/error |
| `ai_requests` | Provider/model, usage, latency, status; tanpa prompt atau key |
| `migrations` | Fingerprint, counts/IDs, dan receipt verifikasi |

Gunakan unique index `(sessionId, sequence)` untuk urutan messages dan FTS5 untuk retrieval history. Stats, resources, relationships, inventory, dan facts tetap nested di definition/state; tidak perlu kolom per genre atau stat.

Session menyimpan snapshot definition saat dimulai. Edit konfigurasi session berjalan yang diizinkan pada bagian 32 harus memperbarui snapshot tersebut dan memvalidasi state dalam transaction yang sama. Edit template game tidak otomatis mengubah session lama.

Transaction penyimpanan turn mencakup state, messages, revision, dan hasil turn. Request LLM dilakukan di luar transaction; jangan menunggu jaringan sambil menahan transaction SQLite.

Gunakan `PRAGMA user_version` untuk migrasi schema SQLite. Menambah custom stat/resource/item cukup mengubah data. Tidak perlu migration framework atau event-sourcing system.

---

# 53. Personal Use Boundaries

MVP mengasumsikan satu pemilik perangkat. Tidak perlu login, OAuth, roles, enkripsi database khusus, atau audit platform. Static server development hanya mendengarkan loopback, bukan dibuka ke jaringan umum.

Tetap pertahankan validasi input, validasi output AI, dan transaction penyimpanan agar save tidak rusak. Tampilkan output AI sebagai text atau Markdown yang aman, tanpa mengeksekusi raw HTML/script. API key tidak dicatat dalam log atau backup.

LLM tidak boleh memiliki direct DB access.

Flow:

```text
LLM
↓
structured proposal
↓
application validation
↓
database
```

Tidak:

```text
LLM
↓
SQL/database tool
```

---

# 54. Observability

Gunakan ledger lokal server untuk debugging; tidak perlu monitoring service atau analytics SDK. Catat per request:

```text
session ID

turn ID

model

token usage

latency

structured response validity

state changes

validation failures
```

Useful untuk debugging narrative consistency.

Jangan log API key atau seluruh prompt/transcript. Metrik bagian 55 dapat dinilai dari sesi uji pribadi; tidak memerlukan telemetry remote.

---

# 55. Success Metrics

Untuk MVP, metric utama bukan jumlah fitur.

Measure:

```text
Average turns per session

Average session duration

Games created per user

Sessions resumed

Percentage of AI responses requiring regeneration

Structured-output validation failure rate

State inconsistency reports
```

Product signal terpenting:

> Apakah user mau melanjutkan cerita yang sama berkali-kali?

---

# 56. MVP Acceptance Criteria

MVP dianggap playable jika user dapat:

1. membuat game baru;
2. menulis scenario initial;
3. membuat custom stats;
4. membuat custom resource/currency;
5. membuat custom relationship attributes;
6. membuat player;
7. membuat minimal satu NPC;
8. membuat item;
9. menentukan starting inventory;
10. memulai session;
11. berbicara bebas dengan NPC;
12. memilih salah satu dari tiga aksi atau menulis aksi bebas;
13. melakukan stat check;
14. menerima atau kehilangan item;
15. menggunakan resource;
16. mengubah relationship;
17. menyimpan story facts;
18. keluar dari aplikasi;
19. membuka kembali session;
20. melanjutkan cerita dengan state yang sama.

Kriteria teknis local-use:

21. seluruh fitur game berjalan melalui backend loopback tanpa login;
22. request LLM nyata melalui backend berhasil pada Gemini dan OpenRouter, masing-masing dengan minimal satu model; pergantian provider di antara turn mempertahankan state/history dan memakai credential yang sesuai;
23. restart server dan buka ulang aplikasi lokal memulihkan save dari SQLite;
24. export lalu import memulihkan konfigurasi, state, dan history tanpa API key;
25. response invalid, request gagal, atau penyimpanan gagal tidak menghasilkan partial turn;
26. dua tab dengan revision sama tidak saling menimpa; Web Locks dipakai untuk transfer migrasi legacy.

---

# 57. MVP Development Priority

### P0 — Core

Backend lokal authoritative; uji provider Gemini dan OpenRouter secara terpisah dengan credential server-side. Jika credential salah satu belum tersedia, fitur data/editor tetap dapat diverifikasi tetapi acceptance provider itu tetap pending. Migrasi IndexedDB legacy harus memverifikasi seluruh data melalui read-back sebelum cutover.

```text
Game definition

Player

NPC

Custom attributes

Custom resources

Custom relationships

Chat session

LLM narration

Persistent state

Facts

Save/resume

Export/import save backup
```

### P1 — RPG

```text
Inventory

Items

Effects

Attribute checks

Relationship updates

Resource updates
```

### P2 — UX

```text
Tiga pilihan aksi yang selalu tampil bersama aksi bebas

Streaming (optional, bukan syarat MVP)

Character panel

Inventory panel

Relationship panel

Game creator improvements
```

### Post-MVP

```text
Generated characters

Generated game templates

Shareable scenario templates (terpisah dari backup save MVP)

Story summaries

Memory retrieval improvements

Character portraits

Voice

Multiplayer

Community templates

Advanced rule engine

Multi-agent architecture
```

---

# 58. Core Product Rule

The main architectural rule of the product:

> **The AI controls the narrative. The application controls reality.**

The LLM may decide that an NPC is angry, suspicious, friendly, or curious.

The LLM may propose that trust increases.

The LLM may introduce a new situation or character.

But authoritative game state such as:

```text
attributes

resources

relationships

items

inventory

facts
```

must remain controlled and validated by the game engine.

---

# 59. Final MVP Scope

The first version should essentially be:

```text
Configurable World
+
Configurable Characters
+
Configurable RPG State
+
Single LLM
+
Persistent Story Memory
+
Free Roleplay
+
Visual-Novel Choices
```

Nothing more is required for the first playable version.

The product should prioritize **story consistency, configurability, and low friction** before advanced agentic architecture.
