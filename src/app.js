/* ScreenLink UI controller: home / sharing host / guest viewer. */
(function () {
  'use strict';

  const Bridge = window.Bridge;
  const { Relay, RtcSession, sha256, randomDigits, randomPassword, formatId, digitsOnly } = window.Net;

  const $ = (id) => document.getElementById(id);

  const els = {
    screens: Array.from(document.querySelectorAll('.screen')),
    relayChip: $('relay-chip'),
    relaySummary: $('relay-summary'),
    // host
    sourceList: $('source-list'),
    audioRow: $('audio-row'),
    shareAudio: $('share-audio'),
    shareSetup: $('share-setup'),
    shareLive: $('share-live'),
    startShare: $('btn-start-share'),
    stopShare: $('btn-stop-share'),
    myId: $('my-id'),
    myPass: $('my-pass'),
    copyId: $('btn-copy-id'),
    copyPass: $('btn-copy-pass'),
    newPass: $('btn-new-pass'),
    hostStatus: $('host-status'),
    hostStats: $('host-stats'),
    previewWrap: document.querySelector('.preview-wrap'),
    previewVideo: $('preview-video'),
    controlBar: $('host-control-bar'),
    controlText: $('host-control-text'),
    revoke: $('btn-revoke'),
    // viewer
    viewForm: $('view-form'),
    viewId: $('view-id'),
    viewPass: $('view-pass'),
    viewConnect: $('view-connect-btn'),
    viewStage: $('view-stage'),
    stageVideo: $('stage-video'),
    remoteVideo: $('remote-video'),
    overlay: $('stage-overlay'),
    overlayText: $('stage-overlay-text'),
    remoteDot: $('remote-dot'),
    remoteStatus: $('remote-status'),
    viewStats: $('view-stats'),
    requestControl: $('btn-request-control'),
    clipSend: $('btn-clip-send'),
    fullscreen: $('btn-fullscreen'),
    disconnect: $('btn-disconnect'),
    controlNote: $('control-note'),
    // settings
    settingsModal: $('settings-modal'),
    relayInput: $('relay-input'),
    turnInput: $('turn-input'),
    nameInput: $('display-name'),
    settingsSave: $('settings-save'),
    settingsCancel: $('settings-cancel'),
    // control prompt
    controlModal: $('control-modal'),
    controlModalText: $('control-modal-text'),
    controlAllow: $('control-allow'),
    controlDeny: $('control-deny'),
    toasts: $('toasts'),
  };

  const state = {
    settings: { relay: '', name: '', turn: '' },
    screen: 'home',
    statsTimer: null,
    canInject: false,
    host: {
      active: false,
      stream: null,
      source: null,
      displayId: '',
      id: null,
      pass: null,
      secret: null,
      relay: null,
      rtc: null,
      allowed: false,
      peerName: '',
    },
    view: {
      active: false,
      id: null,
      relay: null,
      rtc: null,
      keys: null,
      controlling: false,
      pointer: { x: 0, y: 0, dirty: false, raf: 0 },
      buttons: new Set(),
    },
  };

  /* ------------------------------------------------------------------ */
  /* tiny ui helpers                                                    */
  /* ------------------------------------------------------------------ */

  function show(name) {
    state.screen = name;
    for (const s of els.screens) s.classList.toggle('active', s.id === `screen-${name}`);
  }

  function toast(message, kind) {
    const node = document.createElement('div');
    node.className = `toast ${kind || ''}`;
    node.textContent = message;
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translateY(6px)';
      node.style.transition = '.2s';
      setTimeout(() => node.remove(), 220);
    }, kind === 'error' ? 5200 : 3400);
  }

  async function copyText(text, label) {
    const ok = await Bridge.clipboard.write(text);
    if (ok) toast(`${label || 'Copied'} to clipboard`, 'ok');
    else toast('Could not copy — copy it by hand', 'error');
  }

  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel || 'Please wait…';
      button.disabled = true;
    } else {
      if (button.dataset.label) button.textContent = button.dataset.label;
      button.disabled = false;
    }
  }

  function defaultRelay() {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
    }
    return 'ws://localhost:8787';
  }

  function normalizeRelay(value) {
    let v = String(value || '').trim();
    if (!v) return '';
    if (v.startsWith('http://')) v = `ws://${v.slice(7)}`;
    else if (v.startsWith('https://')) v = `wss://${v.slice(8)}`;
    else if (!/^wss?:\/\//i.test(v)) v = `ws://${v}`;
    return v.replace(/\/+$/, '');
  }

  function relayLabel(url) {
    try {
      const u = new URL(url);
      return u.host;
    } catch {
      return url;
    }
  }

  function updateRelayUi() {
    const relay = state.settings.relay;
    els.relayChip.classList.toggle('hidden', !relay);
    if (relay) els.relayChip.textContent = `Relay · ${relayLabel(relay)}`;

    if (!relay) {
      els.relaySummary.textContent = 'No relay server set yet — open Settings to add one';
      document.querySelector('.hint-row .dot').className = 'dot warn';
    } else {
      els.relaySummary.textContent = `Relay: ${relayLabel(relay)}`;
      document.querySelector('.hint-row .dot').className = 'dot ok';
    }
  }

  /* ------------------------------------------------------------------ */
  /* settings                                                           */
  /* ------------------------------------------------------------------ */

  async function loadSettings() {
    const saved = (await Bridge.settings.get()) || {};
    state.settings = {
      relay: normalizeRelay(saved.relay || defaultRelay()),
      name: saved.name || '',
      turn: saved.turn || '',
    };
    const info = await Bridge.info();
    state.canInject = Boolean(info && info.canInject);
    updateRelayUi();
  }

  function openSettings() {
    els.relayInput.value = state.settings.relay;
    els.turnInput.value = state.settings.turn;
    els.nameInput.value = state.settings.name;
    els.settingsModal.classList.remove('hidden');
    els.relayInput.focus();
  }

  function closeSettings() {
    els.settingsModal.classList.add('hidden');
  }

  async function saveSettings() {
    const next = {
      relay: normalizeRelay(els.relayInput.value || defaultRelay()),
      turn: els.turnInput.value.trim(),
      name: els.nameInput.value.trim().slice(0, 30),
    };
    await Bridge.settings.set(next);
    state.settings = next;
    updateRelayUi();
    closeSettings();
    toast('Settings saved', 'ok');
  }

  /* ------------------------------------------------------------------ */
  /* HOST: share my screen                                              */
  /* ------------------------------------------------------------------ */

  function resetShareUi() {
    els.shareSetup.classList.remove('hidden');
    els.shareLive.classList.add('hidden');
    els.controlBar.classList.add('hidden');
    els.previewWrap.classList.remove('has-video');
    if (!state.host.active) els.previewVideo.srcObject = null;
    els.hostStats.textContent = '';
    state.host.source = null;
  }

  async function openShare() {
    show('share');
    resetShareUi();
    els.audioRow.classList.toggle('hidden', !(Bridge.isElectron && /win/i.test(navigator.platform)));
    await loadSources();
  }

  async function loadSources() {
    if (!Bridge.isElectron) {
      els.sourceList.innerHTML = `
        <button class="source-item selected" type="button" data-web="1" style="grid-column:1/-1">
          <div style="display:grid;place-items:center;aspect-ratio:16/6;color:#4a5f75;font-size:13px;">
            Your browser will ask what to share
          </div>
          <span class="src-name">Entire screen, a window or a tab</span>
        </button>`;
      return;
    }

    try {
      const sources = await Bridge.listSources();
      if (!sources || !sources.length) {
        els.sourceList.innerHTML = '<p class="muted small">No screens found.</p>';
        return;
      }
      els.sourceList.innerHTML = sources.map((s, i) => `
        <button class="source-item ${i === 0 ? 'selected' : ''}" type="button"
                data-id="${s.id}" data-display="${s.displayId}" data-name="${s.name.replace(/"/g, '&quot;')}">
          ${s.thumbnail ? `<img src="${s.thumbnail}" alt="" />` : '<div style="aspect-ratio:16/10;background:#060a0f;border-radius:7px;margin-bottom:6px"></div>'}
          <span class="tag">${s.isScreen ? 'Screen' : 'Window · view only'}</span>
          <span class="src-name">${s.name}</span>
        </button>`).join('');
      state.host.source = sources[0];
      state.host.displayId = sources[0].displayId;
      state.host.canControl = Boolean(sources[0].isScreen);
      els.sourceList.querySelectorAll('.source-item').forEach((node) => {
        node.addEventListener('click', () => {
          els.sourceList.querySelectorAll('.source-item').forEach((n) => n.classList.remove('selected'));
          node.classList.add('selected');
          state.host.source = { id: node.dataset.id, displayId: node.dataset.display, name: node.dataset.name };
          state.host.displayId = node.dataset.display;
          state.host.canControl = node.dataset.id.startsWith('screen:');
        });
      });
    } catch (err) {
      els.sourceList.innerHTML = `<p class="muted small">Could not list screens: ${err.message}</p>`;
    }
  }

  function hostStatus(message, live) {
    els.hostStatus.classList.toggle('live', Boolean(live));
    const spinner = live ? '' : '<span class="spinner"></span>';
    els.hostStatus.innerHTML = `${spinner}<span>${message}</span>`;
  }

  async function startShare() {
    if (!state.settings.relay) {
      toast('Add a relay server in Settings first', 'error');
      openSettings();
      return;
    }

    setBusy(els.startShare, true, 'Starting…');

    try {
      if (Bridge.isElectron) {
        if (!state.host.source) {
          toast('Pick a screen or window first', 'error');
          setBusy(els.startShare, false);
          return;
        }
        await Bridge.startShare({
          sourceId: state.host.source.id,
          displayId: state.host.displayId,
        });
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: Boolean(els.shareAudio.checked && !els.audioRow.classList.contains('hidden')),
      });

      state.host.stream = stream;
      state.host.active = true;
      els.previewVideo.srcObject = stream;
      els.previewWrap.classList.add('has-video');

      // If the user stops sharing from the system bar, end the session.
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (state.host.active) stopShare(true);
        });
      }

      state.host.id = randomDigits(9);
      state.host.pass = randomPassword(8);
      state.host.secret = await sha256(`${state.host.id}:${state.host.pass}`);

      els.shareSetup.classList.add('hidden');
      els.shareLive.classList.remove('hidden');
      els.myId.textContent = formatId(state.host.id);
      els.myPass.textContent = state.host.pass;
      hostStatus('Waiting for your friend to connect…');

      connectHostRelay();
      startStatsLoop();
      setBusy(els.startShare, false);
    } catch (err) {
      setBusy(els.startShare, false);
      if (err && err.name === 'AbortError') {
        toast('Sharing was cancelled');
      } else if (err && err.name === 'NotAllowedError' && !Bridge.isElectron) {
        toast('The browser blocked screen capture here. Install the Windows app to share for real.', 'error');
      } else if (err && err.name === 'NotAllowedError') {
        toast('Screen capture was blocked — check Windows privacy settings for Desktop apps.', 'error');
      } else {
        toast(`Could not start sharing: ${err.message}`, 'error');
      }
      if (Bridge.isElectron) Bridge.stopShare();
      teardownHost(false);
    }
  }

  function connectHostRelay() {
    if (state.host.relay) state.host.relay.close();

    const relay = new Relay(state.settings.relay, {
      onOpen: () => {
        if (!state.host.active) return;
        relay.send({
          type: 'register',
          id: state.host.id,
          secret: state.host.secret,
          name: state.settings.name || 'Friend',
        });
      },
      onMessage: handleHostMessage,
      onClose: (byUs) => {
        if (byUs || !state.host.active) return;
        hostStatus('Relay connection lost — reconnecting…');
      },
    });

    state.host.relay = relay;
    relay.connect().catch((err) => {
      hostStatus('Cannot reach the relay server.', false);
      toast(`${err.message} Check Settings → Relay server.`, 'error');
    });
  }

  async function handleHostMessage(msg) {
    switch (msg.type) {
      case 'registered':
        hostStatus('Waiting for your friend to connect…');
        break;

      case 'peer-joined': {
        state.host.peerName = msg.name || 'Your friend';
        hostStatus(`${state.host.peerName} connected — sending your screen…`);
        await startHostPeer();
        break;
      }

      case 'answer':
        if (state.host.rtc) state.host.rtc.acceptAnswer(msg.sdp);
        break;

      case 'ice':
        if (state.host.rtc) state.host.rtc.addIce(msg.candidate);
        break;

      case 'peer-left':
        endHostPeer('Your friend disconnected.');
        break;

      case 'closed':
        if (msg.reason === 'idle') {
          toast('Session timed out while nobody was connected');
          stopShare();
        }
        break;

      case 'error':
        toast(msg.message || 'Relay error', 'error');
        if (msg.code === 'id_taken') {
          hostStatus('That ID was already taken — restart sharing for a new one.');
        }
        break;

      default:
        break;
    }
  }

  async function startHostPeer() {
    const rtc = new RtcSession({
      relay: state.host.relay,
      role: 'host',
      turn: state.settings.turn,
      onState: (st) => {
        if (st === 'connected') {
          hostStatus(`${state.host.peerName} is watching your screen`, true);
        } else if (st === 'disconnected' || st === 'failed') {
          hostStatus('Connection problem — trying to recover…');
        }
      },
      onData: handleHostData,
    });
    state.host.rtc = rtc;

    try {
      await rtc.share(state.host.stream, { maxFramerate: 30, maxBitrate: 8_000_000 });
    } catch (err) {
      toast(`Could not start the video link: ${err.message}`, 'error');
    }
  }

  function handleHostData(msg) {
    switch (msg.k) {
      case 'control-request':
        openControlPrompt(msg.name);
        break;

      case 'input':
        // main process enforces the allow-flag again, so this is safe.
        if (state.host.allowed && msg.e) Bridge.sendInput(msg.e);
        break;

      case 'clip':
        if (typeof msg.text === 'string') {
          Bridge.clipboard.write(msg.text);
          toast('Clipboard received — press Ctrl+V to paste it', 'ok');
        }
        break;

      case 'bye':
        endHostPeer('Your friend ended the session.');
        break;

      default:
        break;
    }
  }

  function endHostPeer(message) {
    setRemoteControl(false, true);
    if (state.host.rtc) {
      state.host.rtc.close();
      state.host.rtc = null;
    }
    if (state.host.active) {
      hostStatus(message || 'Waiting for your friend to connect…');
      els.hostStats.textContent = '';
    }
    if (message) toast(message);
  }

  function openControlPrompt(name) {
    if (!state.host.canControl) {
      if (state.host.rtc) state.host.rtc.sendData({ k: 'control-state', allowed: false });
      toast('A single window can only be watched. Share the whole screen to let a friend control it.', 'error');
      return;
    }
    els.controlModalText.textContent = `${name || 'Your friend'} wants to use your mouse and keyboard. You can stop them at any time — or press Ctrl+Shift+F12.`;
    els.controlModal.classList.remove('hidden');
  }

  async function setRemoteControl(allowed, silent) {
    const res = await Bridge.setControlAllowed(allowed);
    state.host.allowed = allowed;

    if (allowed && res && res.helperReady === false) {
      toast('View-only mode: this computer cannot inject remote input. Install the desktop app on the controlled PC.', 'error');
      state.host.allowed = false;
      Bridge.setControlAllowed(false);
      return;
    }

    if (state.host.rtc) state.host.rtc.sendData({ k: 'control-state', allowed });

    els.controlBar.classList.toggle('hidden', !allowed);
    if (allowed) {
      els.controlText.textContent = `${state.host.peerName || 'Your friend'} is controlling your screen`;
      hostStatus(`${state.host.peerName || 'Your friend'} is watching and controlling`, true);
      if (!silent) toast('Control given. Press Ctrl+Shift+F12 to stop it instantly.', 'ok');
    } else {
      hostStatus(`${state.host.peerName || 'Your friend'} is watching (view only)`, true);
      if (!silent) toast('Remote control stopped');
    }
  }

  function stopShare(silent) {
    if (state.host.rtc) {
      state.host.rtc.sendData({ k: 'bye' });
      state.host.rtc.close();
      state.host.rtc = null;
    }
    if (state.host.relay) {
      state.host.relay.send({ type: 'bye' });
      state.host.relay.close();
      state.host.relay = null;
    }
    Bridge.setControlAllowed(false);
    if (Bridge.isElectron) Bridge.stopShare();

    if (state.host.stream) {
      for (const track of state.host.stream.getTracks()) track.stop();
      state.host.stream = null;
    }

    state.host.active = false;
    state.host.id = null;
    state.host.pass = null;
    state.host.secret = null;
    state.host.allowed = false;
    state.host.peerName = '';
    stopStatsLoop();
    resetShareUi();
    if (!silent) toast('Sharing stopped');
  }

  /* A lighter teardown used when sharing fails to start. */
  function teardownHost(notify) {
    if (state.host.stream) {
      for (const track of state.host.stream.getTracks()) track.stop();
      state.host.stream = null;
    }
    state.host.active = false;
    if (notify) toast('Session closed');
  }

  /* ------------------------------------------------------------------ */
  /* VIEWER: control a friend                                           */
  /* ------------------------------------------------------------------ */

  async function openViewer(prefillId, prefillPass) {
    show('view');
    els.viewStage.classList.add('hidden');
    els.viewForm.classList.remove('hidden');
    if (prefillId) els.viewId.value = formatId(prefillId);
    if (prefillPass) els.viewPass.value = prefillPass;
    (prefillId ? els.viewPass : els.viewId).focus();
  }

  async function connectViewer(rawId, pass) {
    const id = digitsOnly(rawId);
    if (id.length !== 9) {
      toast('The ID is 9 digits', 'error');
      els.viewId.focus();
      return;
    }
    if (!pass) {
      toast('Enter the password your friend sent you', 'error');
      els.viewPass.focus();
      return;
    }
    if (!state.settings.relay) {
      toast('Add a relay server in Settings first', 'error');
      openSettings();
      return;
    }

    setBusy(els.viewConnect, true, 'Connecting…');
    state.view.id = id;
    state.view.controlling = false;

    const secret = await sha256(`${id}:${pass}`);

    const relay = new Relay(state.settings.relay, {
      onOpen: () => relay.send({
        type: 'join',
        id,
        secret,
        name: state.settings.name || 'Friend',
      }),
      onMessage: handleViewerMessage,
      onClose: (byUs) => {
        if (byUs || !state.view.active) return;
        setRemoteStatus('Reconnecting to the relay…', 'warn');
      },
    });
    state.view.relay = relay;

    try {
      await relay.connect();
      // mark active only once we are joined, handled in handleViewerMessage
    } catch (err) {
      setBusy(els.viewConnect, false);
      toast(`${err.message} Check Settings → Relay server.`, 'error');
      relay.close();
      state.view.relay = null;
    }
  }

  function setRemoteStatus(text, kind) {
    els.remoteStatus.textContent = text;
    els.remoteDot.className = `dot ${kind || ''}`;
  }

  function showOverlay(text, spinner) {
    els.overlayText.textContent = text;
    els.overlay.classList.remove('gone');
    const sp = els.overlay.querySelector('.spinner');
    if (sp) sp.classList.toggle('hidden', !spinner);
  }

  function hideOverlay() {
    els.overlay.classList.add('gone');
  }

  async function handleViewerMessage(msg) {
    switch (msg.type) {
      case 'joined':
        state.view.active = true;
        setBusy(els.viewConnect, false);
        els.viewForm.classList.add('hidden');
        els.viewStage.classList.remove('hidden');
        showOverlay('Waiting for their screen…', true);
        setRemoteStatus('Connected to relay…', 'warn');
        els.stageVideo.focus();
        break;

      case 'offer': {
        if (!state.view.rtc) {
          const rtc = new RtcSession({
            relay: state.view.relay,
            role: 'viewer',
            turn: state.settings.turn,
            onStream: (stream) => attachRemoteStream(stream),
            onState: (st) => {
              if (st === 'connected') {
                setRemoteStatus('Connected', 'ok');
                hideOverlay();
              } else if (st === 'disconnected') {
                setRemoteStatus('Connection interrupted…', 'warn');
                showOverlay('Reconnecting…', true);
              } else if (st === 'failed') {
                setRemoteStatus('Connection failed', 'bad');
                showOverlay('Connection failed — trying again…', true);
              }
            },
            onData: handleViewerData,
            onChannel: () => syncControlUi(),
          });
          state.view.rtc = rtc;

          state.view.keys = new window.VK.RemoteKeys((vk, down) => {
            sendInput({ t: 'key', vk, down });
          });
        }
        await state.view.rtc.answer(msg.sdp);
        showOverlay('Connecting…', true);
        break;
      }

      case 'ice':
        if (state.view.rtc) state.view.rtc.addIce(msg.candidate);
        break;

      case 'peer-left':
      case 'closed':
        endViewer('Your friend stopped sharing.');
        break;

      case 'error':
        setBusy(els.viewConnect, false);
        toast(msg.message || 'Could not connect', 'error');
        if (state.view.relay) {
          state.view.relay.close();
          state.view.relay = null;
        }
        state.view.active = false;
        els.viewStage.classList.add('hidden');
        els.viewForm.classList.remove('hidden');
        break;

      default:
        break;
    }
  }

  function attachRemoteStream(stream) {
    els.remoteVideo.srcObject = stream;
    els.remoteVideo.play().catch(() => {});
    els.remoteVideo.onloadedmetadata = () => {
      hideOverlay();
      setRemoteStatus('Connected', 'ok');
    };
    startStatsLoop();
  }

  function handleViewerData(msg) {
    switch (msg.k) {
      case 'control-state':
        setControlling(Boolean(msg.allowed));
        break;
      case 'clip':
        if (typeof msg.text === 'string') {
          Bridge.clipboard.write(msg.text);
          toast('Copied your friend\'s clipboard', 'ok');
        }
        break;
      case 'toast':
        toast(String(msg.message || ''), msg.kind || '');
        break;
      default:
        break;
    }
  }

  function sendInput(evt) {
    if (!state.view.rtc || !state.view.controlling) return;
    state.view.rtc.sendData({ k: 'input', e: evt });
  }

  function syncControlUi() {
    els.requestControl.classList.toggle('active', state.view.controlling);
    els.requestControl.textContent = state.view.controlling ? 'Control active' : 'Request control';
    els.controlNote.classList.toggle('hidden', !state.view.controlling);
    if (state.view.controlling) {
      els.controlNote.textContent = 'You are controlling your friend\'s screen. Click the video, then use your mouse and keyboard. Esc stops fullscreen.';
    }
  }

  function setControlling(allowed) {
    const was = state.view.controlling;
    state.view.controlling = allowed;
    els.stageVideo.classList.toggle('controlling', allowed);
    els.stageVideo.style.cursor = allowed ? 'none' : 'default';

    if (allowed && !was) {
      els.stageVideo.focus();
      toast('Control granted — you can use the mouse and keyboard now', 'ok');
    }
    if (!allowed && was) {
      releaseEverything();
      toast('Control stopped');
    }
    syncControlUi();
  }

  function releaseEverything() {
    if (state.view.keys) state.view.keys.releaseAll();
    for (const button of Array.from(state.view.buttons)) {
      sendInput({ t: 'btn', button, down: false });
      state.view.buttons.delete(button);
    }
  }

  function endViewer(message) {
    releaseEverything();
    state.view.controlling = false;
    syncControlUi();

    if (state.view.rtc) {
      state.view.rtc.close();
      state.view.rtc = null;
    }
    if (state.view.relay) {
      state.view.relay.send({ type: 'bye' });
      state.view.relay.close();
      state.view.relay = null;
    }

    stopStatsLoop();
    els.remoteVideo.srcObject = null;
    els.viewStage.classList.add('hidden');
    els.viewForm.classList.remove('hidden');
    els.viewStats.textContent = '';
    setBusy(els.viewConnect, false);
    state.view.active = false;
    state.view.keys = null;
    if (message) toast(message);
  }

  /* ------------------------------------------------------------------ */
  /* input forwarding (viewer side)                                      */
  /* ------------------------------------------------------------------ */

  function pointerToNormalized(ev) {
    const vid = els.remoteVideo;
    const rect = vid.getBoundingClientRect();
    const vw = vid.videoWidth || 16;
    const vh = vid.videoHeight || 9;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const offX = rect.left + (rect.width - dw) / 2;
    const offY = rect.top + (rect.height - dh) / 2;
    const x = (ev.clientX - offX) / (dw || 1);
    const y = (ev.clientY - offY) / (dh || 1);
    return {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
  }

  function flushPointer() {
    const p = state.view.pointer;
    p.raf = 0;
    if (!p.dirty) return;
    p.dirty = false;
    sendInput({ t: 'move', x: p.x, y: p.y });
  }

  function attachViewerInput() {
    const stage = els.stageVideo;

    stage.addEventListener('pointermove', (ev) => {
      if (!state.view.controlling) return;
      const { x, y } = pointerToNormalized(ev);
      const p = state.view.pointer;
      p.x = x;
      p.y = y;
      p.dirty = true;
      if (!p.raf) p.raf = requestAnimationFrame(flushPointer);
    });

    stage.addEventListener('pointerdown', (ev) => {
      stage.focus();
      if (!state.view.controlling) return;
      ev.preventDefault();
      const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
      const { x, y } = pointerToNormalized(ev);
      sendInput({ t: 'move', x, y });
      sendInput({ t: 'btn', button, down: true });
      state.view.buttons.add(button);
      try { stage.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    });

    const release = (ev) => {
      if (!state.view.controlling) return;
      const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
      if (state.view.buttons.has(button)) {
        sendInput({ t: 'btn', button, down: false });
        state.view.buttons.delete(button);
      }
    };
    stage.addEventListener('pointerup', release);
    stage.addEventListener('pointercancel', release);

    stage.addEventListener('contextmenu', (ev) => ev.preventDefault());

    stage.addEventListener('wheel', (ev) => {
      if (!state.view.controlling) return;
      ev.preventDefault();
      const dy = Math.round(-ev.deltaY / 100);
      const dx = Math.round(-ev.deltaX / 100);
      if (!dy && !dx) return;
      sendInput({ t: 'wheel', dy: Math.max(-10, Math.min(10, dy || Math.sign(-ev.deltaY))), dx: Math.max(-10, Math.min(10, dx)) });
    }, { passive: false });

    document.addEventListener('keydown', (ev) => {
      if (!state.view.controlling) return;
      if (ev.code === 'F11') return; // local fullscreen, handled below

      if (ev.code === 'Delete' && ev.ctrlKey && ev.altKey) {
        ev.preventDefault();
        toast('Windows blocks Ctrl+Alt+Del from remote control', 'error');
        return;
      }

      ev.preventDefault();
      if (ev.repeat) return;
      if (state.view.keys) state.view.keys.key(ev.code, true, ev);
    }, { capture: true });

    document.addEventListener('keyup', (ev) => {
      if (!state.view.controlling) return;
      if (ev.code === 'F11') return;
      ev.preventDefault();
      if (state.view.keys) state.view.keys.key(ev.code, false, ev);
    }, { capture: true });

    window.addEventListener('blur', releaseEverything);

    document.addEventListener('keydown', (ev) => {
      if (ev.code === 'F11') {
        ev.preventDefault();
        toggleFullscreen();
      } else if (ev.code === 'Escape' && document.fullscreenElement) {
        toggleFullscreen(false);
      }
    });
  }

  async function toggleFullscreen(force) {
    const want = typeof force === 'boolean' ? force : !document.fullscreenElement;
    if (Bridge.isElectron) await Bridge.window.fullscreen(want);
    else if (want && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else if (!want && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* stats                                                              */
  /* ------------------------------------------------------------------ */

  function fmtStats(s) {
    if (!s) return '';
    const parts = [];
    if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
    if (s.fps) parts.push(`${s.fps} fps`);
    if (s.bitrate) parts.push(`${(s.bitrate / 1000).toFixed(1)} Mbps`);
    return parts.join(' · ');
  }

  function startStatsLoop() {
    stopStatsLoop();
    state.statsTimer = setInterval(async () => {
      const rtc = state.screen === 'view' ? state.view.rtc : state.host.rtc;
      if (!rtc) return;
      const s = await rtc.stats();
      const text = fmtStats(s);
      if (state.screen === 'view') els.viewStats.textContent = text;
      else els.hostStats.textContent = text;
    }, 1300);
  }

  function stopStatsLoop() {
    clearInterval(state.statsTimer);
    state.statsTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                             */
  /* ------------------------------------------------------------------ */

  function goHome() {
    if (state.host.active) stopShare(true);
    if (state.view.active) endViewer();
    show('home');
    updateRelayUi();
  }

  function wire() {
    $('brand-home').addEventListener('click', goHome);
    $('btn-settings').addEventListener('click', openSettings);
    $('home-open-settings').addEventListener('click', openSettings);
    els.settingsCancel.addEventListener('click', closeSettings);
    els.settingsSave.addEventListener('click', saveSettings);
    els.settingsModal.addEventListener('click', (ev) => {
      if (ev.target === els.settingsModal) closeSettings();
    });

    document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', goHome));

    $('go-share').addEventListener('click', openShare);
    $('go-view').addEventListener('click', () => openViewer());

    // quick connect (home)
    $('quick-connect').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const id = $('quick-id').value;
      const pass = $('quick-pass').value.trim();
      await openViewer(id, pass);
      if (digitsOnly(id).length === 9 && pass) connectViewer(id, pass);
    });
    $('quick-id').addEventListener('input', (ev) => {
      const d = digitsOnly(ev.target.value);
      ev.target.value = d.length > 3 ? formatId(d) : d;
    });
    $('quick-pass').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') $('quick-connect').requestSubmit();
    });

    // host
    els.startShare.addEventListener('click', startShare);
    els.stopShare.addEventListener('click', () => stopShare());
    els.copyId.addEventListener('click', () => {
      if (!state.host.id) return;
      copyText(
        `ScreenLink\nID: ${formatId(state.host.id)}\nPassword: ${state.host.pass}\n\nOpen ScreenLink → "Control a friend" and enter these.`,
        'ID and password copied',
      );
    });
    els.copyPass.addEventListener('click', () => {
      if (state.host.pass) copyText(state.host.pass, 'Password copied');
    });
    els.newPass.addEventListener('click', async () => {
      if (!state.host.active) return;
      state.host.pass = randomPassword(8);
      state.host.secret = await sha256(`${state.host.id}:${state.host.pass}`);
      els.myPass.textContent = state.host.pass;
      if (state.host.relay) {
        state.host.relay.send({ type: 'unregister' });
        state.host.relay.send({
          type: 'register', id: state.host.id, secret: state.host.secret, name: state.settings.name || 'Friend',
        });
      }
      toast('New password generated — send it to your friend', 'ok');
    });
    els.revoke.addEventListener('click', () => setRemoteControl(false));
    els.controlAllow.addEventListener('click', async () => {
      els.controlModal.classList.add('hidden');
      if (!state.host.canControl) {
        toast('Share a whole screen to allow control', 'error');
        return;
      }
      await setRemoteControl(true);
    });
    els.controlDeny.addEventListener('click', () => {
      els.controlModal.classList.add('hidden');
      if (state.host.rtc) state.host.rtc.sendData({ k: 'control-state', allowed: false });
      toast('Control denied — your friend can still watch');
    });

    // viewer
    els.viewForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      connectViewer(els.viewId.value, els.viewPass.value.trim());
    });
    els.viewId.addEventListener('input', (ev) => {
      const d = digitsOnly(ev.target.value);
      ev.target.value = d.length > 3 ? formatId(d) : d;
    });
    els.viewId.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); els.viewPass.focus(); }
    });

    els.requestControl.addEventListener('click', () => {
      if (!state.view.rtc) return;
      if (state.view.controlling) {
        setControlling(false);
        state.view.rtc.sendData({ k: 'control-state', allowed: false });
        return;
      }
      const sent = state.view.rtc.sendData({ k: 'control-request', name: state.settings.name || 'A friend' });
      if (sent) toast('Asked your friend for control…');
      else toast('Not connected yet', 'error');
    });

    els.clipSend.addEventListener('click', async () => {
      if (!state.view.rtc) return;
      const text = await Bridge.clipboard.read();
      if (!text) { toast('Your clipboard is empty', 'error'); return; }
      const ok = state.view.rtc.sendData({ k: 'clip', text });
      toast(ok ? 'Clipboard sent — press Ctrl+V there' : 'Not connected yet', ok ? 'ok' : 'error');
    });

    els.fullscreen.addEventListener('click', () => toggleFullscreen());
    els.disconnect.addEventListener('click', () => endViewer('Disconnected'));

    attachViewerInput();

    Bridge.onControlRevoked(() => {
      if (state.host.allowed) {
        state.host.allowed = false;
        els.controlBar.classList.add('hidden');
        if (state.host.rtc) state.host.rtc.sendData({ k: 'control-state', allowed: false });
        hostStatus(`${state.host.peerName || 'Your friend'} is watching (view only)`, true);
        toast('Remote control stopped with the hotkey', 'ok');
      }
    });

    window.addEventListener('beforeunload', () => {
      releaseEverything();
      if (state.host.rtc) state.host.rtc.close();
      if (state.host.relay) state.host.relay.close();
      if (state.view.rtc) state.view.rtc.close();
      if (state.view.relay) state.view.relay.close();
      if (Bridge.isElectron) Bridge.setControlAllowed(false);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) releaseEverything();
    });
  }

  async function init() {
    wire();
    await loadSettings();
    if (!Bridge.isElectron && !state.settings.relay) updateRelayUi();
  }

  init();
})();
