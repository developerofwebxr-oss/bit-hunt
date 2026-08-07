// Comfort settings — ALL OFF by default (per the webxr-threejs Controller &
// Input Standard: "don't nanny"). Opt-in via the X pause menu, persisted to
// localStorage. Movement speeds are FIXED, not a toggle.
const KEY = 'bit-hunt.comfort.v1';

const DEFAULTS = {
  vignette: false, // tunnel-vignette while moving/flying
  snapTurn: false, // right-stick turn becomes fixed snaps instead of smooth
  haptics: false,  // controller pulse on fire / grab / jump-land
  sound: true,     // scanner Geiger ticks — core feedback, so default ON (not a nanny toggle)
};

// Fixed locomotion speeds (shared source of truth; NOT user-tunable).
export const SPEED = { walk: 1.4, run: 2.8 };
export const SNAP_TURN_DEG = 45;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

const state = load();
const listeners = new Set();

export const comfort = {
  get(key) { return state[key]; },
  all() { return { ...state }; },
  set(key, value) {
    if (!(key in DEFAULTS)) return;
    state[key] = !!value;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
    listeners.forEach((fn) => fn(state));
  },
  toggle(key) { this.set(key, !state[key]); return state[key]; },
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
