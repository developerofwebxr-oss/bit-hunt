// Self-contained Screen / VR / AR switcher. Shows all three controls on every
// device; greys out + tooltips the unsupported ones. Drives session enter/exit
// off the REAL session events so the app never gets stuck after the user exits
// via a system gesture.
export function createModeSwitcher({ renderer, onModeChange } = {}) {
  const btnScreen = document.getElementById('btn-screen');
  const btnVR = document.getElementById('btn-vr');
  const btnAR = document.getElementById('btn-ar');
  const modeLabel = document.getElementById('mode-label');
  const statusEl = document.getElementById('status');

  let currentSession = null;

  const setStatus = (t) => statusEl && (statusEl.textContent = t);
  const setMode = (m) => {
    if (modeLabel) modeLabel.textContent = m;
    btnScreen.classList.toggle('active', m === 'Screen');
    btnVR.classList.toggle('active', m === 'VR');
    btnAR.classList.toggle('active', m === 'AR');
    onModeChange?.(m);
  };

  // ---- capability detection ----
  async function detect() {
    const xr = navigator.xr;
    const vrOK = xr ? await xr.isSessionSupported('immersive-vr').catch(() => false) : false;
    const arOK = xr ? await xr.isSessionSupported('immersive-ar').catch(() => false) : false;
    if (!vrOK) {
      btnVR.disabled = true;
      btnVR.dataset.tip = xr ? 'VR not available on this device' : 'WebXR needs HTTPS + a headset';
    }
    if (!arOK) {
      btnAR.disabled = true;
      btnAR.dataset.tip = xr ? 'AR passthrough not available here' : 'WebXR needs HTTPS + AR device';
    }
    return { vrOK, arOK };
  }

  // ---- session lifecycle ----
  async function enter(type) {
    const sessionInit = type === 'immersive-ar'
      ? { requiredFeatures: ['local-floor'], optionalFeatures: ['dom-overlay', 'hit-test'], domOverlay: { root: document.getElementById('hud') } }
      : { requiredFeatures: ['local-floor'], optionalFeatures: ['bounded-floor'] };
    try {
      const session = await navigator.xr.requestSession(type, sessionInit);
      currentSession = session;
      await renderer.xr.setSession(session);
      document.body.classList.add('xr-active');
      setMode(type === 'immersive-ar' ? 'AR' : 'VR');
      (type === 'immersive-ar' ? btnAR : btnVR).textContent = type === 'immersive-ar' ? 'Exit AR' : 'Exit VR';
      session.addEventListener('end', onSessionEnd);
    } catch (err) {
      // surface the failure — otherwise the button silently "does nothing"
      setStatus(`Could not enter ${type === 'immersive-ar' ? 'AR' : 'VR'}: ${err.message || err}`);
      console.error('[xr] requestSession failed', err);
    }
  }

  function onSessionEnd() {
    currentSession?.removeEventListener('end', onSessionEnd);
    currentSession = null;
    document.body.classList.remove('xr-active');
    btnVR.textContent = 'Enter VR';
    btnAR.textContent = 'Enter AR';
    setMode('Screen');
    setStatus('flat mode');
  }

  btnScreen.addEventListener('click', () => {
    if (currentSession) currentSession.end(); else setMode('Screen');
  });
  btnVR.addEventListener('click', () => {
    if (btnVR.disabled) return;
    if (currentSession) currentSession.end(); else enter('immersive-vr');
  });
  btnAR.addEventListener('click', () => {
    if (btnAR.disabled) return;
    if (currentSession) currentSession.end(); else enter('immersive-ar');
  });

  // also catch exits routed through the renderer
  renderer.xr.addEventListener('sessionend', () => { if (!currentSession) onSessionEnd(); });

  setMode('Screen');
  return { detect, setStatus, isInSession: () => !!currentSession };
}
