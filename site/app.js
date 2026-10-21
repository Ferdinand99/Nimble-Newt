// Nimble Newt landing page — progressive enhancement only. Everything on the
// page works without this file: the nav wraps, content is visible, and every
// download button links to the latest release on GitHub.
(function () {
  "use strict";

  // Tells the CSS the script is running (cancels the reveal safety net)
  document.documentElement.classList.add("js-ok");

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // Nav: hairline once content scrolls under it --------------------------
  var bar = document.querySelector(".topbar");
  function onScroll() {
    if (bar) bar.classList.toggle("is-scrolled", window.scrollY > 4);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mobile menu ------------------------------------------------------------
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.getElementById("topnav");
  if (toggle && menu && bar) {
    toggle.hidden = false;
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Menu");
      menu.classList.toggle("open", open);
      bar.classList.toggle("menu-open", open);
    };
    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && menu.classList.contains("open")) {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (menu.classList.contains("open") && !bar.contains(e.target)) setOpen(false);
    });
    window.matchMedia("(min-width: 881px)").addEventListener("change", function (mq) {
      if (mq.matches) setOpen(false);
    });
  }

  // Current section in the nav ---------------------------------------------
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.topnav-link[href^="#"]'));
  if ("IntersectionObserver" in window && navLinks.length) {
    var byId = {};
    navLinks.forEach(function (a) {
      byId[a.getAttribute("href").slice(1)] = a;
    });
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var link = byId[entry.target.id];
          if (!link) return;
          if (entry.isIntersecting) {
            navLinks.forEach(function (a) {
              a.removeAttribute("aria-current");
            });
            link.setAttribute("aria-current", "true");
          } else if (link.getAttribute("aria-current")) {
            link.removeAttribute("aria-current");
          }
        });
      },
      { rootMargin: "-45% 0px -50% 0px" }
    );
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  // Reveal on scroll, once ---------------------------------------------------
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add("is-in");
    });
  }

  // Which computer is this? ------------------------------------------------
  // Only used to highlight a download; nothing is stored or sent anywhere.
  function detectOS() {
    var ua = navigator.userAgent || "";
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/android|iphone|ipad|ipod/i.test(ua) || /android|ios/i.test(platform)) return "mobile";
    // iPadOS presents itself as a Mac; a touch screen gives it away
    if (/mac/i.test(platform) || /mac os x/i.test(ua)) {
      return navigator.maxTouchPoints > 1 ? "mobile" : "mac";
    }
    if (/win/i.test(platform) || /windows/i.test(ua)) return "windows";
    return "other";
  }

  var os = detectOS();
  document.documentElement.setAttribute("data-os", os);
  var heroDownload = document.getElementById("hero-download");
  var heroLabel = heroDownload && heroDownload.querySelector("span");

  if (os === "windows" || os === "mac") {
    var card = document.getElementById(os === "mac" ? "platform-mac" : "platform-windows");
    if (card) {
      card.classList.add("is-recommended");
      // First in reading order too, not just visually
      if (card.parentNode && card.parentNode.firstElementChild !== card) card.parentNode.prepend(card);
      var pill = card.querySelector("[data-recommended]");
      if (pill) pill.hidden = false;
    }
    if (heroLabel) heroLabel.textContent = os === "mac" ? "Download for Mac" : "Download for Windows";
  } else if (os === "mobile") {
    var note = document.getElementById("device-note");
    if (note) note.hidden = false;
  }

  // Latest release ------------------------------------------------------------
  // The release assets carry the version in their names, so the buttons are
  // filled from the GitHub API. If it can't be reached (offline, rate limit),
  // every button keeps its fallback link to the releases page.
  var API = "https://api.github.com/repos/Ferdinand99/Nimble-Newt/releases/latest";
  var CACHE_KEY = "nn-latest-release";
  var CACHE_MS = 15 * 60 * 1000;

  var PATTERNS = {
    exe: [/_x64-setup\.exe$/i, /\.exe$/i],
    msi: [/_x64_[^/]*\.msi$/i, /\.msi$/i],
    dmg: [/_universal\.dmg$/i, /\.dmg$/i]
  };

  function findAsset(assets, kind) {
    var patterns = PATTERNS[kind];
    for (var p = 0; p < patterns.length; p++) {
      for (var i = 0; i < assets.length; i++) {
        if (patterns[p].test(assets[i].name)) return assets[i];
      }
    }
    return null;
  }

  function formatSize(bytes) {
    if (!bytes) return "";
    var mb = bytes / (1024 * 1024);
    return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + " MB";
  }

  function formatDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
    } catch (err) {
      return iso.slice(0, 10);
    }
  }

  function readCache() {
    try {
      var raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var cached = JSON.parse(raw);
      if (Date.now() - cached.at > CACHE_MS) return null;
      return cached.data;
    } catch (err) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
    } catch (err) {
      /* storage blocked: fine, just fetch again next time */
    }
  }

  // Keep only what the page needs
  function slim(release) {
    return {
      tag: String(release.tag_name || ""),
      url: String(release.html_url || ""),
      published: String(release.published_at || ""),
      assets: (release.assets || []).map(function (a) {
        return { name: String(a.name || ""), size: Number(a.size) || 0, url: String(a.browser_download_url || "") };
      })
    };
  }

  function isGitHubUrl(url) {
    return /^https:\/\/github\.com\/Ferdinand99\/Nimble-Newt\//.test(url);
  }

  function apply(release) {
    var version = release.tag.replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+/.test(version)) return;
    var date = formatDate(release.published);
    var notesUrl = isGitHubUrl(release.url) ? release.url : null;

    var pillLabel = document.getElementById("release-pill-label");
    if (pillLabel) pillLabel.textContent = "Version " + version + " is out";
    var info = document.getElementById("release-info");
    if (info) info.textContent = "Version " + version + (date ? ", released " + date + "." : ".");
    if (notesUrl) {
      ["release-pill", "release-notes"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.href = notesUrl;
      });
    }

    document.querySelectorAll("[data-asset]").forEach(function (btn) {
      var kind = btn.getAttribute("data-asset");
      var asset = findAsset(release.assets, kind);
      if (!asset || !isGitHubUrl(asset.url)) return;
      btn.href = asset.url;
      var size = btn.querySelector("[data-size]");
      if (size) size.textContent = formatSize(asset.size);
    });

    var winFiles = document.querySelector('[data-files="windows"]');
    var exe = findAsset(release.assets, "exe");
    var msi = findAsset(release.assets, "msi");
    if (winFiles && exe && msi) {
      winFiles.textContent = "";
      winFiles.append("The ", code(exe.name), " installer suits most people; ", code(msi.name), " is for managed deployments.");
    }
    var macFiles = document.querySelector('[data-files="mac"]');
    var dmg = findAsset(release.assets, "dmg");
    if (macFiles && dmg) {
      macFiles.textContent = "";
      macFiles.append("Open ", code(dmg.name), " and drag Nimble Newt to Applications.");
    }
  }

  function code(text) {
    var el = document.createElement("code");
    el.textContent = text;
    return el;
  }

  var cached = readCache();
  if (cached) {
    apply(cached);
  } else if (window.fetch) {
    var controller = "AbortController" in window ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () {
          controller.abort();
        }, 8000)
      : null;
    fetch(API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error("GitHub API " + res.status);
        return res.json();
      })
      .then(function (json) {
        var release = slim(json);
        writeCache(release);
        apply(release);
      })
      .catch(function () {
        /* Keep the fallback links to the releases page */
      })
      .then(function () {
        if (timer) clearTimeout(timer);
      });
  }
})();
