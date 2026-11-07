import { useEffect, useRef } from 'react';

interface AboutPanelProps {
  onClose: () => void;
}

const FOCUSABLE =
  'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AboutPanel({ onClose }: AboutPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Tab focus trap: while the dialog is open, Tab cycles within it, and focus
  // returns to wherever it was when the dialog closes. Esc is handled at the
  // app level.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div
      className="about-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="about"
        role="dialog"
        aria-modal="true"
        aria-label="About this study"
        ref={panelRef}
      >
        <header>
          <h2>HandSignal — about this study</h2>
          <div className="spacer" />
          <button type="button" onClick={onClose} autoFocus>
            Close
          </button>
        </header>

        <section>
          <h3>Research question</h3>
          <p>
            Can a standardized industrial hand-signal vocabulary serve as a
            reliable, learnable command channel for cobot cells, and what
            dwell time best trades false activations against responsiveness?
          </p>
        </section>

        <section>
          <h3>Why crane signals</h3>
          <p>
            Signalperson hand signals (ASME B30.5) are a real, learned,
            safety-critical gesture language already used on industrial
            floors. That matters for three reasons: many operators arrive with
            pre-existing floor literacy in the vocabulary; gestures need no
            wake word and work at a distance; and they survive environments
            where hands are busy, gloves are on, and hearing protection makes
            voice unreliable.
          </p>
        </section>

        <section>
          <h3>Honest adaptation note</h3>
          <p>
            This prototype recognizes MediaPipe&apos;s canonical single-hand
            static poses, which constrains the vocabulary. Only the open-palm
            STOP closely matches its crane counterpart. The other four
            mappings are adaptations of the crane vocabulary&apos;s semantics
            to camera-recognizable poses, and they are labeled as adaptations
            in the legend: closed fist held 1.5 s adapts &quot;dog
            everything&quot; to an emergency stop; index-up adapts the
            &quot;move slowly&quot; modifier; thumb-up and the V sign have no
            B30.5 equivalent. A production system would train recognizers on
            the actual dynamic B30.5 signals.
          </p>
        </section>

        <section>
          <h3>Interaction safeguards</h3>
          <ul>
            <li>
              Debounce (120 ms) filters classifier flicker before a gesture is
              treated as a candidate.
            </li>
            <li>
              Dwell-time arming (default 600 ms, adjustable 300–1200 ms) shows
              a filling ring, so a command is a deliberate hold, never a
              passing pose. The dwell slider exists precisely because the
              study&apos;s core question is where this parameter should sit.
            </li>
            <li>
              Emergency stop requires a longer 1.5 s hold: a false e-stop
              halts production, so it must cost more intent.
            </li>
            <li>
              After a command fires, the same gesture cannot fire again until
              it has been released and its refractory period has elapsed —
              no machine-gun re-fires — while a different gesture (for
              example STOP) can always interrupt immediately.
            </li>
            <li>
              E-stop recovery is deliberately not gesture-driven: an
              on-screen two-step reset returns the cell only to IDLE.
            </li>
          </ul>
        </section>

        <section>
          <h3>What is simulated</h3>
          <ul>
            <li>
              The work cell is a 3D kinematic model of an SO-ARM100 (MuJoCo
              Menagerie meshes, browser FK/IK validated against MuJoCo
              fixtures), not a physical or physics-simulated robot. Parts
              snap to the gripper when the jaw closes within 15 mm of them.
            </li>
            <li>
              Gemini is in the loop: Gemini Live is the voice, Gemini
              Robotics-ER points, plans and verifies on rendered cell-camera
              frames, Gemini Flash is the typed coworker. Code validates every
              tool call (size, reach, cell state) before anything moves.
            </li>
            <li>
              Simulated-input mode injects synthetic gesture classifications
              from keys 1–5 with an adjustable synthetic confidence. It is
              labeled in the UI, and every downstream stage — state machine,
              cell commands, logging — is identical for real and simulated
              input.
            </li>
            <li>
              Gesture recognition stays on-device (MediaPipe). While a voice
              session is connected and TALK is held, microphone audio streams
              to Gemini Live; rendered cell-camera frames go to Gemini
              Robotics-ER during tasks. Webcam frames never leave this
              machine in this build. Nothing is recorded by this app. The
              counters in the top bar show exactly what has left this machine.
            </li>
          </ul>
        </section>

        <section>
          <h3>Evaluation status</h3>
          <p>
            <span className="status-tag">[Evaluation designed; sessions pending]</span>{' '}
            <span className="dim">
              The session log (raw detections, armed events, fired commands,
              false starts, dwell-to-fire latency) defines the dependent
              measures for a within-subjects dwell-time study. No participant
              data has been collected; nothing shown here is a study result.
            </span>
          </p>
        </section>
      </div>
    </div>
  );
}
