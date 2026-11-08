// Wires the Gemini + voice layer into the app: the client and tools log to the bus, the
// mission-control announcer speaks bay events through ElevenLabs, and the coworker fills
// the Mission pane. The design_sample tool runs the Fabricator.
import type { Sample } from '../contracts';
import { getBay } from '../app/runtime';
import { emitEr, log, onLog, recordGeminiCall, subscribe } from '../app/bus';
import { recordEgress } from '../app/egress';
import { erMarkerHook } from '../scene/erMarker';
import { registerSceneHook } from '../scene/registry';
import { registerMissionSlot } from '../ui/slots';
import { inContainment } from '../core';
import { designAndFabricate } from '../fabricator';
import { startAnnouncer } from '../voice';
import { configureGemini } from './client';
import { configureTools } from './tools';
import { CoworkerPanel } from './CoworkerPanel';
import type { LogSink } from './types';

const sink: LogSink = {
  log: (l) => log(l.kind, l.text, l.t),
  ledger: recordGeminiCall,
  egress: (rec) => recordEgress({ dest: rec.dest, kind: rec.kind, bytes: rec.bytes }),
  er: emitEr,
};
const stowed = (s: Sample) => !s.held && inContainment(s.pos[0], s.pos[1]);

configureGemini({ sink });
configureTools({ sink, fabricate: designAndFabricate, inContainment: stowed });
startAnnouncer(onLog, sink.log, sink.egress);
// point_at answers on the deck (the Bay pane's inset draws them too)
registerSceneHook(erMarkerHook((cb) => subscribe('er:point', cb)));

const bay = getBay();
registerMissionSlot('coworker', function Coworker() {
  // the app shows its own global Gemini ledger, so the panel's is left out
  return <CoworkerPanel bay={bay} sink={sink} fabricate={designAndFabricate} inContainment={stowed} showLedger={false} />;
});
