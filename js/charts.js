/**
 * Every Chart.js configuration in the app.
 *
 * Colours are never written here — they are read from the CSS tokens at draw
 * time, which is what lets one chart serve both themes. The six categorical
 * slots are assigned in fixed order and never cycled: a filter that removes a
 * profile must not repaint the ones that remain, so identity is keyed to the
 * entity, not to its position in the current result set.
 */

import Chart from 'https://esm.sh/chart.js@4/auto';
import { formatMoney, compactMoney } from './ui.js?v=10';

/* Registry of live charts, so a theme flip can rebuild them with new colours. */
const live = new Map();

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The six categorical slots, in order. A 7th entity gets "other", not a hue. */
export function seriesColor(index) {
  return index < 6 ? token(`--series-${index + 1}`) : token('--series-other');
}

/**
 * The column default for finance_categories.color. A row still carrying it was
 * never given a colour — it isn't a choice, so it doesn't get treated as one.
 */
export const UNSET_CATEGORY_COLOR = '#8b8b8b';

/**
 * A category's own colour, or a palette slot if it hasn't got one.
 *
 * `slot` must be the category's position in the profile's category list, not
 * its rank in the chart: colour follows the entity, so a category may not
 * change colour because another one out-spent it this month.
 */
export function categoryColor(category, slot = 0) {
  const stored = (category?.color ?? '').trim().toLowerCase();
  if (stored && stored !== UNSET_CATEGORY_COLOR) return stored;
  return seriesColor(slot);
}

