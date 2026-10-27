import { runSuite } from '../../src/evaluation/run.ts';
import { SUITES } from '../../src/evaluation/suites.ts';
import { SimulatedProvider } from '../../src/investigation/simulated-provider.ts';

/**
 * Prints two real evaluation documents (scripted and simulated, development suite) as JSON. The
 * console's tests read them: the jsdom environment cannot load the node-only evaluation modules,
 * so a child process runs the real harness and hands over its output.
 */
const dev = SUITES[0];
if (!dev) throw new Error('no suite');
let t = 0;
const base = { clock: () => (t += 3), now: () => new Date('2026-10-27T12:00:00Z') };
const scripted = await runSuite(dev, {
  ...base,
  provider: { kind: 'scripted' },
  id: '20261027T120000Z-development-scripted',
});
const simulated = await runSuite(dev, {
  ...base,
  provider: { kind: 'simulated', provider: new SimulatedProvider() },
  id: '20261027T120100Z-development-simulated',
});
process.stdout.write(JSON.stringify({ scripted, simulated }));
