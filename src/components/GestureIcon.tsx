// Line-style hand glyphs for the five vocabulary gestures, used on the
// simulated-input keypad. Schematic stand-ins (like the canvas hand), not
// photographic imagery; stroke color inherits from the surrounding text.

import type { ReactElement } from 'react';
import type { GestureLabel } from '../gesture/stateMachine';

const PATHS: Record<GestureLabel, ReactElement> = {
  Open_Palm: (
    <>
      <rect x="8" y="12" width="9" height="8" rx="2.5" />
      <path d="M9.5 12 9 6" />
      <path d="M11.8 12 11.6 4.5" />
      <path d="M14 12 14.2 5" />
      <path d="M16.2 12 16.6 6.5" />
      <path d="M8 14.5 4.5 11" />
    </>
  ),
  Closed_Fist: (
    <>
      <rect x="7" y="8.5" width="10.5" height="9.5" rx="3" />
      <path d="M10 8.5 10 11" />
      <path d="M12.4 8.5 12.4 11" />
      <path d="M14.8 8.5 14.8 11" />
      <path d="M7.6 15 15 16.2" />
    </>
  ),
  Thumb_Up: (
    <>
      <rect x="9" y="10.5" width="9" height="8" rx="2.5" />
      <path d="M9 12.5 C7 12.5 6.6 11 6.6 9.5 L6.6 4.8" />
      <path d="M12 10.5 12 13" />
      <path d="M14.8 10.5 14.8 13" />
    </>
  ),
  Pointing_Up: (
    <>
      <rect x="8" y="11" width="9.5" height="8" rx="2.5" />
      <path d="M10.6 11 10.6 4" />
      <path d="M13.4 11 13.4 13.6" />
      <path d="M15.8 11 15.8 13.6" />
      <path d="M8.5 15.4 14.4 16.4" />
    </>
  ),
  Victory: (
    <>
      <rect x="8.6" y="13" width="7.6" height="7" rx="2.4" />
      <path d="M10.8 13 8 4.6" />
      <path d="M13.6 13 16.6 4.6" />
      <path d="M9 16.4 13.6 17.2" />
    </>
  ),
};

export function GestureIcon({
  label,
  size = 26,
}: {
  label: GestureLabel;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[label]}
    </svg>
  );
}
