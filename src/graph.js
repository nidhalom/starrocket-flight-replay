// Canvas graphs (altitude / velocity / acceleration) with optional overlay of a second flight.
// drawChart is pure canvas code; niceTicks is pure math (unit tested).
import { sampleAt } from './flight.js';

export const CHARTS = [
  { key: 'alt', label: 'ALTITUDE', unit: 'm', field: 'alt' },
  { key: 'vel', label: 'VERTICAL VELOCITY', unit: 'm/s', field: 'vAlt' },
  { key: 'acc', label: 'ACCELERATION', unit: 'm/s²', field: 'acc' },
];

export const COLORS = { a: '#5eead4', b: '#ffb347', cursor: '#ff5a36', grid: 'rgba(255,255,255,0.07)', text: '#8393a3', bg: '#0e131a' };

export function niceTicks(min, max, count = 4) {
  if (!(max > min)) { max = min + 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
  return { step, ticks };
}

function seriesPoints(flight, field, offset, maxPts = 700) {
  const f = flight.frames;
  const stride = Math.max(1, Math.ceil(f.length / maxPts));
  const pts = [];
  for (let i = 0; i < f.length; i += stride) pts.push([f[i].t + offset, f[i][field]]);
  const last = f[f.length - 1];
  if ((f.length - 1) % stride !== 0) pts.push([last.t + offset, last[field]]);
  return pts;
}

// opts: { a, b, offsetB, tMin, tMax, tNow, events: bool, title }
export function drawChart(ctx, w, h, spec, opts) {
  const { a, b, offsetB = 0, tMin, tMax, tNow } = opts;
  const m = { l: 46, r: 8, t: 16, b: 18 };
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const A = seriesPoints(a, spec.field, 0);
  const B = b ? seriesPoints(b, spec.field, offsetB) : null;
  let lo = Infinity, hi = -Infinity;
  for (const p of A.concat(B || [])) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  if (spec.key === 'alt') lo = Math.min(lo, 0);
  const pad = (hi - lo) * 0.06 || 1;
  lo -= pad; hi += pad;
  const px = (t) => m.l + ((t - tMin) / (tMax - tMin || 1)) * (w - m.l - m.r);
  const py = (v) => h - m.b - ((v - lo) / (hi - lo || 1)) * (h - m.t - m.b);

  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(`${spec.label} (${spec.unit})`, m.l, 8);
  ctx.lineWidth = 1;
  const yt = niceTicks(lo, hi, 4);
  ctx.textAlign = 'right';
  for (const v of yt.ticks) {
    const y = py(v);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(Math.abs(v) >= 100 ? v.toFixed(0) : String(+v.toFixed(2)), m.l - 4, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const xt = niceTicks(tMin, tMax, Math.max(3, Math.floor((w - m.l) / 70)));
  for (const v of xt.ticks) {
    const x = px(v);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(String(+v.toFixed(2)) + 's', x, h - 4);
  }

  // event markers for flight A (and B, thinner)
  if (opts.events !== false) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    for (const e of a.events) {
      if (e.name === 'custom' || e.t < tMin || e.t > tMax) continue;
      ctx.strokeStyle = 'rgba(94,234,212,0.35)';
      ctx.beginPath(); ctx.moveTo(px(e.t), m.t); ctx.lineTo(px(e.t), h - m.b); ctx.stroke();
    }
    if (b) {
      for (const e of b.events) {
        if (e.name === 'custom') continue;
        const t = e.t + offsetB;
        if (t < tMin || t > tMax) continue;
        ctx.strokeStyle = 'rgba(255,179,71,0.3)';
        ctx.beginPath(); ctx.moveTo(px(t), m.t); ctx.lineTo(px(t), h - m.b); ctx.stroke();
      }
    }
    ctx.restore();
  }

  const line = (pts, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    pts.forEach((p, i) => { const x = px(p[0]), y = py(p[1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  };
  if (B) line(B, COLORS.b);
  line(A, COLORS.a);

  if (tNow !== undefined && tNow !== null) {
    const x = px(tNow);
    ctx.strokeStyle = COLORS.cursor;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke();
    const dot = (fl, off, color) => {
      const s = sampleAt(fl, tNow - off);
      if (tNow - off < 0 || tNow - off > fl.duration) return;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, py(s[spec.field]), 3, 0, Math.PI * 2); ctx.fill();
    };
    dot(a, 0, COLORS.cursor);
    if (b) dot(b, offsetB, COLORS.b);
  }
  return { px, m };
}

export function chartTimeAt(canvasX, w, tMin, tMax) {
  const l = 46, r = 8;
  const f = (canvasX - l) / (w - l - r);
  return tMin + Math.min(1, Math.max(0, f)) * (tMax - tMin);
}

// Render all charts into one PNG-able canvas (1200 px wide).
export function renderSheet(doc, opts) {
  const W = 1200, rowH = 300, head = 64;
  const cv = doc.createElement('canvas');
  cv.width = W;
  cv.height = head + rowH * CHARTS.length;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#e8edf2';
  ctx.font = '700 20px "Space Grotesk", sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('STARROCKET // FLIGHT REPLAY', 20, 30);
  ctx.font = '13px "JetBrains Mono", monospace';
  ctx.fillStyle = COLORS.a;
  ctx.fillText(`A: ${opts.a.name}  (apogee ${opts.a.stats.apogee.toFixed(0)} m)`, 20, 52);
  if (opts.b) {
    ctx.fillStyle = COLORS.b;
    ctx.fillText(`B: ${opts.b.name}  (apogee ${opts.b.stats.apogee.toFixed(0)} m)`, 460, 52);
  }
  CHARTS.forEach((spec, i) => {
    const sub = doc.createElement('canvas');
    sub.width = W; sub.height = rowH;
    drawChart(sub.getContext('2d'), W, rowH, spec, { ...opts, tNow: null });
    ctx.drawImage(sub, 0, head + i * rowH);
  });
  return cv;
}
