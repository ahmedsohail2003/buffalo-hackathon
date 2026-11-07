#!/usr/bin/env bash
# Speech smoke test with a real ElevenLabs key.
#   scripts/smoke-tts.sh [SERVER_URL]                       through the STARHAND server (default http://localhost:8787)
#   ELEVENLABS_API_KEY=... scripts/smoke-tts.sh --direct [VOICE_ID]   straight to ElevenLabs
# Writes the audio to $TMPDIR/starhand-smoke/ (raw PCM, plus WAV when ffmpeg is installed).
set -euo pipefail

OUT="${TMPDIR:-/tmp}/starhand-smoke"
mkdir -p "$OUT"
TEXT='Curation Bay 2, this is mission control. Radio check, one two three.'
FMT='HTTP %{http_code}, %{size_download} bytes, first byte after %{time_starttransfer} s, total %{time_total} s\n'

if [ "${1:-}" = "--direct" ]; then
  : "${ELEVENLABS_API_KEY:?set ELEVENLABS_API_KEY}"
  VOICE="${2:-${ELEVENLABS_VOICE_MISSION:-JBFqnCBsd6RMkjVDRZzb}}"
  echo "ElevenLabs direct, voice $VOICE"
  curl -sS -o "$OUT/tts.pcm" -D "$OUT/headers.txt" -w "$FMT" \
    -X POST "https://api.elevenlabs.io/v1/text-to-speech/$VOICE/stream?output_format=pcm_24000" \
    -H "xi-api-key: $ELEVENLABS_API_KEY" -H 'content-type: application/json' \
    -d "{\"text\":\"$TEXT\",\"model_id\":\"eleven_flash_v2_5\"}"
else
  URL="${1:-http://localhost:8787}"
  URL="${URL%/}"
  echo "Through the server: $URL"
  echo -n "health: "
  curl -sS "$URL/api/health"
  echo
  for VOICE in mission coworker; do
    curl -sS -o "$OUT/tts-$VOICE.pcm" -D "$OUT/headers.txt" -w "$VOICE: $FMT" \
      -X POST "$URL/api/tts" -H 'content-type: application/json' \
      -d "{\"text\":\"$TEXT\",\"voice\":\"$VOICE\"}"
    cp "$OUT/tts-$VOICE.pcm" "$OUT/tts.pcm"
    if ! grep -qi '^content-type: audio/pcm' "$OUT/headers.txt"; then
      echo "Not audio. The server said:"
      cat "$OUT/tts.pcm"
      echo
      exit 1
    fi
  done
fi

if ! grep -qi '^content-type: audio' "$OUT/headers.txt"; then
  echo "Not audio. ElevenLabs said:"
  cat "$OUT/tts.pcm"
  echo
  exit 1
fi
BYTES=$(wc -c < "$OUT/tts.pcm")
echo "audio: $(awk "BEGIN { printf \"%.2f\", $BYTES / 48000 }") s of 24 kHz mono PCM in $OUT"
if command -v ffmpeg >/dev/null; then
  for f in "$OUT"/tts*.pcm; do
    ffmpeg -loglevel error -y -f s16le -ar 24000 -ac 1 -i "$f" "${f%.pcm}.wav"
  done
  echo "WAV files: $(ls "$OUT"/*.wav | tr '\n' ' ')"
else
  echo "Install ffmpeg to get WAV files, or play the raw audio: ffplay -f s16le -ar 24000 -ac 1 $OUT/tts.pcm"
fi
