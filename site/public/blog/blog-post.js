/* Kill Switch blog post interactions — recycled from the Divinci blog.
   Builds the left Table of Contents (with scroll-spy), drives the right-rail
   + bottom share buttons, copy-link toast, and focus mode.
   Adapted to the Kill Switch markup (<article class="article">) and dark theme,
   using inline SVG icons instead of FontAwesome. */
(function () {
  "use strict";

  /* ── Social sharing ─────────────────────────────────────────────── */
  function openShare(url) { window.open(url, "_blank", "width=550,height=420,noopener"); }

  window.shareOnTwitter = function () {
    openShare("https://twitter.com/intent/tweet?url=" + encodeURIComponent(location.href) +
      "&text=" + encodeURIComponent(document.title) + "&via=KillSwitchCloud");
  };
  window.shareOnLinkedIn = function () {
    openShare("https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(location.href));
  };
  window.shareOnFacebook = function () {
    openShare("https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(location.href));
  };

  var CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function showCopyToast(message) {
    var toast = document.getElementById("copy-link-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "copy-link-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      Object.assign(toast.style, {
        position: "fixed", top: "24px", left: "50%",
        transform: "translateX(-50%) translateY(-12px)",
        background: "rgba(16,22,46,0.97)", color: "#5ce2e7",
        padding: "12px 20px", borderRadius: "10px", fontSize: "14px", fontWeight: "600",
        border: "1px solid rgba(92,226,231,0.35)", boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
        zIndex: "99999", opacity: "0", pointerEvents: "none",
        transition: "opacity 0.18s ease, transform 0.18s ease",
        fontFamily: "'Inter', -apple-system, sans-serif",
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    void toast.offsetWidth;
    toast.style.opacity = "1";
    toast.style.transform = "translateX(-50%) translateY(0)";
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toast.style.opacity = "0";
      toast.style.transform = "translateX(-50%) translateY(-12px)";
    }, 1800);
  }

  window.copyLink = function (evt) {
    var btn = (evt && (evt.currentTarget || (evt.target && evt.target.closest(".copy")))) ||
              document.querySelector(".share-btn-overlay.copy, .social-btn-icon.copy");
    navigator.clipboard.writeText(location.href).then(function () {
      showCopyToast("Link copied to clipboard");
      if (btn) {
        var original = btn.innerHTML;
        btn.innerHTML = CHECK_SVG + (btn.querySelector(".btn-label") ? '<span class="btn-label">Copied</span>' : "");
        setTimeout(function () { btn.innerHTML = original; }, 1600);
      }
    }).catch(function () { showCopyToast("Couldn't copy — copy the URL manually"); });
  };

  window.scrollToTop = function () { window.scrollTo({ top: 0, behavior: "smooth" }); return false; };

  /* ── Table of Contents (built from h2/h3 in the article) ─────────── */
  var svg = function (paths) {
    return '<svg xmlns="http://www.w3.org/2000/svg" class="toc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + paths + '</svg>';
  };
  var TOC_ICONS = {
    money:   svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v12m-2-7h4a2 2 0 110 4H10"/>'),
    warning: svg('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    cloud:   svg('<path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/>'),
    code:    svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    lesson:  svg('<polyline points="20 6 9 17 4 12"/>'),
    chart:   svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
    doc:     svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>'),
  };
  function iconFor(text) {
    var t = text.toLowerCase();
    if (/\$|cost|bill|price|money|dollar|charge|spend|invoice/.test(t)) return "money";
    if (/scary|horror|disaster|runaway|spike|trap|danger|warning|fail/.test(t)) return "warning";
    if (/cloud|aws|s3|bucket|websocket|server|infra|durable|worker/.test(t)) return "cloud";
    if (/code|commit|loop|connection|architecture|default|decision/.test(t)) return "code";
    if (/lesson|fix|takeaway|how to|protect|kill switch|cap|floor|seatbelt/.test(t)) return "lesson";
    if (/scale|growth|chart|number|metric|graph/.test(t)) return "chart";
    return "doc";
  }
  var parser = new DOMParser();
  function svgNode(s) { return document.importNode(parser.parseFromString(s, "image/svg+xml").documentElement, true); }

  document.addEventListener("DOMContentLoaded", function () {
    var toc = document.querySelector(".table-of-contents");
    var tocList = document.getElementById("toc-list");
    var article = document.querySelector(".article");
    if (!toc || !tocList || !article) return;

    var headings = article.querySelectorAll("h2, h3");
    if (!headings.length) { toc.style.display = "none"; return; }

    headings.forEach(function (h, i) {
      var id = h.id || ("section-" + i);
      if (!h.id) h.id = id;
      var li = document.createElement("li");
      li.className = "toc-" + h.tagName.toLowerCase();
      var a = document.createElement("a");
      a.href = "#" + id;
      a.dataset.target = id;
      a.appendChild(svgNode(TOC_ICONS[iconFor(h.textContent)]));
      var span = document.createElement("span");
      span.className = "toc-text";
      span.textContent = h.textContent;
      a.appendChild(span);
      li.appendChild(a);
      tocList.appendChild(li);
    });

    var links = tocList.querySelectorAll("a");
    links.forEach(function (link) {
      link.addEventListener("click", function (e) {
        e.preventDefault();
        var el = document.getElementById(this.dataset.target);
        if (el) {
          history.pushState(null, "", "#" + this.dataset.target);
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          setActive(this.dataset.target);
        }
      });
    });

    function setActive(targetId) {
      var current = targetId;
      if (!current) {
        headings.forEach(function (h) { if (h.getBoundingClientRect().top <= 200) current = h.id; });
      }
      var activeLink = null;
      links.forEach(function (l) {
        var on = l.dataset.target === current;
        l.classList.toggle("active", on);
        if (on) activeLink = l;
      });
      if (activeLink) {
        var lr = activeLink.getBoundingClientRect(), tr = toc.getBoundingClientRect();
        if (lr.top < tr.top || lr.bottom > tr.bottom) activeLink.scrollIntoView({ block: "center" });
      }
    }

    var ticking = false;
    window.addEventListener("scroll", function () {
      if (!ticking) {
        window.requestAnimationFrame(function () { setActive(); ticking = false; });
        ticking = true;
      }
    });

    // Reveal the rails (CSS gates actual display behind the min-width media query).
    toc.classList.add("is-ready");
    if (location.hash) {
      var t = location.hash.substring(1);
      setTimeout(function () {
        var el = document.getElementById(t);
        if (el) { el.scrollIntoView({ behavior: "smooth" }); setActive(t); }
      }, 100);
    } else { setActive(); }
  });

  /* ── Focus mode (toggle with the eye button or "F") ──────────────── */
  document.addEventListener("DOMContentLoaded", function () {
    var toggle = document.getElementById("focus-mode-toggle");
    if (!toggle) return;
    if (localStorage.getItem("ksFocusMode") === "true") document.body.classList.add("focus-mode");
    toggle.addEventListener("click", function () {
      var on = document.body.classList.toggle("focus-mode");
      localStorage.setItem("ksFocusMode", on);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "f" && !e.ctrlKey && !e.metaKey && !e.altKey &&
          ["INPUT", "TEXTAREA"].indexOf(e.target.tagName) === -1) {
        e.preventDefault();
        toggle.click();
      }
    });
  });

  /* ── Fade the right rail out once the share CTA / footer is in view ── */
  document.addEventListener("DOMContentLoaded", function () {
    var rail = document.querySelector(".social-sharing-fixed");
    if (rail) rail.classList.add("is-ready");
    var tail = document.querySelector(".share-cta") || document.querySelector(".site-footer");
    if (!rail || !tail) return;
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        var top = tail.getBoundingClientRect().top;
        rail.style.opacity = top < window.innerHeight - 40 ? "0" : "1";
        ticking = false;
      });
    });
  });
})();
