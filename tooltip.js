/* ============================================================================
   SBL shared tooltip / popover module
   ----------------------------------------------------------------------------
   Self-contained IIFE, mirrors the nav.js pattern. Drop <script src="/tooltip.js">
   on any page and it wires up two interaction modes:

     • data-tip="..."        → lightweight floating tooltip (hover + tap + focus).
                               Optional data-tip-title for a bolded heading line.
                               Edge-aware: flips above/below and clamps horizontally
                               so it never leaves the viewport. Works on touch.

     • data-pop-target="ID"  → click/hover opens the element with id=ID as a rich
                               popover anchored to the trigger. The target lives in
                               the DOM (so pages own its markup/content); this module
                               only handles show/hide/positioning. One popover open
                               at a time; Esc or outside-click closes.

   Public API (window.SBLTooltip):
     • refresh()  → re-scan the DOM and (re)bind any new [data-tip] / [data-pop-target]
                    elements. Call after re-rendering cards.
     • hideAll()  → force-close tooltip and popover.

   Namespaced CSS is injected once. Colors use the page's CSS custom properties
   when present, with hard fallbacks so the module is drop-in anywhere.
============================================================================ */
(function () {
  'use strict';
  if (window.SBLTooltip) return; // singleton

  // ── one-time style injection ───────────────────────────────────────────────
  var css = ''
    + '#sbl-tip{position:fixed;z-index:9000;max-width:240px;pointer-events:none;'
    +   'background:var(--bg,#0f1117);border:1px solid var(--accent,#7c6ff7);border-radius:9px;'
    +   'padding:9px 11px;font-size:12px;line-height:1.45;color:var(--text,#e8eaf6);'
    +   'box-shadow:0 10px 30px rgba(0,0,0,.6);opacity:0;visibility:hidden;'
    +   'transition:opacity .12s ease;font-family:inherit;}'
    + '#sbl-tip.show{opacity:1;visibility:visible;}'
    + '#sbl-tip .sbl-tip-title{font-size:11px;font-weight:800;color:var(--accent,#7c6ff7);'
    +   'text-transform:uppercase;letter-spacing:.4px;margin-bottom:3px;}'
    + '#sbl-tip .sbl-tip-body{white-space:normal;}'
    // affordance for tip triggers
    + '[data-tip]{cursor:help;}'
    + '.sbl-tip-underline{text-decoration:underline dotted var(--text3,#5a5f80);text-underline-offset:2px;}'
    // popover positioning shell (pages style the inner content themselves)
    + '.sbl-pop{position:fixed;z-index:9100;opacity:0;visibility:hidden;'
    +   'transform:translateY(-4px);transition:opacity .15s ease,transform .15s ease;}'
    + '.sbl-pop.open{opacity:1;visibility:visible;transform:translateY(0);}';
  var style = document.createElement('style');
  style.id = 'sbl-tooltip-styles';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // ── floating tooltip element (single shared node) ──────────────────────────
  var tip = document.createElement('div');
  tip.id = 'sbl-tip';
  tip.innerHTML = '<div class="sbl-tip-title" hidden></div><div class="sbl-tip-body"></div>';
  var tipTitle = tip.firstChild, tipBody = tip.lastChild;

  function mountTip() {
    if (!tip.parentNode) (document.body || document.documentElement).appendChild(tip);
  }

  var activeTipEl = null;

  function showTip(el) {
    mountTip();
    var title = el.getAttribute('data-tip-title');
    if (title) { tipTitle.textContent = title; tipTitle.hidden = false; }
    else { tipTitle.hidden = true; }
    tipBody.innerHTML = el.getAttribute('data-tip') || '';
    tip.classList.add('show');
    activeTipEl = el;
    positionTip(el);
  }
  function hideTip() { tip.classList.remove('show'); activeTipEl = null; }

  function positionTip(el) {
    var r = el.getBoundingClientRect();
    var tr = tip.getBoundingClientRect();
    var m = 8;
    var top = r.top - tr.height - 10;            // prefer above
    if (top < m) top = r.bottom + 10;            // flip below if cramped
    var left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - tr.width - m));
    tip.style.top = Math.round(top) + 'px';
    tip.style.left = Math.round(left) + 'px';
  }

  // ── popover (page-owned content node, we toggle + position) ────────────────
  var openPop = null, openPopTrigger = null;

  function showPop(target, trigger) {
    closePop();
    target.classList.add('open');
    openPop = target; openPopTrigger = trigger;
    positionPop(target, trigger);
  }
  function closePop() {
    if (openPop) { openPop.classList.remove('open'); }
    openPop = null; openPopTrigger = null;
  }
  function positionPop(target, trigger) {
    // Fixed positioning in viewport coordinates so the popover escapes any
    // overflow:hidden / clipping ancestors. Prefer below the trigger; flip above
    // if it would run off the bottom. Clamp horizontally to the viewport.
    var tRect = trigger.getBoundingClientRect();
    var pRect = target.getBoundingClientRect();
    var m = 8;
    var left = tRect.left + tRect.width / 2 - pRect.width / 2;
    left = Math.max(m, Math.min(left, window.innerWidth - pRect.width - m));
    var top = tRect.bottom + 8;
    if (top + pRect.height > window.innerHeight - m) {
      var above = tRect.top - pRect.height - 8;
      if (above >= m) top = above;                       // flip above if it fits
      else top = Math.max(m, window.innerHeight - pRect.height - m); // else clamp
    }
    target.style.left = Math.round(left) + 'px';
    target.style.top = Math.round(top) + 'px';
  }

  // ── binding ────────────────────────────────────────────────────────────────
  function bind() {
    document.querySelectorAll('[data-tip]').forEach(function (el) {
      if (el._sblTip) return; el._sblTip = true;
      el.addEventListener('mouseenter', function () { showTip(el); });
      el.addEventListener('mouseleave', hideTip);
      el.addEventListener('focus', function () { showTip(el); });
      el.addEventListener('blur', hideTip);
      el.addEventListener('click', function (e) {
        // tap-to-toggle for touch; harmless on desktop
        if (activeTipEl === el) hideTip(); else showTip(el);
        e.stopPropagation();
      });
    });

    document.querySelectorAll('[data-pop-target]').forEach(function (trigger) {
      if (trigger._sblPop) return; trigger._sblPop = true;
      var id = trigger.getAttribute('data-pop-target');
      var target = document.getElementById(id);
      if (!target) return;
      // Hide the target up front so it never renders as a stray visible block before
      // its first open. (.sbl-pop carries position:fixed + visibility:hidden.)
      target.classList.add('sbl-pop');
      var openByHover = trigger.hasAttribute('data-pop-hover');

      trigger.addEventListener('click', function (e) {
        if (openPop === target) closePop(); else showPop(target, trigger);
        e.stopPropagation();
      });
      if (openByHover) {
        trigger.addEventListener('mouseenter', function () { showPop(target, trigger); });
        var leaveTimer;
        var scheduleClose = function () { leaveTimer = setTimeout(function () { if (openPop === target) closePop(); }, 120); };
        var cancelClose = function () { clearTimeout(leaveTimer); };
        trigger.addEventListener('mouseleave', scheduleClose);
        target.addEventListener('mouseenter', cancelClose);
        target.addEventListener('mouseleave', scheduleClose);
      }
    });
  }

  // ── global handlers ──────────────────────────────────────────────────────
  window.addEventListener('scroll', function () {
    if (activeTipEl) positionTip(activeTipEl);
    if (openPop && openPopTrigger) positionPop(openPop, openPopTrigger);
  }, true);
  window.addEventListener('resize', function () {
    if (activeTipEl) positionTip(activeTipEl);
    if (openPop && openPopTrigger) positionPop(openPop, openPopTrigger);
  });
  document.addEventListener('click', function () { hideTip(); closePop(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideTip(); closePop(); } });

  // ── public API ───────────────────────────────────────────────────────────
  window.SBLTooltip = {
    refresh: function () { bind(); },
    hideAll: function () { hideTip(); closePop(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
