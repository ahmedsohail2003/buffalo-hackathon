# Third-party licences

| Component | Where | Licence |
| --- | --- | --- |
| SO-ARM100 meshes, joint data and keyframes (MuJoCo Menagerie `trs_so_arm100`, The Robot Studio) | `public/arm-data.json` (quantized meshes vendored via the portfolio work-cell page) | Apache-2.0 |
| three.js 0.186 | `node_modules/three` | MIT |
| MediaPipe Tasks Vision (GestureRecognizer runtime + hosted model) | `@mediapipe/tasks-vision`, model fetched from the official CDN on opt-in | Apache-2.0 |
| React 18 / react-dom | `node_modules/react` | MIT |
| @google/genai 2.23 (Gemini API SDK, web build) | `node_modules/@google/genai` | Apache-2.0 |
| Vite 5, vitest 2, TypeScript 5 | dev dependencies | MIT / MIT / Apache-2.0 |
| Inter, JetBrains Mono (self-hosted variable fonts) | `public/fonts/` | SIL Open Font License 1.1 |
| HandSignal (gesture safety channel, cell state model, telemetry, guided demo) | this repository, commit 0 | MIT (same author) |

MuJoCo fixtures in `tests/fixtures/` were generated offline with MuJoCo 3.10
(Apache-2.0) from the Menagerie model; only the resulting numbers are
vendored.
