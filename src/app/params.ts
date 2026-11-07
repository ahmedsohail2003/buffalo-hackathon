// URL switches: ?sim=1 forces simulated hand input (no camera prompt), ?present=1 is projector mode.
const query = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);

const flag = (name: string) => {
  const v = query.get(name);
  return v === '1' || v === 'true' || v === '';
};

export const PARAMS = {
  sim: flag('sim'),
  present: flag('present'),
} as const;
