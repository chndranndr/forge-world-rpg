/* Fworld prototype interactions. No dependencies. */
(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var focusables = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /* ---------- Toasts ---------- */

  function toastRegion() {
    var region = $(".toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region";
      region.setAttribute("role", "status");
      region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    return region;
  }

  function toast(message, kind) {
    var region = toastRegion();
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " toast--" + kind : "");
    var icon = kind === "error" ? "i-alert" : "i-check";
    el.innerHTML = '<svg class="icon" aria-hidden="true"><use href="assets/icons.svg#' + icon + '"></use></svg><span></span>';
    el.lastElementChild.textContent = message;
    region.appendChild(el);
    window.setTimeout(function () {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      el.style.transition = "opacity 180ms ease, transform 180ms ease";
      window.setTimeout(function () { el.remove(); }, 220);
    }, kind === "error" ? 8000 : 4000);
  }

  /* ---------- Menus ---------- */

  var openMenu = null;

  function closeMenu(restore) {
    if (!openMenu) return;
    var trigger = openMenu.trigger;
    openMenu.menu.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    openMenu = null;
    if (restore) trigger.focus();
  }

  function initMenus() {
    $$("[data-menu]").forEach(function (trigger) {
      var menu = document.getElementById(trigger.getAttribute("data-menu"));
      if (!menu) return;
      trigger.setAttribute("aria-expanded", "false");
      trigger.addEventListener("click", function (event) {
        event.stopPropagation();
        var isOpen = menu.classList.contains("is-open");
        closeMenu(false);
        if (isOpen) return;
        menu.classList.add("is-open");
        trigger.setAttribute("aria-expanded", "true");
        openMenu = { trigger: trigger, menu: menu };
        var first = $("[role='menuitem'], button, a", menu);
        if (first) first.focus();
      });
      menu.addEventListener("click", function (event) {
        var item = event.target.closest("[role='menuitem'], .menu__item");
        if (item) {
          if (item.hasAttribute("data-toast")) toast(item.getAttribute("data-toast"));
          closeMenu(true);
        }
      });
      menu.addEventListener("keydown", function (event) {
        var items = $$("[role='menuitem'], .menu__item", menu);
        var index = items.indexOf(document.activeElement);
        if (event.key === "ArrowDown") {
          event.preventDefault();
          items[(index + 1) % items.length].focus();
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          items[(index - 1 + items.length) % items.length].focus();
        }
      });
    });

    document.addEventListener("click", function (event) {
      if (openMenu && !openMenu.menu.contains(event.target)) closeMenu(false);
    });
  }

  function initToasts() {
    $$("[data-toast]").forEach(function (trigger) {
      if (trigger.closest(".menu")) return;
      trigger.addEventListener("click", function () {
        toast(trigger.getAttribute("data-toast"));
      });
    });
  }

  /* ---------- Overlays ---------- */

  var overlayStack = [];
  var lastFocus = null;

  function scrim() {
    var el = $(".scrim");
    if (!el) {
      el = document.createElement("div");
      el.className = "scrim";
      el.setAttribute("data-scrim", "");
      document.body.appendChild(el);
      el.addEventListener("click", function () { closeTop(); });
    }
    return el;
  }

  function openOverlay(id, trigger) {
    var overlay = typeof id === "string" ? document.getElementById(id.replace(/^#/, "")) : id;
    if (!overlay) return;
    lastFocus = trigger || document.activeElement;
    overlay.classList.add("is-open");
    overlay.removeAttribute("aria-hidden");
    scrim().classList.add("is-open");
    document.body.classList.add("is-locked");
    overlayStack.push(overlay);
    var first = $(focusables, overlay);
    if (first) {
      window.setTimeout(function () { first.focus(); }, 40);
    }
  }

  function closeOverlay(overlay, restore) {
    if (!overlay) return;
    overlay.classList.remove("is-open");
    overlay.setAttribute("aria-hidden", "true");
    overlayStack = overlayStack.filter(function (item) { return item !== overlay; });
    if (!overlayStack.length) {
      scrim().classList.remove("is-open");
      document.body.classList.remove("is-locked");
    }
    if (restore !== false && lastFocus && document.contains(lastFocus)) {
      lastFocus.focus();
    }
  }

  function closeTop() {
    if (overlayStack.length) closeOverlay(overlayStack[overlayStack.length - 1]);
  }

  function initOverlays() {
    $$("[data-open]").forEach(function (trigger) {
      trigger.addEventListener("click", function (event) {
        event.preventDefault();
        openOverlay(trigger.getAttribute("data-open"), trigger);
      });
    });
    $$("[data-close]").forEach(function (trigger) {
      trigger.addEventListener("click", function () {
        closeOverlay(trigger.closest(".sheet, .dialog"));
      });
    });
    $$(".sheet, .dialog").forEach(function (overlay) {
      overlay.setAttribute("aria-hidden", "true");
      overlay.addEventListener("keydown", function (event) {
        if (event.key !== "Tab") return;
        var items = $$(focusables, overlay).filter(function (el) {
          return el.offsetParent !== null;
        });
        if (!items.length) return;
        var first = items[0];
        var last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (openMenu) {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (overlayStack.length) {
        event.preventDefault();
        closeTop();
      }
    });
  }

  /* ---------- Tabs ---------- */

  function activateTab(tab, syncHash) {
    var group = tab.closest("[data-tabs]");
    if (!group) return;
    var tabs = $$("[role='tab']", group);
    var panels = tabs.map(function (item) { return document.getElementById(item.getAttribute("aria-controls")); });
    tabs.forEach(function (item, index) {
      var selected = item === tab;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.setAttribute("tabindex", selected ? "0" : "-1");
      if (panels[index]) panels[index].hidden = !selected;
    });
    if (syncHash && group.hasAttribute("data-tab-hash") && window.history && window.history.replaceState) {
      window.history.replaceState(null, "", "#" + tab.id);
    }
  }

  function initTabs() {
    $$("[data-tabs]").forEach(function (group) {
      var tabs = $$("[role='tab']", group);
      var hash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
      if (hash && group.hasAttribute("data-tab-hash")) {
        var initial = tabs.filter(function (tab) { return tab.id === hash; })[0];
        if (initial) activateTab(initial, false);
      }
      tabs.forEach(function (tab, index) {
        tab.addEventListener("click", function () { activateTab(tab, true); });
        tab.addEventListener("keydown", function (event) {
          var next = null;
          if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabs[(index + 1) % tabs.length];
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabs[(index - 1 + tabs.length) % tabs.length];
          if (event.key === "Home") next = tabs[0];
          if (event.key === "End") next = tabs[tabs.length - 1];
          if (next) {
            event.preventDefault();
            activateTab(next, true);
            next.focus();
          }
        });
      });
    });

    $$("[data-tab-target]").forEach(function (trigger) {
      trigger.addEventListener("click", function () {
        var tab = $("[role='tab'][aria-controls='" + trigger.getAttribute("data-tab-target") + "']");
        if (tab) activateTab(tab);
      });
    });
  }

  /* ---------- Copy ---------- */

  function initCopy() {
    $$("[data-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        var text = button.getAttribute("data-copy");
        var target = text && text.charAt(0) === "#" ? $(text) : null;
        var value = target ? (target.value || target.textContent) : text;
        if (!value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function () {
            toast("Disalin ke papan klip.");
          }).catch(function () { toast("Tidak bisa menyalin di peramban ini.", "error"); });
        } else {
          toast("Tidak bisa menyalin di peramban ini.", "error");
        }
      });
    });
  }

  /* ---------- Confirmation actions ---------- */

  function initConfirm() {
    $$("[data-confirm-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var message = button.getAttribute("data-confirm-action") || "Perubahan disimpan.";
        var remove = button.getAttribute("data-remove");
        if (remove) {
          var target = $(remove);
          if (target) target.remove();
        }
        closeTop();
        toast(message);
      });
    });
  }

  /* ---------- Library search ---------- */

  function initSearch() {
    var input = $("[data-search]");
    if (!input) return;
    var cards = $$("[data-world-card]");
    var count = $("[data-world-count]");
    var noResult = $("[data-search-empty]");
    var wall = $("[data-wall]");
    var clear = $("[data-search-clear]");

    function apply() {
      var query = input.value.trim().toLowerCase();
      var shown = 0;
      cards.forEach(function (card) {
        var haystack = ((card.getAttribute("data-title") || "") + " " + (card.getAttribute("data-genre") || "")).toLowerCase();
        var match = !query || haystack.indexOf(query) !== -1;
        card.hidden = !match;
        if (match) shown += 1;
      });
      if (count) count.textContent = String(shown).padStart(2, "0") + " dunia";
      if (wall) wall.hidden = query && shown === 0;
      if (noResult) noResult.hidden = !(query && shown === 0);
      if (clear) clear.hidden = !query;
    }

    input.addEventListener("input", apply);
    if (clear) {
      clear.addEventListener("click", function () {
        input.value = "";
        apply();
        input.focus();
      });
    }
    apply();
  }

  /* ---------- Text size ---------- */

  function applyTextSize(size) {
    document.body.setAttribute("data-text-size", size);
    $$("[data-textsize]").forEach(function (button) {
      var active = button.getAttribute("data-textsize") === size;
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function initTextSize() {
    var stored = null;
    try { stored = window.localStorage.getItem("fworld-textsize"); } catch (error) { stored = null; }
    if (stored === "large" || stored === "normal") applyTextSize(stored);

    $$("[data-textsize]").forEach(function (button) {
      button.addEventListener("click", function () {
        var size = button.getAttribute("data-textsize");
        applyTextSize(size);
        try { window.localStorage.setItem("fworld-textsize", size); } catch (error) { /* ignore */ }
        toast(size === "large" ? "Ukuran teks diperbesar." : "Ukuran teks kembali normal.");
      });
    });

    $$("[data-textsize-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        var size = document.body.getAttribute("data-text-size") === "large" ? "normal" : "large";
        applyTextSize(size);
        try { window.localStorage.setItem("fworld-textsize", size); } catch (error) { /* ignore */ }
        toast(size === "large" ? "Ukuran teks diperbesar." : "Ukuran teks kembali normal.");
      });
    });
  }

  /* ---------- Focus mode ---------- */

  function initFocusMode() {
    var trigger = $("[data-focus-toggle]");
    if (!trigger) return;

    function enter() {
      lastFocus = trigger;
      document.body.classList.add("focus-mode");
      trigger.setAttribute("aria-pressed", "true");
      var exit = $("[data-focus-exit]");
      if (exit) exit.focus();
    }

    function exit() {
      document.body.classList.remove("focus-mode");
      trigger.setAttribute("aria-pressed", "false");
      trigger.focus();
    }

    trigger.addEventListener("click", function () {
      if (document.body.classList.contains("focus-mode")) exit(); else enter();
    });
    $$("[data-focus-exit]").forEach(function (button) {
      button.addEventListener("click", exit);
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && document.body.classList.contains("focus-mode") && !overlayStack.length) {
        event.preventDefault();
        exit();
      }
    });
  }

  /* ---------- Session composer ---------- */

  var replies = [
    "Angin membawa bau garam dan kayu basah. Di kejauhan, lentera di dermaga berkedip dua kali, lalu padam. Kamu mendengar langkah kaki berhenti tepat di belakangmu.",
    "Hujan mengetuk atap kanopi. Penjaga itu menatap peta di mejanya, lalu menggesernya sedikit ke arahmu. \"Kalau memang mencari jalur lama, jangan lewat gerbang utara malam ini.\"",
    "Air di bawah jembatan naik perlahan. Sebuah perahu tanpa lampu bergerak melawan arus, dan seseorang di buritannya menoleh tepat ketika kamu menoleh."
  ];

  function initComposer() {
    var composer = $("[data-composer]");
    if (!composer) return;
    var area = $("[data-composer-area]", composer);
    var send = $("[data-send]", composer);
    var status = $("[data-composer-status]", composer);
    var messages = $("[data-messages]");
    var fail = $("[data-composer-fail]");
    var replyIndex = 0;
    var busy = false;

    function grow() {
      area.style.height = "auto";
      area.style.height = Math.min(area.scrollHeight, 168) + "px";
      if (send) send.disabled = busy || !area.value.trim();
    }

    function scroll() {
      var dock = $(".composer-dock");
      if (dock) dock.scrollIntoView({ behavior: "smooth", block: "end" });
    }

    function appendPlayer(text) {
      if (!messages) return;
      var el = document.createElement("div");
      el.className = "msg msg--player";
      el.innerHTML = '<div class="msg__label">Kamu</div><div class="msg__body"><p></p></div>';
      el.querySelector("p").textContent = text;
      messages.appendChild(el);
    }

    function appendNarration(text) {
      if (!messages) return;
      var el = document.createElement("div");
      el.className = "msg msg--narration";
      el.innerHTML = '<div class="msg__label">Narator</div><div class="msg__body"><p></p></div>';
      el.querySelector("p").textContent = text;
      messages.appendChild(el);
      var end = $(".stage-end");
      if (end) messages.appendChild(end);
    }

    function run(text) {
      if (!text || busy) return;
      busy = true;
      if (fail) fail.hidden = true;
      appendPlayer(text);
      area.value = "";
      grow();
      scroll();
      if (status) {
        status.hidden = false;
        status.innerHTML = 'Narator sedang menulis <span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>';
      }
      $$("[data-choice]").forEach(function (choice) { choice.setAttribute("aria-busy", "true"); });

      window.setTimeout(function () {
        appendNarration(replies[replyIndex % replies.length]);
        replyIndex += 1;
        busy = false;
        if (status) {
          status.hidden = true;
          status.textContent = "";
        }
        $$("[data-choice]").forEach(function (choice) { choice.removeAttribute("aria-busy"); });
        grow();
        scroll();
      }, 1500);
    }

    function submit() {
      var text = area.value.trim();
      if (!text) return;
      run(text);
    }

    if (area) {
      area.addEventListener("input", grow);
      area.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submit();
        }
      });
      grow();
    }
    if (send) send.addEventListener("click", submit);

    $$("[data-choice]").forEach(function (choice) {
      choice.addEventListener("click", function () {
        if (busy) return;
        var text = choice.getAttribute("data-choice") || choice.textContent.trim();
        run(text);
      });
    });

    var retry = $("[data-retry]");
    if (retry) {
      retry.addEventListener("click", function () {
        if (fail) fail.hidden = true;
        toast("Percobaan diulang.", "info");
      });
    }
  }

  /* ---------- Editor ---------- */

  function initEditor() {
    var editor = $("[data-editor]");
    if (!editor) return;
    var links = $$("[data-section]", editor);
    var sections = $$(".ed-section", editor);
    var saveState = $$("[data-save-state]");
    var primaries = $$("[data-editor-primary]", editor);
    var form = $("[data-editor-form]");
    var dirty = false;

    function syncLinks(id) {
      links.forEach(function (link) {
        link.setAttribute("aria-current", link.getAttribute("data-section") === id ? "true" : "false");
      });
    }

    function showSection(id) {
      syncLinks(id);
      sections.forEach(function (section) {
        section.classList.toggle("is-active", section.id === id);
      });
      var main = $(".editor-main");
      if (main) main.scrollTop = 0;
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, "", "#" + id);
      }
    }

    links.forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        showSection(link.getAttribute("data-section"));
      });
    });

    var hash = window.location.hash.replace("#", "");
    var activeSection = $(".ed-section.is-active", editor);
    if (hash && document.getElementById(hash)) showSection(hash);
    else if (activeSection) syncLinks(activeSection.id);

    function setDirty(next) {
      dirty = next;
      saveState.forEach(function (el) {
        el.classList.toggle("save-state--dirty", dirty);
        el.innerHTML = '<span class="status-dot" aria-hidden="true"></span>' + (dirty ? "Belum disimpan" : "Tersimpan");
      });
      primaries.forEach(function (primary) {
        if (dirty) {
          primary.textContent = "Simpan";
          primary.setAttribute("data-mode", "save");
        } else {
          primary.textContent = "Mulai sesi";
          primary.setAttribute("data-mode", "start");
        }
      });
    }

    if (form) {
      form.addEventListener("input", function () { setDirty(true); });
      form.addEventListener("change", function () { setDirty(true); });
    }

    if (editor.getAttribute("data-dirty") === "true") setDirty(true);

    function save() {
      if (!dirty) {
        toast("Tidak ada perubahan baru.");
        return;
      }
      setDirty(false);
      toast("Perubahan tersimpan di draf peramban.");
    }

    $$("[data-save]").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.preventDefault();
        save();
      });
    });

    primaries.forEach(function (primary) {
      primary.addEventListener("click", function () {
        if (primary.getAttribute("data-mode") === "save" || dirty) {
          save();
        } else {
          window.location.href = "session.html";
        }
      });
    });

    var back = $("[data-editor-back]");
    if (back) {
      back.addEventListener("click", function (event) {
        event.preventDefault();
        if (dirty) openOverlay("dialog-unsaved", back);
        else window.location.href = "library.html";
      });
    }

    var discard = $("[data-discard]");
    if (discard) {
      discard.addEventListener("click", function () {
        window.location.href = "library.html";
      });
    }
    var saveAndLeave = $("[data-save-leave]");
    if (saveAndLeave) {
      saveAndLeave.addEventListener("click", function () {
        save();
        window.location.href = "library.html";
      });
    }

    $$(".entity__summary", editor).forEach(function (summary) {
      summary.addEventListener("click", function () {
        var open = summary.closest(".entity").classList.toggle("is-open");
        summary.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });

    $$("[data-add]", editor).forEach(function (button) {
      button.addEventListener("click", function () {
        toast(button.getAttribute("data-add") || "Baris baru ditambahkan.", "info");
      });
    });

    window.addEventListener("beforeunload", function (event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  /* ---------- Settings ---------- */

  function initSettings() {
    var prompt = $("[data-prompt-narator]");
    if (!prompt) return;
    var counter = $("[data-prompt-count]");
    var defaultPrompt = prompt.value;

    function count() {
      if (!counter) return;
      var length = prompt.value.length;
      counter.textContent = length.toLocaleString("id-ID") + " / 8.000";
    }

    prompt.addEventListener("input", count);
    count();

    var reset = $("[data-reset-prompt]");
    if (reset) {
      reset.addEventListener("click", function () {
        prompt.value = defaultPrompt;
        count();
        prompt.focus();
        toast("Prompt bawaan dipulihkan.");
      });
    }

    var saveAi = $("[data-save-ai]");
    if (saveAi) {
      saveAi.addEventListener("click", function () {
        toast("Pengaturan AI disimpan di perangkat ini.");
      });
    }

    var test = $("[data-test-connection]");
    if (test) {
      test.addEventListener("click", function () {
        toast("Koneksi berhasil · 42 ms.");
      });
    }

    var saveKey = $("[data-save-key]");
    if (saveKey) {
      saveKey.addEventListener("click", function () {
        var input = $("#api-key");
        if (!input) return;
        if (!input.value.trim()) {
          toast("Masukkan kunci API baru.", "error");
          input.focus();
          return;
        }
        input.value = "";
        var status = $("[data-key-status]");
        if (status) status.textContent = "Status: kunci baru tersimpan";
        closeOverlay($("#sheet-key"));
        toast("Kunci API diperbarui.");
      });
    }

    var saveProfile = $("[data-save-profile]");
    if (saveProfile) {
      saveProfile.addEventListener("click", function () {
        closeOverlay($("#sheet-profile"));
        toast("Profil AI disimpan.");
      });
    }

    $$("[data-backup-now]").forEach(function (button) {
      button.addEventListener("click", function () {
        toast("Backup fworld-backup-2026-10-20 dibuat.");
      });
    });
  }

  /* ---------- Create world ---------- */

  function initCreate() {
    var form = $("[data-create-form]");
    if (!form) return;
    var name = $("[data-create-name]");
    var hint = $("[data-create-hint]");
    var templates = {
      coast: {
        name: "Perjalanan pesisir",
        hint: "Pesisir, misteri, 6 tokoh siap disunting."
      },
      blank: {
        name: "Dunia kosong",
        hint: "Kanvas kosong tanpa tokoh atau peta."
      }
    };

    function apply(value) {
      var template = templates[value];
      if (!template) return;
      if (name) name.textContent = template.name;
      if (hint) hint.textContent = template.hint;
    }

    $$(".template-card__input", form).forEach(function (input) {
      input.addEventListener("change", function () {
        if (input.checked) apply(input.value);
      });
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
    });
  }

  /* ---------- Boot ---------- */

  document.addEventListener("DOMContentLoaded", function () {
    initMenus();
    initToasts();
    initOverlays();
    initTabs();
    initCopy();
    initConfirm();
    initSearch();
    initTextSize();
    initFocusMode();
    initComposer();
    initEditor();
    initSettings();
    initCreate();
  });
})();
