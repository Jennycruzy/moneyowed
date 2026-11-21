// Small, dependency-free motion: reveal on scroll, count-ups. Honours reduced motion.
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js');
  var lis = document.querySelectorAll('.inc li');
  for (var i = 0; i < lis.length; i++) lis[i].style.setProperty('--n', i);

  function countUp(el) {
    var to = parseFloat(el.getAttribute('data-to'));
    var dec = parseInt(el.getAttribute('data-dec') || '0', 10);
    if (reduce || !isFinite(to)) { el.textContent = to.toFixed(dec); return; }
    var from = dec ? Math.floor(to) - 3 : 0, t0 = null, dur = dec ? 1400 : 1100;
    function step(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4);
      el.textContent = (from + (to - from) * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var hero = document.querySelector('.hero .count');
  if (hero) countUp(hero);

  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (!en.isIntersecting) return;
      en.target.classList.add('in');
      var c = en.target.querySelectorAll('.count');
      for (var j = 0; j < c.length; j++) countUp(c[j]);
      io.unobserve(en.target);
    });
  }, { threshold: 0.18 }) : null;
  var els = document.querySelectorAll('.reveal');
  for (var k = 0; k < els.length; k++) { if (io && !reduce) io.observe(els[k]); else els[k].classList.add('in'); }
})();
