/* Standalone design prototype. AI, checks and item effects are simulated. */
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clone = (value) => structuredClone(value);
const storeKey = "fworld-design-prototype-v1";
const sections = [
  "Overview",
  "Opening scenario",
  "Player",
  "NPCs",
  "Attributes",
  "Resources",
  "Relationships",
  "Items",
  "Starting inventory",
  "AI Settings",
];
const numeric = (name, value = 0, min = 0, max = 20) => ({
  name,
  min,
  max,
  value,
  description: "",
});
const sample = {
  id: "kamakura",
  title: "Summer in Kamakura",
  description: "A quiet summer of unexpected friendships by the sea.",
  genre: "Slice of life",
  tone: "Gentle and reflective",
  language: "English",
  setting: "Kamakura, Japan. A small coastal town in summer.",
  scenario:
    "You arrive in Kamakura with a camera and no plans. At the station, a girl asks you to take her picture.",
  rules: "A contemporary world without magic.",
  context: "The last train leaves at sunset.",
  player: {
    name: "Ren",
    description: "A curious traveler with a film camera.",
    background: "Taking a summer away from the city.",
    personality: "Thoughtful, curious",
    notes: "Enjoys quiet places.",
  },
  npcs: [
    {
      name: "Aiko",
      description: "A film photography student.",
      background: "Grew up in Kamakura.",
      role: "New friend",
      personality: "Reserved, observant, kind",
      goals: "Finish her photography project",
      privateKnowledge: "Plans to move away in autumn",
      trust: 14,
      affection: 8,
    },
  ],
  attributes: [
    numeric("Intelligence", 8),
    numeric("Charm", 5),
    numeric("Creativity", 6),
  ],
  resources: [numeric("Yen", 4500, 0, 10000), numeric("Energy", 80, 0, 100)],
  relationships: [
    numeric("Trust", 14, 0, 100),
    numeric("Affection", 8, 0, 100),
  ],
  items: [
    {
      name: "Camera",
      description: "A well-loved 35mm film camera.",
      stackable: false,
      maxStack: 1,
      consumable: false,
      tags: "Photography",
      effects: [],
    },
    {
      name: "Umbrella",
      description: "For sudden summer showers.",
      stackable: false,
      maxStack: 1,
      consumable: false,
      tags: "Utility",
      effects: [],
    },
    {
      name: "Rice ball",
      description: "A small snack for the road.",
      stackable: true,
      maxStack: 10,
      consumable: true,
      tags: "Food",
      effects: [
        {
          type: "RESOURCE_CHANGE",
          target: "Energy",
          operation: "ADD",
          value: 10,
          npc: "",
        },
      ],
    },
  ],
  inventory: [
    { name: "Camera", quantity: 1 },
    { name: "Umbrella", quantity: 1 },
    { name: "Rice ball", quantity: 2 },
  ],
  provider: "Gemini",
  model: "gemini-flash",
  randomness: "NORMAL",
  session: {
    turn: 12,
    location: "Yuigahama Beach",
    time: "Day 3 · Afternoon",
    scene: "At the seawall",
    facts: [
      {
        text: "Aiko enjoys film photography.",
        visibility: "public",
        knownBy: "Ren, Aiko",
      },
      {
        text: "You promised to visit the old bookshop.",
        visibility: "public",
        knownBy: "Ren, Aiko",
      },
    ],
    messages: [
      {
        role: "Narrator",
        text: "The last train fades into the distance. Aiko lowers her camera, watching sunlight scatter across the water.",
      },
      {
        role: "Aiko",
        text: "Do you have a place you go when you need to think?",
      },
    ],
  },
};
const fantasy = {
  ...clone(sample),
  id: "lantern",
  title: "The Lantern Archive",
  genre: "Fantasy",
  description:
    "A city of lanterns, forgotten names, and a library that opens after dark.",
  setting: "An ancient mountain city.",
  scenario:
    "A sealed letter arrives at your door. Its ink glows in the moonlight.",
  session: null,
};
let data = {
  games: [clone(sample), clone(fantasy)],
  settings: { provider: "Gemini", model: "gemini-flash", textSize: "normal" },
};
try {
  const saved = JSON.parse(localStorage.getItem(storeKey));
  if (saved?.games && Array.isArray(saved.games)) data = saved;
} catch {
  /* A blocked store does not prevent previewing. */
}
let selected = data.games[0]?.id,
  draft,
  mode = "choices",
  busy = false;
