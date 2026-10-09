// Pi adapter for the CLI host (CONTRACT.md "Adapters"). The in-process half is
// extension.js, loaded by Pi itself.
import { callPiModel } from './model.js';
import { readPiSession } from './transcript.js';

export default {
  name: 'pi',
  readTranscript: readPiSession,
  callModel: callPiModel,
};
