// Controller haptics — opt-in (comfort.haptics). No-op outside an XR session or
// when the actuator isn't available, so callers don't need to guard.
import { comfort } from './comfort.js';

// hand: 'left' | 'right' | undefined (both). intensity 0..1, duration ms.
export function hapticPulse(renderer, { hand, intensity = 0.4, duration = 40 } = {}) {
  if (!comfort.get('haptics')) return;
  const session = renderer?.xr?.getSession?.();
  if (!session) return;
  for (const src of session.inputSources) {
    if (hand && src.handedness !== hand) continue;
    const act = src.gamepad?.hapticActuators?.[0];
    if (act?.pulse) { try { act.pulse(intensity, duration); } catch {} }
  }
}