function chrome() {
  return {
    text: token('--text'),
    muted: token('--text-muted'),
    faint: token('--text-faint'),
    grid: token('--border-subtle'),
    axis: token('--border'),
    surface: token('--surface'),
    positive: token('--positive'),
    negative: token('--negative'),
    neutral: token('--neutral'),
    font: token('--font-body').split(',')[0].replace(/['"]/g, '').trim() || 'sans-serif',
    mono: token('--font-mono').split(',')[0].replace(/['"]/g, '').trim() || 'monospace',
  };
}

/** Shared skeleton: recessive grid, no chart junk, tooltips on by default. */
function baseOptions(c, { legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: prefersReducedMotion() ? 0 : 400 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: {
        display: legend,
        position: 'bottom',
        align: 'start',
        labels: {
          color: c.muted,
          font: { family: c.font, size: 12 },
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: 'circle',
          padding: 16,
        },
      },
      tooltip: {
        backgroundColor: c.surface,
        titleColor: c.text,
        bodyColor: c.muted,
        borderColor: c.axis,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        usePointStyle: true,
        titleFont: { family: c.font, size: 12, weight: '600' },
        bodyFont: { family: c.mono, size: 12 },
      },
    },
  };
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Replaces whatever chart was on this canvas. Canvases are reused, not rebuilt. */
function mount(canvas, config, builder) {
  live.get(canvas)?.instance.destroy();
  const instance = new Chart(canvas, config);
  live.set(canvas, { instance, builder });
  return instance;
}

/* ------------------------------------------------------------------------- */
/* Habits — completion rate over time                                         */
/* ------------------------------------------------------------------------- */

/**
 * One line per profile. `series` is [{ id, label, points: number[] }] where a
 * point is a completion rate 0–100, aligned to `labels`.
 *
 * `colorIndex` is looked up per series id by the caller so a profile keeps its
 * colour when the filter bar removes another profile.
 */
export function completionChart(canvas, { labels, series }) {
  const builder = () => {
    const c = chrome();
    return {
      type: 'line',
      data: {
        labels,
        datasets: series.map((s) => {
          const color = seriesColor(s.colorIndex);
          return {
            label: s.label,
            data: s.points,
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: labels.length > 40 ? 0 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: color,
            // A 2px surface ring keeps overlapping points readable.
            pointBorderColor: c.surface,
            pointBorderWidth: 2,
            tension: 0.25,
            fill: false,
          };
        }),
      },
      options: {
        ...baseOptions(c, { legend: series.length > 1 }),
        scales: {
          x: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: {
              color: c.faint,
              font: { family: c.font, size: 11 },
              maxRotation: 0,
              autoSkipPadding: 16,
            },
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.mono, size: 11 },
              padding: 8,
              stepSize: 25,
              callback: (v) => `${v}%`,
            },
          },
        },
        plugins: {
          ...baseOptions(c, { legend: series.length > 1 }).plugins,
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${Math.round(ctx.parsed.y)}%`,
            },
          },
        },
      },
    };
  };
  return mount(canvas, builder(), builder);
}

/* ------------------------------------------------------------------------- */
/* Finances — expenses by category                                            */
/* ------------------------------------------------------------------------- */

/**
 * `slices` is [{ label, value, color }], already folded to ≤ 7 by the caller,
 * with each colour resolved there so the legend beside the chart can use the
 * exact same values in the exact same order.
 */
export function categoryDoughnut(canvas, { slices }) {
  const builder = () => {
    const c = chrome();
    const total = slices.reduce((sum, s) => sum + s.value, 0);
    return {
      type: 'doughnut',
      data: {
        labels: slices.map((s) => s.label),
        datasets: [{
          data: slices.map((s) => s.value),
          backgroundColor: slices.map((s, i) => s.color || seriesColor(i)),
          // 2px of surface between segments so adjacent fills never touch.
          borderColor: c.surface,
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        ...baseOptions(c, { legend: true }),
        cutout: '62%',
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          ...baseOptions(c, { legend: true }).plugins,
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const share = total ? Math.round((ctx.parsed / total) * 100) : 0;
                return ` ${formatMoney(ctx.parsed)} · ${share}%`;
              },
            },
          },
        },
      },
    };
  };
  return mount(canvas, builder(), builder);
}

/* ------------------------------------------------------------------------- */
/* Finances — net by month                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Polarity, not identity: a month is above or below zero, so this is the one
 * chart that uses the money colours rather than a categorical slot.
 */
export function monthlyNetChart(canvas, { labels, values }) {
  const builder = () => {
    const c = chrome();
    return {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Net',
          data: values,
          backgroundColor: values.map((v) => (v >= 0 ? c.positive : c.negative)),
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 34,
        }],
      },
      options: {
        ...baseOptions(c),
        scales: {
          x: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: { color: c.faint, font: { family: c.font, size: 11 } },
          },
          y: {
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.mono, size: 11 },
              padding: 8,
              callback: (v) => compactMoney(v),
            },
          },
        },
        plugins: {
          ...baseOptions(c).plugins,
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: { label: (ctx) => ` ${formatMoney(ctx.parsed.y)}` },
          },
        },
      },
    };
  };
  return mount(canvas, builder(), builder);
}

/* ------------------------------------------------------------------------- */
/* Trading                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * A dashed rule at break-even, drawn under the line. Chart.js has no built-in
 * annotation and the plugin that does it is a dependency we don't need for one
 * horizontal line.
 */
const breakEvenLine = {
  id: 'breakEvenLine',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.y) return;
    const y = scales.y.getPixelForValue(0);
    if (y < chartArea.top || y > chartArea.bottom) return;

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = opts.color;
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.restore();
  },
};

/**
 * Cumulative P&L. One series, so no legend — the panel label names it. Filled
 * with a gradient that fades out downward, because the area under a running
 * total is the thing you actually read, and a flat block of colour would fight
 * the grid for attention. The last point is the only dot: it's where you are.
 */
export function equityCurveChart(canvas, { labels, values, mode = 'amount' }) {
  const builder = () => {
    const c = chrome();
    const line = c.positive;
    const lastIndex = values.length - 1;
    // In percent mode the numbers are already a ratio of the starting balance,
    // so they must not go near the currency helpers.
    const format = mode === 'percent'
      ? (v) => `${Number(v).toFixed(2)}%`
      : (v) => formatMoney(v);
    const tick = mode === 'percent'
      ? (v) => `${Number(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`
      : (v) => compactMoney(v);

    return {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Cumulative P&L',
          data: values,
          borderColor: line,
          borderWidth: 2,
          // Scriptable: the gradient needs the plot box, which doesn't exist
          // on the first pass or after a resize.
          backgroundColor: (ctx) => {
            const { chart } = ctx;
            if (!chart.chartArea) return 'transparent';
            const { top, bottom } = chart.chartArea;
            const gradient = chart.ctx.createLinearGradient(0, top, 0, bottom);
            gradient.addColorStop(0, alpha(line, 0.32));
            gradient.addColorStop(0.55, alpha(line, 0.1));
            gradient.addColorStop(1, alpha(line, 0));
            return gradient;
          },
          pointRadius: (ctx) => (ctx.dataIndex === lastIndex ? 5 : 0),
          pointHoverRadius: 5,
          pointBackgroundColor: line,
          pointBorderColor: c.surface,
          pointBorderWidth: 2,
          tension: 0.25,
          fill: 'origin',
        }],
      },
      options: {
        ...baseOptions(c),
        plugins: {
          ...baseOptions(c).plugins,
          breakEvenLine: { color: c.axis },
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: { label: (ctx) => ` ${format(ctx.parsed.y)}` },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.font, size: 11 },
              maxRotation: 0,
              autoSkipPadding: 24,
            },
          },
          y: {
            grid: { color: c.grid, drawTicks: false, drawBorder: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.mono, size: 11 },
              padding: 10,
              maxTicksLimit: 6,
              callback: (v) => tick(v),
            },
          },
        },
      },
      plugins: [breakEvenLine],
    };
  };
  return mount(canvas, builder(), builder);
}

/** Hex to rgb() with an alpha channel, for gradient stops. */
function alpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
}

/**
 * Signed bars: P&L by day / month / year, and P&L by emotion. Polarity, so the
 * money colours rather than a categorical slot.
 */
export function signedBarChart(canvas, { labels, values, counts }) {
  const builder = () => {
    const c = chrome();
    return {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'P&L',
          data: values,
          backgroundColor: values.map((v) => (v >= 0 ? c.positive : c.negative)),
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 40,
        }],
      },
      options: {
        ...baseOptions(c),
        scales: {
          x: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: { color: c.faint, font: { family: c.font, size: 11 }, autoSkipPadding: 12 },
          },
          y: {
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.mono, size: 11 },
              padding: 8,
              callback: (v) => compactMoney(v),
            },
          },
        },
        plugins: {
          ...baseOptions(c).plugins,
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const n = counts?.[ctx.dataIndex];
                return ` ${formatMoney(ctx.parsed.y)}${n ? ` · ${n} trade${n === 1 ? '' : 's'}` : ''}`;
              },
            },
          },
        },
      },
    };
  };
  return mount(canvas, builder(), builder);
}

/**
 * Win rate by setup / session: one measure ranked across categories, so a single
 * hue — colour here would only repeat what position already says. `counts` is
 * carried into the tooltip because a 100% win rate over two trades is noise.
 */
export function rateBarChart(canvas, { labels, values, counts, slot = 1 }) {
  const builder = () => {
    const c = chrome();
    return {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Win rate',
          data: values,
          backgroundColor: seriesColor(slot),
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 40,
        }],
      },
      options: {
        ...baseOptions(c),
        indexAxis: 'y',
        scales: {
          x: {
            min: 0,
            max: 100,
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.mono, size: 11 },
              stepSize: 25,
              callback: (v) => `${v}%`,
            },
          },
          y: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: { color: c.muted, font: { family: c.font, size: 11 } },
          },
        },
        plugins: {
          ...baseOptions(c).plugins,
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: {
              label: (ctx) => {
                const n = counts?.[ctx.dataIndex] ?? 0;
                return ` ${Math.round(ctx.parsed.x)}% of ${n} trade${n === 1 ? '' : 's'}`;
              },
            },
          },
        },
      },
    };
  };
  return mount(canvas, builder(), builder);
}

/**
 * Counts by category, each bar in its own colour. Horizontal, because the
 * labels are words and words read better along the axis than under it.
 */
export function countBarChart(canvas, { labels, values, colors, unit = 'time' }) {
  const builder = () => {
    const c = chrome();
    return {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Count',
          data: values,
          backgroundColor: colors,
          borderRadius: 4,
          borderSkipped: false,
          maxBarThickness: 30,
        }],
      },
      options: {
        ...baseOptions(c),
        indexAxis: 'y',
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: c.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: c.faint,
              font: { family: c.mono, size: 11 },
              precision: 0,
            },
          },
          y: {
            grid: { display: false },
            border: { color: c.axis },
            ticks: { color: c.muted, font: { family: c.font, size: 11 } },
          },
        },
        plugins: {
          ...baseOptions(c).plugins,
          tooltip: {
            ...baseOptions(c).plugins.tooltip,
            callbacks: {
              label: (ctx) => ` ${ctx.parsed.x} ${unit}${ctx.parsed.x === 1 ? '' : 's'}`,
            },
          },
        },
      },
    };
  };
  return mount(canvas, builder(), builder);
}

/* Axis ticks and tooltips go through the money helpers in ui.js, so a change of
   display currency reaches the charts without any of them knowing about it. */

/* ------------------------------------------------------------------------- */

export function destroyChart(canvas) {
  live.get(canvas)?.instance.destroy();
  live.delete(canvas);
}

/**
 * Dark mode is its own set of steps, not a filter over the light ones, so a
 * theme change means rebuilding every chart rather than tinting it.
 */
new MutationObserver(() => {
  for (const [canvas, entry] of live) {
    entry.instance.destroy();
    const instance = new Chart(canvas, entry.builder());
    live.set(canvas, { instance, builder: entry.builder });
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
