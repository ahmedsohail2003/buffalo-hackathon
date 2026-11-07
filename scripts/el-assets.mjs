// One-off ElevenLabs asset generation (Node 22, no dependencies). The key comes from the
// environment and is never written anywhere.
//
//   node scripts/el-assets.mjs sfx                         public/sfx/*.mp3 (sound generation)
//   node scripts/el-assets.mjs voice mission|coworker      three previews in private/ + their generated ids
//   node scripts/el-assets.mjs save mission|coworker ID    saves a preview as a voice, prints the env line
//
// Env: ELEVENLABS_API_KEY (required), ELEVENLABS_BASE (default https://api.elevenlabs.io),
//      SFX_DIR (default public/sfx), PREVIEW_DIR (default private).
// Sound generation is billed per second of audio: the full set below is about 45 s.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.ELEVENLABS_API_KEY;
const BASE = (process.env.ELEVENLABS_BASE ?? 'https://api.elevenlabs.io').replace(/\/+$/, '');
const SFX_DIR = process.env.SFX_DIR ?? 'public/sfx';
const PREVIEW_DIR = process.env.PREVIEW_DIR ?? 'private'; // git-ignored

/** One file per cue in src/voice/sfx.ts, plus the ambience loop. */
const SFX = {
  ambience: { text: 'Deep space station control room ambience: low reactor hum, soft air circulation, faint distant telemetry beeps, no voices', duration_seconds: 30, loop: true },
  'task-start': { text: 'Short futuristic interface confirmation chirp, two rising synth notes, clean and dry', duration_seconds: 0.8 },
  'task-done': { text: 'Soft bright sci-fi success chime, mission accomplished, clean', duration_seconds: 1.2 },
  estop: { text: 'Spacecraft emergency alarm klaxon, two-tone, urgent, dry, no voice', duration_seconds: 2 },
  materialize: { text: 'Sci-fi fabricator materialize shimmer with a soft rising whoosh', duration_seconds: 1.5 },
  blip: { text: 'Tiny soft interface blip, a single short electronic tick', duration_seconds: 0.5 },
  reject: { text: 'Low soft two-note denial buzz from a spacecraft console, short', duration_seconds: 0.7 },
  'talk-on': { text: 'Radio push-to-talk key-up click with a tiny burst of static', duration_seconds: 0.5 },
  'talk-off': { text: 'Radio push-to-talk release click with a short squelch tail', duration_seconds: 0.5 },
};

const VOICES = {
  mission: {
    name: 'STARHAND Flight Director',
    description:
      'Calm, authoritative American flight director in his fifties at mission control. Low warm voice, measured pace, crisp diction, steady and reassuring under pressure, close-mic radio delivery.',
  },
  coworker: {
    name: 'STARHAND CAPCOM',
    description:
      'Composed American capsule communicator in her thirties. Clear mid-range voice, brisk but unhurried, precise with numbers and units, friendly and professional over a mission radio loop.',
  },
};

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'xi-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

function usage() {
  console.log('usage: node scripts/el-assets.mjs sfx | voice mission|coworker | save mission|coworker GENERATED_VOICE_ID');
  process.exit(1);
}

const [cmd, role, id] = process.argv.slice(2);
if (!cmd) usage();
if (!KEY) {
  console.error('Set ELEVENLABS_API_KEY first.');
  process.exit(1);
}

if (cmd === 'sfx') {
  await mkdir(SFX_DIR, { recursive: true });
  for (const [name, spec] of Object.entries(SFX)) {
    const r = await post('/v1/sound-generation?output_format=mp3_44100_64', { model_id: 'eleven_text_to_sound_v3', prompt_influence: 0.4, ...spec });
    const buf = Buffer.from(await r.arrayBuffer());
    const file = join(SFX_DIR, `${name}.mp3`);
    await writeFile(file, buf);
    console.log(`${file}  ${buf.length} bytes`);
  }
} else if (cmd === 'voice' && VOICES[role]) {
  const d = await (await post('/v1/text-to-voice/design', { model_id: 'eleven_ttv_v3', auto_generate_text: true, voice_description: VOICES[role].description })).json();
  await mkdir(PREVIEW_DIR, { recursive: true });
  for (const [i, p] of (d.previews ?? []).entries()) {
    const file = join(PREVIEW_DIR, `voice-${role}-${i}.mp3`);
    await writeFile(file, Buffer.from(p.audio_base_64, 'base64'));
    console.log(`${file}  generated_voice_id=${p.generated_voice_id}`);
  }
  console.log(`Listen, then: node scripts/el-assets.mjs save ${role} GENERATED_VOICE_ID`);
} else if (cmd === 'save' && VOICES[role] && id) {
  const v = await (await post('/v1/text-to-voice', { voice_name: VOICES[role].name, voice_description: VOICES[role].description, generated_voice_id: id })).json();
  console.log(`ELEVENLABS_VOICE_${role.toUpperCase()}=${v.voice_id}`);
} else {
  usage();
}
