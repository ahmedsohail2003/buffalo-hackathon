// One-call wiring for mission control's voice. Pass the bus subscription and, optionally, a
// logger for the spoken lines:
//   startAnnouncer(bus.onLog, (l) => bus.log(l.kind, l.text, l.t), recordEgress)
import type { LogLine } from '../contracts';
import type { EgressNote, LogSource } from '../gemini/types';
import { Announcer } from './announcer';
import { getSpeaker } from './elevenSpeaker';
import { playSfx } from './sfx';
import { getServerHealth } from '../gemini/health';

export function startAnnouncer(source: LogSource, log?: (line: LogLine) => void, egress?: (rec: EgressNote) => void): Announcer {
  const speaker = getSpeaker();
  if (log && !speaker.onError) speaker.onError = (message) => log({ t: Date.now(), kind: 'voice', text: message });
  if (egress && !speaker.onEgress) speaker.onEgress = (chars) => egress({ dest: 'elevenlabs', kind: 'text', bytes: chars, note: 'speech' });
  const announcer = new Announcer({
    speaker,
    onSpoken: (c) => {
      if (c.priority === 'estop') playSfx('estop');
      log?.({ t: Date.now(), kind: 'voice', text: c.text });
    },
  });
  announcer.attach(source);
  // No speech requests until the server says ElevenLabs is configured (no failing calls in local dev);
  // re-check every 30 s so starting the server mid-session brings the voice back.
  speaker.markOffline();
  let said = false;
  const check = () =>
    void getServerHealth({ refresh: true }).then((h) => {
      if (h.elevenlabs) {
        if (speaker.broken) speaker.repair();
      } else {
        speaker.markOffline();
        if (!said && log) log({ t: Date.now(), kind: 'voice', text: 'Mission-control voice offline: start the server with an ElevenLabs key (npm run server). Events still show here.' });
        said = true;
      }
    });
  check();
  if (typeof setInterval !== 'undefined') setInterval(check, 30_000);
  return announcer;
}

export { Announcer, calloutFor } from './announcer';
export { ElevenSpeaker, getSpeaker, type SpeakerLike, type VoiceName } from './elevenSpeaker';
export { playSfx, preloadSfx, setSfxMuted, startAmbience, type SfxName } from './sfx';
