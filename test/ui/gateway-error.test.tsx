// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createHttpSource } from '../../src/ui/data/http-source.ts';
import { renderAt } from './support.tsx';

describe('the console when the application is not running behind the dev proxy', () => {
  it('shows a clear error with a retry, never an empty or successful list', async () => {
    // The dev proxy's answer when nothing listens: 502, text/plain, empty body.
    const gateway = vi.fn(() =>
      Promise.resolve(new Response('', { status: 502, headers: { 'content-type': 'text/plain' } })),
    );
    renderAt('#/', createHttpSource(gateway));
    const alert = await screen.findByText(/The local application is not reachable \(HTTP 502\)/);
    expect(alert.textContent).toContain('pnpm serve');
    expect(screen.queryByText('No investigations yet')).toBeNull();
    expect(screen.queryByText(/unreadable response/)).toBeNull();
    // Retry asks again, and a running application then answers.
    gateway.mockImplementation(() => Promise.resolve(new Response('{"runs":[]}')));
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('No investigations yet')).toBeDefined();
    expect(gateway).toHaveBeenCalledTimes(2);
  });
});
