// Frame to Tokens — extracts a design system (Variables + Styles) from a captured frame.
//
// Figma's official web-capture extension (June 2026) drops editable layers with every
// value hardcoded — no Variables, no Styles. This plugin reads a selected frame,
// infers each color's SEMANTIC ROLE from how it's used, clusters near-duplicate raw
// values into a tight token set, writes them as a two-tier Variable system
// (Primitives + Semantic aliases) + Text/Effect Styles, and optionally rebinds the layers.
//
// Runs in the plugin sandbox (plain JS, zero build). See README.md.

figma.showUI(__html__, { width: 360, height: 600 });

const MIXED = figma.mixed;
const SURFACE_AREA = 40000; // px² — a fill on an area bigger than this reads as a surface/background

// ---------------------------------------------------------------------------
// color math
// ---------------------------------------------------------------------------
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function round(n, p) { const f = Math.pow(10, p == null ? 2 : p); return Math.round(n * f) / f; }

function rgbToHex(c) {
  const h = (n) => Math.round(clamp01(n) * 255).toString(16).padStart(2, '0');
  return '#' + h(c.r) + h(c.g) + h(c.b);
}
function colorDist(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
function rgbToHsl(c) {
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  let h = 0, s = 0; const l = (max + min) / 2; const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s, l };
}
function hueName(h) {
  if (h < 15 || h >= 345) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'teal';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

// --- primitive palette naming (ported from site-to-figma Token Refiner) ------
const STEP_LADDER = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
function hueFamily(h) {
  if (h < 15 || h >= 345) return 'Red';
  if (h < 45) return 'Orange';
  if (h < 70) return 'Yellow';
  if (h < 160) return 'Green';
  if (h < 195) return 'Teal';
  if (h < 240) return 'Blue';
  if (h < 275) return 'Indigo';
  if (h < 315) return 'Purple';
  return 'Pink';
}
function lightnessToStep(l) {
  if (l >= 0.97) return 'White';
  if (l <= 0.06) return 'Black';
  const idx = Math.round((1 - l) * (STEP_LADDER.length - 1));
  return STEP_LADDER[Math.max(0, Math.min(STEP_LADDER.length - 1, idx))];
}
// family + step for a 0–1 color, using chroma (not HSL saturation) to spot neutrals
function primitiveName(color) {
  const { h, l } = rgbToHsl(color);
  const chroma = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
  const family = chroma < 0.12 ? 'Neutral' : hueFamily(h);
  return 'Color/' + family + '/' + lightnessToStep(l);
}
function snap(value) {
  const cands = [Math.round(value / 4) * 4, Math.round(value / 8) * 8];
  let best = cands[0];
  for (const c of cands) if (Math.abs(c - value) < Math.abs(best - value)) best = c;
  return best || Math.round(value);
}

// ---------------------------------------------------------------------------
// 1. COLLECT — walk the tree, tally every raw value (colors keep role context)
// ---------------------------------------------------------------------------
function emptyAcc() {
  return { colors: new Map(), radii: new Map(), spacing: new Map(), type: new Map(), effects: new Map(), nodeCount: 0 };
}
function tallyColor(map, color, role) {
  if (!color) return;
  const hex = rgbToHex(color);
  const e = map.get(hex) || { color: { r: color.r, g: color.g, b: color.b }, hex, count: 0, roles: { text: 0, surface: 0, border: 0, fill: 0 } };
  e.count++; e.roles[role]++; map.set(hex, e);
}
function tallyNum(map, value) {
  if (typeof value !== 'number' || value <= 0) return;
  const e = map.get(value) || { value, count: 0 }; e.count++; map.set(value, e);
}

function collect(node, acc) {
  acc.nodeCount++;
  const area = ('width' in node && 'height' in node) ? node.width * node.height : 0;

  if ('fills' in node && node.fills !== MIXED && Array.isArray(node.fills)) {
    let role = 'fill';
    if (node.type === 'TEXT') role = 'text';
    else if (area > SURFACE_AREA) role = 'surface';
    for (const p of node.fills) if (p.type === 'SOLID' && p.visible !== false) tallyColor(acc.colors, p.color, role);
  }
  if ('strokes' in node && Array.isArray(node.strokes)) {
    for (const p of node.strokes) if (p.type === 'SOLID' && p.visible !== false) tallyColor(acc.colors, p.color, 'border');
  }

  if ('cornerRadius' in node) {
    if (node.cornerRadius === MIXED) {
      tallyNum(acc.radii, node.topLeftRadius); tallyNum(acc.radii, node.topRightRadius);
      tallyNum(acc.radii, node.bottomLeftRadius); tallyNum(acc.radii, node.bottomRightRadius);
    } else tallyNum(acc.radii, node.cornerRadius);
  }
  if ('layoutMode' in node && node.layoutMode !== 'NONE') {
    tallyNum(acc.spacing, node.itemSpacing);
    tallyNum(acc.spacing, node.paddingLeft); tallyNum(acc.spacing, node.paddingRight);
    tallyNum(acc.spacing, node.paddingTop); tallyNum(acc.spacing, node.paddingBottom);
  }
  if (node.type === 'TEXT' && node.fontName !== MIXED && node.fontSize !== MIXED) {
    const lh = node.lineHeight, ls = node.letterSpacing;
    const lhNorm = (lh !== MIXED && lh) ? lh : { unit: 'AUTO' };
    const lsNorm = (ls !== MIXED && ls) ? ls : { value: 0, unit: 'PERCENT' };
    const lhKey = lhNorm.unit === 'AUTO' ? 'auto' : round(lhNorm.value) + lhNorm.unit;
    const key = node.fontName.family + '|' + node.fontName.style + '|' + node.fontSize + '|' + lhKey;
    const e = acc.type.get(key) || { family: node.fontName.family, style: node.fontName.style, size: node.fontSize, lineHeight: lhNorm, letterSpacing: lsNorm, count: 0 };
    e.count++; acc.type.set(key, e);
  }
  if ('effects' in node && Array.isArray(node.effects)) {
    for (const ef of node.effects) {
      if ((ef.type === 'DROP_SHADOW' || ef.type === 'INNER_SHADOW') && ef.visible !== false) {
        const key = ef.type + '|' + rgbToHex(ef.color) + '|' + round(ef.color.a) + '|' + round(ef.offset.x) + ',' + round(ef.offset.y) + '|' + round(ef.radius) + '|' + round(ef.spread || 0);
        const e = acc.effects.get(key) || { effect: ef, count: 0 }; e.count++; acc.effects.set(key, e);
      }
    }
  }
  if ('children' in node) for (const child of node.children) collect(child, acc);
}

// ---------------------------------------------------------------------------
// 2. CLUSTER + SEMANTIC NAMING
// ---------------------------------------------------------------------------
const COLOR_THRESHOLD = 0.05;

const SCOPE = {
  text: ['TEXT_FILL'],
  border: ['STROKE_COLOR'],
  background: ['FRAME_FILL', 'SHAPE_FILL'],
  brand: ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL'],
};
const Q = {
  text: ['primary', 'secondary', 'tertiary', 'quaternary'],
  background: ['default', 'subtle', 'muted', 'strong'],
  border: ['subtle', 'default', 'strong'],
  brand: ['primary', 'secondary', 'tertiary'],
};

function dominantGroup(rep) {
  const r = rep.roles, l = rep.hsl.l;
  // text wins only if it's actually the dominant use
  if (r.text > 0 && r.text >= r.surface && r.text >= r.border && r.text >= r.fill) return 'text';
  // near-white / near-black read as surfaces regardless of stray stroke/fill counts
  // (a white "border" is almost always a hairline artifact; white = background/default)
  if (l > 0.93 || l < 0.07) return 'background';
  if (r.border > 0 && r.border >= r.surface && r.border >= r.fill) return 'border';
  // remaining fills: chromatic -> brand, neutral -> background
  return rep.hsl.s >= 0.25 ? 'brand' : 'background';
}

function qualifier(group, i, total) {
  const scale = Q[group];
  if (i < scale.length) return scale[i];
  return scale[scale.length - 1] + '-' + (i - scale.length + 2);
}

function clusterColors(colorMap) {
  const items = [...colorMap.values()].sort((a, b) => b.count - a.count);
  const reps = [];
  const assign = new Map(); // original hex -> representative hex
  for (const item of items) {
    let host = null;
    for (const rep of reps) if (colorDist(item.color, rep.color) < COLOR_THRESHOLD) { host = rep; break; }
    if (host) {
      host.count += item.count;
      for (const k in item.roles) host.roles[k] += item.roles[k];
      assign.set(item.hex, host.hex);
    } else {
      reps.push({ color: item.color, hex: item.hex, count: item.count, roles: Object.assign({}, item.roles) });
      assign.set(item.hex, item.hex);
    }
  }
  for (const rep of reps) rep.hsl = rgbToHsl(rep.color);

  // bucket by inferred group, then rank within group to assign qualifiers
  const groups = { text: [], background: [], border: [], brand: [] };
  for (const rep of reps) groups[dominantGroup(rep)].push(rep);

  // text: very light text is "inverse" (sits on dark surfaces); rest ranked dark -> light
  const inverse = groups.text.filter((r) => r.hsl.l > 0.85);
  const normalText = groups.text.filter((r) => r.hsl.l <= 0.85).sort((a, b) => a.hsl.l - b.hsl.l);
  normalText.forEach((r, i) => { r.name = 'color/text/' + qualifier('text', i, normalText.length); r.group = 'text'; });
  inverse.forEach((r, i) => { r.name = 'color/text/inverse' + (i ? '-' + (i + 1) : ''); r.group = 'text'; });

  // background: lightest first (white -> default)
  groups.background.sort((a, b) => b.hsl.l - a.hsl.l)
    .forEach((r, i) => { r.name = 'color/background/' + qualifier('background', i, groups.background.length); r.group = 'background'; });

  // border: lightest first (subtle -> strong)
  groups.border.sort((a, b) => b.hsl.l - a.hsl.l)
    .forEach((r, i) => { r.name = 'color/border/' + qualifier('border', i, groups.border.length); r.group = 'border'; });

  // brand: group by hue. single hue -> primary/secondary; multiple -> name by hue
  const byHue = new Map();
  for (const r of groups.brand) { const h = hueName(r.hsl.h); if (!byHue.has(h)) byHue.set(h, []); byHue.get(h).push(r); }
  if (byHue.size <= 1) {
    groups.brand.sort((a, b) => b.count - a.count)
      .forEach((r, i) => { r.name = 'color/brand/' + qualifier('brand', i, groups.brand.length); r.group = 'brand'; });
  } else {
    for (const [hue, list] of byHue) list.sort((a, b) => b.count - a.count)
      .forEach((r, i) => { r.name = 'color/brand/' + hue + (i ? '-' + (i + 1) : ''); r.group = 'brand'; });
  }
  return { reps, assign };
}

function clusterNumbers(numMap, prefix) {
  const snapped = new Map(), assign = new Map();
  for (const { value, count } of numMap.values()) {
    const s = snap(value); snapped.set(s, (snapped.get(s) || 0) + count); assign.set(value, s);
  }
  const reps = [...snapped.entries()].map(([value, count]) => ({ value, count, name: prefix + '/' + value }))
    .sort((a, b) => a.value - b.value);
  return { reps, assign };
}

// ---------------------------------------------------------------------------
// 3. WRITE — two-tier system: Primitives (raw palette) + Semantic (aliases)
// ---------------------------------------------------------------------------
// A find-or-create palette in the Primitives collection, keyed by hex so the
// same extracted value is never created twice.
function makePalette(coll) {
  const mode = coll.defaultModeId;
  const byHex = new Map();   // hex -> Variable
  const usedNames = new Set();
  function get(color) {
    const hex = rgbToHex(color);
    if (byHex.has(hex)) return byHex.get(hex);
    let base = primitiveName(color), name = base, i = 2;
    while (usedNames.has(name)) name = base + '-' + (i++);
    usedNames.add(name);
    const v = figma.variables.createVariable(name, coll, 'COLOR');
    v.scopes = ['ALL_FILLS', 'STROKE_COLOR'];
    v.setValueForMode(mode, { r: color.r, g: color.g, b: color.b, a: 1 });
    byHex.set(hex, v);
    return v;
  }
  return { get, count: () => byHex.size };
}

// Build Primitives + Semantic color collections. Every semantic token aliases a
// primitive that was actually extracted from the frame (no invented values).
function buildColorSystem(prim, colorReps) {
  const palette = makePalette(prim);
  const sem = figma.variables.createVariableCollection('Semantic');
  const mode = sem.defaultModeId;

  const semByHex = new Map(); // representative hex -> Semantic Variable
  for (const rep of colorReps) {
    const sourcePrim = palette.get(rep.color);
    const sv = figma.variables.createVariable(rep.name, sem, 'COLOR');
    sv.scopes = SCOPE[rep.group] || ['ALL_FILLS'];
    sv.setValueForMode(mode, figma.variables.createVariableAlias(sourcePrim));
    semByHex.set(rep.hex, sv);
  }
  return { semByHex, primitiveCount: palette.count() };
}

// Spacing / radius live as primitives only (no semantic layer — standard DS practice).
function buildNumberPrimitives(coll, reps, scopes) {
  const mode = coll.defaultModeId;
  const map = new Map();
  for (const rep of reps) {
    const v = figma.variables.createVariable(rep.name, coll, 'FLOAT');
    v.scopes = scopes;
    v.setValueForMode(mode, rep.value);
    map.set(rep.value, v);
  }
  return map;
}

async function buildTextStyles(typeMap) {
  const items = [...typeMap.values()].sort((a, b) => b.size - a.size || b.count - a.count);
  const styleFor = new Map(); const used = new Set();
  for (const t of items) {
    let role;
    if (t.size >= 32) role = 'display'; else if (t.size >= 24) role = 'heading';
    else if (t.size >= 20) role = 'title'; else if (t.size >= 16) role = 'body-lg';
    else if (t.size >= 14) role = 'body'; else role = 'caption';
    let name = 'text/' + role, n = 2;
    while (used.has(name)) name = 'text/' + role + '-' + (n++);
    used.add(name);
    try {
      const fontName = { family: t.family, style: t.style };
      await figma.loadFontAsync(fontName);
      const ts = figma.createTextStyle();
      ts.name = name; ts.fontName = fontName; ts.fontSize = t.size;
      ts.lineHeight = t.lineHeight; ts.letterSpacing = t.letterSpacing;
      const k = t.family + '|' + t.style + '|' + t.size + '|' + (t.lineHeight.unit === 'AUTO' ? 'auto' : round(t.lineHeight.value) + t.lineHeight.unit);
      styleFor.set(k, ts);
    } catch (e) { /* font unavailable — skip */ }
  }
  return styleFor;
}

function buildEffectStyles(effectMap) {
  const items = [...effectMap.values()].sort((a, b) => b.count - a.count);
  items.forEach((item, i) => {
    const es = figma.createEffectStyle();
    es.name = 'elevation/' + String((i + 1) * 100);
    const ef = item.effect;
    es.effects = [{ type: ef.type, color: ef.color, offset: { x: ef.offset.x, y: ef.offset.y }, radius: ef.radius, spread: ef.spread || 0, visible: true, blendMode: ef.blendMode || 'NORMAL' }];
  });
  return items.length;
}

// ---------------------------------------------------------------------------
// 4. REBIND — point layers at the new tokens (best effort, never throws out)
// ---------------------------------------------------------------------------
function rebind(node, ctx) {
  const { colorAssign, semByHex, spaceVar, radiusVar } = ctx;
  try {
    if ('fills' in node && node.fills !== MIXED && Array.isArray(node.fills) && node.fills.length) {
      let changed = false;
      const fills = node.fills.map((p) => {
        if (p.type !== 'SOLID' || p.visible === false) return p;
        const repHex = colorAssign.get(rgbToHex(p.color));
        const v = repHex && semByHex.get(repHex);
        if (!v) return p; changed = true;
        return figma.variables.setBoundVariableForPaint(p, 'color', v);
      });
      if (changed) node.fills = fills;
    }
  } catch (e) { /* skip */ }
  try {
    if ('cornerRadius' in node && node.cornerRadius !== MIXED && typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      const v = radiusVar.get(snap(node.cornerRadius));
      if (v) for (const f of ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius']) node.setBoundVariable(f, v);
    }
  } catch (e) { /* skip */ }
  try {
    if ('layoutMode' in node && node.layoutMode !== 'NONE') {
      const bind = (field, raw) => { if (typeof raw === 'number' && raw > 0) { const v = spaceVar.get(snap(raw)); if (v) node.setBoundVariable(field, v); } };
      bind('itemSpacing', node.itemSpacing);
      bind('paddingLeft', node.paddingLeft); bind('paddingRight', node.paddingRight);
      bind('paddingTop', node.paddingTop); bind('paddingBottom', node.paddingBottom);
    }
  } catch (e) { /* skip */ }
  if ('children' in node) for (const child of node.children) rebind(child, ctx);
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------
async function run(opts) {
  const selection = figma.currentPage.selection;
  if (!selection.length) { figma.ui.postMessage({ type: 'error', message: 'Select a captured frame first.' }); return; }

  const acc = emptyAcc();
  for (const node of selection) collect(node, acc);

  const raw = {
    colors: acc.colors.size, spacing: acc.spacing.size, radii: acc.radii.size,
    type: acc.type.size, effects: acc.effects.size,
  };

  const { reps: colorReps, assign: colorAssign } = clusterColors(acc.colors);
  const { reps: spacingReps } = clusterNumbers(acc.spacing, 'spacing');
  const { reps: radiusReps } = clusterNumbers(acc.radii, 'radius');

  const primColl = figma.variables.createVariableCollection('Primitives');
  const { semByHex, primitiveCount } = buildColorSystem(primColl, colorReps);
  const spaceVar = buildNumberPrimitives(primColl, spacingReps, ['GAP', 'WIDTH_HEIGHT']);
  const radiusVar = buildNumberPrimitives(primColl, radiusReps, ['CORNER_RADIUS']);
  const textStyleCount = (await buildTextStyles(acc.type)).size;
  const effectStyleCount = buildEffectStyles(acc.effects);

  if (opts.rebind) {
    const ctx = { colorAssign, semByHex, spaceVar, radiusVar };
    for (const node of selection) rebind(node, ctx);
  }

  const primitivesTotal = primitiveCount + spacingReps.length + radiusReps.length;
  figma.ui.postMessage({
    type: 'done',
    stats: {
      nodes: acc.nodeCount,
      primitives: primitivesTotal,
      colors: { raw: raw.colors, tokens: colorReps.length },
      spacing: { raw: raw.spacing, tokens: spacingReps.length },
      radii: { raw: raw.radii, tokens: radiusReps.length },
      type: { raw: raw.type, tokens: textStyleCount },
      effects: { raw: raw.effects, tokens: effectStyleCount },
      sampleNames: colorReps.slice(0, 8).map((r) => r.name),
      rebound: !!opts.rebind,
    },
  });
}

figma.ui.onmessage = (msg) => {
  if (msg.type === 'run') run({ rebind: !!msg.rebind }).catch((e) => figma.ui.postMessage({ type: 'error', message: String((e && e.message) || e) }));
  if (msg.type === 'close') figma.closePlugin();
};
