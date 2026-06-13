/**
 * Newsletter subscribe form → POST /api/subscribe (Beehiiv proxy in src/index.js).
 * Progressive enhancement: the form is plain HTML; this just adds async submit
 * with inline status messaging.
 */
(function () {
  "use strict";

  var form = document.getElementById("newsletter-form");
  if (!form) return;

  var emailEl = document.getElementById("newsletter-email");
  var statusEl = document.getElementById("newsletter-status");
  var btn = form.querySelector(".newsletter-btn");

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "newsletter-status" + (kind ? " " + kind : "");
  }

  var MESSAGES = {
    invalid_email: "That email doesn't look right — mind checking it?",
    not_configured: "Signups open shortly — try again soon.",
    provider_error: "Something went wrong on our end. Please try again.",
    provider_unreachable: "Something went wrong on our end. Please try again.",
    bad_request: "Something went wrong. Please try again.",
    network: "Network hiccup — please try again.",
  };

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = (emailEl.value || "").trim();
    if (!email) {
      setStatus(MESSAGES.invalid_email, "err");
      emailEl.focus();
      return;
    }

    btn.disabled = true;
    setStatus("Subscribing…", "");

    fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: email,
        company: form.elements.company ? form.elements.company.value : "",
      }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (result.data && result.data.ok) {
          setStatus("You're in. Watch your inbox for the next horror story. 🔪", "ok");
          form.reset();
        } else {
          var code = (result.data && result.data.error) || "provider_error";
          setStatus(MESSAGES[code] || MESSAGES.provider_error, "err");
        }
      })
      .catch(function () {
        setStatus(MESSAGES.network, "err");
      })
      .finally(function () {
        btn.disabled = false;
      });
  });
})();
