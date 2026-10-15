#!/usr/bin/env bun
// Generates src/theme/vscode-dark-modern.css and src/theme/vscode-light-modern.css (KTD8).
//
// The plan wanted a dump of the computed `--vscode-*` variables from a running VS Code
// webview. We can't drive VS Code here, so this script reproduces what VS Code computes:
//   1. Theme colors from the built-in Dark Modern / Light Modern theme JSON, with the
//      `include` chain resolved (dark_modern -> dark_plus -> dark_vs, same for light).
//   2. Colors the theme doesn't set fall back to VS Code's color-registry defaults,
//      parsed from `registerColor(id, {dark, light, ...})` calls in the bundled workbench
//      JS and from built-in extensions' `contributes.colors`. Defaults that reference other
//      colors or use transparent()/darken()/lighten()/opaque()/oneOf()/lessProminent()/
//      ifDefinedThenElse()/mix() are resolved with VS Code's color math.
//   3. Colors VS Code leaves undefined in a theme (e.g. contrastBorder outside high
//      contrast) are emitted as `initial` (the guaranteed-invalid value), which behaves
//      exactly like an undefined custom property while still being declared.
//   4. Non-color variables (fonts, sash sizes, hover widths, ...) are hand-filled below.
// It then asserts that every `var(--vscode-*)` name the Claude Code extension's webview
// stylesheet references is defined in both outputs, and lists the hand-filled names.
//
// Usage: bun scripts/gen-vscode-theme.ts [--vscode <VS Code.app>] [--extension-css <index.css>]

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const VSCODE_APP = arg("--vscode") ?? "/Applications/Visual Studio Code.app";
const APP_ROOT = join(VSCODE_APP, "Contents/Resources/app");
const THEMES = join(APP_ROOT, "extensions/theme-defaults/themes");
const WORKBENCH_JS = join(APP_ROOT, "out/vs/workbench/workbench.desktop.main.js");
const EXT_ROOT = join(homedir(), ".vscode/extensions");
const EXTENSION_CSS = arg("--extension-css") ?? findExtensionCss();
const OUT_DIR = resolve(dirname(new URL(import.meta.url).pathname), "../src/theme");

function findExtensionCss(): string {
  const dirs = existsSync(EXT_ROOT) ? readdirSync(EXT_ROOT).filter((d) => d.startsWith("anthropic.claude-code-")) : [];
  dirs.sort();
  const last = dirs[dirs.length - 1];
  if (!last) throw new Error(`No anthropic.claude-code-* extension under ${EXT_ROOT}; pass --extension-css`);
  return join(EXT_ROOT, last, "webview/index.css");
}

// ---------------------------------------------------------------- color math (mirrors vs/base/common/color.ts)

interface RGBA { r: number; g: number; b: number; a: number }

function parseHex(hex: string): RGBA | undefined {
  const m = /^#([0-9a-f]+)$/i.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return undefined;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

function toHex(c: RGBA): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return c.a >= 1 ? base : base + h(c.a * 255);
}

function toHsl({ r, g, b, a }: RGBA) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 0) {
    s = Math.min(l <= 0.5 ? d / (2 * l) : d / (2 - 2 * l), 1);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
  }
  return { h, s, l, a };
}

function fromHsl({ h, s, l, a }: { h: number; s: number; l: number; a: number }): RGBA {
  l = Math.max(0, Math.min(1, l));
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h / 360 + 1 / 3); g = hue(p, q, h / 360); b = hue(p, q, h / 360 - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a };
}

const lighten = (c: RGBA, f: number) => { const x = toHsl(c); return fromHsl({ ...x, l: x.l + x.l * f }); };
const darken = (c: RGBA, f: number) => { const x = toHsl(c); return fromHsl({ ...x, l: x.l - x.l * f }); };
const transparent = (c: RGBA, f: number): RGBA => ({ ...c, a: c.a * f });
function opaque(c: RGBA, bg: RGBA): RGBA {
  if (c.a === 1) return c;
  const o = opaque(bg, { r: 0, g: 0, b: 0, a: 1 });
  return { r: c.a * c.r + (1 - c.a) * o.r, g: c.a * c.g + (1 - c.a) * o.g, b: c.a * c.b + (1 - c.a) * o.b, a: 1 };
}
const mix = (c: RGBA, w: RGBA, f: number): RGBA => ({
  r: c.r + (w.r - c.r) * f, g: c.g + (w.g - c.g) * f, b: c.b + (w.b - c.b) * f, a: c.a + (w.a - c.a) * f,
});
function luminance(c: RGBA) {
  const ch = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}
