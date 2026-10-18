// Small DOM helpers shared by the UI classes.

/** h('button.big#play', { onclick }, 'Play') → element */
export function h(spec, attrs = {}, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * Touch-friendly button: fires on press (not on release, like hardware),
 * supports multi-touch and an optional release callback.
 */
export function pad(el, onDown, onUp) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    el.classList.add('pressed');
    onDown(e);
  });
  const up = (e) => {
    if (!el.classList.contains('pressed')) return;
    el.classList.remove('pressed');
    if (onUp) onUp(e);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return el;
}

/** Keep a canvas' pixel size matched to its CSS size. Returns a getter for {w, h, dpr}. */
export function fitCanvas(canvas, onResize) {
  const info = { w: 0, h: 0, dpr: 1 };
  const apply = () => {
    const r = canvas.getBoundingClientRect();
    info.dpr = Math.min(2, window.devicePixelRatio || 1);
    info.w = Math.max(1, Math.round(r.width));
    info.h = Math.max(1, Math.round(r.height));
    canvas.width = Math.round(info.w * info.dpr);
    canvas.height = Math.round(info.h * info.dpr);
    if (onResize) onResize(info);
  };
  new ResizeObserver(apply).observe(canvas);
  apply();
  return info;
}

export function fmtTime(sec, tenths = false) {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  let out = `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
  if (tenths) out += `.${Math.floor((sec * 10) % 10)}`;
  return out;
}

/** Only touch the DOM when the text actually changes. */
export function setText(el, text) {
  if (el._t !== text) {
    el._t = text;
    el.textContent = text;
  }
}

export function toggleClass(el, cls, on) {
  if (el.classList.contains(cls) !== !!on) el.classList.toggle(cls, !!on);
}

export function toast(msg, ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div#toasts');
    document.body.append(box);
  }
  const t = h('div.toast', {}, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
