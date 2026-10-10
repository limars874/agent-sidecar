// Pi adapter for the CLI host（见 CONTRACT.md「Adapters」）。进程内部分由 Pi 加载
// `extension.js`；模型调用归属于独立的 `runners/pi.js`。
import { readPiSession } from './transcript.js';

export default {
  name: 'pi',
  readTranscript: readPiSession,
};
