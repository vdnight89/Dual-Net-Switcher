'use strict';
// A small host-only preference cookie survives the app's changing localhost port.
// This file runs before CSS; no inline script or extra service is needed.
(() => {
  let theme = 'dark';
  try {
    const saved = document.cookie.match(/(?:^|;\s*)dualnetTheme=(light|dark)(?:;|$)/)?.[1]
      || localStorage.getItem('dualnetTheme');
    if (saved === 'light' || saved === 'dark') theme = saved;
  } catch { /* A blocked preference store must not prevent opening the app. */ }
  document.documentElement.dataset.theme = theme;
})();
