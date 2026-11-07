// Integration point: each layer's install module is imported here once, one import per line,
// so merging a layer in is a one-line change. An install module registers its pieces through
// src/app/runtime.ts (registerTickHook, setSafetyLabelFilter), src/scene/registry.ts
// (registerSampleGeometry, registerSceneHook) and src/ui/slots.ts (registerMissionSlot,
// registerHandPaneExtra, registerTeleopController).
import './gemini/install';
import './fabricator/install';
import './teleop/install';

export {};
