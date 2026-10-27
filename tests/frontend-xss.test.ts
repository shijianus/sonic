// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { escapeHtmlAttribute } from '../player/src/utils/escapeHtml';

function findRepoRoot(start: string): string {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'js', 'playlist-view.js'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Unable to locate repository root');
    dir = parent;
  }
}

const repoRoot = findRepoRoot(process.cwd());
const playlistViewSource = readFileSync(join(repoRoot, 'js', 'playlist-view.js'), 'utf8');
const legacyAppSource = readFileSync(join(repoRoot, 'js', 'index.js'), 'utf8');
const heroCardSource = readFileSync(
  join(repoRoot, 'player', 'src', 'components', 'Ui', 'HeroCard.vue'),
  'utf8',
);
const mvCardSource = readFileSync(
  join(repoRoot, 'player', 'src', 'components', 'Ui', 'MVCard.vue'),
  'utf8',
);
const deployedHeaders = readFileSync(join(repoRoot, 'player', 'public', '_headers'), 'utf8');

function loadPlaylistView(): any {
  new Function(playlistViewSource)();
  return (window as any).SonicPlaylistView;
}

const NAME_PAYLOAD = '<img src=x onerror="window.__xss=1">';
const ARTIST_PAYLOAD = 'Evil" onclick="window.__xss=2';

describe('Third-party metadata is never parsed as HTML', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (window as any).__xss = 0;
  });

  it('renders hostile track names as text nodes', () => {
    const view = loadPlaylistView();
    const item = view.createPlaylistItem(
      { name: NAME_PAYLOAD, artist: ARTIST_PAYLOAD, id: '1' },
      0,
    );

    expect(item.querySelector('img')).toBeNull();
    expect(item.querySelector('script')).toBeNull();
    expect(item.querySelectorAll('button')).toHaveLength(2);
    expect(item.textContent).toContain(NAME_PAYLOAD);
    expect(item.textContent).toContain(ARTIST_PAYLOAD);
    expect(item.getAttribute('aria-label')).toBe(`播放 ${NAME_PAYLOAD}`);
  });

  it('keeps action wiring attributes intact', () => {
    const view = loadPlaylistView();
    const item = view.createPlaylistItem({ name: 'Song', artist: ['A', 'B'] }, 7);

    expect(item.dataset.index).toBe('7');
    expect(item.textContent).toContain('Song - A, B');

    const remove = item.querySelector('.playlist-item-remove') as HTMLElement;
    const download = item.querySelector('.playlist-item-download') as HTMLElement;
    expect(remove.dataset.playlistAction).toBe('remove');
    expect(remove.dataset.index).toBe('7');
    expect(download.dataset.playlistAction).toBe('download');
    expect(download.dataset.index).toBe('7');
  });

  it('renders a full playlist without injecting nodes', () => {
    const view = loadPlaylistView();
    const container = document.createElement('div');
    view.renderInto(container, [
      { name: NAME_PAYLOAD, artist: ARTIST_PAYLOAD },
      { name: 'Safe', artist: 'Artist' },
    ]);

    expect(container.querySelectorAll('.playlist-item')).toHaveLength(2);
    expect(container.querySelectorAll('img, script, iframe')).toHaveLength(0);
    expect(container.textContent).toContain(NAME_PAYLOAD);
    expect((window as any).__xss).toBe(0);
  });

  it('escapes cover URLs before attribute interpolation', () => {
    expect(escapeHtmlAttribute('https://cdn.example/a.jpg" onerror="alert(1)')).toBe(
      'https://cdn.example/a.jpg&quot; onerror=&quot;alert(1)',
    );
    expect(escapeHtmlAttribute('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtmlAttribute("a&b'c")).toBe('a&amp;b&#39;c');
    expect(escapeHtmlAttribute(null)).toBe('');
  });

  it('keeps the legacy app and Vue cards on the escaped code path', () => {
    expect(legacyAppSource).toContain('SonicPlaylistView.renderInto');
    expect(legacyAppSource).not.toContain('dom.playlistItems.innerHTML = playlistHtml');
    expect(heroCardSource).toMatch(/const cleanCover = escapeHtmlAttribute\(formatCoverUrl\(/);
    expect(mvCardSource).toMatch(/const cleanCover = escapeHtmlAttribute\(/);
    expect(mvCardSource).not.toMatch(/const cleanCover = formatCoverUrl\(/);
  });

  it('ships baseline anti-sniffing and anti-framing headers', () => {
    expect(deployedHeaders).toMatch(/X-Content-Type-Options:\s*nosniff/i);
    expect(deployedHeaders).toMatch(/X-Frame-Options:\s*DENY/i);
    expect(deployedHeaders).toMatch(/frame-ancestors 'none'/);
  });
});
