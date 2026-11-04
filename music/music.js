(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    var script = root.document.currentScript;
    root.MagnetMusic = factory({ root: root, baseUrl: new URL('.', script.src).href });
  }
})(typeof window === 'undefined' ? globalThis : window, function createMusic(options) {
  'use strict';
  var root = options.root || globalThis, doc = options.document || root.document;
  var fetchFile = options.fetch || root.fetch.bind(root), setTimer = options.setTimeout || root.setTimeout.bind(root);
  var clearTimer = options.clearTimeout || root.clearTimeout.bind(root), wallNow = options.now || function () { return root.performance.now(); };
  var Controller = options.AbortController || root.AbortController;
  var createContext = options.createContext || function () {
    var Audio = root.AudioContext || root.webkitAudioContext;
    if (!Audio) throw new Error('audio_unavailable');
    try { return new Audio({ sampleRate: 32000, latencyHint: 'playback' }); }
    catch (_) { return new Audio(); }
  };
  var filenames = ['phase1.ogg', 'phase2.ogg', 'phase3.ogg', 'boss.ogg'];
  var names = ['차가운 궤도', '강철 성운', '최후의 항로', '거대 병기'];
  var MAX_FILE_BYTES = 5 * 1024 * 1024, FETCH_TIMEOUT_MS = 15000;
  var owner = null, generation = 0, context = null, master = null, analyser = null, hidden = false;
  var state = { track: 0, gain: 0, muted: true, prefetch: -1, crossfadeSeconds: .65 };
  var cache = new Map(), voices = [], serial = 0, active = null, pending = null, fadeTimer = null, unlockTask = null;
  var masterRamp = { from: 0, to: 0, start: 0, end: 0 }, blocked = new Map();
  var fetches = [], decodes = [], errors = [], events = [], transitionCount = 0, peakDecodedBytes = 0, pumpQueued = false;
  var maxVoices = 0, maxCached = 0, gestureUnlocked = false;
  function time() { return context ? context.currentTime : 0; }
  function bounded(array, value) { array.push(value); if (array.length > 96) array.shift(); }
  function event(kind, extra) { bounded(events, Object.assign({ kind: kind, at: wallNow() }, extra || {})); }
  function fault(track, code) { blocked.set(track, wallNow()); bounded(errors, { track: track, code: code, at: wallNow() }); event('error', { track: track, code: code }); }
  function goodOwner(value) { return Number.isInteger(value) && value !== 0 && Math.abs(value) <= 2147483648; }
  function track(value) { return Number.isInteger(value) && value >= 0 && value < 4; }
  function unit(value) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
  function valueAt(ramp, at) {
    if (ramp.end <= ramp.start || at >= ramp.end) return ramp.to;
    if (at <= ramp.start) return ramp.from;
    return ramp.from + (ramp.to - ramp.from) * (at - ramp.start) / (ramp.end - ramp.start);
  }
  function ramp(param, old, target, seconds) {
    var at = time(), value = valueAt(old, at);
    param.cancelScheduledValues(at); param.setValueAtTime(value, at);
    if (seconds > 0) param.linearRampToValueAtTime(target, at + seconds);
    else param.setValueAtTime(target, at);
    return { from: value, to: target, start: at, end: at + seconds };
  }
  function bytes(buffer) { return buffer.length * buffer.numberOfChannels * 4; }
  function decodedBytes() { var n = 0; cache.forEach(function (entry) { n += bytes(entry.buffer); }); return n; }
  function trackInVoice(id) { return voices.some(function (voice) { return voice.track === id; }); }
  function disposeVoice(voice) {
    if (!voices.includes(voice)) return;
    voices = voices.filter(function (item) { return item !== voice; });
    if (active === voice) active = null;
    try { voice.source.onended = null; voice.source.stop(); } catch (_) {}
    try { voice.source.disconnect(); voice.gain.disconnect(); voice.source.buffer = null; } catch (_) {}
    event('voice-stop', { track: voice.track });
  }
  function retireFinished() {
    var at = time();
    voices.slice().forEach(function (voice) {
      if (voice !== active && voice.ramp.to === 0 && at >= voice.ramp.end) disposeVoice(voice);
    });
  }
  function scheduleRetirement() {
    if (fadeTimer !== null) clearTimer(fadeTimer);
    fadeTimer = null;
    var retiring = voices.filter(function (voice) { return voice !== active; });
    if (!retiring.length || !context) return;
    var delay = Math.max(50, (Math.min.apply(null, retiring.map(function (v) { return v.ramp.end; })) - time()) * 1000 + 25);
    fadeTimer = setTimer(function () { fadeTimer = null; retireFinished(); scheduleRetirement(); schedulePump(); }, delay);
  }
  function freeSlot() {
    retireFinished();
    if (cache.size < 2) return true;
    var candidates = [];
    cache.forEach(function (entry, id) { if (!trackInVoice(id) && id !== state.track) candidates.push({ id: id, used: entry.used }); });
    candidates.sort(function (a, b) { return a.used - b.used; });
    if (!candidates.length) return false;
    var remove = candidates[0].id; cache.delete(remove); event('buffer-evict', { track: remove });
    return true;
  }
  function stillNeeded(id) { return id === state.track || id === state.prefetch || trackInVoice(id); }
  function mayLoad() { return owner !== null && !hidden && context && context.state !== 'closed' && !state.muted && state.gain > 0; }
  function schedulePump() {
    if (pumpQueued) return;
    pumpQueued = true;
    Promise.resolve().then(function () { pumpQueued = false; pump(); });
  }
  function setMaster(immediate) {
    if (!master) return;
    masterRamp = ramp(master.gain, masterRamp, state.muted ? 0 : state.gain, immediate || state.muted ? 0 : state.crossfadeSeconds);
  }
  function switchTrack(id) {
    if (!context || !cache.has(id) || !mayLoad()) return;
    retireFinished();
    if (active && active.track === id) { cache.get(id).used = ++serial; return; }
    var next = voices.find(function (voice) { return voice.track === id; });
    if (!next) {
      if (voices.length >= 2) { scheduleRetirement(); return; }
      var entry = cache.get(id), source = null, gain = null;
      try {
        source = context.createBufferSource(); gain = context.createGain(); gain.gain.value = 0;
        source.buffer = entry.buffer; source.loop = true; source.loopStart = 0; source.loopEnd = entry.buffer.duration;
        source.connect(gain); gain.connect(master);
        next = { track: id, source: source, gain: gain, ramp: { from: 0, to: 0, start: time(), end: time() }, startedAt: time() };
        source.start(0, 0); voices.push(next);
      } catch (_) {
        if (source) { try { source.stop(); source.disconnect(); source.buffer = null; } catch (_) {} }
        if (gain) { try { gain.disconnect(); } catch (_) {} }
        fault(id, 'play_failed'); return;
      }
    }
    active = next; cache.get(id).used = ++serial;
    voices.forEach(function (voice) { voice.ramp = ramp(voice.gain.gain, voice.ramp, voice === active ? 1 : 0, state.crossfadeSeconds); });
    transitionCount++; maxVoices = Math.max(maxVoices, voices.length);
    event('track-start', { track: id, voices: voices.length }); scheduleRetirement();
  }
  async function load(id) {
    if (!freeSlot()) { scheduleRetirement(); return; }
    var expectedGeneration = generation, loadingContext = context, controller = new Controller();
    var job = { track: id, generation: expectedGeneration, controller: controller, stage: 'fetch', obsolete: false };
    pending = job;
    var started = wallNow(), timeout = setTimer(function () { job.timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
    try {
      var url = new URL(filenames[id], options.baseUrl); url.searchParams.set('v', '0.5.4');
      var response = await fetchFile(url.href, { credentials: 'omit', mode: 'same-origin', cache: 'force-cache', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('download_failed');
      var length = Number(response.headers && response.headers.get('content-length'));
      if (Number.isFinite(length) && length > MAX_FILE_BYTES) throw new Error('file_too_large');
      var encoded = await response.arrayBuffer(); clearTimer(timeout); timeout = null;
      if (encoded.byteLength === 0 || encoded.byteLength > MAX_FILE_BYTES) throw new Error('file_too_large');
      if (generation !== expectedGeneration || job.obsolete || !stillNeeded(id)) return;
      bounded(fetches, { track: id, bytes: encoded.byteLength, ms: wallNow() - started });
      job.stage = 'decode'; var decodeStarted = wallNow();
      // One in-flight decoder. A pending decode retains the slot until completion;
      // racing a timeout with another decode could exceed the two-buffer budget.
      var buffer = await loadingContext.decodeAudioData(encoded); encoded = null;
      if (generation !== expectedGeneration || loadingContext !== context || job.obsolete || !stillNeeded(id)) return;
      if (!buffer || buffer.numberOfChannels !== 2 || !Number.isFinite(buffer.duration) || buffer.duration < 45 || buffer.duration > 80)
        throw new Error('invalid_audio');
      if (!freeSlot()) return;
      cache.set(id, { buffer: buffer, used: ++serial }); blocked.delete(id);
      maxCached = Math.max(maxCached, cache.size); peakDecodedBytes = Math.max(peakDecodedBytes, decodedBytes());
      bounded(decodes, { track: id, seconds: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
        bytes: bytes(buffer), ms: wallNow() - decodeStarted });
      event('buffer-ready', { track: id, decodedBytes: decodedBytes() });
    } catch (error) {
      if (generation === expectedGeneration && !job.obsolete && stillNeeded(id))
        fault(id, job.timedOut ? 'download_timeout' : job.stage === 'decode' ? 'decode_failed' : error && error.message === 'file_too_large' ? 'file_too_large' : 'download_failed');
    } finally {
      if (timeout !== null) clearTimer(timeout);
      if (pending === job) pending = null;
      schedulePump();
    }
  }
  function pump() {
    if (!mayLoad()) return;
    retireFinished();
    if (cache.has(state.track) && !blocked.has(state.track)) switchTrack(state.track);
    if (pending) return;
    if (!cache.has(state.track)) {
      if (!blocked.has(state.track)) load(state.track);
      return;
    }
    if (state.prefetch !== -1 && state.prefetch !== state.track && !cache.has(state.prefetch) && !blocked.has(state.prefetch)) load(state.prefetch);
  }
  function stopResources(keepOwner) {
    generation++;
    if (fadeTimer !== null) clearTimer(fadeTimer); fadeTimer = null;
    if (pending) { pending.obsolete = true; if (pending.stage === 'fetch') pending.controller.abort(); }
    voices.slice().forEach(disposeVoice); cache.clear(); active = null; blocked.clear();
    var closing = context; context = master = analyser = null; gestureUnlocked = false; unlockTask = null;
    masterRamp = { from: 0, to: 0, start: 0, end: 0 };
    if (!keepOwner) owner = null;
    if (closing) { try { Promise.resolve(closing.close()).catch(function () {}); } catch (_) {} }
    event('resources-released');
  }
  function unlock(gesture) {
    if (!gesture || gesture.isTrusted !== true || hidden) return Promise.resolve(false);
    blocked.forEach(function (at, id) { if (wallNow() - at >= 5000) blocked.delete(id); });
    if (unlockTask) return unlockTask;
    if (!context || context.state === 'closed') {
      try {
        context = createContext(); master = context.createGain(); master.gain.value = 0;
        analyser = context.createAnalyser(); analyser.fftSize = 2048;
        master.connect(analyser); analyser.connect(context.destination);
        masterRamp = { from: 0, to: 0, start: time(), end: time() }; setMaster(false);
      } catch (_) { fault(state.track, 'audio_unavailable'); return Promise.resolve(false); }
    }
    var expected = context;
    try {
      var resume = expected.state === 'running' ? Promise.resolve() : expected.resume();
      var task = Promise.resolve(resume).then(function () {
        if (expected !== context) return false;
        gestureUnlocked = expected.state === 'running'; schedulePump(); return gestureUnlocked;
      }).catch(function () { if (expected === context) event('gesture-needed'); return false; }).finally(function () { if (unlockTask === task) unlockTask = null; });
      unlockTask = task; return task;
    } catch (_) { event('gesture-needed'); return Promise.resolve(false); }
  }
  function acquire(value) {
    if (!goodOwner(value)) return 0;
    if (owner !== null && owner !== value) return 0;
    if (owner === null) { owner = value; event('owner-acquired'); }
    schedulePump(); return 1;
  }
  function update(value, next) {
    if (value !== owner || owner === null || !next || !track(next.track)) return 0;
    var old = state;
    state = { track: next.track, gain: unit(next.gain), muted: next.muted === true,
      prefetch: track(next.prefetch) && next.prefetch !== next.track ? next.prefetch : -1,
      crossfadeSeconds: Number.isFinite(next.crossfadeSeconds) ? Math.max(.05, Math.min(3, next.crossfadeSeconds)) : .65 };
    if (old.track !== state.track) { blocked.delete(state.track); event('target', { track: state.track }); }
    if (pending && !stillNeeded(pending.track)) { pending.obsolete = true; if (pending.stage === 'fetch') pending.controller.abort(); }
    if (old.gain !== state.gain || old.muted !== state.muted) setMaster(state.muted || state.gain === 0);
    schedulePump(); return 1;
  }
  function release(value) { if (value !== owner || owner === null) return 0; stopResources(false); return 1; }
  function snapshot() {
    var at = time(), cachedTracks = Array.from(cache.keys()).sort();
    return JSON.parse(JSON.stringify({ owner: owner, targetTrack: state.track, activeTrack: active ? active.track : -1,
      targetName: names[state.track], activeName: active ? names[active.track] : '', requestedGain: state.gain,
      outputGain: valueAt(masterRamp, at), muted: state.muted, prefetch: state.prefetch,
      contextState: context ? context.state : 'not-created', sampleRate: context ? context.sampleRate : 0, gestureUnlocked: gestureUnlocked,
      voices: voices.map(function (voice) { return { track: voice.track, weight: valueAt(voice.ramp, at), startedAt: voice.startedAt }; }),
      voiceCount: voices.length, maxVoiceCount: maxVoices, cachedTracks: cachedTracks, maxCachedCount: maxCached,
      decodedBytes: decodedBytes(), peakDecodedBytes: peakDecodedBytes, pendingTrack: pending ? pending.track : -1,
      pendingStage: pending ? pending.stage : '', transitionCount: transitionCount,
      playing: !!active && !!context && context.state === 'running' && !state.muted && state.gain > 0,
      fetches: fetches, decodes: decodes, errors: errors, events: events,
      memoryScope: 'Retained decoded AudioBuffers only. Not Unity heap, encoded buffers, in-flight decoder or browser RSS.' }));
  }
  function measureOutput() {
    if (!analyser || !context) return { rms: 0, peak: 0, samples: 0, contextState: 'not-created' };
    var samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
    var squared = 0, peak = 0; for (var i = 0; i < samples.length; i++) { squared += samples[i] * samples[i]; peak = Math.max(peak, Math.abs(samples[i])); }
    return { rms: Math.sqrt(squared / samples.length), peak: peak, samples: samples.length, contextState: context.state };
  }
  if (doc && doc.addEventListener) {
    doc.addEventListener('pointerdown', unlock, true); doc.addEventListener('keydown', unlock, true);
  }
  if (root.addEventListener) {
    root.addEventListener('pagehide', function () { hidden = true; stopResources(true); });
    root.addEventListener('pageshow', function () { hidden = false; });
  }
  return Object.freeze({ acquire: acquire, update: update, release: release, unlock: unlock, snapshot: snapshot, measureOutput: measureOutput });
});
