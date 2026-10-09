// Adapter registry. A new agent adds one entry here plus its own directory.
import pi from './pi/index.js';

export const ADAPTERS = { pi };

export function getAdapter(name) {
  const adapter = ADAPTERS[name];
  if (!adapter) throw new Error(`unknown agent "${name}" (known: ${Object.keys(ADAPTERS).join(', ')})`);
  return adapter;
}
