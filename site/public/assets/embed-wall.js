/**
 * Bill Shock embed wall.
 * Default: a single horizontal row of tweet cards you can scroll through.
 * Scroll right past a small threshold → the wall blooms open into a fixed
 * multi-row grid (rows above & below). Scroll back to the start → it collapses.
 *
 * Open vs. collapsed is a single discrete state (one CSS class), never a
 * continuous function of scroll position — that decoupling, plus hysteresis
 * and a fixed card height, is what keeps the transition stable instead of
 * oscillating. The expanded row count (3) lives in CSS.
 */
(function () {
  'use strict';

  var EXPAND_AT = 40;      // px scrolled right that triggers bloom-open
  var COLLAPSE_AT = 8;     // px (back near the start) that triggers collapse
  var LOCK_MS = 500;       // ignore collapse right after expanding (covers the CSS transition)
  // Expanded viewport height: 3 rows (3*420) + 2 gaps (2*20) + chrome (30).
  // Set inline (highest cascade priority) so the height is guaranteed to grow.
  var EXPANDED_MAXH = 1330;

  function $(id) { return document.getElementById(id); }

  function cellHtml(t) {
    var url = 'https://twitter.com/' + t.handle + '/status/' + t.id;
    var xurl = 'https://x.com/' + t.handle + '/status/' + t.id;
    return (
      '<div class="embed-cell" data-handle="' + t.handle + '">' +
        '<blockquote class="twitter-tweet" data-theme="dark" data-dnt="true">' +
          '<a href="' + url + '"></a>' +
        '</blockquote>' +
        '<div class="embed-more"><a href="' + xurl + '" target="_blank" rel="noopener">View on X →</a></div>' +
      '</div>'
    );
  }

  function loadTweets(track) {
    return fetch('/assets/embed-wall-tweets.json')
      .then(function (r) { return r.json(); })
      .then(function (tweets) {
        track.innerHTML = tweets.map(cellHtml).join('');
        return track.querySelectorAll('.embed-cell');
      });
  }

  function renderTwitterEmbeds(root) {
    if (window.twttr && window.twttr.widgets && window.twttr.widgets.load) {
      window.twttr.widgets.load(root || document);
      return;
    }
    var waited = 0;
    var iv = setInterval(function () {
      if (window.twttr && window.twttr.widgets && window.twttr.widgets.load) {
        clearInterval(iv);
        window.twttr.widgets.load(root || document);
      } else if (++waited > 40) {
        clearInterval(iv);
      }
    }, 250);
  }

  function initWall(viewport, track, cells) {
    var expanded = false;
    var lockUntil = 0;
    var raf = 0;
    var collapseTimer = 0;

    function expand() {
      if (expanded) return;
      expanded = true;
      lockUntil = performance.now() + LOCK_MS;
      if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = 0; }
      viewport.classList.add('embed-wall-viewport--grid');
      viewport.style.maxHeight = EXPANDED_MAXH + 'px';   // grow; cards animate in via CSS
    }

    function collapse() {
      if (!expanded) return;
      expanded = false;
      // Shrink the viewport first; keep the 3-row layout so the lower rows are
      // clipped away smoothly as the height transitions. Reflow back to one row
      // only after the transition finishes, so it never snaps.
      viewport.style.maxHeight = '';
      if (collapseTimer) clearTimeout(collapseTimer);
      collapseTimer = setTimeout(function () {
        collapseTimer = 0;
        viewport.classList.remove('embed-wall-viewport--grid');
      }, 520);
    }

    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var x = viewport.scrollLeft;
        if (!expanded) {
          if (x > EXPAND_AT) expand();
        } else if (x < COLLAPSE_AT && performance.now() > lockUntil) {
          collapse();
        }
      });
    }

    viewport.addEventListener('scroll', onScroll, { passive: true });
  }

  function boot() {
    var viewport = $('embed-wall-viewport');
    var track = $('embed-wall-track');
    if (!viewport || !track) return;

    loadTweets(track)
      .then(function (cells) {
        renderTwitterEmbeds(track);
        initWall(viewport, track, cells);
      })
      .catch(function (err) {
        console.warn('embed-wall: failed to load tweets', err);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