let credentials = { Gemini: "", OpenRouter: "" };
let failedInput = "";
const app = $("#app");
function notify(message) {
  $("#notice").textContent = message;
  $("#notice").style.display = "block";
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => ($("#notice").style.display = "none"), 4500);
}
function persist() {
  try {
    localStorage.setItem(storeKey, JSON.stringify(data));
    return true;
  } catch {
    notify("Penyimpanan browser gagal. Export untuk menyimpan salinan.");
    return false;
  }
}
function current() {
  return data.games.find((g) => g.id === selected);
}
function cover(game) {
  return game.id === "lantern" ? "assets/lantern.svg" : "assets/coast.svg";
}
function field(label, path, value, type = "text", options) {
  path = escapeHtml(path);
  return `<label>${escapeHtml(label)}${type === "textarea" ? `<textarea data-path="${path}">${escapeHtml(value)}</textarea>` : type === "select" ? `<select data-path="${path}">${options.map((o) => `<option ${o === value ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>` : type === "checkbox" ? `<input data-path="${path}" type="checkbox" ${value ? "checked" : ""}>` : `<input data-path="${path}" type="${type}" value="${escapeHtml(value)}" ${type === "number" ? 'step="any"' : ""}>`}</label>`;
}
function nav(route) {
  const session = ["story", "player", "inventory", "people", "facts"].includes(
    route,
  );
  const links = session
    ? [
        ["story", "▤", "Story"],
        ["player", "♙", "Player"],
        ["inventory", "▣", "Inventory"],
        ["people", "♧", "People"],
        ["facts", "≡", "Facts"],
      ]
    : [
        ["library", "▤", "Library"],
        ["settings", "⚙", "Settings"],
      ];
  $("#navigation").innerHTML =
    route === "editor"
      ? ""
      : links
          .map(
            ([url, icon, label]) =>
              `<a href="#${url}" ${route === url ? 'aria-current="page"' : ""}><span aria-hidden="true">${icon}</span>${label}</a>`,
          )
          .join("");
  $("#navigation").style.display = route === "editor" ? "none" : "flex";
}
function library() {
  const active = data.games.find((g) => g.session);
  app.innerHTML = `<div class="intro"><div class="eyebrow">Your story library</div><h1>A world to return to.</h1><p>Pick up a story, or begin your own.</p></div><div class="library-grid"><section><h2>Continue playing</h2>${active ? `<article class="featured"><img class="cover" src="${cover(active)}" alt="Illustrated story landscape"><div class="body"><h2>${escapeHtml(active.title)}</h2><p class="muted">${escapeHtml(active.session.time)} · Turn ${active.session.turn}</p><p><small>Progress tersimpan di browser mockup ini</small></p><button class="primary wide" data-action="play" data-id="${active.id}">Continue story →</button></div></article>` : '<div class="empty"><p>Belum ada cerita aktif.</p><button data-action="create">Create your first world</button></div>'}</section><section><div class="section-head"><h2>Your worlds</h2><small>${data.games.length} games</small></div><input class="search" id="search" aria-label="Cari game" placeholder="Search your worlds…"><div id="world-list">${worldRows(data.games)}</div><div class="toolbar"><button class="primary wide" data-action="create">＋ Create a new game</button></div><p class="footer-note">Stories are saved in this browser. Data contoh terpisah dari save aplikasi utama.</p></section></div>`;
}
function worldRows(games) {
  return (
    games
      .map(
        (g) =>
          `<article class="world"><img src="${cover(g)}" alt=""><div class="description"><h3>${escapeHtml(g.title)}</h3><small>${escapeHtml(g.genre)} · ${g.session ? "In progress" : "Ready to play"}</small></div><div class="actions"><button data-action="play" data-id="${g.id}" aria-label="Mainkan ${escapeHtml(g.title)}">→</button><button data-action="game-menu" data-id="${g.id}" aria-label="Menu ${escapeHtml(g.title)}">⋮</button></div></article>`,
      )
      .join("") || '<p class="empty">Tidak ada dunia yang cocok.</p>'
  );
}
function numberEditor(kind) {
  return (
    draft[kind]
      .map(
        (v, i) =>
          `<div class="entity"><div class="row"><h3>${escapeHtml(v.name || "New definition")}</h3><button class="danger" data-action="remove" data-kind="${kind}" data-index="${i}">Remove</button></div>${field("Name", `${kind}.${i}.name`, v.name)}${field("Description", `${kind}.${i}.description`, v.description)}<div class="fields">${field("Minimum", `${kind}.${i}.min`, v.min, "number")}${field("Maximum", `${kind}.${i}.max`, v.max, "number")}${field(kind === "resources" ? "Initial value" : "Default value", `${kind}.${i}.value`, v.value, "number")}</div></div>`,
      )
      .join("") +
    `<button data-action="add" data-kind="${kind}">＋ Add ${kind.slice(0, -1)}</button>`
  );
}
function characterFields(person, path) {
  return (
    field("Name", `${path}.name`, person.name) +
    field(
      "Description",
      `${path}.description`,
      person.description,
      "textarea",
    ) +
    field("Background", `${path}.background`, person.background, "textarea") +
    field("Personality", `${path}.personality`, person.personality, "textarea")
  );
}
function aiFields(value) {
  return `<div class="fields">${field("Provider", "provider", value.provider, "select", ["Gemini", "OpenRouter"])}${field("Model ID", "model", value.model)}</div><label>API key · hanya di memory<input id="api-key" type="password" autocomplete="off" placeholder="Tidak diperlukan untuk mockup" value="${escapeHtml(credentials[value.provider] || "")}"></label><button data-action="test-ai">Test connection (simulation)</button><p class="settings-note">Mockup memakai respons contoh. Tidak ada request ke Gemini atau OpenRouter.</p>`;
}
function editor() {
  if (!draft) {
    location.hash = "library";
    return;
  }
  const content = [
    field("Game title", "title", draft.title) +
      field("Description", "description", draft.description, "textarea") +
      `<div class="fields">${field("Genre", "genre", draft.genre)}${field("Tone", "tone", draft.tone)}${field("Language", "language", draft.language)}</div>`,
    field("World setting", "setting", draft.setting, "textarea") +
      field("Starting situation", "scenario", draft.scenario, "textarea") +
      field("World rules", "rules", draft.rules, "textarea") +
      field("Additional context", "context", draft.context, "textarea"),
    characterFields(draft.player, "player") +
      field("Notes", "player.notes", draft.player.notes, "textarea") +
      `<h3>Initial attributes & resources</h3>${["attributes", "resources"].map((k) => draft[k].map((v, i) => field(v.name, `${k}.${i}.value`, v.value, "number")).join("")).join("")}`,
    draft.npcs
      .map(
        (n, i) =>
          `<div class="entity"><div class="row"><h3>${escapeHtml(n.name || "New NPC")}</h3><button data-action="remove" data-kind="npcs" data-index="${i}">Remove NPC</button></div>${characterFields(n, `npcs.${i}`)}${field("Role", `npcs.${i}.role`, n.role)}${field("Goals", `npcs.${i}.goals`, n.goals, "textarea")}${field("Private knowledge", `npcs.${i}.privateKnowledge`, n.privateKnowledge, "textarea")}<h3>Initial relationships</h3>${draft.relationships.map((r) => field(r.name, `npcs.${i}.rel_${r.name}`, n[`rel_${r.name}`] ?? r.value, "number")).join("")}</div>`,
      )
      .join("") +
      '<button data-action="add" data-kind="npcs">＋ Add NPC</button>',
    numberEditor("attributes"),
    numberEditor("resources"),
    numberEditor("relationships"),
    draft.items
      .map(
        (item, i) =>
          `<div class="entity"><div class="row"><h3>${escapeHtml(item.name || "New item")}</h3><button data-action="remove" data-kind="items" data-index="${i}">Remove item</button></div>${field("Name", `items.${i}.name`, item.name)}${field("Description", `items.${i}.description`, item.description, "textarea")}<div class="fields">${field("Stackable", `items.${i}.stackable`, item.stackable, "checkbox")}${field("Consumable", `items.${i}.consumable`, item.consumable, "checkbox")}${field("Maximum stack", `items.${i}.maxStack`, item.maxStack, "number")}${field("Tags", `items.${i}.tags`, item.tags)}</div><h3>Effects</h3>${item.effects.map((e, j) => `<div class="entity">${field("Type", `items.${i}.effects.${j}.type`, e.type, "select", ["ATTRIBUTE_CHANGE", "RESOURCE_CHANGE", "RELATIONSHIP_CHANGE", "ADD_ITEM", "REMOVE_ITEM", "ADD_FACT", "REMOVE_FACT"])}${field("Target / fact text", `items.${i}.effects.${j}.target`, e.target)}${field("NPC (relationship effect)", `items.${i}.effects.${j}.npc`, e.npc)}<div class="fields">${field("Operation", `items.${i}.effects.${j}.operation`, e.operation, "select", ["ADD", "SUBTRACT", "SET"])}${field("Value / quantity", `items.${i}.effects.${j}.value`, e.value, "number")}</div><button data-action="remove-effect" data-index="${i}" data-effect="${j}">Remove effect</button></div>`).join("")}<button data-action="add-effect" data-index="${i}">＋ Add effect</button></div>`,
      )
      .join("") +
      '<button data-action="add" data-kind="items">＋ Add item</button>',
    draft.inventory
      .map(
        (v, i) =>
          `<div class="entity"><div class="fields">${field(
            "Item",
            `inventory.${i}.name`,
            v.name,
            "select",
            draft.items.map((x) => x.name),
          )}${field("Quantity", `inventory.${i}.quantity`, v.quantity, "number")}</div><button data-action="remove" data-kind="inventory" data-index="${i}">Remove entry</button></div>`,
      )
      .join("") +
      '<button data-action="add" data-kind="inventory">＋ Add inventory entry</button>',
    aiFields(draft) +
      field(
        "Randomness (check preview)",
        "randomness",
        draft.randomness,
        "select",
        ["OFF", "LOW", "NORMAL", "HIGH"],
      ),
  ];
  app.innerHTML = `<div class="editor"><div class="row"><a href="#library">← Library</a><button data-action="cancel">Cancel</button></div><div class="intro"><div class="eyebrow">A new story</div><h1>${data.games.some((g) => g.id === draft.id) ? "Edit your world" : "Create your world"}</h1><p>Set the scene. Let the story unfold.</p></div><div class="toolbar"><button data-action="import-template">↥ Import JSON template</button><button data-action="export-template">↧ Export JSON template</button></div><p class="settings-note">Import mengisi editor untuk cerita baru. Template tidak menyertakan progress, history, atau API key.</p><div id="validation" role="alert"></div>${sections.map((name, i) => `<details ${i < 2 ? "open" : ""} data-section="${i}"><summary>${name}</summary><div class="content">${content[i]}</div></details>`).join("")}<div class="sticky-actions"><button data-action="save" class="primary">Save game</button><button data-action="save-start">Save & start</button></div></div>`;
}
function panelHead(title) {
  return `<div class="row"><a href="#library">← Library</a><button data-action="session-menu">⋮ Session</button></div><h1>${title}</h1>`;
}
function stats(values) {
  return values
    .map(
      (v) =>
        `<div class="stat"><div class="row"><span>${escapeHtml(v.name)}</span><strong>${escapeHtml(v.value)}</strong></div><meter min="${v.min}" max="${v.max}" value="${v.value}" aria-label="${escapeHtml(v.name)}"></meter><small>${escapeHtml(v.description)}</small></div>`,
    )
    .join("");
}
function story() {
  const g = current();
  app.innerHTML = `<section class="story">${panelHead(escapeHtml(g.title))}<p class="muted">${escapeHtml(g.session.time)} · ${escapeHtml(g.session.location)} · Turn ${g.session.turn}</p><img class="cover" src="${cover(g)}" alt="Illustrated seaside scene"><p class="settings-note">Preview mode · cerita dan perubahan state disimulasikan.</p><div id="transcript">${g.session.messages.map((m) => `<article class="message ${m.role === "You" ? "player" : m.role === "Event" ? "event" : ""}"><small>${escapeHtml(m.role)}</small><p>${escapeHtml(m.text)}</p></article>`).join("")}</div><div class="composer"><div class="tabs"><button data-action="mode" data-mode="chat" class="${mode === "chat" ? "selected" : ""}">Free Chat</button><button data-action="mode" data-mode="choices" class="${mode === "choices" ? "selected" : ""}">Choice Mode</button></div>${mode === "choices" ? `<div class="choices">${["Ask what brought her here", "Tell her about your favorite place", "Watch the waves together"].map((t) => `<button data-action="choice" data-text="${t}" ${busy ? "disabled" : ""}>${t} →</button>`).join("")}</div>` : ""}<label for="action-input">Your action</label><textarea id="action-input" placeholder="Write your own action…" ${busy ? "disabled" : ""}>${escapeHtml(failedInput)}</textarea><div class="row"><small>${busy ? "Simulating a turn…" : "No API key needed"}</small><button data-action="send" class="primary" ${busy ? "disabled" : ""}>Send →</button></div><button data-action="simulate-error">Preview failed turn</button>${failedInput ? '<p class="error">Simulated connection failure. Progress unchanged; input preserved. Send to retry.</p>' : ""}</div></section>`;
}
function player() {
  const g = current();
  app.innerHTML = `<section class="panel">${panelHead("Player")}<div class="person-head"><div class="avatar">${escapeHtml(g.player.name[0])}</div><div><h2>${escapeHtml(g.player.name)}</h2><small>${escapeHtml(g.player.description)}</small></div></div><h2>Attributes</h2>${stats(g.attributes)}<h2>Resources</h2>${stats(g.resources)}<details><summary>Background & notes</summary><p>${escapeHtml(g.player.background)}</p><p>${escapeHtml(g.player.personality)}</p><p>${escapeHtml(g.player.notes)}</p></details><h2>Attribute check preview</h2><label>Attribute<select id="check-attribute">${g.attributes.map((a, i) => `<option value="${i}">${escapeHtml(a.name)}</option>`).join("")}</select></label><label>Difficulty<input type="number" id="difficulty" value="6" min="0" max="100"></label><button data-action="check">Run sample check</button><div id="check-result" aria-live="polite"></div></section>`;
}
function inventory() {
  const g = current();
  app.innerHTML = `<section class="panel">${panelHead("Inventory")}<p class="muted">${g.inventory.reduce((sum, i) => sum + i.quantity, 0)} items carried</p>${
    g.inventory
      .map((entry, i) => {
        const item = g.items.find((v) => v.name === entry.name);
        return `<article class="item"><div class="row"><h3>${escapeHtml(entry.name)}</h3><strong>× ${entry.quantity}</strong></div><p class="muted">${escapeHtml(item?.description)}</p><div class="toolbar"><button data-action="item-detail" data-index="${i}">Details</button><button data-action="use-item" data-index="${i}" ${entry.quantity < 1 ? "disabled" : ""}>${item?.consumable ? "Use item" : "Inspect"}</button></div></article>`;
      })
      .join("") || '<p class="empty">Your inventory is empty.</p>'
  }</section>`;
}
function people() {
  const g = current();
  app.innerHTML = `<section class="panel">${panelHead("People")}${g.npcs.map((n, i) => `<article><div class="person-head"><div class="avatar">${escapeHtml(n.name[0])}</div><div><h2>${escapeHtml(n.name)}</h2><small>${escapeHtml(n.role)}</small></div></div><p>${escapeHtml(n.description)}</p>${stats(g.relationships.map((r) => ({ ...r, value: n[`rel_${r.name}`] ?? n[r.name.toLowerCase()] ?? r.value })))}<button data-action="npc-detail" data-index="${i}">Character details</button></article>`).join("")}</section>`;
}
function facts() {
  const g = current();
  app.innerHTML = `<section class="panel">${panelHead("World & memory")}<h2>Current scene</h2><dl><dt>Location</dt><dd>${escapeHtml(g.session.location)}</dd><dt>Time</dt><dd>${escapeHtml(g.session.time)}</dd><dt>Scene</dt><dd>${escapeHtml(g.session.scene)}</dd></dl><h2>Story facts</h2>${g.session.facts.map((f) => `<div class="fact"><p>${escapeHtml(f.text)}</p><small>${escapeHtml(f.visibility)} · Known by ${escapeHtml(f.knownBy)}</small></div>`).join("")}<h2>Conversation history</h2><p>${g.session.messages.length} messages · Turn ${g.session.turn}</p><button data-action="history">Read full history</button></section>`;
}
function settings() {
  app.innerHTML = `<section class="panel"><a href="#library">← Library</a><h1>Settings</h1><h2>AI connection</h2>${aiFields(data.settings)}<h2>Reading</h2>${field("Text size", "textSize", data.settings.textSize, "select", ["normal", "large"])}<h2>Save & backup</h2><p class="muted">Local preview data is stored separately from the real app.</p><div class="toolbar"><button data-action="export-all">Export mockup library</button><button data-action="restore">Restore mockup backup</button></div><button data-action="reset" class="danger">Reset demo data</button></section>`;
}
function render() {
  const route = location.hash.slice(1) || "library";
  nav(route);
  if (
    ["story", "player", "inventory", "people", "facts"].includes(route) &&
    !current()?.session
  ) {
    location.hash = "library";
    return;
  }
  (
    ({ library, editor, story, player, inventory, people, facts, settings })[
      route
    ] || library
  )();
  app.style.fontSize = data.settings.textSize === "large" ? "18px" : "";
}
function go(route) {
  if (location.hash === `#${route}`) render();
  else location.hash = route;
}
function showDialog(html) {
  $("#modal-content").innerHTML = html;
  $("#modal").showModal();
}
function updatePath(object, path, value) {
  const keys = path.split(".");
  if (
    keys.some((key) => ["__proto__", "constructor", "prototype"].includes(key))
  )
    return;
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key];
  target[keys.at(-1)] = value;
}
function validate(g) {
  const errors = [];
  if (!g.title.trim()) errors.push("Game title is required.");
  if (!g.player.name.trim()) errors.push("Player name is required.");
  if (!g.scenario.trim()) errors.push("Opening scenario is required.");
  for (const kind of ["attributes", "resources", "relationships"]) {
    const names = new Set();
    for (const v of g[kind]) {
      if (!v.name.trim() || names.has(v.name))
        errors.push(`${kind}: names must be nonempty and unique.`);
      names.add(v.name);
      if (
        ![v.min, v.max, v.value].every(Number.isFinite) ||
        v.min > v.value ||
        v.value > v.max
      )
        errors.push(`${v.name}: minimum ≤ value ≤ maximum.`);
    }
  }
  for (const entry of g.inventory) {
    if (
      !g.items.some((i) => i.name === entry.name) ||
      !Number.isInteger(entry.quantity) ||
      entry.quantity < 1
    )
      errors.push(
        "Inventory: choose an existing item and positive integer quantity.",
      );
  }
  return [...new Set(errors)];
}
function saveDraft(start) {
  const errors = validate(draft);
  if (errors.length) {
    $("#validation").innerHTML =
      `<p class="error">${errors.map(escapeHtml).join("<br>")}</p>`;
    $("#validation").scrollIntoView({ block: "center" });
    return;
  }
  const existing = data.games.findIndex((g) => g.id === draft.id);
  const saved = clone(draft);
  if (existing >= 0) data.games[existing] = saved;
  else data.games.push(saved);
  selected = saved.id;
  persist();
  draft = null;
  if (start) startSession(saved);
  else go("library");
  notify("Game saved in mockup library.");
}
function startSession(g) {
  if (!g.session)
    g.session = {
      turn: 0,
      location: g.setting,
      time: "Day 1",
      scene: g.scenario,
      facts: [],
      messages: [{ role: "Narrator", text: g.scenario }],
    };
  selected = g.id;
  persist();
  go("story");
}
async function turn(text) {
  if (busy || !text.trim()) return;
  const g = current();
  busy = true;
  failedInput = "";
  render();
  await new Promise((resolve) => setTimeout(resolve, 650));
  g.session.turn++;
  g.session.messages.push(
    { role: "You", text },
    {
      role: "Narrator",
      text: `${g.npcs[0]?.name || "Your companion"} pauses, considering your words. The conversation takes a quieter turn as you explore the world together.`,
    },
    { role: "Event", text: "Simulated turn completed · story memory updated" },
  );
  if (
    !g.session.facts.some(
      (f) => f.text === "You shared a quiet moment together.",
    )
  )
    g.session.facts.push({
      text: "You shared a quiet moment together.",
      visibility: "public",
      knownBy: [g.player.name, g.npcs[0]?.name].filter(Boolean).join(", "),
    });
  busy = false;
  persist();
  render();
  $(".composer").scrollIntoView({ block: "end" });
}
function download(games) {
  downloadJson(
    { format: "fworld-mockup", version: 1, games },
    "fworld-mockup-save.json",
  );
}
function templateBundle(game) {
  const template = Object.fromEntries(
    Object.keys(sample)
      .filter((key) => !["id", "session"].includes(key))
      .map((key) => [key, clone(game[key])]),
  );
  return { format: "fworld-mockup-template", version: 1, game: template };
}
function readTemplate(bundle) {
  if (
    bundle?.format !== "fworld-mockup-template" ||
    bundle.version !== 1 ||
    !bundle.game
  )
    throw Error("Choose a Fworld JSON template.");
  const game = bundle.game;
  if (
    !game.player ||
    ![
      "npcs",
      "attributes",
      "resources",
      "relationships",
      "items",
      "inventory",
    ].every((key) => Array.isArray(game[key]))
  )
    throw Error("Invalid template structure.");
  for (const key of [
    "title",
    "description",
    "genre",
    "tone",
    "language",
    "setting",
    "scenario",
    "rules",
    "context",
    "provider",
    "model",
    "randomness",
  ])
    if (typeof game[key] !== "string")
      throw Error("Invalid template field: " + key);
  const template = templateBundle(game).game;
  return { ...template, id: crypto.randomUUID(), session: null };
}
let importTemplate = false;
function downloadJson(bundle, filename) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.id === "search")
    $("#world-list").innerHTML = worldRows(
      data.games.filter((g) =>
        g.title.toLowerCase().includes(el.value.toLowerCase()),
      ),
    );
  if (el.id === "api-key")
    credentials[(draft || data.settings).provider] = el.value;
  if (el.dataset.path) {
    updatePath(
      draft || data.settings,
      el.dataset.path,
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? Number(el.value)
          : el.value,
    );
    if (!draft) persist();
  }
});
document.addEventListener("change", (event) => {
  if (event.target.dataset.path === "provider") {
    credentials = { Gemini: "", OpenRouter: "" };
    if (draft) editor();
    else settings();
  }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const a = button.dataset.action,
    g = current();
  if (a === "settings") go("settings");
  if (a === "create") {
    draft = {
      ...clone(fantasy),
      id: crypto.randomUUID(),
      title: "",
      description: "",
      genre: "",
      tone: "",
      setting: "",
      scenario: "",
      player: {
        name: "",
        description: "",
        background: "",
        personality: "",
        notes: "",
      },
      npcs: [],
      attributes: [],
      resources: [],
      relationships: [],
      items: [],
      inventory: [],
      session: null,
    };
    go("editor");
  }
  if (a === "cancel") {
    draft = null;
    go("library");
  }
  if (a === "play")
    startSession(data.games.find((x) => x.id === button.dataset.id));
  if (a === "game-menu") {
    selected = button.dataset.id;
    showDialog(
      `<h2>${escapeHtml(current().title)}</h2><div class="toolbar"><button data-action="edit">Edit template</button><button data-action="export">Export save</button><button class="danger" data-action="delete">Delete world</button></div>`,
    );
  }
  if (a === "edit") {
    draft = clone(g);
    $("#modal").close();
    go("editor");
  }
  if (a === "delete") {
    showDialog(
      '<h2>Delete this world?</h2><p>This removes its mockup progress. Export a copy first if needed.</p><button class="danger" data-action="confirm-delete">Delete world</button>',
    );
  }
  if (a === "confirm-delete") {
    data.games = data.games.filter((x) => x.id !== selected);
    selected = data.games[0]?.id;
    persist();
    $("#modal").close();
    go("library");
  }
  if (a === "save" || a === "save-start") saveDraft(a === "save-start");
  if (a === "add") {
    const k = button.dataset.kind;
    draft[k].push(
      k === "npcs"
        ? {
            name: "",
            description: "",
            background: "",
            personality: "",
            goals: "",
            privateKnowledge: "",
            role: "",
          }
        : k === "items"
          ? {
              name: "",
              description: "",
              stackable: true,
              maxStack: 10,
              consumable: false,
              tags: "",
              effects: [],
            }
          : k === "inventory"
            ? { name: draft.items[0]?.name || "", quantity: 1 }
            : numeric("", 0),
    );
    refreshEditor(k);
  }
  if (a === "remove") {
    draft[button.dataset.kind].splice(Number(button.dataset.index), 1);
    refreshEditor(button.dataset.kind);
  }
  if (a === "add-effect") {
    draft.items[button.dataset.index].effects.push({
      type: "RESOURCE_CHANGE",
      target: "",
      operation: "ADD",
      value: 1,
      npc: "",
    });
    refreshEditor("items");
  }
  if (a === "remove-effect") {
    draft.items[button.dataset.index].effects.splice(
      Number(button.dataset.effect),
      1,
    );
    refreshEditor("items");
  }
  if (a === "mode") {
    mode = button.dataset.mode;
    render();
  }
  if (a === "choice") await turn(button.dataset.text);
  if (a === "send") await turn($("#action-input").value);
  if (a === "simulate-error") {
    failedInput = $("#action-input").value || "I ask Aiko about her camera.";
    render();
  }
  if (a === "test-ai")
    notify(
      "Simulation: connection successful. No real provider request was made.",
    );
  if (a === "session-menu")
    showDialog(
      `<h2>Session</h2><p>${escapeHtml(g.title)} · Turn ${g.session.turn}</p><div class="toolbar"><button data-action="export">Export mockup save</button><button data-action="edit">Edit template</button><button data-action="settings">AI Settings</button></div><small>Editing the template is a design preview.</small>`,
    );
  if (a === "export" || a === "export-all")
    download(a === "export" ? [g] : data.games);
  if (a === "export-template")
    downloadJson(templateBundle(draft), "fworld-story-template.json");
  if (a === "import-template" || a === "restore") {
    importTemplate = a === "import-template";
    $("#import-file").click();
  }
  if (a === "reset")
    showDialog(
      '<h2>Reset demo data?</h2><p>Your mockup worlds will be replaced by the two original examples.</p><button data-action="confirm-reset" class="danger">Reset demo data</button>',
    );
  if (a === "confirm-reset") {
    data.games = [clone(sample), clone(fantasy)];
    selected = data.games[0].id;
    persist();
    $("#modal").close();
    go("library");
  }
  if (a === "item-detail") {
    const entry = g.inventory[button.dataset.index],
      item = g.items.find((x) => x.name === entry.name);
    showDialog(
      `<h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(item?.description)}</p><p>Quantity: ${entry.quantity} · ${item?.consumable ? "Consumable" : "Reusable"}</p><h3>Effects</h3>${item?.effects.map((e) => `<p>${escapeHtml(e.type)} · ${escapeHtml(e.target)} ${escapeHtml(e.operation)} ${e.value}</p>`).join("") || "<p>No numeric effects.</p>"}`,
    );
  }
  if (a === "use-item") {
    const entry = g.inventory[button.dataset.index],
      item = g.items.find((x) => x.name === entry.name);
    if (!item?.consumable) {
      notify("You inspect the item. Nothing is consumed.");
      return;
    }
    entry.quantity--;
    for (const effect of item.effects) {
      const r = g.resources.find((x) => x.name === effect.target);
      if (effect.type === "RESOURCE_CHANGE" && r)
        r.value = Math.max(
          r.min,
          Math.min(
            r.max,
            effect.operation === "SET"
              ? effect.value
              : r.value +
                  (effect.operation === "SUBTRACT"
                    ? -effect.value
                    : effect.value),
          ),
        );
    }
    g.inventory = g.inventory.filter((x) => x.quantity > 0);
    g.session.messages.push({
      role: "Event",
      text: `Simulated item use: ${item.name}`,
    });
    persist();
    render();
    notify("Item used (simulation).");
  }
  if (a === "npc-detail") {
    const n = g.npcs[button.dataset.index];
    showDialog(
      `<h2>${escapeHtml(n.name)}</h2><p>${escapeHtml(n.background)}</p><h3>Personality</h3><p>${escapeHtml(n.personality)}</p><h3>Goals</h3><p>${escapeHtml(n.goals)}</p><p class="muted">Private knowledge is visible only in the template editor.</p>`,
    );
  }
  if (a === "history")
    showDialog(
      `<h2>Conversation history</h2>${g.session.messages.map((m) => `<h3>${escapeHtml(m.role)}</h3><p>${escapeHtml(m.text)}</p>`).join("")}`,
    );
  if (a === "check") {
    const stat = g.attributes[Number($("#check-attribute").value)],
      difficulty = Number($("#difficulty").value);
    if (!stat || !Number.isFinite(difficulty) || difficulty < 0) {
      notify("Choose an attribute and valid difficulty.");
      return;
    }
    $("#check-result").innerHTML =
      `<p class="check">Deterministic sample · ${escapeHtml(stat.name)} ${stat.value} vs ${difficulty}<br><strong>${stat.value >= difficulty ? "Success" : "Failure"}</strong></p>`;
  }
  if (a === "settings" && $("#modal").open) $("#modal").close();
});
function refreshEditor(kind) {
  const index = {
    npcs: 3,
    attributes: 4,
    resources: 5,
    relationships: 6,
    items: 7,
    inventory: 8,
  }[kind];
  const open = [...document.querySelectorAll("details[open]")].map(
    (d) => d.dataset.section,
  );
  editor();
  for (const id of [...open, String(index)])
    document.querySelector(`details[data-section="${id}"]`).open = true;
}
$("#close-dialog").onclick = () => $("#modal").close();
$("#import-file").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw Error("File too large (maximum 2 MB).");
    const bundle = JSON.parse(await file.text());
    if (importTemplate) {
      const importedDraft = readTemplate(bundle);
      draft = importedDraft;
      editor();
      event.target.value = "";
      notify("Template loaded. Review and save to create a new story.");
      return;
    }
    if (
      bundle.format !== "fworld-mockup" ||
      bundle.version !== 1 ||
      !Array.isArray(bundle.games) ||
      bundle.games.length > 100
    )
      throw Error("Use a mockup export, not a production save.");
    const imported = [];
    for (const raw of bundle.games) {
      const entry = clone(raw);
      if (
        !entry ||
        typeof entry.title !== "string" ||
        !entry.player ||
        ![
          "npcs",
          "attributes",
          "resources",
          "relationships",
          "items",
          "inventory",
        ].every((k) => Array.isArray(entry[k])) ||
        validate(entry).length
      )
        throw Error("Invalid game configuration.");
      if (
        entry.session &&
        (!Array.isArray(entry.session.messages) ||
          !Array.isArray(entry.session.facts))
      )
        throw Error("Invalid session.");
      entry.id = crypto.randomUUID();
      entry.title += " (imported)";
      imported.push(entry);
    }
    data.games.push(...imported);
    persist();
    go("library");
    notify("Imported as new copies.");
  } catch (error) {
    notify(`Import failed: ${error.message}`);
  }
  event.target.value = "";
};
window.addEventListener("hashchange", () => {
  render();
  window.scrollTo(0, 0);
});
render();
