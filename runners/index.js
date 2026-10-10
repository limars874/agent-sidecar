// Runner registry：runner 负责一次性模型调用，和 agent adapter 的 transcript 读取相互独立。
import jcode from './jcode.js';
import pi from './pi.js';

export const DEFAULT_RUNNER = 'pi';
export const RUNNERS = { pi, jcode };

export function resolveRunnerName(item, config) {
  return item.runner ?? config.runner ?? DEFAULT_RUNNER;
}

export function getRunner(name) {
  const runner = RUNNERS[name];
  if (!runner) throw new Error(`unknown runner "${name}" (known: ${Object.keys(RUNNERS).join(', ')})`);
  return runner;
}
