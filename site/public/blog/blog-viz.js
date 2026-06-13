/* Kill Switch blog — self-contained, dependency-free post visualizations.
   <figure data-viz="name">           → full viz, auto-plays once when scrolled into view.
   <div   data-viz="name" data-thumb>  → compact thumbnail, replays on card hover.
   Respects prefers-reduced-motion (renders the final static state, no motion). */
(function () {
  "use strict";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var SVGNS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, ns) {
    var n = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function money(n) { return "$" + Math.round(n).toLocaleString("en-US"); }
  function compact(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
    return Math.round(n).toString();
  }
  function head(label, readoutHTML) {
    return '<div class="viz-head"><span class="viz-label">' + label + '</span>' +
           '<span class="viz-readout">' + readoutHTML + '</span></div>';
  }
  function whenVisible(node, cb) {
    if (!("IntersectionObserver" in window)) { cb(); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); cb(); } });
    }, { threshold: 0.35 });
    io.observe(node);
  }
  /* cancellable single animation */
  function Anim() { this.raf = null; }
  Anim.prototype.run = function (dur, step, done) {
    var self = this; this.cancel(); var t0 = null;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      step(p);
      if (p < 1) self.raf = requestAnimationFrame(frame);
      else { self.raf = null; if (done) done(); }
    }
    self.raf = requestAnimationFrame(frame);
  };
  Anim.prototype.cancel = function () { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; } };

  /* ---- VIZ: immortal agents accruing cost ---- */
  function vizAgents(root, thumb) {
    var W = 600, H = thumb ? 150 : 210, TARGET = 91316, MAX = thumb ? 110 : 160, cols = 20, rows = thumb ? 6 : 8;
    root.innerHTML = head(thumb ? "" : "Per-unit agents, never retired", '<span data-cost>$0</span>');
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, "class": "viz-svg" }, SVGNS);
    var spark = el("path", { "class": "viz-spark", fill: "none", stroke: "#5ce2e7", "stroke-width": "2" }, SVGNS);
    var dots = el("g", {}, SVGNS);
    svg.appendChild(spark); svg.appendChild(dots); root.appendChild(svg);
    if (!thumb) root.insertAdjacentHTML("beforeend",
      '<div class="viz-cap">Every unit that ever spoke got its own always-on Durable Object &mdash; lazy-created, never closed. The meter only goes up.</div>');
    var costEl = root.querySelector("[data-cost]");
    var order = []; for (var i = 0; i < cols * rows; i++) order.push(i);
    for (var j = order.length - 1; j > 0; j--) { var r = Math.floor(Math.random() * (j + 1)); var t = order[j]; order[j] = order[r]; order[r] = t; }
    function place(n) {
      while (dots.childNodes.length < n) {
        var idx = order[dots.childNodes.length % order.length];
        var cx = (idx % cols) * (W / cols) + (W / cols) / 2;
        var cy = Math.floor(idx / cols) * ((H - 30) / rows) + 24;
        dots.appendChild(el("circle", { cx: cx.toFixed(1), cy: cy.toFixed(1), r: "3.2", fill: "#5ce2e7", "class": "viz-agent" }, SVGNS));
      }
    }
    var pts = [], anim = new Anim();
    function frame(p) {
      var cost = TARGET * Math.pow(p, 2.2);
      if (costEl) costEl.textContent = money(cost);
      place(Math.round(MAX * p));
      pts.push([(W * p).toFixed(1), (H - 6 - (H - 18) * Math.pow(p, 2.2)).toFixed(1)]);
      spark.setAttribute("d", "M" + pts.map(function (a) { return a.join(" "); }).join(" L"));
    }
    return {
      reset: function () { anim.cancel(); dots.textContent = ""; pts = []; spark.setAttribute("d", ""); if (costEl) { costEl.textContent = "$0"; costEl.classList.remove("viz-done"); } },
      play: function (instant) {
        if (instant || reduce) { for (var s = 0; s <= 1.0001; s += 0.06) frame(Math.min(1, s)); if (costEl) costEl.textContent = money(TARGET); return; }
        anim.run(thumb ? 2600 : 7000, frame, function () { if (costEl) { costEl.textContent = money(TARGET); costEl.classList.add("viz-done"); } });
      }
    };
  }

  /* ---- VIZ: request storm on an empty bucket ---- */
  function vizBucket(root, thumb) {
    var W = 600, H = thumb ? 150 : 230, REQ = 1e8, BILL = 1300, cx = W / 2, cy = H - (thumb ? 46 : 70), bs = thumb ? 26 : 34;
    var ty = cy - bs * 0.76;
    root.innerHTML = head(thumb ? "" : "Denied requests &mdash; billed anyway", '<span data-req>0</span> reqs &middot; <span data-bill class="viz-accent">$0</span>');
    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, "class": "viz-svg" }, SVGNS);
    var pings = el("g", {}, SVGNS);
    var bucket = el("path", { d: "M" + (cx - bs) + " " + ty + " L" + (cx + bs) + " " + ty + " L" + (cx + bs * 0.76) + " " + (cy + bs * 0.88) + " L" + (cx - bs * 0.76) + " " + (cy + bs * 0.88) + " Z", fill: "rgba(92,226,231,0.08)", stroke: "#5ce2e7", "stroke-width": "2" }, SVGNS);
    var rim = el("ellipse", { cx: cx, cy: ty, rx: bs, ry: bs * 0.24, fill: "none", stroke: "#5ce2e7", "stroke-width": "2" }, SVGNS);
    svg.appendChild(pings); svg.appendChild(bucket); svg.appendChild(rim); root.appendChild(svg);
    if (!thumb) root.insertAdjacentHTML("beforeend",
      '<div class="viz-cap">Anyone who can guess the name can knock &mdash; millions of times. Every <code>403</code> still costs ~$0.005 / 1,000.</div>');
    var reqEl = root.querySelector("[data-req]"), billEl = root.querySelector("[data-bill]");
    var iv = null, anim = new Anim();
    function ping() {
      var e = Math.random(), sx, sy;
      if (e < 0.5) { sx = Math.random() * W; sy = -8; } else { sx = Math.random() < 0.5 ? -8 : W + 8; sy = Math.random() * (H - 40); }
      var ln = el("line", { x1: sx, y1: sy, x2: sx, y2: sy, stroke: "#ff7a5c", "stroke-width": "1.6", opacity: 0.7 }, SVGNS);
      pings.appendChild(ln);
      new Anim().run(560, function (p) {
        var x = sx + (cx - sx) * p, y = sy + (ty - sy) * p;
        ln.setAttribute("x2", x.toFixed(1)); ln.setAttribute("y2", y.toFixed(1));
        ln.setAttribute("x1", (sx + (x - sx) * 0.82).toFixed(1)); ln.setAttribute("y1", (sy + (y - sy) * 0.82).toFixed(1));
        ln.setAttribute("opacity", (0.7 * (1 - p)).toFixed(2));
      }, function () { ln.remove(); });
    }
    function frame(p) { reqEl.textContent = compact(REQ * Math.pow(p, 1.8)); billEl.textContent = money(BILL * Math.pow(p, 1.8)); }
    return {
      reset: function () { anim.cancel(); if (iv) { clearInterval(iv); iv = null; } pings.textContent = ""; reqEl.textContent = "0"; billEl.textContent = "$0"; billEl.classList.remove("viz-done"); },
      play: function (instant) {
        if (instant || reduce) { reqEl.textContent = compact(REQ); billEl.textContent = money(BILL); return; }
        iv = setInterval(ping, thumb ? 95 : 110);
        anim.run(thumb ? 2600 : 7000, frame, function () { if (iv) { clearInterval(iv); iv = null; } reqEl.textContent = compact(REQ); billEl.textContent = money(BILL); billEl.classList.add("viz-done"); });
      }
    };
  }

  /* ---- VIZ: CPU/cost comparison bars ---- */
  function vizBars(root, thumb) {
    root.innerHTML = head(thumb ? "" : "CPU per bot &mdash; same work, different transport", '<span class="viz-accent" data-save>$0 saved</span>') +
      '<div class="viz-bars">' +
        '<div class="viz-bar"><div class="viz-bar-track"><div class="viz-bar-fill ws" data-fill="100"></div><span class="viz-bar-num" data-num="100">0%</span></div><div class="viz-bar-lab">WebSockets' + (thumb ? '' : '<br><small>masks every byte</small>') + '</div></div>' +
        '<div class="viz-bar"><div class="viz-bar-track"><div class="viz-bar-fill shm" data-fill="48"></div><span class="viz-bar-num" data-num="48">0%</span></div><div class="viz-bar-lab">Shared memory' + (thumb ? '' : '<br><small>ring buffer</small>') + '</div></div>' +
      '</div>' +
      (thumb ? '' : '<div class="viz-cap">Recall.ai moved raw video at 100+ MB/s over a local WebSocket. Switching to shared memory cut CPU ~50% &mdash; and over $1M/yr off the bill.</div>');
    var fills = root.querySelectorAll(".viz-bar-fill"), nums = root.querySelectorAll(".viz-bar-num"), saveEl = root.querySelector("[data-save]"), anim = new Anim();
    function frame(p) {
      fills.forEach(function (f) { f.style.height = (parseFloat(f.dataset.fill) * p) + "%"; });
      nums.forEach(function (n) { n.textContent = Math.round(parseFloat(n.dataset.num) * p) + "%"; });
      saveEl.textContent = money(1e6 * p) + " saved";
    }
    return {
      reset: function () { anim.cancel(); fills.forEach(function (f) { f.style.height = "0%"; }); nums.forEach(function (n) { n.textContent = "0%"; }); saveEl.textContent = "$0 saved"; saveEl.classList.remove("viz-done"); },
      play: function (instant) { if (instant || reduce) { frame(1); return; } anim.run(thumb ? 1400 : 1600, frame, function () { saveEl.classList.add("viz-done"); }); }
    };
  }

  var builders = { agents: vizAgents, bucket: vizBucket, bars: vizBars };
  function init() {
    document.querySelectorAll("[data-viz]").forEach(function (node) {
      var fn = builders[node.getAttribute("data-viz")]; if (!fn) return;
      var thumb = node.hasAttribute("data-thumb");
      var ctrl;
      try { ctrl = fn(node, thumb); } catch (e) { return; }
      if (thumb) {
        ctrl.play(true); // rest at the FINAL state so the thumbnail isn't empty; hover replays
        var card = node.closest(".post") || node;
        card.addEventListener("mouseenter", function () { ctrl.reset(); ctrl.play(); });
      } else {
        whenVisible(node, function () { ctrl.play(reduce); });
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
