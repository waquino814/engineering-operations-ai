import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ui = (name: string) => new URL(`../../src/ui/${name}`, import.meta.url);

/** The console is served by the application with `default-src 'self'`: no data: URLs. */
describe('the console page', () => {
  it('links an icon file that exists, so browsers do not request /favicon.ico', () => {
    const html = readFileSync(ui('index.html'), 'utf8');
    const href = /<link rel="icon"[^>]* href="\.\/([^"]+)"/.exec(html)?.[1];
    expect(href).toBe('favicon.svg');
    expect(existsSync(ui(`public/${href ?? ''}`))).toBe(true);
  });

  it('wraps unbreakable text such as hashes in table cells instead of clipping it', () => {
    const css = readFileSync(ui('styles.css'), 'utf8');
    const rule = /\.cell-wrap\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(/\.table td \.tag\s*\{[^}]*white-space: normal/.test(css)).toBe(true);
  });

  it('keeps the narrow-screen nav strip at its content height on a short page', () => {
    const css = readFileSync(ui('styles.css'), 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 960px)'));
    expect(/\.shell\s*\{[^}]*grid-template-rows: auto 1fr/.test(narrow)).toBe(true);
  });
});