function lighterColor(of: RGBA, rel: RGBA, factor: number) {
  if (luminance(of) > luminance(rel)) return of;
  const l1 = luminance(of), l2 = luminance(rel);
  return lighten(of, (factor || 0.5) * (l2 - l1) / l2);
}
function darkerColor(of: RGBA, rel: RGBA, factor: number) {
  if (luminance(of) < luminance(rel)) return of;
  const l1 = luminance(of), l2 = luminance(rel);
  return darken(of, (factor || 0.5) * (l1 - l2) / l1);
}

// ---------------------------------------------------------------- minified-JS expression parser

type Expr =
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "null" }
  | { k: "ref"; name: string }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "obj"; props: Record<string, Expr> }
  | { k: "method"; target: Expr; name: string; args: Expr[] }
  | { k: "unknown" };

class Parser {
  constructor(private s: string, public i: number) {}
  private ws() { while (/\s/.test(this.s[this.i] ?? "")) this.i++; }
  private peek() { this.ws(); return this.s[this.i]; }
  private eat(ch: string) { if (this.peek() !== ch) throw new Error(`expected ${ch} at ${this.i}`); this.i++; }
  expr(): Expr {
    let e = this.primary();
    // Postfix method chains such as `Color.fromHex("#797979").transparent(.4)`.
    while (this.peek() === "." && /^\.[A-Za-z_$]/.test(this.s.slice(this.i, this.i + 2))) {
      const m = /^\.([\w$]+)/.exec(this.s.slice(this.i))!;
      this.i += m[0].length;
      const args: Expr[] = [];
      if (this.peek() === "(") {
        this.i++;
        while (this.peek() !== ")") { args.push(this.expr()); if (this.peek() === ",") this.i++; }
        this.i++;
      }
      e = { k: "method", target: e, name: m[1], args };
    }
    return e;
  }
  private primary(): Expr {
    const c = this.peek();
    if (c === '"' || c === "'" || c === "`") {
      const q = c; let j = this.i + 1; let out = "";
      while (this.s[j] !== q) { if (this.s[j] === "\\") j++; out += this.s[j++]; }
      this.i = j + 1;
      return q === "`" && out.includes("${") ? { k: "unknown" } : { k: "str", v: out };
    }
    if (c === "{") {
      this.i++; const props: Record<string, Expr> = {};
      while (this.peek() !== "}") {
        const m = /^["']?([\w$]+)["']?\s*:/.exec(this.s.slice(this.i, this.i + 80));
        if (!m) throw new Error(`bad key at ${this.i}`);
        this.i += m[0].length;
        props[m[1]] = this.expr();
        if (this.peek() === ",") this.i++;
      }
      this.i++;
      return { k: "obj", props };
    }
    if (c === "!") { this.i++; this.expr(); return { k: "unknown" }; }
    const num = /^-?(\d*\.\d+|\d+)/.exec(this.s.slice(this.i, this.i + 30));
    if (num) { this.i += num[0].length; return { k: "num", v: parseFloat(num[0]) }; }
    if (this.s.startsWith("new ", this.i)) { this.i += 4; const inner = this.expr(); return inner.k === "call" ? { ...inner, fn: `new ${inner.fn}` } : { k: "unknown" }; }
    const id = /^[\w$]+(\.[\w$]+)*/.exec(this.s.slice(this.i, this.i + 120));
    if (!id) throw new Error(`unexpected ${c} at ${this.i}`);
    this.i += id[0].length;
    if (id[0] === "null" || id[0] === "void") return { k: "null" };
    if (this.peek() === "(") {
      this.i++; const args: Expr[] = [];
      while (this.peek() !== ")") { if (this.peek() === "." && this.s.startsWith("...", this.i)) this.i += 3; args.push(this.expr()); if (this.peek() === ",") this.i++; }
      this.i++;
      return { k: "call", fn: id[0], args };
    }
    return { k: "ref", name: id[0] };
  }
  args(): Expr[] { const out: Expr[] = []; out.push(this.expr()); this.eat(","); out.push(this.expr()); return out; }
}

// ---------------------------------------------------------------- color registry

type Defaults = { dark?: Expr; light?: Expr };
const registry = new Map<string, Defaults>();
const varToId = new Map<string, string>();
const helperOps = new Map<string, string>(); // minified fn name -> op

let js = "";
const constants = new Map<string, Expr | null>();
/** A module-level constant used as a default, e.g. `KFe=new Color(new RGBA(155,185,85,.2))`. */
function constantExpr(name: string): Expr | null {
  if (!constants.has(name)) {
    const m = new RegExp(`[,;\\s(]${name.replace(/\$/g, "\\$")}=(?!=)`).exec(js);
    let e: Expr | null = null;
    if (m) { try { e = new Parser(js, m.index + m[0].length).expr(); } catch { e = null; } }
    constants.set(name, e);
  }
  return constants.get(name)!;
}

function loadWorkbenchRegistry() {
  js = readFileSync(WORKBENCH_JS, "utf8");
  // Name the transform helpers by the op they return (see vs/platform/theme/common/colorUtils.ts).
  const opNames: Record<string, string> = { 0: "darken", 1: "lighten", 2: "transparent", 3: "opaque", 4: "oneOf", 5: "lessProminent", 6: "ifDefinedThenElse" };
  for (const m of js.matchAll(/function ([\w$]+)\([^)]*\)\{return\{op:(\d),/g)) helperOps.set(m[1], opNames[m[2]]);
  // The registerColor wrapper: `function ae(s,o,e,t,i){return X.registerColor(s,o,e,t,i)}`.
  const wrappers = [...js.matchAll(/function ([\w$]+)\([\w$,]*\)\{return [\w$]+\.registerColor\(/g)].map((m) => m[1]);
  if (!wrappers.length) throw new Error("registerColor wrapper not found in workbench JS");
  for (const fn of wrappers) {
    const re = new RegExp(`(?:([\\w$]+)=)?\\b${fn.replace("$", "\\$")}\\("([a-zA-Z][\\w.\\-]*)",`, "g");
    for (const m of js.matchAll(re)) {
      const [, varName, id] = m;
      try {
        const p = new Parser(js, m.index! + m[0].length);
        const value = p.expr();
        let d: Defaults;
        if (value.k === "obj") d = { dark: value.props.dark, light: value.props.light };
        else d = { dark: value, light: value };
        if (!registry.has(id)) registry.set(id, d);
        if (varName && !varToId.has(varName)) varToId.set(varName, id);
      } catch (err) {
        if (process.env.DEBUG) console.error(`parse ${id}: ${(err as Error).message}`);
        if (!registry.has(id)) registry.set(id, { dark: { k: "unknown" }, light: { k: "unknown" } });
      }
    }
  }
  // Terminal ANSI colors live in a table: {"terminal.ansiBlack":{index:0,defaults:{...}}, ...}
  for (const m of js.matchAll(/"(terminal\.ansi\w+)":\{index:\d+,defaults:/g)) {
    const p = new Parser(js, m.index! + m[0].length);
    const v = p.expr();
    if (v.k === "obj" && !registry.has(m[1])) registry.set(m[1], { dark: v.props.dark, light: v.props.light });
  }
}

function loadExtensionContributions() {
  const dir = join(APP_ROOT, "extensions");
  for (const ext of readdirSync(dir)) {
    const pkg = join(dir, ext, "package.json");
    if (!existsSync(pkg)) continue;
    const colors = JSON.parse(readFileSync(pkg, "utf8"))?.contributes?.colors as
      | { id: string; defaults: { dark?: string | null; light?: string | null } }[]
      | undefined;
    for (const c of colors ?? []) {
      if (registry.has(c.id)) continue;
      const e = (v: string | null | undefined): Expr => (v == null ? { k: "null" } : { k: "str", v });
      registry.set(c.id, { dark: e(c.defaults.dark), light: e(c.defaults.light) });
    }
  }
}

// ---------------------------------------------------------------- theme files

function parseJsonc(text: string) {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

function loadTheme(file: string): Record<string, string> {
  const json = parseJsonc(readFileSync(join(THEMES, file), "utf8"));
  const base = json.include ? loadTheme(json.include.replace(/^\.\//, "")) : {};
  return { ...base, ...(json.colors ?? {}) };
}

// ---------------------------------------------------------------- resolution

const NAMED: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#ff0000", blue: "#0000ff", green: "#00ff00",
  cyan: "#00ffff", lightgrey: "#d3d3d3", transparent: "#00000000",
};

function resolveTheme(kind: "dark" | "light", themeColors: Record<string, string>) {
  const cache = new Map<string, RGBA | undefined>();
  const stack = new Set<string>();
  const unresolvedIds = new Set<string>();

  const color = (id: string): RGBA | undefined => {
    if (cache.has(id)) return cache.get(id);
    if (stack.has(id)) return undefined;
    stack.add(id);
    let out: RGBA | undefined;
    try {
      const themed = themeColors[id];
      if (themed !== undefined) out = parseHex(themed);
      else {
        const d = registry.get(id);
        out = d ? evalExpr(d[kind]) : undefined;
      }
    } finally {
      stack.delete(id);
    }
    cache.set(id, out);
    return out;
  };

  const evalExpr = (e: Expr | undefined): RGBA | undefined => {
    if (!e) return undefined;
    switch (e.k) {
      case "null": return undefined;
      case "str": return e.v.startsWith("#") ? parseHex(e.v) : color(e.v);
      case "ref": {
        const id = varToId.get(e.name);
        if (id) return color(id);
        const named = e.name.split(".").pop()!;
        if (e.name.includes(".") && NAMED[named]) return parseHex(NAMED[named]);
        const k = !e.name.includes(".") ? constantExpr(e.name) : null;
        if (k) return evalExpr(k);
        throw new Unresolved(`reference ${e.name}`);
      }
      case "obj": {
        const p = e.props;
        if (p.op?.k === "num" && p.op.v === 7) {
          const a = evalExpr(p.color), b = evalExpr(p.with);
          return a && b ? mix(a, b, p.ratio?.k === "num" ? p.ratio.v : 0.5) : a;
        }
        throw new Unresolved("object literal");
      }
      case "method": {
        const c = evalExpr(e.target);
        const f = e.args[0]?.k === "num" ? e.args[0].v : 0;
        if (!c) return undefined;
        if (e.name === "transparent") return transparent(c, f);
        if (e.name === "lighten") return lighten(c, f);
        if (e.name === "darken") return darken(c, f);
        throw new Unresolved(`method ${e.name}`);
      }
      case "call": {
        // `new Color(new RGBA(r, g, b, a))`
        if (e.fn.startsWith("new ") && e.args[0]?.k === "call" && e.args[0].fn.startsWith("new ")) {
          const n = e.args[0].args.map((a) => (a.k === "num" ? a.v : NaN));
          if (n.length >= 3 && n.every((x) => !Number.isNaN(x))) return { r: n[0], g: n[1], b: n[2], a: n[3] ?? 1 };
        }
        const fnName = e.fn.split(".").pop()!;
        if (e.fn.endsWith(".fromHex") && e.args[0]?.k === "str") return parseHex(e.args[0].v);
        const op = helperOps.get(e.fn);
        if (!op && e.fn.includes(".") && !e.fn.startsWith("new ")) {
          // `Color.white.transparent(.18)` was read as one dotted callee: split off the method.
          return evalExpr({ k: "method", target: { k: "ref", name: e.fn.slice(0, e.fn.lastIndexOf(".")) }, name: fnName, args: e.args });
        }
        const num = (x: Expr | undefined) => (x?.k === "num" ? x.v : 0);
        switch (op) {
          case "darken": { const c = evalExpr(e.args[0]); return c && darken(c, num(e.args[1])); }
          case "lighten": { const c = evalExpr(e.args[0]); return c && lighten(c, num(e.args[1])); }
          case "transparent": { const c = evalExpr(e.args[0]); return c && transparent(c, num(e.args[1])); }
          case "opaque": { const c = evalExpr(e.args[0]); const bg = evalExpr(e.args[1]); return c && bg ? opaque(c, bg) : c; }
          case "oneOf": { for (const a of e.args) { const c = evalExpr(a); if (c) return c; } return undefined; }
          case "lessProminent": {
            const from = evalExpr(e.args[0]); if (!from) return undefined;
            const bg = evalExpr(e.args[1]); const f = num(e.args[2]); const t = num(e.args[3]);
            if (!bg) return transparent(from, f * t);
            return transparent(luminance(from) < luminance(bg) ? lighterColor(from, bg, f) : darkerColor(from, bg, f), t);
          }
          case "ifDefinedThenElse": {
            const cond = e.args[0];
            const condId = cond?.k === "str" ? cond.v : cond?.k === "ref" ? varToId.get(cond.name) : undefined;
            return evalExpr(condId && themeColors[condId] !== undefined ? e.args[1] : e.args[2]);
          }
        }
        throw new Unresolved(`call ${fnName}`);
      }
      default: throw new Unresolved(e.k);
    }
  };

  const out = new Map<string, string>();
  const unset = new Set<string>();
  const ids = new Set([...registry.keys(), ...Object.keys(themeColors)]);
  for (const id of [...ids].sort()) {
    try {
      const c = color(id);
      if (c) out.set(id, toHex(c));
      else unset.add(id);
    } catch (err) {
      if (!(err instanceof Unresolved)) throw err;
      if (process.env.DEBUG) console.error(`${kind} ${id}: ${err.message}`);
      cache.set(id, undefined);
      unresolvedIds.add(id);
    }
  }
  return { colors: out, unset, unresolved: unresolvedIds };
}

class Unresolved extends Error {}

// ---------------------------------------------------------------- hand-filled (non-color) variables

const FONT_VARS: Record<string, string> = {
  "font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
  "font-size": "13px",
  "font-weight": "normal",
  "editor-font-family": "Menlo, Monaco, 'Courier New', monospace",
  "editor-font-size": "12px",
  "editor-font-weight": "normal",
  "chat-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
  "chat-font-size": "13px",
};

/** Non-color variables VS Code sets on editor/workbench DOM rather than via the color registry. */
const NON_COLOR_VARS: Record<string, string> = {
  "editorCodeLens-fontFamily": "Menlo, Monaco, 'Courier New', monospace",
  "editorCodeLens-fontFamilyDefault": "Menlo, Monaco, 'Courier New', monospace",
  "editorCodeLens-fontFeatureSettings": '"liga" off, "calt" off',
  "editorCodeLens-fontSize": "11px",
  "editorCodeLens-lineHeight": "15px",
  "parameterHintsWidget-editorFontFamily": "Menlo, Monaco, 'Courier New', monospace",
  "parameterHintsWidget-editorFontFamilyDefault": "Menlo, Monaco, 'Courier New', monospace",
  "editorStickyScroll-foldingOpacityTransition": "opacity 0.5s",
  "editorStickyScroll-scrollableWidth": "0px",
  "hover-maxWidth": "500px",
  "hover-whiteSpace": "normal",
  "hover-sourceWhiteSpace": "normal",
  "icon-x-content": "'\\ea76'",
  "icon-x-font-family": "codicon",
  "sash-size": "4px",
  "sash-hover-size": "4px",
};

/**
 * VS Code's terminal falls back to these colors in code (TerminalInstance's xterm theme), so it
 * never emits them as CSS variables. Speedy's xterm reads the variables, so fill them the same way.
 */
const TERMINAL_RUNTIME_FALLBACKS: Record<string, string> = {
  "terminal.background": "panel.background",
  "terminal.foreground": "foreground",
  "terminalCursor.foreground": "terminal.foreground",
  "terminalCursor.background": "terminal.background",
};

// ---------------------------------------------------------------- main

loadWorkbenchRegistry();
loadExtensionContributions();

const extensionCss = readFileSync(EXTENSION_CSS, "utf8");
const required = [...new Set([...extensionCss.matchAll(/var\(--vscode-([\w-]+)/g)].map((m) => m[1]))].sort();

const cssName = (id: string) => id.replace(/\./g, "-");

function build(kind: "dark" | "light", themeFile: string, title: string) {
  const themeColors = loadTheme(themeFile);
  const { colors, unset, unresolved } = resolveTheme(kind, themeColors);
  const vars = new Map<string, string>();
  for (const [k, v] of Object.entries(FONT_VARS)) vars.set(k, v);
  for (const [id, hex] of colors) vars.set(cssName(id), hex);
  const handFilled: string[] = [];
  for (const [id, from] of Object.entries(TERMINAL_RUNTIME_FALLBACKS)) {
    const value = vars.get(cssName(from));
    if (!vars.has(cssName(id)) && value) { vars.set(cssName(id), value); unset.delete(id); handFilled.push(`${cssName(id)} (= ${cssName(from)})`); }
  }
  for (const id of unset) if (!vars.has(cssName(id))) vars.set(cssName(id), "initial");

  for (const [k, v] of Object.entries(NON_COLOR_VARS)) if (!vars.has(k)) { vars.set(k, v); handFilled.push(k); }
  for (const id of unresolved) if (required.includes(cssName(id))) handFilled.push(`${cssName(id)} (UNRESOLVED COLOR)`);

  const missing = required.filter((n) => !vars.has(n));
  if (missing.length) throw new Error(`${title}: ${missing.length} extension variables undefined:\n  ${missing.join("\n  ")}`);

  const unsetRequired = required.filter((n) => vars.get(n) === "initial");
  const header = [
    `/* GENERATED by scripts/gen-vscode-theme.ts — do not edit by hand.`,
    ` * VS Code ${title} tokens as --vscode-* custom properties (KTD8).`,
    ` * Not a dump from a running webview: values are computed from the built-in theme JSON`,
    ` * (${themeFile}, include chain resolved) plus VS Code's color-registry defaults parsed from`,
    ` * the bundled workbench JS, using VS Code's color math.`,
    ` * \`initial\` = VS Code leaves this color undefined in this theme (behaves as unset).`,
    ` * Covers all ${required.length} --vscode-* names referenced by the Claude Code extension stylesheet.`,
    ` * Hand-filled (not from the color registry): ${[...Object.keys(FONT_VARS), ...handFilled].join(", ")}.`,
    ` * Extension variables VS Code leaves unset here: ${unsetRequired.join(", ") || "none"}. */`,
  ].join("\n");
  const body = [...vars].map(([k, v]) => `  --vscode-${k}: ${v};`).join("\n");
  const block =
    kind === "dark"
      ? `:root {\n  color-scheme: dark;\n${body}\n}\n`
      : `@media (prefers-color-scheme: light) {\n  :root {\n    color-scheme: light;\n${body.replace(/^/gm, "  ")}\n  }\n}\n`;
  writeFileSync(join(OUT_DIR, `vscode-${kind}-modern.css`), `${header}\n${block}`);
  return { count: vars.size, handFilled, unresolved: [...unresolved].filter((id) => required.includes(cssName(id))) };
}

const dark = build("dark", "dark_modern.json", "Dark Modern");
const light = build("light", "light_modern.json", "Light Modern");
writeFileSync(join(OUT_DIR, "extension-vars.json"), JSON.stringify(required, null, 2) + "\n");

console.log(`registry: ${registry.size} colors; extension references ${required.length} --vscode-* names`);
console.log(`dark: ${dark.count} vars; light: ${light.count} vars`);
console.log(`hand-filled: ${[...Object.keys(FONT_VARS), ...dark.handFilled].join(", ")}`);
console.log(`hand-filled (light): ${light.handFilled.join(", ")}`);
if (dark.unresolved.length || light.unresolved.length)
  console.log(`unresolved extension colors: dark=${dark.unresolved.join(",")} light=${light.unresolved.join(",")}`);
console.log(`coverage: all ${required.length} extension variables defined in both files`);
