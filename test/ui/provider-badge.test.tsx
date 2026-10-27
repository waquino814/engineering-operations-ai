// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderBadge } from '../../src/ui/components.tsx';

afterEach(cleanup);

/** A run says who produced it: simulation and a real local model can never be confused. */
describe('the provider badge', () => {
  it('labels the fake provider as a simulation', () => {
    render(<ProviderBadge provider="fake" model="simulated-deterministic-v1" />);
    const badge = screen.getByText('Simulated · simulated-deterministic-v1');
    expect(badge.className).toContain('tag--simulated');
    expect(badge.getAttribute('title')).toContain('not AI-generated');
  });

  it('names Ollama and the model, as local', () => {
    render(<ProviderBadge provider="ollama" model="gemma4:12b" />);
    const badge = screen.getByText('Ollama · gemma4:12b · local');
    expect(badge.className).toContain('tag--local');
    expect(screen.queryByText(/Simulated/)).toBeNull();
  });

  it('shows any other provider plainly, never as simulated or local', () => {
    render(<ProviderBadge provider="other" model="m" />);
    expect(screen.getByText('other · m').className).toBe('tag');
  });
});
