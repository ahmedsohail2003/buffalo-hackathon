// Wires the Fabricator into the app: the scene draws mesh samples with its geometry, the Mission
// pane gets the Fabricator panel (Gemini designs; presets work offline), and the bay opens with
// two real NASA shape models on the deck.
import type { LogKind } from '../app/bus';
import { log } from '../app/bus';
import { getBay } from '../app/runtime';
import { generateJson } from '../gemini/client';
import { registerSampleGeometry } from '../scene/registry';
import { registerMissionSlot } from '../ui/slots';
import { FabricatorPanel } from './FabricatorPanel';
import { fabricatePreset, geometryForSample, materialForSample } from '.';

const fabLog = (text: string, kind?: string) => log((kind === 'reject' ? 'reject' : 'fabricator') as LogKind, text);

registerSampleGeometry(geometryForSample, materialForSample);

const bay = getBay();
registerMissionSlot('fabricator', function Fabricator() {
  return <FabricatorPanel bay={bay} generateJson={generateJson} log={fabLog} />;
});

void (async () => {
  for (const id of ['nasa_bennu', 'nasa_itokawa']) {
    const r = await fabricatePreset(bay, id);
    if (!r.ok) fabLog(`could not seed ${id}: ${r.reason}`, 'reject');
  }
})();
