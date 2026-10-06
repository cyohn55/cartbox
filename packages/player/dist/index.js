// src/audio.ts
var AudioController = class {
  constructor(sampleRate) {
    this.nextStartTime = 0;
    this.context = new AudioContext({ sampleRate });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }
  /** Resumes the context. Call from within a user-gesture handler. */
  async resume() {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }
  /** Suspends output so a paused player makes no sound. */
  async pause() {
    if (this.context.state === "running") {
      await this.context.suspend();
    }
  }
  /**
   * Queues one frame's worth of samples for gapless playback.
   *
   * Each buffer is scheduled to begin exactly where the previous one ended,
   * which avoids clicks between frames. If the scheduler falls behind (e.g. a
   * background tab), it resyncs to the context clock.
   */
  enqueue(samples) {
    if (samples.length === 0) {
      return;
    }
    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channel[i] = (samples[i] ?? 0) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.context.currentTime;
    const startAt = Math.max(now, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }
  /** The context, for other sound (the scene's sounds, EP12) to play on. */
  get audioContext() {
    return this.context;
  }
  /** Where other sound joins the chip's: through the master volume, so it and pause cover everything. */
  get output() {
    return this.gain;
  }
  /** Master volume, 0 (silent) .. 1 (full). */
  setVolume(volume) {
    this.gain.gain.value = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
  }
  destroy() {
    this.gain.disconnect();
    void this.context.close();
  }
};

// src/soundSystem.ts
import { base64ToBytes, synthesizeSound, resolveSynth } from "@cartbox/editor";
function browserSpeaker() {
  const synth = typeof globalThis !== "undefined" ? globalThis.speechSynthesis : void 0;
  const Utterance = typeof globalThis !== "undefined" ? globalThis.SpeechSynthesisUtterance : void 0;
  if (!synth || !Utterance) return null;
  return (text, { volume, pitch, rate }) => {
    const u = new Utterance(text);
    u.volume = Math.max(0, Math.min(1, volume));
    u.pitch = pitch;
    u.rate = rate;
    synth.cancel();
    synth.speak(u);
  };
}
var MAX_VOICES = 24;
var LOOP_SLOTS = 16;
var SoundSystem = class _SoundSystem {
  constructor(context, audio, output, speak) {
    this.context = context;
    this.audio = audio;
    this.speak = speak;
    this.voices = [];
    this.loops = /* @__PURE__ */ new Map();
    /** Emitters: their voice, and the object (scene instance index) each follows, or -1. */
    this.emitters = [];
    this.disposed = false;
    this.master = context.createGain();
    this.master.connect(output);
    this.buses = audio.buses.map((bus) => {
      const g = context.createGain();
      g.gain.value = bus.volume;
      g.connect(this.master);
      return g;
    });
    this.buffers = audio.sounds.map(() => null);
  }
  /**
   * Build the scene's sound: every sound decoded or synthesised (a file that
   * won't decode is left silent), then the emitters started. `objectIndex`
   * finds an emitter's object (by id) among the scene's instances.
   */
  static async create(context, audio, output, objectIndex, speak = browserSpeaker()) {
    const system = new _SoundSystem(context, audio, output, speak);
    await Promise.all(
      audio.sounds.map(async (sound, i) => {
        system.buffers[i] = await bufferFor(context, sound);
      })
    );
    for (const emitter of audio.emitters) {
      const sound = audio.sounds.findIndex((s) => s.name === emitter.sound);
      if (sound < 0) continue;
      const object = emitter.object ? objectIndex(emitter.object) : -1;
      const voice = system.start(sound, emitter.volume, 1, null, true, object >= 0);
      if (voice) system.emitters.push({ ...voice, object });
    }
    return system;
  }
  /** Start a sound (a buffer source through its gain, panner if positional, into its bus). */
  start(sound, volume, pitch, at, loop, positional = at !== null) {
    const def = this.audio.sounds[sound];
    const buffer = this.buffers[sound];
    if (!def || this.disposed) return null;
    if (def.source.kind === "speech") {
      const bus2 = this.audio.buses.findIndex((b) => b.name === def.bus);
      const level = def.volume * volume * (this.buses[bus2]?.gain.value ?? 1) * this.master.gain.value;
      this.speak?.(def.source.text, { volume: level, pitch: def.source.pitch ?? 0.6, rate: def.source.rate ?? 0.9 });
      return null;
    }
    if (!buffer) return null;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop || Boolean(def.loop);
    source.playbackRate.value = Math.max(0.1, Math.min(4, pitch));
    const gain = this.context.createGain();
    gain.gain.value = def.volume * volume;
    source.connect(gain);
    let panner = null;
    if (positional && def.range) {
      panner = this.context.createPanner();
      panner.panningModel = "equalpower";
      panner.distanceModel = "linear";
      panner.refDistance = def.range[0];
      panner.maxDistance = def.range[1];
      panner.rolloffFactor = 1;
      if (at) place(panner, at);
      gain.connect(panner);
    }
    const bus = Math.max(0, this.audio.buses.findIndex((b) => b.name === def.bus));
    (panner ?? gain).connect(this.buses[bus] ?? this.master);
    source.start(this.context.currentTime);
    return { source, gain, panner };
  }
  /** Play a sound once (cartbox.sound). */
  play(sound, volume = 1, pitch = 1, at = null) {
    const voice = this.start(sound, volume, pitch, at, false);
    if (!voice) return;
    this.voices.push(voice);
    voice.source.onended = () => {
      const k = this.voices.indexOf(voice);
      if (k >= 0) this.voices.splice(k, 1);
      voice.gain.disconnect();
      voice.panner?.disconnect();
    };
    if (this.voices.length > MAX_VOICES) stop(this.voices.shift());
  }
  /** Start, move, fade or (sound < 0) stop a looping slot (cartbox.loop). */
  loop(slot, sound, volume = 1, at = null) {
    if (slot < 0 || slot >= LOOP_SLOTS) return;
    const held = this.loops.get(slot);
    if (held && held.sound === sound && sound >= 0) {
      held.gain.gain.value = (this.audio.sounds[sound]?.volume ?? 1) * volume;
      if (held.panner && at) place(held.panner, at);
      return;
    }
    if (held) {
      stop(held);
      this.loops.delete(slot);
    }
    if (sound < 0) return;
    const voice = this.start(sound, volume, 1, at, true);
    if (voice) this.loops.set(slot, { ...voice, sound });
  }
  /** Set a mixer bus's volume (cartbox.mix). */
  mix(bus, volume) {
    const g = this.buses[bus];
    if (g) g.gain.value = Math.max(0, Math.min(2, volume));
  }
  /** A bus's index by name (-1 when the scene has none of that name). */
  busIndex(name) {
    return this.audio.buses.findIndex((b) => b.name === name);
  }
  /** The level a bus is at. */
  busVolume(bus) {
    return this.buses[bus]?.gain.value ?? 0;
  }
  /** Put the listener where the camera is, facing where it looks. */
  listen(eye, forward, up) {
    const l = this.context.listener;
    if (l.positionX) {
      l.positionX.value = eye[0];
      l.positionY.value = eye[1];
      l.positionZ.value = eye[2];
      l.forwardX.value = forward[0];
      l.forwardY.value = forward[1];
      l.forwardZ.value = forward[2];
      l.upX.value = up[0];
      l.upY.value = up[1];
      l.upZ.value = up[2];
    } else {
      l.setPosition(eye[0], eye[1], eye[2]);
      l.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
  }
  /** Move each emitter that follows an object to where the object is (its world matrices, null = hidden). */
  follow(placements) {
    for (const e of this.emitters) {
      if (e.object < 0 || !e.panner) continue;
      const m = placements[e.object];
      if (m) place(e.panner, [m[12], m[13], m[14]]);
    }
  }
  /** How many one-shots are playing (for tests and tooling). */
  playing() {
    return this.voices.length;
  }
  /** Which slots hold a loop, and which sound. */
  loopingSlots() {
    return new Map([...this.loops].map(([slot, v]) => [slot, v.sound]));
  }
  dispose() {
    this.disposed = true;
    for (const v of [...this.voices, ...this.loops.values(), ...this.emitters]) stop(v);
    this.voices.length = 0;
    this.loops.clear();
    this.emitters.length = 0;
    this.master.disconnect();
  }
};
function place(panner, at) {
  if (panner.positionX) {
    panner.positionX.value = at[0];
    panner.positionY.value = at[1];
    panner.positionZ.value = at[2];
  } else panner.setPosition(at[0], at[1], at[2]);
}
function stop(v) {
  try {
    v.source.stop();
  } catch {
  }
  v.gain.disconnect();
  v.panner?.disconnect();
}
async function bufferFor(context, sound) {
  if (sound.source.kind === "synth") {
    const recipe = resolveSynth(sound.source.synth);
    if (!recipe) return null;
    const samples = synthesizeSound(recipe, context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  }
  if (sound.source.kind === "file") {
    try {
      const bytes = base64ToBytes(sound.source.data);
      return await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch {
      return null;
    }
  }
  return null;
}

// src/uiSdk.ts
import { FOCUSABLE, layoutUi, parseUiDocuments, uiNavigation } from "@cartbox/editor";
var lua = (s) => JSON.stringify(s);
function readSidecarUi(raw) {
  if (!raw) return [];
  try {
    return parseUiDocuments(JSON.parse(raw).ui);
  } catch {
    return [];
  }
}
function uiSdkLua(docs, width, height) {
  if (!docs || docs.length === 0) return "";
  const tables = docs.map((doc) => {
    const placed = layoutUi(doc, width, height);
    const nav = uiNavigation(placed);
    const first = placed.findIndex((p) => FOCUSABLE.has(p.widget.kind)) + 1;
    const widgets = placed.map((p) => {
      const w = p.widget;
      const f2 = [`k=${lua(w.kind)}`, `id=${lua(w.id)}`, `x=${p.x}`, `y=${p.y}`, `w=${p.w}`, `h=${p.h}`, `skip=${p.descendants}`];
      if (w.text !== void 0) f2.push(`t=${lua(w.text)}`);
      if (w.color !== void 0) f2.push(`c=${w.color}`);
      if (w.fill !== void 0) f2.push(`f=${w.fill}`);
      if (w.border !== void 0) f2.push(`b=${w.border}`);
      if (w.focusFill !== void 0) f2.push(`ff=${w.focusFill}`);
      if (w.focusColor !== void 0) f2.push(`fc=${w.focusColor}`);
      f2.push(`s=${w.scale ?? 1}`);
      if (w.small) f2.push("sm=true");
      f2.push(`a=${w.align === "center" ? 1 : w.align === "right" ? 2 : 0}`);
      if (w.value) f2.push(`v=${lua(w.value)}`);
      if (w.visible) f2.push(`vis=${lua(w.visible)}`);
      if (w.tint) f2.push(`tn=${lua(w.tint)}`);
      if (w.row !== void 0) f2.push(`row=${w.row}`);
      if (w.sprite !== void 0) f2.push(`sp=${w.sprite}`, `tw=${w.tiles?.[0] ?? 1}`, `th=${w.tiles?.[1] ?? 1}`);
      return `{${f2.join(",")}}`;
    });
    const links = placed.map((_, i) => {
      const n = nav.get(i);
      return n ? `[${i + 1}]={${n.map((j) => j + 1).join(",")}}` : "";
    }).filter(Boolean);
    return `[${lua(doc.name)}]={w={${widgets.join(",\n")}},nav={${links.join(",")}},first=${first}}`;
  });
  return `do
local U = {}
local DOCS = {${tables.join(",\n")}}
local B, shown, focus, sel, on = {}, {}, {}, {}, {}
local function fill(s)
  -- "@key": the string table's text for it (EP19b), in the current language.
  if string.sub(s, 1, 1) == "@" then s = cartbox.text(string.sub(s, 2)) end
  return (string.gsub(s, "{(%w+)}", function(k) local v = B[k]; if v == nil then return "" end; return tostring(v) end))
end
local function isshown(n) for _, m in ipairs(shown) do if m == n then return true end end return false end
U.set = function(k, v) B[k] = v end
U.get = function(k) return B[k] end
U.show = function(n)
  if DOCS[n] and not isshown(n) then shown[#shown + 1] = n; if focus[n] == nil then focus[n] = DOCS[n].first end end
end
U.hide = function(n) for i = #shown, 1, -1 do if shown[i] == n then table.remove(shown, i) end end end
U.shown = function(n) return isshown(n) end
U.focus = function(n, id)
  local d = DOCS[n]
  if not d then return end
  for i, w in ipairs(d.w) do if w.id == id then focus[n] = i end end
end
U.focused = function(n) local d, f = DOCS[n], focus[n]; if d and f and f > 0 then return d.w[f].id end; return nil end
U.select = function(id, row) sel[id] = row end
U.selected = function(id) return sel[id] or 1 end
U.on = function(id, fn) on[id] = fn end
U.update = function()
  local n
  for i = #shown, 1, -1 do if DOCS[shown[i]].first > 0 then n = shown[i]; break end end
  if not n then return nil end
  local d, f = DOCS[n], focus[n] or 0
  if f == 0 then return nil end
  local w = d.w[f]
  if w.k == "list" then
    local count, s = #(B[w.v] or {}), sel[w.id] or 1
    if btnp(0) and s > 1 then sel[w.id] = s - 1; return nil end
    if btnp(1) and s < count then sel[w.id] = s + 1; return nil end
  elseif w.k == "slider" then
    local v = B[w.v] or 0
    if btnp(2) then B[w.v] = math.max(0, v - 0.1); return nil end
    if btnp(3) then B[w.v] = math.min(1, v + 0.1); return nil end
  end
  local links = d.nav[f]
  if links then for dir = 0, 3 do if btnp(dir) and links[dir + 1] > 0 then focus[n] = links[dir + 1]; return nil end end end
  if btnp(4) then
    local value = w.k == "list" and (sel[w.id] or 1) or (w.v and B[w.v])
    if on[w.id] then on[w.id](value) end
    return w.id, value
  end
  return nil
end
local function text(s, x, y, w, h, c, scale, small, align)
  -- The player's text size (EP19b), stepped back down while it would overflow the box.
  local ts = cartbox.textscale()
  if ts ~= 1 then
    local big = math.max(scale, math.floor(scale * ts + 0.5))
    local one = print(s, 0, -64, 0, false, 1, small)
    while big > scale and ((w > 0 and one * big > w) or (h > 0 and 6 * big > h)) do big = big - 1 end
    scale = big
  end
  local tw = print(s, 0, -64, 0, false, scale, small)
  local tx = x
  if align == 1 then tx = x + (w - tw) // 2 elseif align == 2 then tx = x + w - tw end
  local ty = h > 0 and y + (h - 6 * scale) // 2 or y
  print(s, tx, ty, c, false, scale, small)
end
local function drawdoc(n)
  local d = DOCS[n]
  local i, count = 1, #d.w
  while i <= count do
    local w = d.w[i]
    if w.vis and not B[w.vis] then
      i = i + w.skip + 1 -- it and everything under it
    else
      local focused = focus[n] == i
      local c = (w.tn and type(B[w.tn]) == "number") and B[w.tn] or (w.c or 12)
      local k = w.k
      if k == "panel" or k == "button" then
        local bg = (focused and k == "button" and w.ff) or w.f
        if bg then rect(w.x, w.y, w.w, w.h, bg) end
        if w.b then rectb(w.x, w.y, w.w, w.h, w.b) end
        if k == "button" and w.t then text(fill(w.t), w.x, w.y, w.w, w.h, (focused and w.fc) or c, w.s, w.sm, w.a) end
      elseif k == "text" then
        if w.f then rect(w.x, w.y, w.w, w.h, w.f) end
        if w.t then text(fill(w.t), w.x, w.y, w.w, w.h, c, w.s, w.sm, w.a) end
      elseif k == "bar" then
        if w.f then rect(w.x, w.y, w.w, w.h, w.f) end
        local v = math.max(0, math.min(1, tonumber(B[w.v]) or 0))
        local fw = math.floor((w.w - 4) * v)
        if fw > 0 then rect(w.x + 2, w.y + 2, fw, w.h - 4, c) end
        if w.b then rectb(w.x, w.y, w.w, w.h, w.b) end
      elseif k == "slider" then
        rect(w.x, w.y + w.h // 2 - 1, w.w, 2, w.f or 13)
        local v = math.max(0, math.min(1, tonumber(B[w.v]) or 0))
        rect(w.x + math.floor((w.w - 8) * v), w.y, 8, w.h, (focused and w.fc) or c)
      elseif k == "list" then
        if w.f then rect(w.x, w.y, w.w, w.h, w.f) end
        local items, row = B[w.v] or {}, w.row or 12
        local rows = math.max(1, w.h // row)
        local s = sel[w.id] or 1
        local top = math.max(1, s - rows + 1)
        for r = top, math.min(#items, top + rows - 1) do
          local item = items[r]
          local label, ic = item, c
          if type(item) == "table" then label, ic = item.text or "", item.color or c end
          local y = w.y + (r - top) * row
          if r == s and w.ff then rect(w.x, y, w.w, row - 2, w.ff) end
          text(tostring(label), w.x + 8, y, w.w - 16, row - 2, (r == s and w.fc) or ic, w.s, w.sm, w.a)
        end
      elseif k == "image" then
        local scale = math.max(1, w.w // (8 * w.tw))
        spr(w.sp, w.x, w.y, 0, scale, 0, 0, w.tw, w.th)
      end
      i = i + 1
    end
  end
end
U.draw = function() for _, n in ipairs(shown) do drawdoc(n) end end
cartbox.ui = U
end`;
}

// src/stringsSdk.ts
import { COLOR_FILTERS, TEXT_SCALES, pickLanguage } from "@cartbox/editor";

// src/actionsSdk.ts
import { actionLabel, parseInputActions } from "@cartbox/editor";

// src/physics/protocol.ts
var CLASSIC = { pmemAddress: 81924, ramSize: 98304 };
var PRO = { pmemAddress: 542304, ramSize: 786432 };
var ERA = { pmemAddress: 257632, ramSize: 393216 };
var HD = { pmemAddress: 3068512, ramSize: 8388608 };
var RAM_LAYOUTS = {
  classic: CLASSIC,
  voxel: CLASSIC,
  pro: PRO,
  portrait: PRO,
  ps1: ERA,
  n64: ERA,
  xbox360: HD,
  modern: HD
};
var PHYS_BLOCK_BYTES = 8192;
var PHYS_MAGIC = 1213219395;
var PHYS_FIX = 1024;
var PHYS_HDR_MAGIC = 0;
var PHYS_HDR_BODIES = 4;
var PHYS_HDR_TICK = 8;
var PHYS_HDR_HASH = 12;
var PHYS_HDR_LEVEL = 16;
var PHYS_HDR_LEVEL_LOADING = 20;
var PHYS_HDR_LEVEL_PROGRESS = 24;
var PHYS_BODIES = 64;
var PHYS_BODY_BYTES = 32;
var PHYS_MAX_BODIES = 64;
var PHYS_RAYS = PHYS_BODIES + PHYS_MAX_BODIES * PHYS_BODY_BYTES;
var PHYS_RAY_BYTES = 32;
var PHYS_MAX_RAYS = 16;
var PHYS_EVENTS = PHYS_RAYS + PHYS_MAX_RAYS * PHYS_RAY_BYTES;
var PHYS_EVENT_BYTES = 12;
var PHYS_MAX_EVENTS = 48;
var PHYS_OVERLAPS = PHYS_EVENTS + 4 + PHYS_MAX_EVENTS * PHYS_EVENT_BYTES;
var PHYS_OVERLAP_BYTES = 8;
var PHYS_MAX_OVERLAPS = 64;
var PHYS_EVENT_STARTED = 1;
var PHYS_EVENT_TRIGGER = 2;
var PHYS_AGENTS = 3720;
var PHYS_AGENT_BYTES = 16;
var PHYS_MAX_AGENTS = 16;
var NAV_FLAG_MOVING = 1;
var NAV_FLAG_AIR = 2;
var NAV_FLAG_ARRIVED = 4;
var NAV_FLAG_NO_PATH = 8;
var NAV_FLAG_OBSTACLE = 16;
var PHYS_ANIMS = 6400;
var PHYS_ANIM_BYTES = 16;
var PHYS_MAX_ANIMS = 64;
var PHYS_ANIM_EVENTS = PHYS_ANIMS + 4 + PHYS_MAX_ANIMS * PHYS_ANIM_BYTES;
var PHYS_ANIM_EVENT_BYTES = 8;
var PHYS_MAX_ANIM_EVENTS = 32;
var PHYS_JOINTS = 7700;
var PHYS_JOINT_BYTES = 20;
var PHYS_MAX_JOINTS = 16;
var PHYS_TIMELINE = 8032;
var PHYS_TIMELINE_EVENTS = PHYS_TIMELINE + 12;
var PHYS_MAX_TIMELINE_EVENTS = 8;
var PHYS_TIMELINE_VALUES = 6160;
var PHYS_MAX_TIMELINE_VALUES = 32;
var TIMELINE_VALUE_NONE = -2147483648;
function writeTimelineValues(block, names, values) {
  const n = Math.min(names.length, PHYS_MAX_TIMELINE_VALUES);
  block.setInt32(PHYS_TIMELINE_VALUES, n, true);
  for (let i = 0; i < n; i += 1) {
    const v = values.get(names[i]);
    block.setInt32(PHYS_TIMELINE_VALUES + 4 + i * 4, v === void 0 ? TIMELINE_VALUE_NONE : toFix(Math.max(-2e6, Math.min(2e6, v))), true);
  }
}
function writeLevelState(block, level) {
  block.setInt32(PHYS_HDR_LEVEL, level.current, true);
  block.setInt32(PHYS_HDR_LEVEL_LOADING, level.loading, true);
  block.setInt32(PHYS_HDR_LEVEL_PROGRESS, toFix(Math.max(0, Math.min(1, level.progress))), true);
}
function writeTimelineState(block, playback, events = []) {
  block.setInt32(PHYS_TIMELINE, playback.index, true);
  block.setInt32(PHYS_TIMELINE + 4, toFix(playback.time), true);
  block.setInt32(PHYS_TIMELINE + 8, playback.playing ? 1 : 0, true);
  const n = Math.min(events.length, PHYS_MAX_TIMELINE_EVENTS);
  block.setInt32(PHYS_TIMELINE_EVENTS, n, true);
  for (let i = 0; i < n; i += 1) block.setInt32(PHYS_TIMELINE_EVENTS + 4 + i * 4, events[i], true);
}
function writeAgents(block, agents) {
  const n = Math.min(agents.length, PHYS_MAX_AGENTS);
  block.setInt32(PHYS_AGENTS, n, true);
  for (let i = 0; i < n; i += 1) {
    const a = agents[i];
    const at = PHYS_AGENTS + 4 + i * PHYS_AGENT_BYTES;
    for (let k = 0; k < 3; k += 1) block.setInt32(at + k * 4, toFix(a.position[k]), true);
    let f2 = a.facing;
    while (f2 > Math.PI) f2 -= 2 * Math.PI;
    while (f2 < -Math.PI) f2 += 2 * Math.PI;
    const facing = Math.round(f2 * 1e4) & 65535;
    block.setUint32(at + 12, (a.key & 1023 | (a.flags & 63) << 10 | facing << 16) >>> 0, true);
  }
}
function writeJointPositions(block, joints) {
  const n = Math.min(joints.length, PHYS_MAX_JOINTS);
  block.setInt32(PHYS_JOINTS, n, true);
  for (let i = 0; i < n; i += 1) {
    const at = PHYS_JOINTS + 4 + i * PHYS_JOINT_BYTES;
    block.setInt32(at, joints[i].object, true);
    block.setInt32(at + 4, joints[i].joint, true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 8 + k * 4, toFix(joints[i].position[k]), true);
  }
}
var PHYS_CMDS = 4096;
var PHYS_CMD_BYTES = 32;
var PHYS_MAX_CMDS = 64;
var PHYS_FLAG_GROUNDED = 1;
var PHYS_FLAG_SLEEPING = 2;
var PHYS_OP_IMPULSE = 1;
var PHYS_OP_VELOCITY = 2;
var PHYS_OP_TELEPORT = 3;
var PHYS_OP_MOVE = 4;
var PHYS_OP_RAY = 5;
var PHYS_OP_SPAWN = 6;
var PHYS_OP_DESPAWN = 7;
var PHYS_OP_CAST = 8;
var PHYS_CAST_RAY = 0;
var PHYS_CAST_SPHERE = 1;
var PHYS_CAST_BOX = 2;
var PHYS_CAST_CAPSULE = 3;
var PHYS_OP_MOTOR = 9;
var PHYS_OP_UNJOIN = 10;
var PHYS_OP_PLAY = 11;
var PHYS_OP_ANIM_SET = 12;
var PHYS_OP_ANIM_TRIGGER = 13;
var PHYS_OP_ANIM_GOTO = 14;
var PHYS_OP_IK = 15;
var PHYS_OP_IK_POLE = 16;
var PHYS_OP_LOOKAT = 17;
var PHYS_OP_WATCH = 18;
var PHYS_OP_TIMELINE = 19;
var PHYS_OP_LEVEL = 20;
var PHYS_OP_AGENT = 21;
var PHYS_OP_AGENT_GOTO = 22;
var PHYS_OP_AGENT_STOP = 23;
var PHYS_OP_AGENT_REMOVE = 24;
var PHYS_OP_STREAM_FOCUS = 25;
var PHYS_OP_BURST = 26;
var PHYS_OP_DECAL = 27;
var PHYS_OP_RAGDOLL = 28;
var PHYS_OP_DEBRIS = 29;
var PHYS_OP_SHIELD = 30;
var PHYS_OP_SOUND = 31;
var PHYS_OP_SOUND_LOOP = 32;
var PHYS_OP_MIX = 33;
var PHYS_OP_PLACE = 34;
var PHYS_OP_UNPLACE = 35;
function physicsBlockAddress(layout) {
  return layout.ramSize - PHYS_BLOCK_BYTES;
}
var toFix = (v) => {
  const n = Math.round(v * PHYS_FIX);
  return Math.max(-2147483647, Math.min(2147483647, Number.isFinite(n) ? n : 0));
};
var fromFix = (n) => n / PHYS_FIX;
function writePhysicsState(block, tick, bodies, rays, events = [], overlaps = [], hash = 0) {
  block.setInt32(PHYS_HDR_HASH, hash | 0, true);
  const ne = Math.min(events.length, PHYS_MAX_EVENTS);
  block.setInt32(PHYS_EVENTS, ne, true);
  for (let i = 0; i < ne; i += 1) {
    const e = events[i];
    const at = PHYS_EVENTS + 4 + i * PHYS_EVENT_BYTES;
    block.setInt32(at, e.a, true);
    block.setInt32(at + 4, e.b, true);
    block.setInt32(at + 8, (e.started ? PHYS_EVENT_STARTED : 0) | (e.trigger ? PHYS_EVENT_TRIGGER : 0), true);
  }
  const no = Math.min(overlaps.length, PHYS_MAX_OVERLAPS);
  block.setInt32(PHYS_OVERLAPS, no, true);
  for (let i = 0; i < no; i += 1) {
    const at = PHYS_OVERLAPS + 4 + i * PHYS_OVERLAP_BYTES;
    block.setInt32(at, overlaps[i][0], true);
    block.setInt32(at + 4, overlaps[i][1], true);
  }
  block.setInt32(PHYS_HDR_MAGIC, PHYS_MAGIC, true);
  const n = Math.min(bodies.length, PHYS_MAX_BODIES);
  block.setInt32(PHYS_HDR_BODIES, n, true);
  block.setInt32(PHYS_HDR_TICK, tick | 0, true);
  for (let i = 0; i < n; i += 1) {
    const b = bodies[i];
    const at = PHYS_BODIES + i * PHYS_BODY_BYTES;
    block.setInt32(at, b.object, true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 4 + k * 4, toFix(b.position[k]), true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 16 + k * 4, toFix(b.velocity[k]), true);
    block.setInt32(at + 28, (b.grounded ? PHYS_FLAG_GROUNDED : 0) | (b.sleeping ? PHYS_FLAG_SLEEPING : 0), true);
  }
  for (let i = 0; i < PHYS_MAX_RAYS; i += 1) {
    const r = rays[i] ?? null;
    const at = PHYS_RAYS + i * PHYS_RAY_BYTES;
    if (!r) {
      block.setInt32(at, 0, true);
      continue;
    }
    block.setInt32(at, r.object >= 0 ? r.object + 2 : 1, true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 4 + k * 4, toFix(r.point[k]), true);
    for (let k = 0; k < 3; k += 1) block.setInt32(at + 16 + k * 4, toFix(r.normal[k]), true);
    block.setInt32(at + 28, toFix(r.distance), true);
  }
}
function writeAnimationState(block, playback, events = []) {
  const n = Math.min(playback.length, PHYS_MAX_ANIMS);
  block.setInt32(PHYS_ANIMS, n, true);
  for (let i = 0; i < n; i += 1) {
    const at = PHYS_ANIMS + 4 + i * PHYS_ANIM_BYTES;
    block.setInt32(at, playback[i].object, true);
    block.setInt32(at + 4, playback[i].clip, true);
    block.setInt32(at + 8, toFix(playback[i].time), true);
    block.setInt32(at + 12, playback[i].state ?? -1, true);
  }
  const ne = Math.min(events.length, PHYS_MAX_ANIM_EVENTS);
  block.setInt32(PHYS_ANIM_EVENTS, ne, true);
  for (let i = 0; i < ne; i += 1) {
    const at = PHYS_ANIM_EVENTS + 4 + i * PHYS_ANIM_EVENT_BYTES;
    block.setInt32(at, events[i].object, true);
    block.setInt32(at + 4, events[i].event, true);
  }
}
function takeCommandsAt(view, base, max) {
  const n = Math.max(0, Math.min(max, view.getInt32(base, true)));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const at = base + 4 + i * PHYS_CMD_BYTES;
    const v = [0, 0, 0, 0, 0, 0].map((_, k) => fromFix(view.getInt32(at + 8 + k * 4, true)));
    out.push({ op: view.getInt32(at, true), a: view.getInt32(at + 4, true), v });
  }
  view.setInt32(base, 0, true);
  return out;
}
function takePhysicsCommands(block) {
  return takeCommandsAt(block, PHYS_CMDS, PHYS_MAX_CMDS);
}

// src/debug/instrument.ts
var KEYWORDS = /* @__PURE__ */ new Set([
  "and",
  "break",
  "do",
  "else",
  "elseif",
  "end",
  "false",
  "for",
  "function",
  "goto",
  "if",
  "in",
  "local",
  "nil",
  "not",
  "or",
  "repeat",
  "return",
  "then",
  "true",
  "until",
  "while"
]);
var SYMBOLS = ["...", "..", "::", "==", "~=", "<=", ">=", "//", "<<", ">>"];
function tokenizeLua(code) {
  const out = [];
  let i = 0;
  let line = 1;
  const n = code.length;
  const longOpen = (at) => {
    if (code[at] !== "[") return 0;
    let j = at + 1;
    while (code[j] === "=") j += 1;
    return code[j] === "[" ? j - at + 1 : 0;
  };
  const skipLong = (level) => {
    const close = `]${"=".repeat(level)}]`;
    const end = code.indexOf(close, i);
    if (end < 0) return false;
    for (let k = i; k < end; k += 1) if (code.charCodeAt(k) === 10) line += 1;
    i = end + close.length;
    return true;
  };
  while (i < n) {
    const c = code[i];
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === " " || c === "	" || c === "\r" || c === "\f" || c === "\v") {
      i += 1;
      continue;
    }
    const start = i;
    const startLine = line;
    if (c === "-" && code[i + 1] === "-") {
      i += 2;
      const open2 = longOpen(i);
      if (open2 > 0) {
        i += open2;
        if (!skipLong(open2 - 2)) return null;
      } else {
        while (i < n && code[i] !== "\n") i += 1;
      }
      continue;
    }
    const open = longOpen(i);
    if (open > 0) {
      i += open;
      if (!skipLong(open - 2)) return null;
      out.push({ type: "string", value: code.slice(start, i), line: startLine, start });
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < n && code[i] !== c) {
        if (code[i] === "\\") {
          i += 1;
          if (code[i] === "\n") line += 1;
          else if (code[i] === "z") {
            i += 1;
            while (i < n && /\s/.test(code[i])) {
              if (code[i] === "\n") line += 1;
              i += 1;
            }
            continue;
          }
        } else if (code[i] === "\n") return null;
        i += 1;
      }
      if (i >= n) return null;
      i += 1;
      out.push({ type: "string", value: code.slice(start, i), line: startLine, start });
      continue;
    }
    if (/[0-9]/.test(c) || c === "." && /[0-9]/.test(code[i + 1] ?? "")) {
      if (c === "0" && (code[i + 1] === "x" || code[i + 1] === "X")) {
        i += 2;
        while (i < n && /[0-9a-fA-F.pP]/.test(code[i])) {
          if ((code[i] === "p" || code[i] === "P") && (code[i + 1] === "+" || code[i + 1] === "-")) i += 1;
          i += 1;
        }
      } else {
        while (i < n && /[0-9.eE]/.test(code[i])) {
          if ((code[i] === "e" || code[i] === "E") && (code[i + 1] === "+" || code[i + 1] === "-")) i += 1;
          i += 1;
        }
      }
      out.push({ type: "number", value: code.slice(start, i), line: startLine, start });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(code[i])) i += 1;
      const value = code.slice(start, i);
      out.push({ type: KEYWORDS.has(value) ? "keyword" : "name", value, line: startLine, start });
      continue;
    }
    const symbol = SYMBOLS.find((s) => code.startsWith(s, i)) ?? c;
    if (!/[+\-*/%^#&~|<>=(){}[\];:,.]/.test(symbol[0])) return null;
    i += symbol.length;
    out.push({ type: "symbol", value: symbol, line: startLine, start });
  }
  return out;
}
var STATEMENT_KEYWORDS = /* @__PURE__ */ new Set(["local", "if", "for", "while", "repeat", "do", "return", "break", "goto", "function"]);
var ENDS_STATEMENT = /* @__PURE__ */ new Set(["end", "then", "do", "else", "repeat", "break", ")", "]", "}", ";", "true", "false", "nil", "..."]);
var BREAK_HOOK = "__bp";
function instrumentLua(code) {
  const tokens = tokenizeLua(code);
  if (!tokens) return { code, lines: [] };
  const stack = ["root"];
  const inserts = [];
  let prev = null;
  for (const token of tokens) {
    const top = stack[stack.length - 1];
    const firstOnLine = !prev || prev.line !== token.line;
    if (firstOnLine && (top === "root" || top === "block" || top === "function")) {
      const starts = token.type === "name" || token.type === "keyword" && STATEMENT_KEYWORDS.has(token.value) || token.value === "::";
      const after = !prev || prev.type === "name" || prev.type === "number" || prev.type === "string" || ENDS_STATEMENT.has(prev.value);
      if (starts && after) inserts.push({ at: token.start, line: token.line });
    }
    const v = token.value;
    if (token.type === "symbol") {
      if (v === "(" || v === "[" || v === "{") stack.push("bracket");
      else if (v === ")" || v === "]" || v === "}") {
        if (stack.pop() !== "bracket") return { code, lines: [] };
      }
    } else if (token.type === "keyword") {
      if (v === "function") stack.push("function");
      else if (v === "if" || v === "repeat") stack.push("block");
      else if (v === "while" || v === "for") stack.push("head");
      else if (v === "do") {
        if (top === "head") stack[stack.length - 1] = "block";
        else stack.push("block");
      } else if (v === "end" || v === "until") {
        const popped = stack.pop();
        if (popped !== "block" && popped !== "function") return { code, lines: [] };
      }
    }
    prev = token;
  }
  if (stack.length !== 1) return { code, lines: [] };
  let out = "";
  let cursor = 0;
  for (const insert of inserts) {
    out += code.slice(cursor, insert.at) + `${BREAK_HOOK}(${insert.line}) `;
    cursor = insert.at;
  }
  out += code.slice(cursor);
  return { code: out, lines: inserts.map((i) => i.line) };
}
function breakableLine(line, lines) {
  for (const l of lines) if (l >= line) return l;
  return null;
}
function effectiveBreakpoints(list, lines) {
  const out = /* @__PURE__ */ new Set();
  for (const line of list) {
    const at = breakableLine(line, lines);
    if (at !== null) out.add(at);
  }
  return [...out].sort((a, b) => a - b);
}

// src/debug/debugBlock.ts
var DEBUG_BLOCK_BYTES = 4096;
var DEBUG_MAGIC = 1195655747;
var DBG_MAGIC = 0;
var DBG_LINE_OFFSET = 4;
var DBG_STATE = 8;
var DBG_COMMAND = 12;
var DBG_TRACE_USED = 16;
var DBG_TRACE_DROPPED = 20;
var DBG_PAUSED_LINE = 24;
var DBG_BP_VERSION = 28;
var DBG_BP_COUNT = 32;
var DBG_LINE_COUNT = 36;
var DBG_INFO_LENGTH = 40;
var DBG_WATCH_LENGTH = 44;
var DBG_BPS_AT = 64;
var DBG_BPS_MAX = 240;
var DBG_TRACE_AT = 1024;
var DBG_TRACE_BYTES = 1024;
var DBG_TRACE_MAX = 240;
var DBG_WATCH_AT = 2048;
var DBG_WATCH_BYTES = 512;
var DBG_INFO_AT = 2560;
var DBG_INFO_BYTES = 1536;
var DebugCommand = { continue: 1, into: 2, over: 3, out: 4, refresh: 5 };
function debugBlockAddress(layout) {
  return layout.ramSize - PHYS_BLOCK_BYTES - DEBUG_BLOCK_BYTES;
}
function codeLineOffset(original, final) {
  if (!original || final === null || final.length <= original.length) return 0;
  const at = final.lastIndexOf(original);
  if (at <= 0) return 0;
  const head = final.slice(0, at);
  let lines = 0;
  for (let i = 0; i < head.length; i += 1) if (head.charCodeAt(i) === 10) lines += 1;
  return lines;
}
function remapErrorLines(message, offset) {
  return message.replace(/\[string "[^"]*"\]:(\d+):/g, (_all, n) => {
    const line = Number(n) - offset;
    return line > 0 ? `line ${line}:` : "cartbox:";
  });
}
function errorStack(message) {
  const at = /\nat (.*)$/m.exec(message);
  if (!at) return [];
  const frames = [];
  for (const part of at[1].split(" < ")) {
    const m = /^(.*):(\d+)$/.exec(part.trim());
    if (m) frames.push({ name: m[1], line: Number(m[2]) });
  }
  return frames;
}
function debugSdkLua(address, options = {}) {
  const dbg = options.debugger === true;
  return `${dbg ? `local ${BREAK_HOOK}, __cbx_run
` : ""}do
  local _B = ${address}
  local function _rd(a)
    local v = peek(a) | (peek(a + 1) << 8) | (peek(a + 2) << 16) | (peek(a + 3) << 24)
    if v >= 0x80000000 then v = v - 0x100000000 end
    return v
  end
  local function _wr(a, v)
    v = math.floor(v) & 0xffffffff
    poke(a, v & 0xff) poke(a + 1, (v >> 8) & 0xff) poke(a + 2, (v >> 16) & 0xff) poke(a + 3, (v >> 24) & 0xff)
  end
  local function _live() return _rd(_B + ${DBG_MAGIC}) == ${DEBUG_MAGIC} end
  local _trace = trace
  trace = function(msg, color)
    if _trace then _trace(msg, color) end
    if not _live() then return end
    local s = tostring(msg)
    if #s > ${DBG_TRACE_MAX} then s = s:sub(1, ${DBG_TRACE_MAX}) end
    local used = _rd(_B + ${DBG_TRACE_USED})
    if used < 0 or used + 3 + #s > ${DBG_TRACE_BYTES} then
      _wr(_B + ${DBG_TRACE_DROPPED}, _rd(_B + ${DBG_TRACE_DROPPED}) + 1)
      return
    end
    local a = _B + ${DBG_TRACE_AT} + used
    poke(a, #s & 0xff) poke(a + 1, #s >> 8) poke(a + 2, (math.tointeger(color) or 15) & 0xff)
    for i = 1, #s do poke(a + 2 + i, s:byte(i)) end
    _wr(_B + ${DBG_TRACE_USED}, used + 3 + #s)
  end
  local _src = debug.getinfo(1, "S").source
  -- A cart line for a line of the merged source, or nil inside the injected code.
  local function _cart(n)
    local off = _live() and _rd(_B + ${DBG_LINE_OFFSET}) or 0
    local count = _live() and _rd(_B + ${DBG_LINE_COUNT}) or 0
    n = tonumber(n) - off
    if n < 1 or (count > 0 and n > count) then return nil end
    return n
  end
  local _tic = nil -- the cart's own TIC, once the debugger wraps it
  -- A function the core calls (TIC, BDR ...) has no name Lua can see: look it up.
  local function _name(info)
    if info.name then return info.name end
    if info.what == "main" then return "main" end
    if _tic and info.func == _tic then return "TIC" end
    for k, v in pairs(_G) do
      if v == info.func and type(k) == "string" then return k end
    end
    return "?"
  end
  -- The cart frames of a stack, innermost first: {name, line, level}.
  local function _frames(co, max)
    local out = {}
    for level = co and 0 or 2, 60 do
      local info
      if co then info = debug.getinfo(co, level, "Slnf") else info = debug.getinfo(level, "Slnf") end
      if not info then break end
      if info.source == _src and info.currentline and info.currentline > 0 then
        local l = _cart(info.currentline)
        if l then out[#out + 1] = { name = _name(info), line = l, level = level, func = info.func } end
      end
      if #out >= max then break end
    end
    return out
  end
  -- The core passes every runtime error through debug.traceback. Name cart
  -- lines, and keep it short: the core keeps only 256 bytes of it.
  local _tb = debug.traceback
  local function _traceback(co, msg)
    msg = tostring(msg or ""):gsub('^%[string "[^"]*"%]:(%d+):', function(n)
      local l = _cart(n)
      return l and ("line " .. l .. ":") or "cartbox:"
    end)
    local parts = {}
    for _, f in ipairs(_frames(co, 6)) do parts[#parts + 1] = f.name .. ":" .. f.line end
    if #parts > 0 then msg = msg .. "\\nat " .. table.concat(parts, " < ") end
    return msg
  end
  debug.traceback = function(msg, ...)
    if type(msg) ~= "string" and msg ~= nil then return _tb(msg, ...) end
    return _traceback(nil, msg)
  end${dbg ? debuggerLua() : ""}
end`;
}
function debuggerLua() {
  return `
  local _bps, _bpver, _armed = {}, -1, false
  local _step, _depth = 0, 0 -- step: 1 into, 2 over, 3 out
  local _co = nil
  local function _stackdepth()
    local d = 0
    for level = 2, 250 do
      local info = debug.getinfo(level, "S")
      if not info then break end
      if info.source == _src then d = d + 1 end
    end
    return d
  end
  local function _loadbps()
    local v = _rd(_B + ${DBG_BP_VERSION})
    if v == _bpver then return end
    _bpver = v
    _bps = {}
    for i = 0, math.min(_rd(_B + ${DBG_BP_COUNT}), ${DBG_BPS_MAX}) - 1 do _bps[_rd(_B + ${DBG_BPS_AT} + i * 4)] = true end
  end
  ${BREAK_HOOK} = function(line)
    if not _armed then return end
    local stop = _bps[line]
    if not stop then
      if _step == 1 then stop = true
      elseif _step == 2 then stop = _stackdepth() <= _depth
      elseif _step == 3 then stop = _stackdepth() < _depth end
    end
    if not stop or not coroutine.isyieldable() then return end
    _depth = _stackdepth()
    _step = 0
    _wr(_B + ${DBG_PAUSED_LINE}, line)
    _wr(_B + ${DBG_STATE}, 1)
    coroutine.yield()
    local cmd = _rd(_B + ${DBG_COMMAND})
    _wr(_B + ${DBG_COMMAND}, 0)
    _wr(_B + ${DBG_STATE}, 0)
    _step = (cmd == ${DebugCommand.into} and 1) or (cmd == ${DebugCommand.over} and 2) or (cmd == ${DebugCommand.out} and 3) or 0
    _armed = _step ~= 0 or next(_bps) ~= nil
  end
  local function _fmt(v, deep)
    local t = type(v)
    if t == "string" then
      if #v > 40 then v = v:sub(1, 40) .. "..." end
      return (string.format("%q", v):gsub("\\n", "n"))
    elseif t == "number" then
      return math.type(v) == "integer" and tostring(v) or string.format("%.4g", v)
    elseif t == "table" then
      if deep then return "{...}" end
      local parts, n = {}, 0
      for k, x in pairs(v) do
        n = n + 1
        if n <= 4 then parts[#parts + 1] = (type(k) == "string" and k or ("[" .. tostring(k) .. "]")) .. "=" .. _fmt(x, true) end
      end
      return "{" .. table.concat(parts, ", ") .. (n > 4 and (", ... " .. n .. " in all") or "") .. "}"
    elseif t == "function" then
      return "function"
    end
    return tostring(v)
  end
  local function _show(v)
    local ok, s = pcall(_fmt, v)
    s = ok and s or "?"
    return #s > 90 and (s:sub(1, 90) .. "...") or s
  end
  -- Write where the cart stopped: its stack, the stopped function's locals and
  -- upvalues, and each watch expression's value there.
  local function _writeinfo(co)
    local lines = {}
    local frames = _frames(co, 8)
    for _, f in ipairs(frames) do lines[#lines + 1] = "S " .. f.name .. ":" .. f.line end
    local top = frames[1]
    local scope = {}
    if top then
      for i = 1, 200 do
        local k, v = debug.getlocal(co, top.level, i)
        if not k then break end
        if k:sub(1, 1) ~= "(" then scope[k] = { v }; lines[#lines + 1] = "L " .. k .. "=" .. _show(v) end
      end
      for i = 1, 60 do
        local k, v = debug.getupvalue(top.func, i)
        if not k then break end
        if k ~= "_ENV" and k ~= "${BREAK_HOOK}" and not scope[k] then scope[k] = { v }; lines[#lines + 1] = "U " .. k .. "=" .. _show(v) end
      end
    end
    local env = setmetatable({}, { __index = function(_, k)
      local s = scope[k]
      if s then return s[1] end
      return _G[k]
    end })
    local n = _rd(_B + ${DBG_WATCH_LENGTH})
    local text = {}
    for i = 0, math.min(n, ${DBG_WATCH_BYTES}) - 1 do text[#text + 1] = string.char(peek(_B + ${DBG_WATCH_AT} + i)) end
    local index = 0
    for expr in (table.concat(text) .. "\\n"):gmatch("([^\\n]*)\\n") do
      index = index + 1
      if expr:match("%S") then
        local f, err = load("return " .. expr, "=watch", "t", env)
        local ok, v = false, err
        if f then ok, v = pcall(f) end
        lines[#lines + 1] = "W " .. index .. (ok and ("=" .. _show(v)) or ("!" .. tostring(v):gsub("^watch:1: ", ""))):sub(1, 120)
      end
    end
    local out = table.concat(lines, "\\n")
    if #out > ${DBG_INFO_BYTES} then out = out:sub(1, ${DBG_INFO_BYTES}) end
    for i = 1, #out do poke(_B + ${DBG_INFO_AT} + i - 1, out:byte(i)) end
    _wr(_B + ${DBG_INFO_LENGTH}, #out)
  end
  -- Run one frame of the cart's TIC: straight through when nothing can stop it,
  -- else in a coroutine the hooks can yield from, carrying on from a stop.
  __cbx_run = function(tic)
    _tic = tic
    if not _live() then return tic() end
    _loadbps()
    if _co then
      if _rd(_B + ${DBG_STATE}) == 1 then
        local cmd = _rd(_B + ${DBG_COMMAND})
        if cmd == ${DebugCommand.refresh} then
          _wr(_B + ${DBG_COMMAND}, 0)
          _writeinfo(_co)
        end
        if cmd < ${DebugCommand.continue} or cmd > ${DebugCommand.out} then return end
      end
    else
      _armed = _step ~= 0 or next(_bps) ~= nil
      if not _armed then return tic() end
      _co = coroutine.create(tic)
    end
    local ok, err = coroutine.resume(_co)
    if not ok then
      local co = _co
      _co = nil
      _step = 0
      _wr(_B + ${DBG_STATE}, 0)
      error(_traceback(co, err), 0)
    end
    if coroutine.status(_co) == "dead" then
      _co = nil
    else
      _writeinfo(_co)
    end
  end`;
}
function debugPostlude() {
  return `do local _t = TIC if type(_t) == "function" then TIC = function() __cbx_run(_t) end end end`;
}
function parsePauseInfo(line, text, watchCount) {
  const stack = [];
  const locals = [];
  const upvalues = [];
  const watches = Array.from({ length: watchCount }, () => ({ value: "", error: false }));
  for (const row of text.split("\n")) {
    const kind = row.slice(0, 2);
    const body = row.slice(2);
    if (kind === "S ") {
      const m = /^(.*):(\d+)$/.exec(body);
      if (m) stack.push({ name: m[1], line: Number(m[2]) });
    } else if (kind === "L " || kind === "U ") {
      const eq = body.indexOf("=");
      if (eq > 0) (kind === "L " ? locals : upvalues).push({ name: body.slice(0, eq), value: body.slice(eq + 1) });
    } else if (kind === "W ") {
      const m = /^(\d+)([=!])(.*)$/s.exec(body);
      const index = m ? Number(m[1]) - 1 : -1;
      if (m && index >= 0 && index < watchCount) watches[index] = { value: m[3], error: m[2] === "!" };
    }
  }
  return { line, stack, locals, upvalues, watches };
}
function readPause(block, watchCount) {
  if (block.getInt32(DBG_STATE, true) !== 1) return null;
  const length = Math.max(0, Math.min(block.getInt32(DBG_INFO_LENGTH, true), DBG_INFO_BYTES));
  const text = new TextDecoder().decode(new Uint8Array(block.buffer, block.byteOffset + DBG_INFO_AT, length));
  return parsePauseInfo(block.getInt32(DBG_PAUSED_LINE, true), text, watchCount);
}
function sendDebugCommand(block, command) {
  block.setInt32(DBG_COMMAND, command, true);
}
function drainTraces(block) {
  const used = Math.min(block.getInt32(DBG_TRACE_USED, true), DBG_TRACE_BYTES);
  const dropped = block.getInt32(DBG_TRACE_DROPPED, true);
  const traces = [];
  if (used > 0) {
    const decoder = new TextDecoder();
    let at = 0;
    while (at + 3 <= used) {
      const length = block.getUint16(DBG_TRACE_AT + at, true);
      const color = block.getUint8(DBG_TRACE_AT + at + 2);
      const start = DBG_TRACE_AT + at + 3;
      if (at + 3 + length > used) break;
      traces.push({ text: decoder.decode(new Uint8Array(block.buffer, block.byteOffset + start, length)), color });
      at += 3 + length;
    }
  }
  if (used !== 0) block.setInt32(DBG_TRACE_USED, 0, true);
  if (dropped !== 0) block.setInt32(DBG_TRACE_DROPPED, 0, true);
  return { traces, dropped: Math.max(0, dropped) };
}
function armDebugBlock(block, lineOffset, lineCount = 0) {
  block.setUint32(DBG_MAGIC, DEBUG_MAGIC, true);
  block.setInt32(DBG_LINE_OFFSET, lineOffset, true);
  block.setInt32(DBG_LINE_COUNT, lineCount, true);
}
function writeBreakpoints(block, lines) {
  const list = lines.slice(0, DBG_BPS_MAX);
  list.forEach((line, i) => block.setInt32(DBG_BPS_AT + i * 4, line, true));
  block.setInt32(DBG_BP_COUNT, list.length, true);
  block.setInt32(DBG_BP_VERSION, block.getInt32(DBG_BP_VERSION, true) + 1 | 0, true);
}
function writeWatches(block, expressions) {
  const encoder = new TextEncoder();
  let bytes = new Uint8Array(0);
  let fitted = 0;
  for (const expr of expressions) {
    const next = encoder.encode((fitted > 0 ? "\n" : "") + expr.replace(/\n/g, " "));
    if (bytes.length + next.length > DBG_WATCH_BYTES) break;
    const joined = new Uint8Array(bytes.length + next.length);
    joined.set(bytes);
    joined.set(next, bytes.length);
    bytes = joined;
    fitted += 1;
  }
  new Uint8Array(block.buffer, block.byteOffset + DBG_WATCH_AT, bytes.length).set(bytes);
  block.setInt32(DBG_WATCH_LENGTH, bytes.length, true);
  return fitted;
}

// src/actionsSdk.ts
var INPUT_BLOCK_BYTES = 16;
var INPUT_MAGIC = 1095320131;
var INPUT_HELD = 4;
var INPUT_PREVIOUS = 8;
function inputBlockAddress(layout) {
  return debugBlockAddress(layout) - INPUT_BLOCK_BYTES;
}
function writeInputBlock(block, held, previous) {
  block.setUint32(0, INPUT_MAGIC, true);
  block.setUint32(INPUT_HELD, held >>> 0, true);
  block.setUint32(INPUT_PREVIOUS, previous >>> 0, true);
}
var lua2 = (s) => JSON.stringify(s);
function actionsSdkLua(actions, layout) {
  if (!actions || actions.length === 0) return "";
  const names = actions.map((a) => lua2(a.name));
  const idx = actions.map((a, i) => `[${lua2(a.name)}]=${i}`);
  const buttons = actions.map((a) => `{${a.buttons.join(",")}}`);
  const keyLabels = actions.map((a) => lua2(actionLabel(a, "keyboard")));
  const padLabels = actions.map((a) => lua2(actionLabel(a, "pad")));
  return `do
local _A = ${inputBlockAddress(layout)}
local NAMES = {${names.join(",")}}
local IDX = {${idx.join(",")}}
local BTN = {${buttons.join(",")}}
local LK, LP = {${keyLabels.join(",")}}, {${padLabels.join(",")}}
local function rd(a) return peek(a) | (peek(a + 1) << 8) | (peek(a + 2) << 16) | (peek(a + 3) << 24) end
local function index(n) if type(n) == "number" then return n end return IDX[n] end
local function any(i, f) for _, b in ipairs(BTN[i + 1] or {}) do if f(b) then return true end end return false end
-- now, before (nil for an unknown action); without the host, from the console buttons.
local function state(n)
  local i = index(n)
  if i == nil or i < 0 or i >= #NAMES then return nil end
  if rd(_A) ~= ${INPUT_MAGIC} then
    local now = any(i, btn)
    return now, now and not any(i, btnp)
  end
  return (rd(_A + ${INPUT_HELD}) >> i) & 1 == 1, (rd(_A + ${INPUT_PREVIOUS}) >> i) & 1 == 1
end
cartbox.action = function(n) local now = state(n) return now == true end
cartbox.actionp = function(n) local now, before = state(n) return now == true and not before end
cartbox.actionr = function(n) local now, before = state(n) return now == false and before == true end
cartbox.actions = function() local out = {} for i, v in ipairs(NAMES) do out[i] = v end return out end
cartbox.actionlabel = function(n, device)
  local i = index(n)
  if i == nil then return "" end
  return (device == "pad" and LP or LK)[i + 1] or ""
end
end`;
}
function readSidecarActions(raw) {
  if (!raw) return [];
  try {
    return parseInputActions(JSON.parse(raw).actions);
  } catch {
    return [];
  }
}

// src/stringsSdk.ts
var lua3 = (s) => JSON.stringify(s);
function playLanguage(table, preferred) {
  return table ? pickLanguage(table, preferred ?? []) : null;
}
var INPUT_SETTINGS = 12;
function writeInputSettings(block, accessibility, languageIndex, revision) {
  block.setUint8(INPUT_SETTINGS, Math.max(0, TEXT_SCALES.indexOf(accessibility.textScale)));
  block.setUint8(INPUT_SETTINGS + 1, Math.max(0, COLOR_FILTERS.indexOf(accessibility.colorFilter)));
  block.setUint8(INPUT_SETTINGS + 2, Math.max(0, Math.min(255, languageIndex)));
  block.setUint8(INPUT_SETTINGS + 3, revision & 255);
}
function stringsSdkLua(table, language, accessibility, live) {
  const parts = [];
  const startScale = accessibility?.textScale ?? 1;
  const startFilter = accessibility?.colorFilter ?? "none";
  if (live !== void 0 && live !== null && (table || accessibility)) {
    parts.push(`local _A = ${live}
local TS = {${TEXT_SCALES.join(",")}}
local CF = {${COLOR_FILTERS.map(lua3).join(",")}}
local function live(i)
  if (peek(_A) | (peek(_A + 1) << 8) | (peek(_A + 2) << 16) | (peek(_A + 3) << 24)) ~= ${INPUT_MAGIC} then return nil end
  return peek(_A + ${INPUT_SETTINGS} + i)
end
cartbox.textscale = function() local v = live(0) if v == nil then return ${startScale} end return TS[v + 1] or 1 end
cartbox.colorfilter = function() local v = live(1) if v == nil then return ${lua3(startFilter)} end return CF[v + 1] or "none" end`);
  } else if (accessibility && (accessibility.textScale !== 1 || accessibility.colorFilter !== "none")) {
    parts.push(`cartbox.textscale = function() return ${startScale} end
cartbox.colorfilter = function() return ${lua3(startFilter)} end`);
  }
  if (table && table.languages.length > 0) {
    const byLanguage = table.languages.map((l) => {
      const rows = table.entries.flatMap((e) => e.text[l] !== void 0 ? [`[${lua3(e.key)}]=${lua3(e.text[l])}`] : []);
      return `[${lua3(l)}]={${rows.join(",")}}`;
    });
    const current = language && table.languages.includes(language) ? language : table.fallback;
    const liveLanguage = live !== void 0 && live !== null;
    parts.push(`local S = {${byLanguage.join(",\n")}}
local LANGS = {${table.languages.map(lua3).join(",")}}
local FALLBACK, lang = ${lua3(table.fallback)}, ${lua3(current)}
${liveLanguage ? `-- The host's language choice, adopted whenever it changes (the cart's own setlanguage holds until then).
local seen = nil
local function sync()
  local rev = live(3)
  if rev == nil or rev == seen then return end
  seen = rev
  local i = live(2)
  if i and i > 0 and LANGS[i] then lang = LANGS[i] end
end` : "local function sync() end"}
local function fill(s, a)
  local t = type(a[1]) == "table" and a[1] or nil
  return (string.gsub(s, "{(%w+)}", function(n)
    local v
    if tonumber(n) then v = a[tonumber(n)] elseif t then v = t[n] end
    if v == nil then return nil end
    return tostring(v)
  end))
end
cartbox.text = function(k, ...)
  sync()
  local s = S[lang][k] or S[FALLBACK][k] or tostring(k)
  return fill(s, {...})
end
cartbox.language = function() sync() return lang end
cartbox.languages = function() local out = {} for i, l in ipairs(LANGS) do out[i] = l end return out end
cartbox.setlanguage = function(l) sync() if S[l] then lang = l return true end return false end`);
  }
  return parts.length > 0 ? `do
${parts.join("\n")}
end` : "";
}

// src/saveSdk.ts
var SAVE_MAGIC = 1448297027;
var SAVE_PENDING = 4;
var SAVE_SAVED = 1;
var SAVE_ERASED = 2;
var SAVE_LENGTH = 8;
var SAVE_DATA = 12;
function saveBlockBytes(layout) {
  return layout.ramSize <= 98304 ? 448 : 16384;
}
function saveCapacity(layout) {
  return saveBlockBytes(layout) - SAVE_DATA;
}
function saveBlockAddress(layout) {
  return inputBlockAddress(layout) - saveBlockBytes(layout);
}
function armSaveBlock(block) {
  block.setUint32(0, SAVE_MAGIC, true);
}
function takeSave(block) {
  const pending = block.getUint32(SAVE_PENDING, true);
  if (pending === 0) return null;
  block.setUint32(SAVE_PENDING, 0, true);
  if (pending === SAVE_ERASED) return { data: null };
  if (pending !== SAVE_SAVED) return null;
  const length = block.getUint32(SAVE_LENGTH, true);
  if (length === 0 || length > block.byteLength - SAVE_DATA) return null;
  const text = new TextDecoder().decode(new Uint8Array(block.buffer, block.byteOffset + SAVE_DATA, length).slice());
  const data = validSave(text);
  return data ? { data } : null;
}
function validSave(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? text : null;
  } catch {
    return null;
  }
}
var luaLong = (s) => {
  let eq = "";
  while (s.includes(`]${eq}]`)) eq += "=";
  return `[${eq}[${s}]${eq}]`;
};
function saveSdkLua(layout, saved) {
  const start = validSave(saved);
  return `do
local _S, _CAP = ${saveBlockAddress(layout)}, ${saveCapacity(layout)}
local saved = ${start ? luaLong(start) : "nil"}
local function wr(a, v) poke(a, v & 0xff) poke(a + 1, (v >> 8) & 0xff) poke(a + 2, (v >> 16) & 0xff) poke(a + 3, (v >> 24) & 0xff) end
local ESC = { ['"'] = '\\\\"', ['\\\\'] = '\\\\\\\\', ['\\b'] = '\\\\b', ['\\f'] = '\\\\f', ['\\n'] = '\\\\n', ['\\r'] = '\\\\r', ['\\t'] = '\\\\t' }
local function enc(v, out, depth)
  local t = type(v)
  if depth > 32 then error("nested too deep", 0) end
  if v == nil then out[#out + 1] = "null"
  elseif t == "boolean" then out[#out + 1] = v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then out[#out + 1] = "null"
    elseif math.type(v) == "integer" then out[#out + 1] = string.format("%d", v)
    else out[#out + 1] = string.format("%.14g", v) end
  elseif t == "string" then
    out[#out + 1] = '"' .. v:gsub('[%c"\\\\]', function(c) return ESC[c] or string.format("\\\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    local n = #v
    local list = n > 0
    if list then for k in pairs(v) do if math.type(k) ~= "integer" or k < 1 or k > n then list = false break end end end
    if list then
      out[#out + 1] = "["
      for i = 1, n do if i > 1 then out[#out + 1] = "," end enc(v[i], out, depth + 1) end
      out[#out + 1] = "]"
    else
      out[#out + 1] = "{"
      local first = true
      for k, x in pairs(v) do
        local kt = type(k)
        if kt ~= "string" and kt ~= "number" then error("can't save a " .. kt .. " key", 0) end
        if not first then out[#out + 1] = "," end
        first = false
        enc(tostring(k), out, depth + 1)
        out[#out + 1] = ":"
        enc(x, out, depth + 1)
      end
      out[#out + 1] = "}"
    end
  else error("can't save a " .. t, 0) end
end
local function dec(s)
  local i = 1
  local function ws() i = s:find("[^ \\t\\r\\n]", i) or #s + 1 end
  local value
  local function str()
    local out, j = {}, i + 1
    while true do
      local c = s:sub(j, j)
      if c == "" then error("bad save", 0) end
      if c == '"' then i = j + 1 return table.concat(out) end
      if c == "\\\\" then
        local e = s:sub(j + 1, j + 1)
        local map = { b = "\\b", f = "\\f", n = "\\n", r = "\\r", t = "\\t" }
        if e == "u" then out[#out + 1] = utf8.char(tonumber(s:sub(j + 2, j + 5), 16) or 63) j = j + 6
        else out[#out + 1] = map[e] or e j = j + 2 end
      else out[#out + 1] = c j = j + 1 end
    end
  end
  value = function(depth)
    if depth > 32 then error("bad save", 0) end
    ws()
    local c = s:sub(i, i)
    if c == "{" then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == "}" then i = i + 1 return t end
      while true do
        ws()
        if s:sub(i, i) ~= '"' then error("bad save", 0) end
        local k = str()
        ws()
        if s:sub(i, i) ~= ":" then error("bad save", 0) end
        i = i + 1
        t[k] = value(depth + 1)
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "}" then return t elseif d ~= "," then error("bad save", 0) end
      end
    elseif c == "[" then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == "]" then i = i + 1 return t end
      while true do
        t[#t + 1] = value(depth + 1)
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "]" then return t elseif d ~= "," then error("bad save", 0) end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4 return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5 return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4 return nil
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      if not num or num == "" then error("bad save", 0) end
      i = i + #num
      return math.tointeger(tonumber(num)) or tonumber(num)
    end
  end
  return value(0)
end
local function publish(text)
  local n = #text
  for k = 1, n do poke(_S + ${SAVE_DATA} + k - 1, text:byte(k)) end
  wr(_S + ${SAVE_LENGTH}, n)
  wr(_S + ${SAVE_PENDING}, n > 0 and ${SAVE_SAVED} or ${SAVE_ERASED})
end
cartbox.save = function(t)
  if type(t) ~= "table" then return false, "save a table" end
  local out = {}
  local ok, err = pcall(enc, t, out, 0)
  if not ok then return false, err end
  local text = table.concat(out)
  if #text > _CAP then return false, "too big" end
  saved = text
  publish(text)
  return true
end
cartbox.load = function()
  if not saved then return nil end
  local ok, t = pcall(dec, saved)
  if ok and type(t) == "table" then return t end
  return nil
end
cartbox.erase = function()
  saved = nil
  publish("")
end
end`;
}

// src/runtime/commandRing.ts
var CMD_RING_BYTES = 131072;
var CMD_RING_MAX = Math.floor((CMD_RING_BYTES - 4) / PHYS_CMD_BYTES);
function commandRingBytes(layout) {
  const free = saveBlockAddress(layout) - (layout.pmemAddress + 4128);
  for (const bytes of [CMD_RING_BYTES, 65536]) if (free >= bytes + 4096) return bytes;
  return 0;
}
function commandRingMax(layout) {
  const bytes = commandRingBytes(layout);
  return bytes > 0 ? Math.floor((bytes - 4) / PHYS_CMD_BYTES) : 0;
}
function hasCommandRing(layout) {
  return commandRingBytes(layout) > 0 && saveBlockBytes(layout) > 0;
}
function commandRingAddress(layout) {
  return hasCommandRing(layout) ? saveBlockAddress(layout) - commandRingBytes(layout) : null;
}
function commandsPerTick(layout) {
  return PHYS_MAX_CMDS + (hasCommandRing(layout) ? commandRingMax(layout) : 0);
}
function takeRingCommands(ring, max = Math.floor((ring.byteLength - 4) / PHYS_CMD_BYTES)) {
  return takeCommandsAt(ring, 0, max);
}
function resetCommandRing(ring) {
  ring.setInt32(0, 0, true);
}

// src/cartridge.ts
var CartridgeLoadError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "CartridgeLoadError";
  }
};
var MINIMUM_CARTRIDGE_BYTES = 4;
async function fetchCartridge(cartUrl, signal) {
  let response;
  try {
    response = await fetch(cartUrl, { signal });
  } catch (networkError) {
    throw new CartridgeLoadError(`Failed to reach cartridge at ${cartUrl}`, networkError);
  }
  if (!response.ok) {
    throw new CartridgeLoadError(`Cartridge request failed (${response.status}) for ${cartUrl}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MINIMUM_CARTRIDGE_BYTES) {
    throw new CartridgeLoadError(`Cartridge at ${cartUrl} is empty or truncated`);
  }
  return bytes;
}

// src/display.ts
function computeScaledSize(containerWidth, containerHeight, nativeWidth, nativeHeight, mode) {
  let scale;
  if (typeof mode === "number") {
    scale = mode;
  } else {
    const bestFitScale = Math.min(containerWidth / nativeWidth, containerHeight / nativeHeight);
    scale = mode === "integer" ? Math.max(1, Math.floor(bestFitScale)) : bestFitScale;
  }
  return {
    width: nativeWidth * scale,
    height: nativeHeight * scale,
    scale
  };
}
var CanvasSurface = class {
  constructor(container, scaleMode, model) {
    this.container = container;
    this.scaleMode = scaleMode;
    this.model = model;
    this.canvas = container.ownerDocument.createElement("canvas");
    this.canvas.width = model.width;
    this.canvas.height = model.height;
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("2D canvas context unavailable in this environment");
    }
    this.context = context;
    this.frame = context.createImageData(model.width, model.height);
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }
  /** Copies an RGBA framebuffer from the engine to the canvas. */
  blit(rgba) {
    const expected = this.model.width * this.model.height * this.model.pixelBytes;
    if (rgba.byteLength !== expected) {
      throw new Error(`Framebuffer size mismatch: expected ${expected}, got ${rgba.byteLength}`);
    }
    this.frame.data.set(rgba);
    this.context.putImageData(this.frame, 0, 0);
  }
  /** Recomputes CSS size from the current container dimensions. */
  applyScale() {
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
  /** Removes the canvas and stops observing resizes. */
  destroy() {
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }
};

// src/lighting/lightingModel.ts
var NORMAL_DIRECTION_COUNT = 16;
var COMPASS_TILT = 0.55;
function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
function buildNormalVectors() {
  const compassOffsets = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1]
  ];
  const directions = [[0, 0, 1]];
  for (const [offsetX, offsetY] of compassOffsets) {
    const x = offsetX * COMPASS_TILT;
    const y = offsetY * COMPASS_TILT;
    const z = Math.sqrt(Math.max(1e-4, 1 - x * x - y * y));
    directions.push(normalize([x, y, z]));
  }
  while (directions.length < NORMAL_DIRECTION_COUNT) directions.push([0, 0, 1]);
  return directions;
}
var NORMAL_VECTORS = buildNormalVectors();
function normalVector(direction) {
  return NORMAL_VECTORS[direction] ?? NORMAL_VECTORS[0];
}
function nearestDirection(vector) {
  const target = normalize(vector);
  let best = 0;
  let bestDot = -Infinity;
  for (let index = 0; index < NORMAL_VECTORS.length; index += 1) {
    const [nx, ny, nz] = NORMAL_VECTORS[index];
    const dot = nx * target[0] + ny * target[1] + nz * target[2];
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  }
  return best;
}
function interpolateNormal(corner00, corner10, corner01, corner11, fractionX, fractionY) {
  const lerp4 = (a, b, t) => a + (b - a) * t;
  const top = [
    lerp4(corner00[0], corner10[0], fractionX),
    lerp4(corner00[1], corner10[1], fractionX),
    lerp4(corner00[2], corner10[2], fractionX)
  ];
  const bottom = [
    lerp4(corner01[0], corner11[0], fractionX),
    lerp4(corner01[1], corner11[1], fractionX),
    lerp4(corner01[2], corner11[2], fractionX)
  ];
  return normalize([
    lerp4(top[0], bottom[0], fractionY),
    lerp4(top[1], bottom[1], fractionY),
    lerp4(top[2], bottom[2], fractionY)
  ]);
}
function sampleNormalBilinear(indexAt, sampleX, sampleY) {
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const fractionX = sampleX - x0;
  const fractionY = sampleY - y0;
  return interpolateNormal(
    normalVector(indexAt(x0, y0)),
    normalVector(indexAt(x0 + 1, y0)),
    normalVector(indexAt(x0, y0 + 1)),
    normalVector(indexAt(x0 + 1, y0 + 1)),
    fractionX,
    fractionY
  );
}
function sampleScalarBilinear(valueAt, sampleX, sampleY) {
  const x0 = Math.floor(sampleX);
  const y0 = Math.floor(sampleY);
  const fractionX = sampleX - x0;
  const fractionY = sampleY - y0;
  const top = valueAt(x0, y0) + (valueAt(x0 + 1, y0) - valueAt(x0, y0)) * fractionX;
  const bottom = valueAt(x0, y0 + 1) + (valueAt(x0 + 1, y0 + 1) - valueAt(x0, y0 + 1)) * fractionX;
  return top + (bottom - top) * fractionY;
}
var LIGHT_KIND_CODE = { point: 0, directional: 1, spot: 2 };
var DEFAULT_LIGHT_DIRECTION = [0, 0, 1];
var DEFAULT_SPOT_CONE_COS = 0.9;
function shade(albedo, normal, toLight, ambient) {
  const n = normalize(normal);
  const l = normalize(toLight);
  const diffuse = Math.max(0, n[0] * l[0] + n[1] * l[1] + n[2] * l[2]);
  const intensity = ambient + (1 - ambient) * diffuse;
  const clamp5 = (value) => Math.max(0, Math.min(255, Math.round(value * intensity)));
  return [clamp5(albedo[0]), clamp5(albedo[1]), clamp5(albedo[2])];
}

// src/lighting/LightingRenderer.ts
function createFlatMaterial(width, height) {
  const material = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) material[i * 4 + 3] = 255;
  return material;
}

// src/lighting/LightingLayer.ts
var MAX_LIGHTS = 6;
var HEIGHT_MAX = 8;
var DEFAULT_SUPERSAMPLE = 2;
var QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
var QUAD_VS_FLIP = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = vec2((aPos.x + 1.0) * 0.5, (1.0 - aPos.y) * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
var LIGHT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uAlbedo;   // rgb + emissive
uniform sampler2D uMat;      // r=normalIdx/255, g=height, b=spec, a=rough
uniform vec3 uNormals[16];
uniform vec3 uLightPos[${MAX_LIGHTS}];
uniform vec3 uLightColor[${MAX_LIGHTS}];
uniform float uLightRadius[${MAX_LIGHTS}];
uniform float uLightKind[${MAX_LIGHTS}];   // 0 point, 1 directional, 2 spot
uniform vec3 uLightDir[${MAX_LIGHTS}];     // directional: toward light; spot: beam axis
uniform float uLightCone[${MAX_LIGHTS}];   // spot inner-cone cosine
uniform int uLightCount;
uniform float uAmbient;
uniform vec3 uAmbientColor;
uniform vec2 uResolution;
uniform float uEnableShadows;
uniform float uSmoothNormals;
uniform int uUnlit;

const float HMAX = ${HEIGHT_MAX.toFixed(1)};
const vec3 VIEW = vec3(0.0, -0.34, 0.94);

vec3 normalFor(float idxF) {
  int idx = int(idxF + 0.5);
  vec3 n = vec3(0.0, 0.0, 1.0);
  for (int k = 0; k < 16; k++) { if (k == idx) n = uNormals[k]; }
  return n;
}

// The smoothed normal at a UV: bilinearly blend the decoded normals of the four
// surrounding material texels (interpolateNormal / sampleNormalBilinear in
// lightingModel.ts). Blends the vectors, never the indices \u2014 the palette is
// unordered \u2014 so the 16-facet banding melts to a continuous field. A uniform
// region returns that region's normal unchanged.
vec3 sampleNormalSmooth(vec2 uv) {
  vec2 texelSpace = uv * uResolution - 0.5;
  vec2 base = floor(texelSpace);
  vec2 f = texelSpace - base;
  vec2 inv = 1.0 / uResolution;
  vec3 n00 = normalFor(texture2D(uMat, (base + vec2(0.5, 0.5)) * inv).r * 255.0);
  vec3 n10 = normalFor(texture2D(uMat, (base + vec2(1.5, 0.5)) * inv).r * 255.0);
  vec3 n01 = normalFor(texture2D(uMat, (base + vec2(0.5, 1.5)) * inv).r * 255.0);
  vec3 n11 = normalFor(texture2D(uMat, (base + vec2(1.5, 1.5)) * inv).r * 255.0);
  return normalize(mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y));
}

// The smoothed ramp channels (g=height, b=spec, a=rough) at a UV: the scalar
// twin of sampleNormalSmooth (sampleScalarBilinear in lightingModel.ts). The
// four ramp channels are 4-bit, so a painted gradient steps; hardware LINEAR
// can't do this because .r is an unindexable normal index, so the blend is done
// by hand here, per channel. .r is deliberately left off the result.
vec3 sampleRampSmooth(vec2 uv) {
  vec2 texelSpace = uv * uResolution - 0.5;
  vec2 base = floor(texelSpace);
  vec2 f = texelSpace - base;
  vec2 inv = 1.0 / uResolution;
  vec4 m00 = texture2D(uMat, (base + vec2(0.5, 0.5)) * inv);
  vec4 m10 = texture2D(uMat, (base + vec2(1.5, 0.5)) * inv);
  vec4 m01 = texture2D(uMat, (base + vec2(0.5, 1.5)) * inv);
  vec4 m11 = texture2D(uMat, (base + vec2(1.5, 1.5)) * inv);
  return mix(mix(m00, m10, f.x), mix(m01, m11, f.x), f.y).gba; // height, spec, rough
}

float heightAt(vec2 p) { return texture2D(uMat, p / uResolution).g * HMAX; }

float shadowFactor(vec2 px, float h0, vec3 lightPos) {
  vec2 d = lightPos.xy - px;
  float dist = length(d);
  if (dist < 0.001) return 1.0;
  for (int i = 1; i <= 16; i++) {
    float t = float(i) / 16.0;
    float rayH = mix(h0, lightPos.z, t);
    if (heightAt(px + d * t) > rayH + 0.45) return 0.25;
  }
  return 1.0;
}

// A directional light has no position, so its shadow marches a fixed number of
// pixel steps up the to-light direction, rising by the ray's slope each step.
float dirShadowFactor(vec2 px, float h0, vec3 toLight) {
  float len = length(toLight.xy);
  if (len < 0.05) return 1.0;              // key is overhead: no long shadow
  vec2 step = (toLight.xy / len) * 3.0;
  float slope = toLight.z / len;           // height gained per pixel toward the light
  for (int i = 1; i <= 16; i++) {
    float rayH = h0 + slope * float(i) * 3.0;
    if (heightAt(px + step * float(i)) > rayH + 0.45) return 0.25;
  }
  return 1.0;
}

void main() {
  vec4 alb = texture2D(uAlbedo, vUv);
  if (uUnlit == 1) { gl_FragColor = vec4(alb.rgb, 1.0); return; } // passthrough
  vec4 m = texture2D(uMat, vUv);
  vec3 n = uSmoothNormals > 0.5 ? sampleNormalSmooth(vUv) : normalFor(m.r * 255.0);
  // The same flag de-bands the ramp channels: normals and ramps smooth together.
  vec3 ramp = uSmoothNormals > 0.5 ? sampleRampSmooth(vUv) : m.gba;
  float height = ramp.x * HMAX;
  float specStr = ramp.y;
  float rough = ramp.z;
  float emissive = alb.a;
  vec2 px = vUv * uResolution;

  float shininess = mix(6.0, 120.0, 1.0 - rough);
  vec3 lightSum = uAmbient * uAmbientColor;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= uLightCount) break;
    float kind = uLightKind[i];
    vec3 L;
    float atten;
    float shadow;
    if (kind > 0.5 && kind < 1.5) {
      // Directional: parallel rays toward uLightDir, no distance falloff.
      L = normalize(uLightDir[i]);
      atten = 1.0;
      shadow = uEnableShadows > 0.5 ? dirShadowFactor(px, height, L) : 1.0;
    } else {
      // Point and spot both radiate from a position.
      vec3 toLight = vec3(uLightPos[i].xy - px, uLightPos[i].z - height);
      float dist = length(toLight.xy);
      atten = clamp(1.0 - dist / uLightRadius[i], 0.0, 1.0);
      atten *= atten;
      L = normalize(toLight);
      shadow = uEnableShadows > 0.5 ? shadowFactor(px, height, uLightPos[i]) : 1.0;
      if (kind > 1.5) {
        // Spot: gate by how well the beam axis aligns with this pixel.
        vec3 axis = normalize(uLightDir[i]);
        vec3 beam = normalize(vec3(px - uLightPos[i].xy, height - uLightPos[i].z));
        float alignment = dot(beam, axis);
        float inner = uLightCone[i];
        float outer = inner - 0.15;        // matches SPOT_CONE_SOFTNESS
        atten *= clamp((alignment - outer) / max(1e-3, inner - outer), 0.0, 1.0);
      }
    }
    float diffuse = max(0.0, dot(n, L)) * shadow;
    vec3 halfVec = normalize(L + VIEW);
    float specular = pow(max(0.0, dot(n, halfVec)), shininess) * specStr * shadow;
    lightSum += uLightColor[i] * atten * (diffuse + specular);
  }
  float rim = pow(1.0 - max(0.0, dot(n, VIEW)), 3.0);
  lightSum += rim * uAmbientColor * 0.5;

  vec3 lit = alb.rgb * lightSum;
  lit = max(lit, alb.rgb * emissive);
  gl_FragColor = vec4(lit, 1.0);
}`;
var BRIGHT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.25, l), 1.0);
}`;
var BLUR_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform vec2 uTexel;
void main() {
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227;
  sum += texture2D(uTex, vUv + uDir * uTexel * 1.0).rgb * 0.194;
  sum += texture2D(uTex, vUv - uDir * uTexel * 1.0).rgb * 0.194;
  sum += texture2D(uTex, vUv + uDir * uTexel * 2.0).rgb * 0.121;
  sum += texture2D(uTex, vUv - uDir * uTexel * 2.0).rgb * 0.121;
  sum += texture2D(uTex, vUv + uDir * uTexel * 3.0).rgb * 0.054;
  sum += texture2D(uTex, vUv - uDir * uTexel * 3.0).rgb * 0.054;
  gl_FragColor = vec4(sum, 1.0);
}`;
var COMPOSITE_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform int uUseBloom;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  if (uUseBloom == 1) c += texture2D(uBloom, vUv).rgb * uBloomStrength;
  gl_FragColor = vec4(c, 1.0);
}`;
var LightingLayer = class {
  constructor(renderCanvas, width, height, supersample = DEFAULT_SUPERSAMPLE) {
    this.renderCanvas = renderCanvas;
    this.width = width;
    this.height = height;
    this.supersample = supersample;
    this.backend = "webgl";
    this.lightPos = new Float32Array(MAX_LIGHTS * 3);
    this.lightColor = new Float32Array(MAX_LIGHTS * 3);
    this.lightRadius = new Float32Array(MAX_LIGHTS);
    this.lightKind = new Float32Array(MAX_LIGHTS);
    this.lightDir = new Float32Array(MAX_LIGHTS * 3);
    this.lightCone = new Float32Array(MAX_LIGHTS);
    this.flatMaterial = null;
    renderCanvas.width = width;
    renderCanvas.height = height;
    const gl = renderCanvas.getContext("webgl", { antialias: false, alpha: false }) || renderCanvas.getContext("experimental-webgl");
    if (!gl) throw new Error("WebGL is unavailable; cannot create a LightingLayer");
    this.gl = gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.pLight = this.build(LIGHT_FS);
    this.pBright = this.build(BRIGHT_FS);
    this.pBlur = this.build(BLUR_FS);
    this.pComposite = this.build(COMPOSITE_FS, QUAD_VS_FLIP);
    this.albedoTex = this.makeDataTexture();
    this.matTex = this.makeDataTexture();
    const halfW = Math.max(1, width >> 1);
    const halfH = Math.max(1, height >> 1);
    this.scene = this.makeTarget(width * this.supersample, height * this.supersample, true);
    this.bright = this.makeTarget(halfW, halfH, true);
    this.blurA = this.makeTarget(halfW, halfH, true);
    this.blurB = this.makeTarget(halfW, halfH, true);
    this.flatNormals = new Float32Array(16 * 3);
    NORMAL_VECTORS.forEach((v, i) => {
      this.flatNormals[i * 3] = v[0];
      this.flatNormals[i * 3 + 1] = v[1];
      this.flatNormals[i * 3 + 2] = v[2];
    });
  }
  /** Whether a WebGL lighting context can be created on this canvas. */
  static isSupported(canvas) {
    try {
      return Boolean(
        canvas.getContext("webgl") || canvas.getContext("experimental-webgl")
      );
    } catch {
      return false;
    }
  }
  /**
   * Relight one frame and present it to the canvas.
   *
   * @param albedo   The cart's RGBA framebuffer (width*height*4 bytes).
   * @param material Optional per-pixel material (normal/height/spec/rough); when
   *                 null, pixels are lit flat.
   * @param scene    The lights and ambient for this frame.
   */
  render(albedo, material, scene) {
    const gl = this.gl;
    const material0 = material ?? this.flatMaterialBuffer();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, albedo);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.matTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, material0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scene.fbo);
    gl.viewport(0, 0, this.scene.width, this.scene.height);
    this.bindQuad(this.pLight);
    this.bindSampler(0, this.albedoTex, this.pLight, "uAlbedo");
    this.bindSampler(1, this.matTex, this.pLight, "uMat");
    gl.uniform3fv(this.uni(this.pLight, "uNormals"), this.flatNormals);
    gl.uniform2f(this.uni(this.pLight, "uResolution"), this.width, this.height);
    const count = Math.min(scene.lights.length, MAX_LIGHTS);
    for (let i = 0; i < count; i += 1) {
      const light = scene.lights[i];
      this.lightPos[i * 3] = light.x;
      this.lightPos[i * 3 + 1] = light.y;
      this.lightPos[i * 3 + 2] = light.z;
      this.lightColor[i * 3] = light.color[0];
      this.lightColor[i * 3 + 1] = light.color[1];
      this.lightColor[i * 3 + 2] = light.color[2];
      this.lightRadius[i] = light.radius;
      this.lightKind[i] = LIGHT_KIND_CODE[light.kind ?? "point"];
      const dir = light.direction ?? DEFAULT_LIGHT_DIRECTION;
      this.lightDir[i * 3] = dir[0];
      this.lightDir[i * 3 + 1] = dir[1];
      this.lightDir[i * 3 + 2] = dir[2];
      this.lightCone[i] = light.coneCos ?? DEFAULT_SPOT_CONE_COS;
    }
    gl.uniform3fv(this.uni(this.pLight, "uLightPos"), this.lightPos);
    gl.uniform3fv(this.uni(this.pLight, "uLightColor"), this.lightColor);
    gl.uniform1fv(this.uni(this.pLight, "uLightRadius"), this.lightRadius);
    gl.uniform1fv(this.uni(this.pLight, "uLightKind"), this.lightKind);
    gl.uniform3fv(this.uni(this.pLight, "uLightDir"), this.lightDir);
    gl.uniform1fv(this.uni(this.pLight, "uLightCone"), this.lightCone);
    gl.uniform1i(this.uni(this.pLight, "uLightCount"), count);
    gl.uniform1f(this.uni(this.pLight, "uAmbient"), scene.ambient);
    gl.uniform3f(this.uni(this.pLight, "uAmbientColor"), scene.ambientColor[0], scene.ambientColor[1], scene.ambientColor[2]);
    gl.uniform1f(this.uni(this.pLight, "uEnableShadows"), scene.shadows && material ? 1 : 0);
    gl.uniform1f(this.uni(this.pLight, "uSmoothNormals"), scene.smoothNormals ? 1 : 0);
    gl.uniform1i(this.uni(this.pLight, "uUnlit"), scene.unlit ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const useBloom = scene.bloom && !scene.unlit;
    if (useBloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bright.fbo);
      gl.viewport(0, 0, this.bright.width, this.bright.height);
      this.bindQuad(this.pBright);
      this.bindSampler(0, this.scene.tex, this.pBright, "uScene");
      gl.uniform1f(this.uni(this.pBright, "uThreshold"), 0.72);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.bindQuad(this.pBlur);
      gl.uniform2f(this.uni(this.pBlur, "uTexel"), 1 / this.bright.width, 1 / this.bright.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurA.fbo);
      gl.viewport(0, 0, this.blurA.width, this.blurA.height);
      this.bindSampler(0, this.bright.tex, this.pBlur, "uTex");
      gl.uniform2f(this.uni(this.pBlur, "uDir"), 1, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurB.fbo);
      gl.viewport(0, 0, this.blurB.width, this.blurB.height);
      this.bindSampler(0, this.blurA.tex, this.pBlur, "uTex");
      gl.uniform2f(this.uni(this.pBlur, "uDir"), 0, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    this.bindQuad(this.pComposite);
    this.bindSampler(0, this.scene.tex, this.pComposite, "uScene");
    this.bindSampler(1, useBloom ? this.blurB.tex : this.scene.tex, this.pComposite, "uBloom");
    gl.uniform1f(this.uni(this.pComposite, "uBloomStrength"), 1.1);
    gl.uniform1i(this.uni(this.pComposite, "uUseBloom"), useBloom ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  /** Releases all GL resources. */
  dispose() {
    const gl = this.gl;
    for (const p of [this.pLight, this.pBright, this.pBlur, this.pComposite]) gl.deleteProgram(p.program);
    for (const t of [this.albedoTex, this.matTex]) gl.deleteTexture(t);
    for (const target of [this.scene, this.bright, this.blurA, this.blurB]) {
      gl.deleteTexture(target.tex);
      gl.deleteFramebuffer(target.fbo);
    }
    gl.deleteBuffer(this.quad);
  }
  flatMaterialBuffer() {
    if (!this.flatMaterial) this.flatMaterial = createFlatMaterial(this.width, this.height);
    return this.flatMaterial;
  }
  uni(p, name) {
    if (!(name in p.uniforms)) p.uniforms[name] = this.gl.getUniformLocation(p.program, name);
    return p.uniforms[name] ?? null;
  }
  bindQuad(p) {
    const gl = this.gl;
    gl.useProgram(p.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(p.aPos);
    gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
  }
  bindSampler(unit, tex, p, name) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uni(p, name), unit);
  }
  build(fs, vs = QUAD_VS) {
    const program = linkProgram(this.gl, vs, fs);
    return { program, aPos: this.gl.getAttribLocation(program, "aPos"), uniforms: {} };
  }
  makeDataTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  makeTarget(width, height, linear) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width, height };
  }
};
function linkProgram(gl, vsSrc, fsSrc) {
  const compile2 = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("Lighting shader compile failed: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile2(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(program, compile2(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error("Lighting program link failed: " + gl.getProgramInfoLog(program));
  }
  return program;
}

// src/lighting/WebgpuLightingLayer.ts
var MAX_LIGHTS2 = 6;
var HEIGHT_MAX2 = 8;
var DEFAULT_SUPERSAMPLE2 = 2;
var TEXTURE_BINDING = 4;
var COPY_DST_TEX = 2;
var RENDER_ATTACHMENT = 16;
var UNIFORM = 64;
var COPY_DST_BUF = 8;
var VS = (
  /* wgsl */
  `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  let xy = corners[vi];
  var out: VSOut;
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}`
);
var LIGHT_WGSL = VS + /* wgsl */
`
struct LightU {
  dims: vec4<f32>,                              // resX, resY, ambient, unlit
  misc: vec4<f32>,                              // ambientColor.rgb, lightCount
  flags: vec4<f32>,                             // enableShadows, _, _, _
  normals: array<vec4<f32>, 16>,                // xyz = normal
  lightPosRadius: array<vec4<f32>, ${MAX_LIGHTS2}>,
  lightColor: array<vec4<f32>, ${MAX_LIGHTS2}>,    // xyz = colour, w = kind (0/1/2)
  lightDirCone: array<vec4<f32>, ${MAX_LIGHTS2}>,  // xyz = direction, w = spot cone cosine
};
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var albedoTex: texture_2d<f32>;
@group(0) @binding(2) var matTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: LightU;

const HMAX = ${HEIGHT_MAX2.toFixed(1)};
const VIEW = vec3<f32>(0.0, -0.34, 0.94);

fn heightAt(p: vec2<f32>) -> f32 {
  return textureSampleLevel(matTex, samp, p / u.dims.xy, 0.0).g * HMAX;
}

fn shadowFactor(px: vec2<f32>, h0: f32, lp: vec3<f32>) -> f32 {
  let d = lp.xy - px;
  let dist = length(d);
  if (dist < 0.001) { return 1.0; }
  for (var i = 1; i <= 16; i = i + 1) {
    let t = f32(i) / 16.0;
    let rayH = mix(h0, lp.z, t);
    if (heightAt(px + d * t) > rayH + 0.45) { return 0.25; }
  }
  return 1.0;
}

fn dirShadowFactor(px: vec2<f32>, h0: f32, toLight: vec3<f32>) -> f32 {
  let len = length(toLight.xy);
  if (len < 0.05) { return 1.0; }            // key is overhead: no long shadow
  let step = (toLight.xy / len) * 3.0;
  let slope = toLight.z / len;
  for (var i = 1; i <= 16; i = i + 1) {
    let rayH = h0 + slope * f32(i) * 3.0;
    if (heightAt(px + step * f32(i)) > rayH + 0.45) { return 0.25; }
  }
  return 1.0;
}

// The decoded, normalised normal at a UV (nearest material texel).
fn normalIndexAt(uv: vec2<f32>) -> vec3<f32> {
  let idx = clamp(i32(textureSampleLevel(matTex, samp, uv, 0.0).r * 255.0 + 0.5), 0, 15);
  return normalize(u.normals[idx].xyz);
}

// Bilinearly blend the four surrounding texels' decoded normals \u2014 the WGSL twin
// of sampleNormalBilinear (lightingModel.ts). Blending vectors, not the unordered
// indices, melts the 16-facet banding to a smooth field (cinematic gap #2).
fn sampleNormalSmooth(uv: vec2<f32>) -> vec3<f32> {
  let res = u.dims.xy;
  let texelSpace = uv * res - vec2<f32>(0.5, 0.5);
  let base = floor(texelSpace);
  let f = texelSpace - base;
  let inv = vec2<f32>(1.0, 1.0) / res;
  let n00 = normalIndexAt((base + vec2<f32>(0.5, 0.5)) * inv);
  let n10 = normalIndexAt((base + vec2<f32>(1.5, 0.5)) * inv);
  let n01 = normalIndexAt((base + vec2<f32>(0.5, 1.5)) * inv);
  let n11 = normalIndexAt((base + vec2<f32>(1.5, 1.5)) * inv);
  return normalize(mix(mix(n00, n10, f.x), mix(n01, n11, f.x), f.y));
}

// The scalar twin of sampleNormalSmooth for the ramp channels (g=height, b=spec,
// a=rough) \u2014 the WGSL port of sampleScalarBilinear (lightingModel.ts). The mat
// texture stays NEAREST (its .r is an unindexable normal index), so the ramps
// are blended by hand here, per channel, rather than by the sampler. .r is left
// off the result.
fn sampleRampSmooth(uv: vec2<f32>) -> vec3<f32> {
  let res = u.dims.xy;
  let texelSpace = uv * res - vec2<f32>(0.5, 0.5);
  let base = floor(texelSpace);
  let f = texelSpace - base;
  let inv = vec2<f32>(1.0, 1.0) / res;
  let m00 = textureSampleLevel(matTex, samp, (base + vec2<f32>(0.5, 0.5)) * inv, 0.0);
  let m10 = textureSampleLevel(matTex, samp, (base + vec2<f32>(1.5, 0.5)) * inv, 0.0);
  let m01 = textureSampleLevel(matTex, samp, (base + vec2<f32>(0.5, 1.5)) * inv, 0.0);
  let m11 = textureSampleLevel(matTex, samp, (base + vec2<f32>(1.5, 1.5)) * inv, 0.0);
  return mix(mix(m00, m10, f.x), mix(m01, m11, f.x), f.y).gba; // height, spec, rough
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let alb = textureSampleLevel(albedoTex, samp, in.uv, 0.0);
  if (u.dims.w > 0.5) { return vec4<f32>(alb.rgb, 1.0); } // unlit passthrough
  let m = textureSampleLevel(matTex, samp, in.uv, 0.0);
  let idx = clamp(i32(m.r * 255.0 + 0.5), 0, 15);
  let n = select(normalize(u.normals[idx].xyz), sampleNormalSmooth(in.uv), u.flags.y > 0.5);
  // The same flag de-bands the ramp channels: normals and ramps smooth together.
  let ramp = select(vec3<f32>(m.g, m.b, m.a), sampleRampSmooth(in.uv), u.flags.y > 0.5);
  let height = ramp.x * HMAX;
  let specStr = ramp.y;
  let rough = ramp.z;
  let emissive = alb.a;
  let px = in.uv * u.dims.xy;
  let shininess = mix(6.0, 120.0, 1.0 - rough);
  var lightSum = u.dims.z * u.misc.xyz;
  let count = i32(u.misc.w);
  for (var i = 0; i < ${MAX_LIGHTS2}; i = i + 1) {
    if (i >= count) { break; }
    let lp = u.lightPosRadius[i];
    let kind = u.lightColor[i].w;
    var L: vec3<f32>;
    var atten: f32;
    var shadow = 1.0;
    if (kind > 0.5 && kind < 1.5) {
      // Directional: parallel rays toward the stored direction, no falloff.
      L = normalize(u.lightDirCone[i].xyz);
      atten = 1.0;
      if (u.flags.x > 0.5) { shadow = dirShadowFactor(px, height, L); }
    } else {
      let toLight = vec3<f32>(lp.xy - px, lp.z - height);
      let dist = length(toLight.xy);
      atten = clamp(1.0 - dist / lp.w, 0.0, 1.0);
      atten = atten * atten;
      L = normalize(toLight);
      if (u.flags.x > 0.5) { shadow = shadowFactor(px, height, lp.xyz); }
      if (kind > 1.5) {
        // Spot: gate by the beam axis alignment with this pixel.
        let axis = normalize(u.lightDirCone[i].xyz);
        let beam = normalize(vec3<f32>(px - lp.xy, height - lp.z));
        let alignment = dot(beam, axis);
        let inner = u.lightDirCone[i].w;
        let outer = inner - 0.15;              // matches SPOT_CONE_SOFTNESS
        atten = atten * clamp((alignment - outer) / max(1e-3, inner - outer), 0.0, 1.0);
      }
    }
    let diffuse = max(0.0, dot(n, L)) * shadow;
    let halfVec = normalize(L + VIEW);
    let spec = pow(max(0.0, dot(n, halfVec)), shininess) * specStr * shadow;
    lightSum = lightSum + u.lightColor[i].xyz * atten * (diffuse + spec);
  }
  let rim = pow(1.0 - max(0.0, dot(n, VIEW)), 3.0);
  lightSum = lightSum + rim * u.misc.xyz * 0.5;
  var lit = alb.rgb * lightSum;
  lit = max(lit, alb.rgb * emissive);
  return vec4<f32>(lit, 1.0);
}`;
var BRIGHT_WGSL = VS + /* wgsl */
`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: vec4<f32>; // threshold, _, _, _
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let c = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
  let l = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  return vec4<f32>(c * smoothstep(u.x, u.x + 0.25, l), 1.0);
}`;
var BLUR_WGSL = VS + /* wgsl */
`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: vec4<f32>; // dir.xy, texel.xy
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let o = u.xy * u.zw;
  var sum = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb * 0.227;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 1.0, 0.0).rgb * 0.194;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 1.0, 0.0).rgb * 0.194;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 2.0, 0.0).rgb * 0.121;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 2.0, 0.0).rgb * 0.121;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv + o * 3.0, 0.0).rgb * 0.054;
  sum = sum + textureSampleLevel(srcTex, samp, in.uv - o * 3.0, 0.0).rgb * 0.054;
  return vec4<f32>(sum, 1.0);
}`;
var COMPOSITE_WGSL = VS + /* wgsl */
`
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> u: vec4<f32>; // bloomStrength, useBloom, _, _
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  var c = textureSampleLevel(sceneTex, samp, in.uv, 0.0).rgb;
  if (u.y > 0.5) { c = c + textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * u.x; }
  return vec4<f32>(c, 1.0);
}`;
var WebgpuLightingLayer = class _WebgpuLightingLayer {
  constructor(device, context, width, height, textures, targets, pipelines, binds, buffers) {
    this.device = device;
    this.context = context;
    this.width = width;
    this.height = height;
    this.textures = textures;
    this.targets = targets;
    this.pipelines = pipelines;
    this.binds = binds;
    this.buffers = buffers;
    this.backend = "webgpu";
    this.flatMaterial = null;
    this.lightData = new Float32Array(148);
    // matches LightU (592 bytes)
    this.compData = new Float32Array(4);
    NORMAL_VECTORS.forEach((v, i) => {
      this.lightData[12 + i * 4] = v[0];
      this.lightData[12 + i * 4 + 1] = v[1];
      this.lightData[12 + i * 4 + 2] = v[2];
    });
  }
  static async create(canvas, width, height, device, supersample = DEFAULT_SUPERSAMPLE2) {
    try {
      const gpu = globalThis.navigator?.gpu;
      if (!gpu || !device) return null;
      const context = canvas.getContext("webgpu");
      if (!context) return null;
      canvas.width = width;
      canvas.height = height;
      const format = gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });
      const dataTexture = () => device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_BINDING | COPY_DST_TEX });
      const targetTexture = () => device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_BINDING | RENDER_ATTACHMENT });
      const albedo = dataTexture();
      const mat = dataTexture();
      const scene = device.createTexture({
        size: [width * supersample, height * supersample],
        format: "rgba8unorm",
        usage: TEXTURE_BINDING | RENDER_ATTACHMENT
      });
      const bright = targetTexture();
      const blurA = targetTexture();
      const blurB = targetTexture();
      const nearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
      const linear = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      const pipe = (code, targetFormat) => {
        const module = device.createShaderModule({ code });
        return device.createRenderPipeline({
          layout: "auto",
          vertex: { module, entryPoint: "vs" },
          fragment: { module, entryPoint: "fs", targets: [{ format: targetFormat }] },
          primitive: { topology: "triangle-list" }
        });
      };
      const light = pipe(LIGHT_WGSL, "rgba8unorm");
      const brightPipe = pipe(BRIGHT_WGSL, "rgba8unorm");
      const blurPipe = pipe(BLUR_WGSL, "rgba8unorm");
      const composite = pipe(COMPOSITE_WGSL, format);
      const uniform = (size) => device.createBuffer({ size, usage: UNIFORM | COPY_DST_BUF });
      const lightBuffer = uniform(592);
      const brightBuffer = uniform(16);
      const blurBufferH = uniform(16);
      const blurBufferV = uniform(16);
      const compositeBuffer = uniform(16);
      device.queue.writeBuffer(brightBuffer, 0, new Float32Array([0.72, 0, 0, 0]));
      device.queue.writeBuffer(blurBufferH, 0, new Float32Array([1, 0, 1 / width, 1 / height]));
      device.queue.writeBuffer(blurBufferV, 0, new Float32Array([0, 1, 1 / width, 1 / height]));
      const bind = (pipeline, entries) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const tex = (t) => t.createView();
      const binds = {
        light: bind(light, [
          { binding: 0, resource: nearest },
          { binding: 1, resource: tex(albedo) },
          { binding: 2, resource: tex(mat) },
          { binding: 3, resource: { buffer: lightBuffer } }
        ]),
        bright: bind(brightPipe, [
          { binding: 0, resource: linear },
          // downsamples the supersampled scene
          { binding: 1, resource: tex(scene) },
          { binding: 2, resource: { buffer: brightBuffer } }
        ]),
        blurA: bind(blurPipe, [
          { binding: 0, resource: linear },
          { binding: 1, resource: tex(bright) },
          { binding: 2, resource: { buffer: blurBufferH } }
        ]),
        blurB: bind(blurPipe, [
          { binding: 0, resource: linear },
          { binding: 1, resource: tex(blurA) },
          { binding: 2, resource: { buffer: blurBufferV } }
        ]),
        composite: bind(composite, [
          { binding: 0, resource: linear },
          // downsamples the supersampled scene
          { binding: 1, resource: tex(scene) },
          { binding: 2, resource: tex(blurB) },
          { binding: 3, resource: { buffer: compositeBuffer } }
        ])
      };
      return new _WebgpuLightingLayer(
        device,
        context,
        width,
        height,
        { albedo, mat },
        { scene, bright, blurA, blurB },
        { light, bright: brightPipe, blur: blurPipe, composite },
        binds,
        { light: lightBuffer, composite: compositeBuffer }
      );
    } catch {
      return null;
    }
  }
  render(albedo, material, scene) {
    const q = this.device.queue;
    const mat = material ?? this.flatMaterialBuffer();
    const layout = { bytesPerRow: this.width * 4, rowsPerImage: this.height };
    const size = { width: this.width, height: this.height };
    q.writeTexture({ texture: this.textures.albedo }, albedo, layout, size);
    q.writeTexture({ texture: this.textures.mat }, mat, layout, size);
    const u = this.lightData;
    const count = Math.min(scene.lights.length, MAX_LIGHTS2);
    u[0] = this.width;
    u[1] = this.height;
    u[2] = scene.ambient;
    u[3] = scene.unlit ? 1 : 0;
    u[4] = scene.ambientColor[0];
    u[5] = scene.ambientColor[1];
    u[6] = scene.ambientColor[2];
    u[7] = count;
    u[8] = scene.shadows && material ? 1 : 0;
    u[9] = scene.smoothNormals ? 1 : 0;
    u[10] = 0;
    u[11] = 0;
    for (let i = 0; i < count; i += 1) {
      const light = scene.lights[i];
      u[76 + i * 4] = light.x;
      u[76 + i * 4 + 1] = light.y;
      u[76 + i * 4 + 2] = light.z;
      u[76 + i * 4 + 3] = light.radius;
      u[100 + i * 4] = light.color[0];
      u[100 + i * 4 + 1] = light.color[1];
      u[100 + i * 4 + 2] = light.color[2];
      u[100 + i * 4 + 3] = LIGHT_KIND_CODE[light.kind ?? "point"];
      const dir = light.direction ?? DEFAULT_LIGHT_DIRECTION;
      u[124 + i * 4] = dir[0];
      u[124 + i * 4 + 1] = dir[1];
      u[124 + i * 4 + 2] = dir[2];
      u[124 + i * 4 + 3] = light.coneCos ?? DEFAULT_SPOT_CONE_COS;
    }
    q.writeBuffer(this.buffers.light, 0, u);
    const useBloom = scene.bloom && !scene.unlit;
    this.compData[0] = 1.1;
    this.compData[1] = useBloom ? 1 : 0;
    q.writeBuffer(this.buffers.composite, 0, this.compData);
    const encoder = this.device.createCommandEncoder();
    this.runPass(encoder, this.targets.scene.createView(), this.pipelines.light, this.binds.light);
    if (useBloom) {
      this.runPass(encoder, this.targets.bright.createView(), this.pipelines.bright, this.binds.bright);
      this.runPass(encoder, this.targets.blurA.createView(), this.pipelines.blur, this.binds.blurA);
      this.runPass(encoder, this.targets.blurB.createView(), this.pipelines.blur, this.binds.blurB);
    }
    this.runPass(encoder, this.context.getCurrentTexture().createView(), this.pipelines.composite, this.binds.composite);
    q.submit([encoder.finish()]);
  }
  dispose() {
    for (const t of [this.textures.albedo, this.textures.mat, this.targets.scene, this.targets.bright, this.targets.blurA, this.targets.blurB]) {
      try {
        t.destroy();
      } catch {
      }
    }
  }
  runPass(encoder, view, pipeline, bindGroup) {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }
  flatMaterialBuffer() {
    if (!this.flatMaterial) this.flatMaterial = createFlatMaterial(this.width, this.height);
    return this.flatMaterial;
  }
};

// src/lighting/webgpuDevice.ts
var devicePromise;
function getWebgpuDevice() {
  if (!devicePromise) devicePromise = acquireDevice();
  return devicePromise;
}
async function acquireDevice() {
  try {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) return null;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const timestamps = adapter.features?.has?.("timestamp-query") === true;
    return await adapter.requestDevice(timestamps ? { requiredFeatures: ["timestamp-query"] } : void 0);
  } catch {
    return null;
  }
}

// src/lighting/createLightingLayer.ts
var SUPERSAMPLE_AUTO_MAX_PIXELS = 1e5;
function resolveSupersample(width, height, requested) {
  if (requested !== void 0 && Number.isFinite(requested)) {
    return Math.max(1, Math.min(4, Math.round(requested)));
  }
  return width * height <= SUPERSAMPLE_AUTO_MAX_PIXELS ? 2 : 1;
}
async function createLightingLayer(doc, width, height, deviceProvider = getWebgpuDevice, supersample) {
  const factor = resolveSupersample(width, height, supersample);
  const device = await deviceProvider();
  if (device) {
    const canvas2 = doc.createElement("canvas");
    const renderer = await WebgpuLightingLayer.create(canvas2, width, height, device, factor);
    if (renderer) return { renderer, canvas: canvas2 };
  }
  const canvas = doc.createElement("canvas");
  try {
    return { renderer: new LightingLayer(canvas, width, height, factor), canvas };
  } catch {
    return null;
  }
}

// src/lighting/LitCanvasSurface.ts
var DEFAULT_AMBIENT = 0.16;
var DEFAULT_AMBIENT_COLOR = [0.5, 0.55, 0.8];
var LitCanvasSurface = class _LitCanvasSurface {
  constructor(container, scaleMode, model, options, built) {
    this.container = container;
    this.scaleMode = scaleMode;
    this.model = model;
    this.options = options;
    this.frame = 0;
    this.cartLights = [];
    // A stable, non-resizable copy of the framebuffer for GPU upload. The engine's
    // framebuffer is a view over WASM memory whose backing ArrayBuffer is growable,
    // and WebGL/WebGPU texture uploads reject resizable ArrayBufferViews. Copying
    // into a plain buffer once per frame satisfies the upload contract.
    this.albedoCopy = null;
    // The per-pixel material the engine emitted for this frame (same growable-buffer
    // caveat as the framebuffer, so it is copied into a stable buffer before upload).
    this.cartMaterial = null;
    this.cartMaterialCopy = null;
    // Per-pixel emissive (one byte each) the engine emitted this frame. Folded into
    // the albedo copy's alpha, which the shader reads as self-illumination.
    this.cartEmissive = null;
    const view = container.ownerDocument.defaultView;
    this.performanceNow = () => view?.performance.now() ?? Date.now();
    if (!built) {
      this.fallback = new CanvasSurface(container, scaleMode, model);
      this.resizeObserver = new ResizeObserver(() => {
      });
      return;
    }
    this.renderer = built.renderer;
    this.canvas = built.canvas;
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }
  /** Builds the surface, choosing the best available lighting backend. */
  static async create(container, scaleMode, model, options) {
    const built = await createLightingLayer(
      container.ownerDocument,
      model.width,
      model.height,
      void 0,
      options.supersample
    );
    return new _LitCanvasSurface(container, scaleMode, model, options, built);
  }
  /** Whether the lit path is active (false means it fell back to plain 2D). */
  get isLit() {
    return !this.fallback;
  }
  /** The active backend: "webgpu", "webgl", or "2d" when unlit. */
  get backend() {
    return this.renderer?.backend ?? "2d";
  }
  /**
   * Sets the lights the running cart emitted this frame (via `cartbox.light`).
   * They are combined with any host-provided lights on the next {@link blit}.
   */
  setCartLights(lights) {
    this.cartLights = lights;
  }
  /**
   * Sets the per-pixel material buffer the engine emitted for this frame's
   * sprites (RGBA: normal index, height, specular, roughness). Copied into a
   * stable buffer on {@link blit}; an empty buffer falls back to host material.
   */
  setCartMaterial(material) {
    this.cartMaterial = material.length ? material : null;
  }
  /**
   * Sets the per-pixel emissive plane (one byte each) the engine emitted this
   * frame. It is folded into the albedo copy's alpha channel on {@link blit},
   * which both lighting backends read as self-illumination. An empty buffer
   * leaves the framebuffer's own alpha untouched.
   */
  setCartEmissive(emissive) {
    this.cartEmissive = emissive.length ? emissive : null;
  }
  blit(albedo) {
    if (this.fallback || !this.renderer) {
      this.fallback?.blit(albedo);
      return;
    }
    const context = {
      frame: this.frame,
      timeMs: this.performanceNow(),
      width: this.model.width,
      height: this.model.height
    };
    const hostLights = this.options.lights?.(context) ?? [];
    const lights = this.cartLights.length ? [...this.cartLights, ...hostLights] : hostLights;
    const material = this.resolveMaterial(context);
    const unlit = (this.options.autoDetect ?? false) && lights.length === 0;
    if (!this.albedoCopy || this.albedoCopy.length !== albedo.length) {
      this.albedoCopy = new Uint8Array(albedo.length);
    }
    this.albedoCopy.set(albedo);
    if (this.cartEmissive && this.cartEmissive.length * 4 === this.albedoCopy.length) {
      for (let i = 0; i < this.cartEmissive.length; i += 1) {
        this.albedoCopy[i * 4 + 3] = this.cartEmissive[i] ?? 0;
      }
    }
    this.renderer.render(this.albedoCopy, material, {
      lights,
      ambient: this.options.ambient ?? DEFAULT_AMBIENT,
      ambientColor: this.options.ambientColor ?? DEFAULT_AMBIENT_COLOR,
      bloom: this.options.bloom ?? true,
      shadows: this.options.shadows ?? false,
      smoothNormals: this.options.smoothNormals ?? true,
      unlit
    });
    this.frame += 1;
  }
  destroy() {
    if (this.fallback) {
      this.fallback.destroy();
      return;
    }
    this.resizeObserver.disconnect();
    this.renderer?.dispose();
    this.canvas?.remove();
  }
  resolveMaterial(context) {
    if (this.cartMaterial) {
      if (!this.cartMaterialCopy || this.cartMaterialCopy.length !== this.cartMaterial.length) {
        this.cartMaterialCopy = new Uint8Array(this.cartMaterial.length);
      }
      this.cartMaterialCopy.set(this.cartMaterial);
      return this.cartMaterialCopy;
    }
    const source = this.options.material;
    if (typeof source === "function") return source(context);
    return source ?? null;
  }
  applyScale() {
    if (!this.canvas) return;
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
};

// src/fx/bloomModel.ts
var MIN_PYRAMID_DIMENSION = 4;
var MAX_PYRAMID_LEVELS = 6;
var BLOOM_KNEE = 0.5;
var EPSILON = 1e-4;
function pyramidLevelCount(width, height, maxLevels = MAX_PYRAMID_LEVELS) {
  let shorterSide = Math.min(width, height);
  let levels = 0;
  while (levels < maxLevels && Math.floor(shorterSide / 2) >= MIN_PYRAMID_DIMENSION) {
    shorterSide = Math.floor(shorterSide / 2);
    levels += 1;
  }
  return Math.max(1, levels);
}
function pyramidLevelSize(baseWidth, baseHeight, index) {
  const divisor = 2 ** (index + 1);
  return {
    width: Math.max(1, Math.floor(baseWidth / divisor)),
    height: Math.max(1, Math.floor(baseHeight / divisor))
  };
}
function softKneePrefilter(rgb, threshold, knee = BLOOM_KNEE) {
  const brightest = Math.max(rgb[0], rgb[1], rgb[2]);
  const kneeWidth = Math.max(knee, EPSILON);
  let soft = brightest - threshold + kneeWidth;
  soft = Math.min(Math.max(soft, 0), 2 * kneeWidth);
  soft = soft * soft / (4 * kneeWidth + EPSILON);
  const contribution = Math.max(soft, brightest - threshold) / Math.max(brightest, EPSILON);
  const clamped = Math.max(contribution, 0);
  return [rgb[0] * clamped, rgb[1] * clamped, rgb[2] * clamped];
}
function acesFilmicChannel(x) {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  const mapped = x * (a * x + b) / (x * (c * x + d) + e);
  return Math.min(Math.max(mapped, 0), 1);
}
function acesFilmic(rgb, exposure = 1) {
  return [
    acesFilmicChannel(rgb[0] * exposure),
    acesFilmicChannel(rgb[1] * exposure),
    acesFilmicChannel(rgb[2] * exposure)
  ];
}

// src/fx/BloomPyramid.ts
var VERTEX_SOURCE = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = (aPosition + 1.0) * 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
var PREFILTER_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uSourceTexel;
uniform float uThreshold;
uniform float uKnee;

vec3 prefilter(vec3 c) {
  float brightest = max(c.r, max(c.g, c.b));
  float kneeWidth = max(uKnee, 1e-4);
  float soft = brightest - uThreshold + kneeWidth;
  soft = clamp(soft, 0.0, 2.0 * kneeWidth);
  soft = soft * soft / (4.0 * kneeWidth + 1e-4);
  float contribution = max(soft, brightest - uThreshold) / max(brightest, 1e-4);
  return c * max(contribution, 0.0);
}

void main() {
  vec2 o = uSourceTexel * 0.5;
  vec3 sum = texture2D(uTex, vUv + vec2(o.x, o.y)).rgb;
  sum += texture2D(uTex, vUv + vec2(-o.x, o.y)).rgb;
  sum += texture2D(uTex, vUv + vec2(o.x, -o.y)).rgb;
  sum += texture2D(uTex, vUv + vec2(-o.x, -o.y)).rgb;
  gl_FragColor = vec4(prefilter(sum * 0.25), 1.0);
}
`;
var DOWNSAMPLE_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;

void main() {
  vec2 halfTexel = uTexel * 0.5;
  vec3 sum = texture2D(uTex, vUv).rgb * 4.0;
  sum += texture2D(uTex, vUv - halfTexel).rgb;
  sum += texture2D(uTex, vUv + halfTexel).rgb;
  sum += texture2D(uTex, vUv + vec2(halfTexel.x, -halfTexel.y)).rgb;
  sum += texture2D(uTex, vUv - vec2(halfTexel.x, -halfTexel.y)).rgb;
  gl_FragColor = vec4(sum / 8.0, 1.0);
}
`;
var UPSAMPLE_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uRadius;

void main() {
  vec2 spread = uTexel * 0.5 * (0.5 + uRadius);
  vec3 sum = texture2D(uTex, vUv + vec2(-spread.x * 2.0, 0.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(-spread.x, spread.y)).rgb * 2.0;
  sum += texture2D(uTex, vUv + vec2(0.0, spread.y * 2.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(spread.x, spread.y)).rgb * 2.0;
  sum += texture2D(uTex, vUv + vec2(spread.x * 2.0, 0.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(spread.x, -spread.y)).rgb * 2.0;
  sum += texture2D(uTex, vUv + vec2(0.0, -spread.y * 2.0)).rgb;
  sum += texture2D(uTex, vUv + vec2(-spread.x, -spread.y)).rgb * 2.0;
  gl_FragColor = vec4(sum / 12.0, 1.0);
}
`;
var BloomPyramid = class _BloomPyramid {
  constructor(gl, quad, prefilter, downsample, upsample, textureType) {
    this.gl = gl;
    this.quad = quad;
    this.prefilter = prefilter;
    this.downsample = downsample;
    this.upsample = upsample;
    this.textureType = textureType;
    this.levels = [];
    this.baseWidth = 0;
    this.baseHeight = 0;
  }
  /** Whether the pyramid can hold light past 1.0 (true HDR) or clamps at it. */
  get isHdr() {
    return this.textureType !== this.gl.UNSIGNED_BYTE;
  }
  /**
   * Build the pyramid against an existing GL context, or return null if any
   * shader/buffer allocation fails. The context is shared with the owning pass;
   * this class only ever renders into its own framebuffers and leaves the
   * default framebuffer bound when it is done.
   */
  static create(gl) {
    const quad = gl.createBuffer();
    if (!quad) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const prefilter = buildProgram(gl, PREFILTER_SOURCE, ["uTex", "uSourceTexel", "uThreshold", "uKnee"]);
    const downsample = buildProgram(gl, DOWNSAMPLE_SOURCE, ["uTex", "uTexel"]);
    const upsample = buildProgram(gl, UPSAMPLE_SOURCE, ["uTex", "uTexel", "uRadius"]);
    if (!prefilter || !downsample || !upsample) {
      gl.deleteBuffer(quad);
      return null;
    }
    return new _BloomPyramid(gl, quad, prefilter, downsample, upsample, detectTargetType(gl));
  }
  /**
   * Generate the bloom for one frame and return the finest pyramid level (a
   * half-resolution texture holding the accumulated glow), ready to be sampled
   * and added by the composite pass. Targets are reallocated only when the base
   * resolution changes, so steady-state playback allocates nothing.
   */
  generate(source, baseWidth, baseHeight, threshold, radius) {
    const gl = this.gl;
    if (baseWidth !== this.baseWidth || baseHeight !== this.baseHeight) {
      this.allocate(baseWidth, baseHeight);
    }
    if (this.levels.length === 0) return null;
    gl.disable(gl.BLEND);
    this.begin(this.prefilter, this.levels[0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(this.prefilter.uniforms.get("uTex"), 0);
    gl.uniform2f(this.prefilter.uniforms.get("uSourceTexel"), 1 / baseWidth, 1 / baseHeight);
    gl.uniform1f(this.prefilter.uniforms.get("uThreshold"), threshold);
    gl.uniform1f(this.prefilter.uniforms.get("uKnee"), BLOOM_KNEE);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    for (let index = 1; index < this.levels.length; index++) {
      const finer = this.levels[index - 1];
      this.begin(this.downsample, this.levels[index]);
      gl.bindTexture(gl.TEXTURE_2D, finer.texture);
      gl.uniform1i(this.downsample.uniforms.get("uTex"), 0);
      gl.uniform2f(this.downsample.uniforms.get("uTexel"), 1 / finer.width, 1 / finer.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let index = this.levels.length - 2; index >= 0; index--) {
      const coarser = this.levels[index + 1];
      this.begin(this.upsample, this.levels[index]);
      gl.bindTexture(gl.TEXTURE_2D, coarser.texture);
      gl.uniform1i(this.upsample.uniforms.get("uTex"), 0);
      gl.uniform2f(this.upsample.uniforms.get("uTexel"), 1 / coarser.width, 1 / coarser.height);
      gl.uniform1f(this.upsample.uniforms.get("uRadius"), radius);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.levels[0].texture;
  }
  dispose() {
    const gl = this.gl;
    this.freeLevels();
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.prefilter.program);
    gl.deleteProgram(this.downsample.program);
    gl.deleteProgram(this.upsample.program);
  }
  /** Bind a program and its target framebuffer, and point the shared quad at the
   * program's attribute — GLSL ES 1.00 has no VAOs, so this repeats per draw. */
  begin(program, level) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffer);
    gl.viewport(0, 0, level.width, level.height);
    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(program.attribLocation);
    gl.vertexAttribPointer(program.attribLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
  }
  allocate(baseWidth, baseHeight) {
    this.freeLevels();
    this.baseWidth = baseWidth;
    this.baseHeight = baseHeight;
    const count = pyramidLevelCount(baseWidth, baseHeight);
    for (let index = 0; index < count; index++) {
      const { width, height } = pyramidLevelSize(baseWidth, baseHeight, index);
      const level = this.makeLevel(width, height);
      if (!level) break;
      this.levels.push(level);
    }
  }
  makeLevel(width, height) {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, this.textureType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
      return null;
    }
    return { texture, framebuffer, width, height };
  }
  freeLevels() {
    const gl = this.gl;
    for (const level of this.levels) {
      gl.deleteTexture(level.texture);
      gl.deleteFramebuffer(level.framebuffer);
    }
    this.levels = [];
  }
};
function buildProgram(gl, fragmentSource, uniformNames) {
  const compile2 = (type, source) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("BloomPyramid shader compile failed:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };
  const vertex = compile2(gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile2(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("BloomPyramid program link failed:", gl.getProgramInfoLog(program));
    return null;
  }
  const uniforms = /* @__PURE__ */ new Map();
  for (const name of uniformNames) uniforms.set(name, gl.getUniformLocation(program, name));
  return { program, attribLocation: gl.getAttribLocation(program, "aPosition"), uniforms };
}
function detectTargetType(gl) {
  const halfFloat = gl.getExtension("OES_texture_half_float");
  const halfFloatLinear = gl.getExtension("OES_texture_half_float_linear");
  const colorBufferHalfFloat = gl.getExtension("EXT_color_buffer_half_float");
  if (!halfFloat || !halfFloatLinear || !colorBufferHalfFloat) return gl.UNSIGNED_BYTE;
  const type = halfFloat.HALF_FLOAT_OES;
  const texture = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!texture || !framebuffer) return gl.UNSIGNED_BYTE;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteTexture(texture);
  gl.deleteFramebuffer(framebuffer);
  return complete ? type : gl.UNSIGNED_BYTE;
}

// src/fx/flareModel.ts
var FLARE_GHOSTS = [
  { along: 0.55, radius: 0.035, tint: [0.35, 0.6, 1] },
  { along: 0.2, radius: 0.06, tint: [0.25, 0.5, 0.9] },
  { along: -0.3, radius: 0.045, tint: [0.9, 0.6, 0.3] },
  { along: -0.6, radius: 0.1, tint: [0.3, 0.45, 0.8] },
  { along: -1.1, radius: 0.16, tint: [0.2, 0.35, 0.7] }
];
var FLARE_GHOST_GAIN = 0.45;
var FLARE_SPIKE_POWER = 48;
function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
function lensFlareAt(uv, origin, aspect, params) {
  if (params.visible <= 0 || params.glare <= 0 && params.ghosts <= 0) return [0, 0, 0];
  const dx = (uv[0] - origin[0]) * aspect;
  const dy = uv[1] - origin[1];
  const r = Math.hypot(dx, dy);
  const size = Math.max(0.01, params.size);
  const glow = Math.exp(-(r * r) / (size * size));
  const angle = Math.atan2(dy, dx);
  const spikes = Math.pow(Math.abs(Math.cos(angle * 3)), FLARE_SPIKE_POWER) * Math.exp(-r / (size * 2.5));
  const g = params.glare * (glow + spikes * 0.6);
  let red = g;
  let green = g;
  let blue = g;
  if (params.ghosts > 0) {
    for (const ghost of FLARE_GHOSTS) {
      const gx = (0.5 + (origin[0] - 0.5) * ghost.along - uv[0]) * aspect;
      const gy = 0.5 + (origin[1] - 0.5) * ghost.along - uv[1];
      const disc = smoothstep(ghost.radius, ghost.radius * 0.6, Math.hypot(gx, gy));
      const k = disc * params.ghosts * FLARE_GHOST_GAIN;
      red += ghost.tint[0] * k;
      green += ghost.tint[1] * k;
      blue += ghost.tint[2] * k;
    }
  }
  const v = Math.min(1, params.visible);
  return [red * v, green * v, blue * v];
}

// src/fx/PostFxPass.ts
var f = (n) => n.toFixed(4);
var GHOST_TERMS = FLARE_GHOSTS.map(
  (g) => `    flare += vec3(${f(g.tint[0])}, ${f(g.tint[1])}, ${f(g.tint[2])}) * flareGhost(uv, ${f(g.along)}, ${f(g.radius)}, aspect);`
).join("\n");
var VERTEX_SOURCE2 = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  // Screen-space UV with a top-left origin, so uv.y matches image row order.
  vUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;
var FRAGMENT_SOURCE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform vec2 uSourceSize;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uFogDensity;
uniform float uFogHorizon;
uniform vec3 uFogColor;
uniform float uBloomStrength;
uniform float uBloomThreshold;
// The multi-scale bloom the pyramid produces, and whether it is available: when
// it is not (no framebuffers/extensions) the shader falls back to an inline 3x3.
uniform sampler2D uBloomTex;
uniform float uHasBloomTex;
// HDR rolloff: uToneMap gates the ACES curve, uExposure scales into it.
uniform float uToneMap;
uniform float uExposure;
uniform float uCurvature;
uniform float uScanlines;
uniform float uAberration;
uniform float uVignette;
uniform float uPosterize;
uniform float uDitherAmount;
uniform float uDitherScale;
uniform float uHalftoneStrength;
uniform float uHalftoneScale;
uniform float uHalftoneAngle;
uniform float uGodrayStrength;
uniform float uGodrayDensity;
uniform float uGodrayDecay;
uniform vec2 uGodrayOrigin;
uniform float uStreakStrength;
uniform float uStreakLength;
uniform float uFlareGlare;
uniform float uFlareGhosts;
uniform float uFlareSize;
uniform vec3 uFlareColor;
uniform vec2 uFlareOrigin;
uniform float uFlareVisible;
uniform float uSplitStrength;
uniform float uSplitBalance;
uniform vec3 uSplitShadows;
uniform vec3 uSplitHighlights;
uniform float uReflectStrength;
uniform float uReflectHorizon;
uniform float uReflectFalloff;
uniform float uReflectWobble;
uniform float uTiltStrength;
uniform float uTiltFocus;
uniform float uTiltRange;
uniform float uKaleidoSegments;
uniform float uKaleidoAngle;
uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uTime;

const float TAU = 6.2831853;
// Fixed sample counts: GLSL ES 1.00 requires constant loop bounds, so the cost
// is decided at compile time and the effects are switched off by branching
// around the loop rather than by shortening it.
const int GODRAY_SAMPLES = 16;
const int STREAK_SAMPLES = 8;
// Ring taps for the tilt-shift disk blur. Two rings + centre per iteration.
const int DOF_SAMPLES = 10;

float luma(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 brightPass(vec2 uv) {
  vec3 color = texture2D(uSource, uv).rgb;
  return color * smoothstep(uBloomThreshold, 1.0, luma(color));
}

/**
 * ACES filmic tonemap (Narkowicz's fit), the exact twin of acesFilmic() in
 * bloomModel.ts. Maps summed HDR light back into 0..1 with a highlight shoulder,
 * so a bloomed emissive rolls off keeping its colour rather than clipping white.
 */
vec3 acesFilmic(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/**
 * The 2x2 Bayer threshold, and the recursive construction of the 4x4 and 8x8
 * from it. Built arithmetically rather than from a lookup table because GLSL ES
 * 1.00 forbids indexing a local array with a computed index.
 */
float bayer2(vec2 a) {
  a = floor(a);
  return fract(a.x * 0.5 + a.y * a.y * 0.75);
}

float bayer4(vec2 a) {
  return bayer2(a * 0.5) * 0.25 + bayer2(a);
}

float bayer8(vec2 a) {
  // Each level halves the coordinate before recursing: an 8x8 matrix is a 4x4
  // of 2x2 blocks, so the coarser level must be sampled at half the frequency.
  return bayer4(a * 0.5) * 0.25 + bayer2(a);
}

/**
 * One lens ghost (lensFlareAt in flareModel.ts): a soft disc on the line from
 * the light through the frame centre, \`along\` of the way from centre to light.
 */
float flareGhost(vec2 uv, float along, float radius, float aspect) {
  vec2 centre = vec2(0.5) + (uFlareOrigin - vec2(0.5)) * along;
  vec2 d = (centre - uv) * vec2(aspect, 1.0);
  return smoothstep(radius, radius * 0.6, length(d)) * uFlareGhosts * ${FLARE_GHOST_GAIN.toFixed(4)};
}

/** A deterministic 0..1 hash of a 2D point \u2014 the grain's noise source. */
float hash12(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 folded = vUv;

  // Kaleidoscope: fold the frame into one wedge and mirror it around. Done
  // before curvature so the tube still bows the composed image, not each wedge.
  if (uKaleidoSegments >= 2.0) {
    vec2 offset = folded - 0.5;
    float radius = length(offset);
    float segment = TAU / uKaleidoSegments;
    float angle = mod(atan(offset.y, offset.x) + uKaleidoAngle, segment);
    // Reflecting about the wedge's midline is what makes neighbouring wedges
    // mirror rather than repeat, which is the difference between a kaleidoscope
    // and a pinwheel.
    angle = abs(angle - segment * 0.5);
    // A wedge reaches past the frame at the corners, where the radius exceeds a
    // half-width. Clamping samples the edge there; letting it fall through would
    // hit the out-of-frame test below and punch four black corners.
    folded = clamp(vec2(cos(angle), sin(angle)) * radius + 0.5, 0.0, 1.0);
  }

  // CRT barrel curvature: bow the sampling grid outward from the centre.
  vec2 centered = folded - 0.5;
  vec2 uv = folded + centered * dot(centered, centered) * uCurvature * 4.0;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Chromatic aberration: R and B sampled slightly toward/away from centre.
  vec2 fringe = centered * uAberration / uSourceSize;
  vec3 color = vec3(
    texture2D(uSource, uv + fringe).r,
    texture2D(uSource, uv).g,
    texture2D(uSource, uv - fringe).b
  );

  // Tilt-shift depth of field: keep a horizontal band sharp and blur outside it,
  // the row standing in for distance in a flat scene. The blur weight is the pure
  // tiltShiftBlur() of lensModel.ts \u2014 0 inside the band, ramping to 1 over a fixed
  // feather \u2014 scaled by strength into a disk radius. Offsets come from sin/cos of
  // the loop index rather than an indexed array (GLSL ES 1.00 forbids the latter).
  if (uTiltStrength > 0.0) {
    float outside = abs(uv.y - uTiltFocus) - max(uTiltRange, 0.0);
    float blurAmount = clamp(outside / 0.35, 0.0, 1.0) * uTiltStrength;
    if (blurAmount > 0.001) {
      float radius = blurAmount * 6.0;             // max ~6px kernel at full blur
      vec2 texel = 1.0 / uSourceSize;
      vec3 blurred = color;
      float total = 1.0;
      for (int i = 0; i < DOF_SAMPLES; i++) {
        float a = float(i) / float(DOF_SAMPLES) * TAU;
        vec2 dir = vec2(cos(a), sin(a));
        blurred += texture2D(uSource, uv + dir * radius * texel).rgb;
        blurred += texture2D(uSource, uv + dir * (radius * 0.5) * texel).rgb;
        total += 2.0;
      }
      color = mix(color, blurred / total, clamp(blurAmount, 0.0, 1.0));
    }
  }

  // Wet-floor reflection: below the horizon, mirror the frame above it downward and
  // fade with distance (reflectionSampleY / reflectionFade in lensModel.ts). A
  // clock-driven sideways ripple, growing with depth, makes the surface read as wet
  // rather than a mirror. Sampled from the raw source so the reflected scene is the
  // upright picture, not one already reflected.
  if (uReflectStrength > 0.0) {
    float below = uv.y - uReflectHorizon;
    if (below > 0.0) {
      float ripple = sin(uv.x * 40.0 + uTime * 2.2) * uReflectWobble * 0.02 * below / max(uReflectFalloff, 0.001);
      vec2 rUv = clamp(vec2(uv.x + ripple, uReflectHorizon - below), 0.0, 1.0);
      vec3 mirror = texture2D(uSource, rUv).rgb;
      float fade = uReflectStrength * clamp(1.0 - below / max(uReflectFalloff, 0.001), 0.0, 1.0);
      color = mix(color, mirror, fade);
    }
  }

  // Bloom: add the wide multi-scale glow the pyramid pre-computed. Where the
  // pyramid could not be built, fall back to the original 3x3 bright-pass blur so
  // bloom still does something on a context without render-to-texture.
  if (uBloomStrength > 0.0) {
    vec3 glow;
    if (uHasBloomTex > 0.5) {
      glow = texture2D(uBloomTex, uv).rgb;
    } else {
      vec2 texel = 1.0 / uSourceSize;
      glow = vec3(0.0);
      for (int dy = -1; dy <= 1; dy++) {
        for (int dx = -1; dx <= 1; dx++) {
          float weight = (dx == 0 && dy == 0) ? 0.25 : (dx == 0 || dy == 0) ? 0.125 : 0.0625;
          glow += brightPass(uv + vec2(float(dx), float(dy)) * texel) * weight;
        }
      }
    }
    color += glow * uBloomStrength;
  }

  // God rays: march back toward the light, accumulating the bright pass with a
  // geometric falloff. A 2D scene has no depth to occlude with, so what forms
  // the shafts is the artwork's own dark pixels contributing nothing.
  if (uGodrayStrength > 0.0) {
    // Named around the builtins: "step" is a GLSL function and "sample" is a
    // reserved word, and shadowing either is a trap.
    vec2 marchStep = (uv - uGodrayOrigin) * uGodrayDensity / float(GODRAY_SAMPLES);
    vec2 probe = uv;
    float decay = 1.0;
    vec3 shafts = vec3(0.0);
    for (int i = 0; i < GODRAY_SAMPLES; i++) {
      probe -= marchStep;
      shafts += brightPass(clamp(probe, 0.0, 1.0)) * decay;
      decay *= uGodrayDecay;
    }
    color += shafts * (uGodrayStrength / float(GODRAY_SAMPLES));
  }

  // Anamorphic streaks: the same bright pass smeared horizontally only, which is
  // what a cylindrical lens does and what reads as "cinematic" on a light source.
  if (uStreakStrength > 0.0) {
    float reach = uStreakLength * 0.25;
    vec3 streak = vec3(0.0);
    float total = 0.0;
    for (int i = 1; i <= STREAK_SAMPLES; i++) {
      float distance = float(i) / float(STREAK_SAMPLES);
      float weight = 1.0 - distance;
      vec2 offset = vec2(reach * distance, 0.0);
      streak += (brightPass(clamp(uv + offset, 0.0, 1.0)) + brightPass(clamp(uv - offset, 0.0, 1.0))) * weight;
      total += weight * 2.0;
    }
    color += streak * (uStreakStrength / max(total, 1.0));
  }

  // Sun glare and lens flare (lensFlareAt in flareModel.ts): a glow and a
  // six-pointed starburst round the light, and ghosts strung across the frame
  // from it through the centre \u2014 all scaled by how much of the light is
  // unblocked, which a 3D scene reports each frame.
  if ((uFlareGlare > 0.0 || uFlareGhosts > 0.0) && uFlareVisible > 0.0) {
    float aspect = uSourceSize.x / uSourceSize.y;
    vec2 d = (uv - uFlareOrigin) * vec2(aspect, 1.0);
    float r = length(d);
    float size = max(0.01, uFlareSize);
    float glow = exp(-(r * r) / (size * size));
    float spikes = pow(abs(cos(atan(d.y, d.x) * 3.0)), ${FLARE_SPIKE_POWER.toFixed(1)}) * exp(-r / (size * 2.5));
    vec3 flare = vec3(uFlareGlare * (glow + spikes * 0.6));
    if (uFlareGhosts > 0.0) {
${GHOST_TERMS}
    }
    color += flare * min(uFlareVisible, 1.0) * uFlareColor;
  }

  // HDR tonemap: with the additive light (bloom, god rays, streaks) now summed,
  // roll the highlights off the ACES curve so they compress into range with
  // their colour intact instead of clipping flat. Left of here everything is
  // HDR; right of here everything is displayable 0..1.
  if (uToneMap > 0.5) {
    color = acesFilmic(color * uExposure);
  }

  // Grade: brightness, then contrast around mid-grey, then saturation.
  color *= uBrightness;
  color = (color - 0.5) * uContrast + 0.5;
  color = mix(vec3(luma(color)), color, uSaturation);

  // Split tone: pick a tint by brightness and multiply it in. The tints are
  // doubled so a mid-grey pick is the identity, which lets "no tint" be
  // expressible rather than only approachable.
  if (uSplitStrength > 0.0) {
    float tone = smoothstep(uSplitBalance - 0.25, uSplitBalance + 0.25, luma(color));
    vec3 tint = mix(uSplitShadows, uSplitHighlights, tone) * 2.0;
    color = mix(color, color * tint, uSplitStrength);
  }

  // Ordered dither: offset each channel by up to half a posterisation step
  // before quantising, so pixels straddling a boundary alternate and read as the
  // colour between the two available ones. Applied to the *source* pixel grid so
  // the pattern stays put when the FX canvas renders above native resolution.
  if (uDitherAmount > 0.0 && uPosterize >= 2.0) {
    vec2 cell = floor(uv * uSourceSize / max(uDitherScale, 1.0));
    color += (bayer8(cell) - 0.5) * (uDitherAmount / uPosterize);
  }

  // Posterize: quantise each channel to uPosterize levels (0 = off).
  if (uPosterize >= 2.0) {
    color = floor(color * uPosterize) / (uPosterize - 1.0);
    color = min(color, vec3(1.0));
  }

  // Halftone: a rotated grid of dots whose radius tracks brightness. The square
  // root is deliberate \u2014 ink coverage goes as the dot's *area*, so a linear
  // radius would darken the midtones.
  if (uHalftoneStrength > 0.0) {
    vec2 grid = uv * uSourceSize / max(uHalftoneScale, 1.0);
    float sinA = sin(uHalftoneAngle);
    float cosA = cos(uHalftoneAngle);
    vec2 rotated = vec2(grid.x * cosA - grid.y * sinA, grid.x * sinA + grid.y * cosA);
    float radius = sqrt(clamp(luma(color), 0.0, 1.0)) * 0.7;
    float ink = step(length(fract(rotated) - 0.5), radius);
    color = mix(color, color * mix(0.15, 1.0, ink), uHalftoneStrength);
  }

  // Fog: thickens from the horizon line upward (distance in a 2D scene).
  // smoothstep needs edge0 < edge1, so invert the ramp instead of the edges.
  float fogAmount = uFogDensity * (1.0 - smoothstep(uFogHorizon - 0.35, uFogHorizon + 0.35, uv.y));
  color = mix(color, uFogColor, clamp(fogAmount, 0.0, 1.0));

  // Vignette: radial darkening toward the corners.
  float falloff = 1.0 - uVignette * smoothstep(0.25, 0.75, dot(centered, centered) * 2.0);
  color *= falloff;

  // Film grain: noise keyed to the source pixel grid and the clock, so it
  // shimmers between frames rather than sitting still as a fixed dirt pattern.
  if (uGrainAmount > 0.0) {
    vec2 grainCell = floor(uv * uSourceSize / max(uGrainSize, 1.0));
    color += (hash12(grainCell + fract(uTime) * 71.0) - 0.5) * uGrainAmount;
  }

  // Scanlines: darken alternate source rows (identity when strength is 0).
  float scan = 1.0 - uScanlines * 0.25 * (1.0 + sin(uv.y * uSourceSize.y * 3.14159));
  color *= scan;

  gl_FragColor = vec4(color, 1.0);
}
`;
var PostFxPass = class _PostFxPass {
  constructor(gl, program, texture, quad, positionLocation, bloom) {
    this.gl = gl;
    this.program = program;
    this.texture = texture;
    this.quad = quad;
    this.positionLocation = positionLocation;
    this.bloom = bloom;
    this.uniformLocations = /* @__PURE__ */ new Map();
  }
  /** Returns null when WebGL is unavailable or the shaders fail to compile. */
  static create(canvas) {
    const gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const compile2 = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("PostFx shader compile failed:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };
    const vertex = compile2(gl.VERTEX_SHADER, VERTEX_SOURCE2);
    const fragment = compile2(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("PostFx program link failed:", gl.getProgramInfoLog(program));
      return null;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    if (!texture || !buffer) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const bloom = BloomPyramid.create(gl);
    return new _PostFxPass(gl, program, texture, buffer, positionLocation, bloom);
  }
  location(name) {
    if (!this.uniformLocations.has(name)) {
      this.uniformLocations.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniformLocations.get(name) ?? null;
  }
  /**
   * Upload one frame and draw it through the effect chain.
   *
   * `time` (seconds) drives the only effect that moves, the grain. It is a
   * parameter rather than a clock read inside the pass so a still preview — the
   * editor's FX tab, a test — renders deterministically, and only a caller that
   * actually has a running frame loop supplies one.
   */
  render(source, width, height, uniforms, time = 0) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (source instanceof Uint8Array || source instanceof Uint8ClampedArray) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      );
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    let bloomTexture = null;
    if (this.bloom && uniforms.bloomStrength > 0) {
      bloomTexture = this.bloom.generate(this.texture, width, height, uniforms.bloomThreshold, uniforms.bloomRadius);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTexture ?? this.texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.location("uSource"), 0);
    gl.uniform1i(this.location("uBloomTex"), 1);
    gl.uniform1f(this.location("uHasBloomTex"), bloomTexture ? 1 : 0);
    gl.uniform2f(this.location("uSourceSize"), width, height);
    gl.uniform1f(this.location("uBrightness"), uniforms.brightness);
    gl.uniform1f(this.location("uContrast"), uniforms.contrast);
    gl.uniform1f(this.location("uSaturation"), uniforms.saturation);
    gl.uniform1f(this.location("uFogDensity"), uniforms.fogDensity);
    gl.uniform1f(this.location("uFogHorizon"), uniforms.fogHorizon);
    gl.uniform3f(this.location("uFogColor"), ...uniforms.fogColor);
    gl.uniform1f(this.location("uBloomStrength"), uniforms.bloomStrength);
    gl.uniform1f(this.location("uBloomThreshold"), uniforms.bloomThreshold);
    gl.uniform1f(this.location("uToneMap"), uniforms.toneMap);
    gl.uniform1f(this.location("uExposure"), uniforms.exposure);
    gl.uniform1f(this.location("uCurvature"), uniforms.curvature);
    gl.uniform1f(this.location("uScanlines"), uniforms.scanlines);
    gl.uniform1f(this.location("uAberration"), uniforms.aberration);
    gl.uniform1f(this.location("uVignette"), uniforms.vignette);
    gl.uniform1f(this.location("uPosterize"), uniforms.posterize);
    gl.uniform1f(this.location("uDitherAmount"), uniforms.ditherAmount);
    gl.uniform1f(this.location("uDitherScale"), uniforms.ditherScale);
    gl.uniform1f(this.location("uHalftoneStrength"), uniforms.halftoneStrength);
    gl.uniform1f(this.location("uHalftoneScale"), uniforms.halftoneScale);
    gl.uniform1f(this.location("uHalftoneAngle"), uniforms.halftoneAngle);
    gl.uniform1f(this.location("uGodrayStrength"), uniforms.godrayStrength);
    gl.uniform1f(this.location("uGodrayDensity"), uniforms.godrayDensity);
    gl.uniform1f(this.location("uGodrayDecay"), uniforms.godrayDecay);
    gl.uniform2f(this.location("uGodrayOrigin"), ...uniforms.godrayOrigin);
    gl.uniform1f(this.location("uStreakStrength"), uniforms.streakStrength);
    gl.uniform1f(this.location("uStreakLength"), uniforms.streakLength);
    gl.uniform1f(this.location("uFlareGlare"), uniforms.flareGlare);
    gl.uniform1f(this.location("uFlareGhosts"), uniforms.flareGhosts);
    gl.uniform1f(this.location("uFlareSize"), uniforms.flareSize);
    gl.uniform3f(this.location("uFlareColor"), ...uniforms.flareColor);
    gl.uniform2f(this.location("uFlareOrigin"), ...uniforms.flareOrigin);
    gl.uniform1f(this.location("uFlareVisible"), uniforms.flareVisible);
    gl.uniform1f(this.location("uSplitStrength"), uniforms.splitStrength);
    gl.uniform1f(this.location("uSplitBalance"), uniforms.splitBalance);
    gl.uniform3f(this.location("uSplitShadows"), ...uniforms.splitShadows);
    gl.uniform3f(this.location("uSplitHighlights"), ...uniforms.splitHighlights);
    gl.uniform1f(this.location("uReflectStrength"), uniforms.reflectionStrength);
    gl.uniform1f(this.location("uReflectHorizon"), uniforms.reflectionHorizon);
    gl.uniform1f(this.location("uReflectFalloff"), uniforms.reflectionFalloff);
    gl.uniform1f(this.location("uReflectWobble"), uniforms.reflectionWobble);
    gl.uniform1f(this.location("uTiltStrength"), uniforms.tiltStrength);
    gl.uniform1f(this.location("uTiltFocus"), uniforms.tiltFocus);
    gl.uniform1f(this.location("uTiltRange"), uniforms.tiltRange);
    gl.uniform1f(this.location("uKaleidoSegments"), uniforms.kaleidoSegments);
    gl.uniform1f(this.location("uKaleidoAngle"), uniforms.kaleidoAngle);
    gl.uniform1f(this.location("uGrainAmount"), uniforms.grainAmount);
    gl.uniform1f(this.location("uGrainSize"), uniforms.grainSize);
    gl.uniform1f(this.location("uTime"), time);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() {
    this.bloom?.dispose();
    this.gl.deleteBuffer(this.quad);
    this.gl.deleteTexture(this.texture);
    this.gl.deleteProgram(this.program);
  }
};

// src/fx/postfx.ts
var POST_FX_EFFECTS = [
  {
    id: "grade",
    label: "Color grade",
    description: "Brightness, contrast, and saturation over the whole frame.",
    params: [
      { id: "brightness", label: "Brightness", min: 0.5, max: 1.5, step: 0.01, defaultValue: 1 },
      { id: "contrast", label: "Contrast", min: 0.5, max: 1.5, step: 0.01, defaultValue: 1 },
      { id: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, defaultValue: 1 }
    ]
  },
  {
    id: "fog",
    label: "Fog",
    description: "Screen-space fog that thickens toward the chosen horizon.",
    colors: [{ id: "tint", label: "Fog colour", defaultValue: "#9db4c8" }],
    params: [
      { id: "density", label: "Density", min: 0, max: 1, step: 0.01, defaultValue: 0.35 },
      { id: "horizon", label: "Horizon", min: 0, max: 1, step: 0.01, defaultValue: 0.4 }
    ]
  },
  {
    id: "bloom",
    label: "Bloom",
    description: "Bright pixels glow past their edges through a multi-scale blur pyramid.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1.5, step: 0.01, defaultValue: 0.6 },
      // The bright-pass gate. Max stays below 1 so a soft knee still has headroom
      // above it (the extract ramps from threshold - knee up to threshold + knee).
      { id: "threshold", label: "Threshold", min: 0, max: 0.95, step: 0.01, defaultValue: 0.6 },
      // How far up the pyramid the glow reaches: 0 keeps it tight around edges, 1
      // spreads the widest, softest halo by weighting the coarser blur levels more.
      { id: "radius", label: "Radius", min: 0, max: 1, step: 0.01, defaultValue: 0.6 }
    ]
  },
  {
    id: "tonemap",
    label: "HDR tonemap",
    description: "Rolls bright highlights off the ACES filmic curve so bloomed light keeps its colour instead of clipping to white.",
    params: [
      // Scales the scene into the curve before mapping: >1 lifts the whole image
      // toward the shoulder (more rolloff), <1 holds detail in the highlights.
      { id: "exposure", label: "Exposure", min: 0.2, max: 3, step: 0.01, defaultValue: 1 }
    ]
  },
  {
    id: "crt",
    label: "CRT",
    description: "Barrel curvature and scanlines, like a tube television.",
    params: [
      { id: "curvature", label: "Curvature", min: 0, max: 0.25, step: 5e-3, defaultValue: 0.08 },
      { id: "scanlines", label: "Scanlines", min: 0, max: 1, step: 0.01, defaultValue: 0.35 }
    ]
  },
  {
    id: "chroma",
    label: "Chromatic aberration",
    description: "Red/blue fringing that grows toward the frame edge.",
    params: [{ id: "amount", label: "Amount", min: 0, max: 3, step: 0.05, defaultValue: 1 }]
  },
  {
    id: "vignette",
    label: "Vignette",
    description: "Darkens the corners of the frame.",
    params: [{ id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.35 }]
  },
  {
    id: "posterize",
    label: "Posterize",
    description: "Quantises colours to a fixed number of levels.",
    params: [{ id: "levels", label: "Levels", min: 2, max: 16, step: 1, defaultValue: 4 }]
  },
  {
    id: "dither",
    label: "Ordered dither",
    description: "Bayer pattern that turns posterised bands into pixel-art stipple.",
    params: [
      { id: "amount", label: "Amount", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "scale", label: "Cell size", min: 1, max: 4, step: 1, defaultValue: 1 }
    ]
  },
  {
    id: "halftone",
    label: "Halftone",
    description: "Print-style dot screen sized by brightness.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
      { id: "scale", label: "Dot size", min: 2, max: 16, step: 1, defaultValue: 5 },
      { id: "angle", label: "Screen angle", min: 0, max: 90, step: 1, defaultValue: 45 }
    ]
  },
  {
    id: "godrays",
    label: "God rays",
    description: "Light shafts streaming out of a bright point in the frame.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 2, step: 0.05, defaultValue: 0.8 },
      { id: "density", label: "Length", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "decay", label: "Falloff", min: 0.8, max: 0.99, step: 5e-3, defaultValue: 0.95 },
      { id: "x", label: "Source X", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "y", label: "Source Y", min: 0, max: 1, step: 0.01, defaultValue: 0.2 }
    ]
  },
  {
    id: "streaks",
    label: "Light streaks",
    description: "Anamorphic horizontal flares off the brightest pixels.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 2, step: 0.05, defaultValue: 0.6 },
      { id: "length", label: "Length", min: 0, max: 1, step: 0.01, defaultValue: 0.4 }
    ]
  },
  {
    id: "lensflare",
    label: "Sun glare & lens flare",
    description: "A glow and starburst round the sun, and lens ghosts strung across the frame from it. In a 3D scene with a sky dome it follows the sun and fades as geometry covers it; otherwise it sits at the source point.",
    colors: [{ id: "tint", label: "Flare colour", defaultValue: "#fff1d6" }],
    params: [
      { id: "glare", label: "Glare", min: 0, max: 2, step: 0.05, defaultValue: 0.8 },
      { id: "ghosts", label: "Ghosts", min: 0, max: 2, step: 0.05, defaultValue: 0.6 },
      { id: "size", label: "Glare size", min: 0.03, max: 0.5, step: 0.01, defaultValue: 0.12 },
      { id: "x", label: "Source X", min: 0, max: 1, step: 0.01, defaultValue: 0.75 },
      { id: "y", label: "Source Y", min: 0, max: 1, step: 0.01, defaultValue: 0.2 }
    ]
  },
  {
    id: "splittone",
    label: "Split tone",
    description: "Tints shadows and highlights toward different colours.",
    colors: [
      { id: "shadows", label: "Shadows", defaultValue: "#3d4f7a" },
      { id: "highlights", label: "Highlights", defaultValue: "#ffd9a0" }
    ],
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      { id: "balance", label: "Balance", min: 0, max: 1, step: 0.01, defaultValue: 0.5 }
    ]
  },
  {
    id: "reflection",
    label: "Wet-floor reflection",
    description: "Mirrors the scene above a horizon line down into the floor below it, fading with distance \u2014 the screen-space reflection of a rain-slick street.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
      // Where the reflective surface begins. Shape, not intensity: it chooses the
      // waterline whether or not the effect is dialled up, so it is read always.
      { id: "horizon", label: "Horizon", min: 0, max: 1, step: 0.01, defaultValue: 0.7 },
      { id: "falloff", label: "Falloff", min: 0.05, max: 1, step: 0.01, defaultValue: 0.4 },
      // Sideways ripple amplitude; animated by the clock so the surface shimmers.
      { id: "wobble", label: "Ripple", min: 0, max: 1, step: 0.01, defaultValue: 0.25 }
    ]
  },
  {
    id: "tiltshift",
    label: "Tilt-shift focus",
    description: "Keeps a horizontal band sharp and blurs above and below it, the miniature-diorama depth of field the cinematic look leans on.",
    params: [
      { id: "strength", label: "Strength", min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
      // The in-focus band's centre row and half-height. Both are shape.
      { id: "focus", label: "Focus row", min: 0, max: 1, step: 0.01, defaultValue: 0.55 },
      { id: "range", label: "In-focus band", min: 0, max: 0.5, step: 0.01, defaultValue: 0.12 }
    ]
  },
  {
    id: "kaleidoscope",
    label: "Kaleidoscope",
    description: "Mirrors a wedge of the frame around the centre.",
    params: [
      // Below 2 there is nothing to mirror, so the shader treats it as off.
      { id: "segments", label: "Segments", min: 2, max: 12, step: 1, defaultValue: 6 },
      { id: "angle", label: "Rotation", min: 0, max: 360, step: 1, defaultValue: 0 }
    ]
  },
  {
    id: "grain",
    label: "Film grain",
    description: "Animated noise over the frame.",
    params: [
      { id: "amount", label: "Amount", min: 0, max: 0.5, step: 0.01, defaultValue: 0.08 },
      { id: "size", label: "Grain size", min: 1, max: 4, step: 1, defaultValue: 1 }
    ]
  }
];
function paramKey(effect, param) {
  return `${effect}.${param}`;
}
var LEGACY_FOG_COLOR_KEY = "fogColor";
var HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
function defaultPostFxSettings() {
  const enabled = {};
  const values = {};
  const colors = {};
  for (const effect of POST_FX_EFFECTS) {
    enabled[effect.id] = false;
    for (const param of effect.params) {
      values[paramKey(effect.id, param.id)] = param.defaultValue;
    }
    for (const color of effect.colors ?? []) {
      colors[paramKey(effect.id, color.id)] = color.defaultValue;
    }
  }
  return { enabled, values, colors };
}
function anyPostFxEnabled(settings) {
  return POST_FX_EFFECTS.some((effect) => settings.enabled[effect.id]);
}
function parsePostFxSettings(value) {
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  const rawEnabled = record.enabled;
  const rawValues = record.values;
  if (typeof rawEnabled !== "object" || rawEnabled === null) return null;
  if (typeof rawValues !== "object" || rawValues === null) return null;
  const rawColors = typeof record.colors === "object" && record.colors !== null ? record.colors : {};
  const settings = defaultPostFxSettings();
  for (const effect of POST_FX_EFFECTS) {
    const enabled = rawEnabled[effect.id];
    if (typeof enabled === "boolean") settings.enabled[effect.id] = enabled;
    for (const param of effect.params) {
      const key = paramKey(effect.id, param.id);
      const raw = rawValues[key];
      if (typeof raw === "number" && Number.isFinite(raw)) {
        settings.values[key] = Math.min(param.max, Math.max(param.min, raw));
      }
    }
    for (const color of effect.colors ?? []) {
      const key = paramKey(effect.id, color.id);
      const raw = rawColors[key];
      if (typeof raw === "string" && HEX_COLOR.test(raw)) settings.colors[key] = raw;
    }
  }
  const legacyFog = record[LEGACY_FOG_COLOR_KEY];
  if (typeof legacyFog === "string" && HEX_COLOR.test(legacyFog) && !(paramKey("fog", "tint") in rawColors)) {
    settings.colors[paramKey("fog", "tint")] = legacyFog;
  }
  return settings;
}
function hexToRgb01(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}
function colorDefault(effect, colorId) {
  const def = POST_FX_EFFECTS.find((entry) => entry.id === effect)?.colors?.find((color) => color.id === colorId);
  return def?.defaultValue ?? "#000000";
}
function uniformsFromSettings(settings) {
  const value = (effect, param, neutral) => settings.enabled[effect] ? settings.values[paramKey(effect, param)] ?? neutral : neutral;
  const shape = (effect, param, fallback) => settings.values[paramKey(effect, param)] ?? fallback;
  const color = (effect, colorId) => hexToRgb01(settings.colors[paramKey(effect, colorId)] ?? colorDefault(effect, colorId));
  return {
    brightness: value("grade", "brightness", 1),
    contrast: value("grade", "contrast", 1),
    saturation: value("grade", "saturation", 1),
    fogDensity: value("fog", "density", 0),
    fogHorizon: shape("fog", "horizon", 0.4),
    fogColor: color("fog", "tint"),
    bloomStrength: value("bloom", "strength", 0),
    bloomThreshold: shape("bloom", "threshold", 0.6),
    bloomRadius: shape("bloom", "radius", 0.6),
    toneMap: settings.enabled.tonemap ? 1 : 0,
    exposure: shape("tonemap", "exposure", 1),
    curvature: value("crt", "curvature", 0),
    scanlines: value("crt", "scanlines", 0),
    aberration: value("chroma", "amount", 0),
    vignette: value("vignette", "strength", 0),
    posterize: settings.enabled.posterize ? shape("posterize", "levels", 4) : 0,
    ditherAmount: value("dither", "amount", 0),
    ditherScale: shape("dither", "scale", 1),
    halftoneStrength: value("halftone", "strength", 0),
    halftoneScale: shape("halftone", "scale", 5),
    halftoneAngle: shape("halftone", "angle", 45) * Math.PI / 180,
    godrayStrength: value("godrays", "strength", 0),
    godrayDensity: shape("godrays", "density", 0.5),
    godrayDecay: shape("godrays", "decay", 0.95),
    godrayOrigin: [shape("godrays", "x", 0.5), shape("godrays", "y", 0.2)],
    streakStrength: value("streaks", "strength", 0),
    streakLength: shape("streaks", "length", 0.4),
    flareGlare: value("lensflare", "glare", 0),
    flareGhosts: value("lensflare", "ghosts", 0),
    flareSize: shape("lensflare", "size", 0.12),
    flareColor: color("lensflare", "tint"),
    flareOrigin: [shape("lensflare", "x", 0.75), shape("lensflare", "y", 0.2)],
    flareVisible: 1,
    splitStrength: value("splittone", "strength", 0),
    splitBalance: shape("splittone", "balance", 0.5),
    splitShadows: color("splittone", "shadows"),
    splitHighlights: color("splittone", "highlights"),
    reflectionStrength: value("reflection", "strength", 0),
    reflectionHorizon: shape("reflection", "horizon", 0.7),
    reflectionFalloff: shape("reflection", "falloff", 0.4),
    reflectionWobble: shape("reflection", "wobble", 0.25),
    tiltStrength: value("tiltshift", "strength", 0),
    tiltFocus: shape("tiltshift", "focus", 0.55),
    tiltRange: shape("tiltshift", "range", 0.12),
    kaleidoSegments: settings.enabled.kaleidoscope ? shape("kaleidoscope", "segments", 6) : 0,
    kaleidoAngle: shape("kaleidoscope", "angle", 0) * Math.PI / 180,
    grainAmount: value("grain", "amount", 0),
    grainSize: shape("grain", "size", 1)
  };
}

// src/fx/PostFxSurface.ts
var MAX_RENDER_SCALE = 3;
var MAX_RENDER_WIDTH = 1280;
var PostFxSurface = class _PostFxSurface {
  constructor(container, scaleMode, model, inner, innerCanvas, canvas, pass, settings) {
    this.container = container;
    this.scaleMode = scaleMode;
    this.model = model;
    this.inner = inner;
    this.innerCanvas = innerCanvas;
    this.canvas = canvas;
    this.pass = pass;
    /** When this surface started, so animated effects get a monotonic clock. */
    this.startedAt = performance.now();
    /** The sun a 3D scene reports this frame; the lens flare follows it. Null = use the source point. */
    this.sun = null;
    this.uniforms = uniformsFromSettings(settings);
    this.canvas.style.imageRendering = "pixelated";
    this.canvas.style.display = "block";
    this.canvas.style.margin = "auto";
    container.appendChild(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.applyScale());
    this.resizeObserver.observe(container);
    this.applyScale();
  }
  /**
   * Builds the FX surface, or returns null when post-processing cannot run
   * (the caller should then mount the inner surface directly). The inner
   * factory is only invoked once the FX pass itself is viable.
   */
  static async create(container, scaleMode, model, settings, makeInner) {
    const document2 = container.ownerDocument;
    const canvas = document2.createElement("canvas");
    const renderScale = Math.max(1, Math.min(MAX_RENDER_SCALE, Math.floor(MAX_RENDER_WIDTH / model.width)));
    canvas.width = model.width * renderScale;
    canvas.height = model.height * renderScale;
    const pass = PostFxPass.create(canvas);
    if (!pass) return null;
    const innerContainer = document2.createElement("div");
    const inner = await makeInner(innerContainer);
    const innerCanvas = innerContainer.querySelector("canvas");
    if (!innerCanvas) {
      inner.destroy();
      pass.dispose();
      return null;
    }
    return new _PostFxSurface(container, scaleMode, model, inner, innerCanvas, canvas, pass, settings);
  }
  /** Swap the effect stack without rebuilding the pipeline. */
  setSettings(settings) {
    this.uniforms = uniformsFromSettings(settings);
  }
  /**
   * Follow a 3D scene's sun with the lens flare (HALO2_STYLE_ROADMAP.md, H8),
   * or null to go back to the effect's own source point.
   */
  setSun(sun) {
    this.sun = sun;
  }
  blit(rgba) {
    this.inner.blit(rgba);
    const sun = this.sun;
    this.pass.render(
      this.innerCanvas,
      this.model.width,
      this.model.height,
      sun ? { ...this.uniforms, flareOrigin: [sun.x, sun.y], flareVisible: sun.visible } : this.uniforms,
      (performance.now() - this.startedAt) / 1e3
    );
  }
  destroy() {
    this.resizeObserver.disconnect();
    this.pass.dispose();
    this.canvas.remove();
    this.inner.destroy();
  }
  applyScale() {
    const { width, height } = computeScaledSize(
      this.container.clientWidth,
      this.container.clientHeight,
      this.model.width,
      this.model.height,
      this.scaleMode
    );
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }
};

// src/quality.ts
var QUALITY_LEVELS = ["low", "medium", "high"];
var QUALITY_PRESETS = {
  high: { level: "high", shadows: true, shadowMapSize: 1024, shadowCascades: true, maxRenderScale: 1, disabledEffects: [], terrainDetail: 1 },
  medium: { level: "medium", shadows: true, shadowMapSize: 512, maxRenderScale: 0.75, disabledEffects: [], terrainDetail: 0.6 },
  low: { level: "low", shadows: false, shadowMapSize: 512, maxRenderScale: 0.5, disabledEffects: ["bloom", "chroma"], terrainDetail: 0.3 }
};
function detectQuality(hints) {
  if (hints.cores !== void 0 && hints.cores <= 2 || hints.memoryGB !== void 0 && hints.memoryGB <= 2) return "low";
  if (hints.mobile || hints.webgpu === false) return "medium";
  return "high";
}
function resolveQuality(choice, hints) {
  const level = !choice || choice === "auto" ? detectQuality(hints) : choice;
  return QUALITY_PRESETS[QUALITY_LEVELS.includes(level) ? level : "high"];
}
function browserDeviceHints(webgpu) {
  const nav = typeof navigator === "undefined" ? void 0 : navigator;
  if (!nav) return webgpu === void 0 ? {} : { webgpu };
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? "");
  return {
    ...typeof nav.hardwareConcurrency === "number" ? { cores: nav.hardwareConcurrency } : {},
    ...typeof nav.deviceMemory === "number" ? { memoryGB: nav.deviceMemory } : {},
    mobile,
    ...webgpu === void 0 ? {} : { webgpu }
  };
}
function applyQualityToPostFx(settings, quality) {
  if (!quality.disabledEffects.some((id) => settings.enabled[id])) return settings;
  const enabled = { ...settings.enabled };
  for (const id of quality.disabledEffects) if (id in enabled) enabled[id] = false;
  return { ...settings, enabled };
}

// src/net/netplay.ts
var NET_WORDS = 119;
var NET_SLOTS = 8;
var NET_STATE_WORDS = 3;
var NET_IN_HEADER = 0;
var NET_IN_MATCH = 1;
var NET_IN_SEQ = 2;
var NET_IN_SLOTS = 3;
var NET_IN_EVENT_COUNT = 27;
var NET_IN_EVENTS = 28;
var NET_IN_EVENT_CAPACITY = 20;
var NET_OUT_MASK = 70;
var NET_OUT_MATCH = 71;
var NET_OUT_SLOTS = 72;
var NET_OUT_EVENT_COUNT = 96;
var NET_OUT_EVENTS = 97;
var NET_OUT_EVENT_CAPACITY = 10;
var NET_MODE_OFFLINE = 0;
var NET_MODE_CLIENT = 1;
var NET_MODE_HOST = 2;
function writeNetInbox(words, inbox) {
  words[NET_IN_HEADER] = (inbox.mode & 3 | (inbox.mySlot & 7) << 2 | ((inbox.status ?? 0) & 7) << 5 | (inbox.humans & 255) << 8 | (inbox.live & 255) << 16) >>> 0;
  words[NET_IN_MATCH] = inbox.match >>> 0;
  words[NET_IN_SEQ] = inbox.seq >>> 0;
  for (let slot = 0; slot < NET_SLOTS; slot += 1) {
    const state = inbox.slots[slot] ?? null;
    for (let k = 0; k < NET_STATE_WORDS; k += 1) {
      words[NET_IN_SLOTS + slot * NET_STATE_WORDS + k] = state ? state[k] >>> 0 : 0;
    }
  }
  const count = Math.min(inbox.events.length, NET_IN_EVENT_CAPACITY);
  words[NET_IN_EVENT_COUNT] = count;
  for (let i = 0; i < count; i += 1) {
    words[NET_IN_EVENTS + i * 2] = inbox.events[i][0] >>> 0;
    words[NET_IN_EVENTS + i * 2 + 1] = inbox.events[i][1] >>> 0;
  }
  return count;
}
function takeNetOutbox(words) {
  const mask = words[NET_OUT_MASK] & 255;
  const states = /* @__PURE__ */ new Map();
  for (let slot = 0; slot < NET_SLOTS; slot += 1) {
    if (!(mask & 1 << slot)) continue;
    const base = NET_OUT_SLOTS + slot * NET_STATE_WORDS;
    states.set(slot, [words[base], words[base + 1], words[base + 2]]);
  }
  const count = Math.min(words[NET_OUT_EVENT_COUNT], NET_OUT_EVENT_CAPACITY);
  const events = [];
  for (let i = 0; i < count; i += 1) events.push([words[NET_OUT_EVENTS + i * 2], words[NET_OUT_EVENTS + i * 2 + 1]]);
  const match = words[NET_OUT_MATCH];
  words[NET_OUT_MASK] = 0;
  words[NET_OUT_EVENT_COUNT] = 0;
  return { states, match, events };
}

// src/models.ts
var SOFTWARE_RASTER_CAPS = {
  zBuffer: true,
  perspectiveCorrect: true,
  textureFiltering: "none",
  vertexPrecision: "float",
  textureCacheBytes: 0,
  polyBudget: 0,
  programmableShaders: false
};
var PS1_RASTER_CAPS = {
  zBuffer: false,
  perspectiveCorrect: false,
  vertexPrecision: "integer",
  textureFiltering: "none",
  textureCacheBytes: 64 * 1024,
  polyBudget: 3e3,
  programmableShaders: false
};
var N64_RASTER_CAPS = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "trilinear",
  textureCacheBytes: 4 * 1024,
  polyBudget: 7e3,
  programmableShaders: false
};
var XBOX360_RASTER_CAPS = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "trilinear",
  textureCacheBytes: 0,
  polyBudget: 0,
  programmableShaders: false
};
var MODERN_RASTER_CAPS = {
  zBuffer: true,
  perspectiveCorrect: true,
  vertexPrecision: "float",
  textureFiltering: "trilinear",
  textureCacheBytes: 0,
  polyBudget: 0,
  programmableShaders: true
};
var MODELS = {
  classic: {
    id: "classic",
    label: "Classic",
    kind: "raster2d",
    width: 240,
    height: 136,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 2,
    sampleRate: 44100,
    paletteSize: 16,
    cartSizeBytes: 64 * 1024,
    // The classic core ships at /engine/tic80.js (not a /classic/ subdirectory
    // like the later models). The web app already loads it from here via
    // ENGINE_URL_BY_MODEL; this default was pointing at a path that has never
    // existed, so any caller that mounted a classic cart without an explicit
    // engineUrl override got a 404.
    engineUrl: "/engine/tic80.js",
    inputs: ["gamepad", "mouse", "keyboard"],
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0
  },
  pro: {
    id: "pro",
    label: "Pro",
    kind: "raster2d",
    // 16:9 (640x360): scales to 1080p at exact 3x and 4K at 6x. Big enough that a
    // Classic cart (240x136) composites at pixel-perfect integer 2x (480x272)
    // pillarboxed inside with even 80px side / 44px top-bottom margins, rather
    // than being non-integer-scaled to fit. Both dimensions divide the 8px tile
    // grid (80x45 cells).
    width: 640,
    height: 360,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    // 64-color authoring palette (editor-enforced), 4x Classic's 16. The pro core's
    // framebuffer is 8bpp/256-capable (6bpp is not byte-aligned; see the engine
    // build note), so 64 is the creative limit, not a hardware cap.
    paletteSize: 64,
    cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/pro/engine.js",
    inputs: ["gamepad", "mouse", "keyboard"],
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0
  },
  portrait: {
    id: "portrait",
    label: "Portrait",
    kind: "raster2d",
    // 9:16 (360x640) — the Pro spec turned on its side, for carts played the way
    // a handheld is actually held. Deliberately Pro's exact pixel count
    // (360*640 == 640*360), so the core reuses Pro's framebuffer and memory map
    // unchanged; only the two dimensions and the overscan buffer differ.
    // Both divide the 8px tile grid (45x80 cells).
    width: 360,
    height: 640,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 64,
    cartSizeBytes: 1024 * 1024,
    engineUrl: "/engine/portrait/engine.js",
    inputs: ["gamepad", "mouse", "keyboard"],
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0
  },
  voxel: {
    id: "voxel",
    label: "Voxel",
    kind: "voxel3d",
    width: 320,
    height: 180,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    cartSizeBytes: 2 * 1024 * 1024,
    // No voxel core is built yet, so /engine/voxel/engine.js does not exist —
    // pointing here would 404. Fall back to the classic core, matching the web
    // app's ENGINE_URL_BY_MODEL, which is why voxel is not offered as a
    // selectable model. Replace this with the real core once it is built.
    engineUrl: "/engine/tic80.js",
    inputs: ["gamepad", "mouse"],
    renderCaps: SOFTWARE_RASTER_CAPS,
    assetBudgetBytes: 0
  },
  ps1: {
    id: "ps1",
    label: "PS1",
    kind: "poly3d",
    // 320x240, the era's NTSC frame. 4:3 rather than the 16:9 the Pro models
    // use, because the aspect ratio is as much a period signal as the pixels:
    // a 16:9 PS1 game would read as a remaster.
    width: 320,
    height: 240,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    // 8-bit CLUT textures were the era's workhorse (4-bit for the rest), so 256
    // is authentic rather than a compromise.
    paletteSize: 256,
    // The cartridge carries code, 2D art and sound. Geometry and textures do
    // not live here — they go to the content-addressed asset store, which is
    // the whole reason a 3D era model is possible at all.
    cartSizeBytes: 2 * 1024 * 1024,
    engineUrl: "/engine/ps1/engine.js",
    inputs: ["gamepad", "keyboard"],
    renderCaps: PS1_RASTER_CAPS,
    // A CD-ROM, because that is what the era's games shipped on. The disc is
    // the defining physical fact about this generation — it is why its games
    // have full-motion video, streamed audio and textured worlds at all, where
    // the cartridge eras did not.
    //
    // The alternative was a smaller figure chosen to keep pressure on the
    // artist. That would be inventing a constraint the hardware did not have,
    // which is the opposite of how every other number in this file was picked:
    // the frame is 320x240 because that is the frame, and the texture cache is
    // 64KB because that is the page. The budget follows the same rule.
    //
    // The pressure that shaped the era's art comes from the caps above — a
    // 64KB texture page and a 3,000-triangle frame — not from disc capacity.
    // Those bind on every frame; the disc only ever bound on the whole game.
    assetBudgetBytes: 660 * 1024 * 1024
  },
  n64: {
    id: "n64",
    label: "N64",
    kind: "poly3d",
    // 320x240, the era's common output. The N64 shared the PS1's resolution;
    // what separated the generations was rendering, not pixels, so the
    // difference lives entirely in renderCaps below — a z-buffer, perspective
    // correction, filtering, and the 4KB texture cache — not in this number.
    width: 320,
    height: 240,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    // Code, 2D HUD art and sound. Geometry and textures live in the asset store.
    cartSizeBytes: 4 * 1024 * 1024,
    engineUrl: "/engine/n64/engine.js",
    inputs: ["gamepad", "keyboard"],
    renderCaps: N64_RASTER_CAPS,
    // A cartridge, not a disc — 64MB, the largest the generation shipped. This
    // is the era-true inverse of the PS1: better rendering, an order of
    // magnitude *less* storage. The tiny cartridge and the 4KB texture cache
    // pull the same direction — small, heavily-reused textures — from storage
    // and from fill respectively.
    assetBudgetBytes: 64 * 1024 * 1024
  },
  xbox360: {
    id: "xbox360",
    label: "Xbox 360",
    kind: "poly3d",
    // 1280x720 — the generation's signature output, and the first in this family
    // that is HD. This is why it needs its own core binary: the framebuffer and
    // the core's per-frame draw buffers are sized from these compile-time
    // constants (see build-xbox360-wasm.sh).
    width: 1280,
    height: 720,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 44100,
    paletteSize: 256,
    cartSizeBytes: 8 * 1024 * 1024,
    engineUrl: "/engine/xbox360/engine.js",
    inputs: ["gamepad", "keyboard"],
    renderCaps: XBOX360_RASTER_CAPS,
    // 2GB — Xbox Live Arcade's final size ceiling, the closest thing the 360 had
    // to a fixed content budget (the doctrine wants a number that evokes the era,
    // and a 360 disc's ~7.9GB is neither web-sane nor how most of this content
    // shipped). Large, because this is the tier where storage genuinely stops
    // being the constraint — which is the whole point ERA_MODELS.md makes about
    // it not being console-shaped.
    assetBudgetBytes: 2 * 1024 * 1024 * 1024
  },
  modern: {
    id: "modern",
    label: "Modern (AAA)",
    kind: "poly3d",
    // 1080p output — the target for a modern, PBR-lit web title. The stub reuses
    // the 360 core binary (its framebuffer scales), so a dedicated core is not
    // required to prototype the tier; see AAA_TIER_ROADMAP.md Phase 1.
    width: 1920,
    height: 1080,
    pixelBytes: 4,
    fps: 60,
    audioChannels: 8,
    sampleRate: 48e3,
    paletteSize: 256,
    cartSizeBytes: 8 * 1024 * 1024,
    // Stub: reuse the 360 core until a dedicated Modern core lands (Phase 1).
    engineUrl: "/engine/xbox360/engine.js",
    inputs: ["gamepad", "keyboard", "mouse"],
    renderCaps: MODERN_RASTER_CAPS,
    // 8GB — this tier's whole premise is that storage is no longer the constraint;
    // real photoreal scenes need room for compressed meshes + PBR texture sets.
    assetBudgetBytes: 8 * 1024 * 1024 * 1024
  }
};
var DEFAULT_MODEL_ID = "classic";
function getModel(id = DEFAULT_MODEL_ID) {
  const model = MODELS[id];
  if (!model) {
    throw new Error(`Unknown console model: ${id}`);
  }
  return model;
}
function framebufferBytes(model) {
  return model.width * model.height * model.pixelBytes;
}
function frameDurationMs(model) {
  return 1e3 / model.fps;
}

// src/engine.ts
function readCString(heap, ptr) {
  if (ptr === 0) return "";
  let end = ptr;
  while (end < heap.length && heap[end] !== 0) end += 1;
  return new TextDecoder().decode(heap.subarray(ptr, end));
}
var moduleCache = /* @__PURE__ */ new Map();
var EngineLoadError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "EngineLoadError";
  }
};
async function loadEngineModule(engineUrl, wasm) {
  const cached = moduleCache.get(engineUrl);
  if (cached) {
    return cached;
  }
  const pending = import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    engineUrl
  ).then((glue) => glue.default(wasm ? { wasmBinary: wasm, locateFile: (file) => file } : void 0)).catch((error) => {
    moduleCache.delete(engineUrl);
    throw new EngineLoadError(`Failed to load the engine module at ${engineUrl}`, error);
  });
  moduleCache.set(engineUrl, pending);
  return pending;
}
function createConsole(module, model, sampleRate = model.sampleRate) {
  const handle = module._cbx_create(sampleRate);
  if (handle === 0) {
    throw new Error("Engine failed to create a console instance");
  }
  const frameBytes = framebufferBytes(model);
  return {
    loadCartridge(bytes) {
      const ptr = module._malloc(bytes.byteLength);
      try {
        module.HEAPU8.set(bytes, ptr);
        return module._cbx_load(handle, ptr, bytes.byteLength) === 1;
      } finally {
        module._free(ptr);
      }
    },
    tick(gamepadMask) {
      module._cbx_tick(handle, gamepadMask);
    },
    readFramebuffer() {
      const ptr = module._cbx_screen_ptr(handle);
      return module.HEAPU8.subarray(ptr, ptr + frameBytes);
    },
    readAudioSamples() {
      const count = module._cbx_samples_count(handle);
      if (count === 0) {
        return new Int16Array(0);
      }
      const ptr = module._cbx_samples_ptr(handle);
      const start = ptr / Int16Array.BYTES_PER_ELEMENT;
      return module.HEAP16.slice(start, start + count);
    },
    netWords() {
      const ptr = module._cbx_mailbox_ptr(handle);
      if (ptr === 0) return null;
      return new Uint32Array(module.HEAPU8.buffer, ptr - NET_WORDS * 4, NET_WORDS);
    },
    ramView(offsetFromPmem, length) {
      const ptr = module._cbx_mailbox_ptr(handle);
      if (ptr === 0) return null;
      const start = ptr - NET_WORDS * 4 + offsetFromPmem;
      if (start < 0 || start + length > module.HEAPU8.length) return null;
      return module.HEAPU8.subarray(start, start + length);
    },
    readMailbox() {
      const ptr = module._cbx_mailbox_ptr(handle);
      const words = module._cbx_mailbox_words(handle);
      if (ptr === 0 || words === 0) {
        return new Uint32Array(0);
      }
      return new Uint32Array(module.HEAPU8.buffer, ptr, words).slice();
    },
    setMaterialCapture(enabled) {
      module._cbx_set_material_capture(handle, enabled ? 1 : 0);
    },
    readMaterial() {
      const ptr = module._cbx_material_ptr(handle);
      return module.HEAPU8.subarray(ptr, ptr + frameBytes);
    },
    readEmissive() {
      const ptr = module._cbx_emissive_ptr(handle);
      return module.HEAPU8.subarray(ptr, ptr + frameBytes / 4);
    },
    readError() {
      if (typeof module._cbx_error_seq !== "function" || typeof module._cbx_last_error !== "function") {
        return null;
      }
      const seq = module._cbx_error_seq();
      const message = readCString(module.HEAPU8, module._cbx_last_error());
      return { seq, message };
    },
    memoryBytes() {
      return module.HEAPU8.byteLength;
    },
    dispose() {
      module._cbx_delete(handle);
    }
  };
}

// src/types.ts
var ConsoleButton = /* @__PURE__ */ ((ConsoleButton2) => {
  ConsoleButton2[ConsoleButton2["Up"] = 0] = "Up";
  ConsoleButton2[ConsoleButton2["Down"] = 1] = "Down";
  ConsoleButton2[ConsoleButton2["Left"] = 2] = "Left";
  ConsoleButton2[ConsoleButton2["Right"] = 3] = "Right";
  ConsoleButton2[ConsoleButton2["A"] = 4] = "A";
  ConsoleButton2[ConsoleButton2["B"] = 5] = "B";
  ConsoleButton2[ConsoleButton2["X"] = 6] = "X";
  ConsoleButton2[ConsoleButton2["Y"] = 7] = "Y";
  return ConsoleButton2;
})(ConsoleButton || {});

// src/sticks.ts
var STICK_WORD = 68;
var STICK_OPTIN_WORD = 69;
var STICK_OPTIN_MAGIC = 1398033201;
var STICK_DPAD_THRESHOLD = 0.4;
var byte = (v) => Math.round(Math.max(-1, Math.min(1, v || 0)) * 127) & 255;
function packSticks(axes) {
  return (byte(axes[0]) | byte(axes[1]) << 8 | byte(axes[2]) << 16 | byte(axes[3]) << 24) >>> 0;
}
function stickDirections(x, y, threshold = STICK_DPAD_THRESHOLD) {
  let bits = 0;
  if (y < -threshold) bits |= 1 << 0 /* Up */;
  if (y > threshold) bits |= 1 << 1 /* Down */;
  if (x < -threshold) bits |= 1 << 2 /* Left */;
  if (x > threshold) bits |= 1 << 3 /* Right */;
  return bits;
}

// src/controls.ts
import { parseActionRebinds } from "@cartbox/editor";
var PAD_BUTTONS = [
  "A",
  "B",
  "X",
  "Y",
  "LB",
  "RB",
  "LT",
  "RT",
  "Back",
  "Start",
  "LS",
  "RS",
  "Up",
  "Down",
  "Left",
  "Right",
  "Guide"
];
var DEFAULT_PAD_BINDINGS = {
  A: 4 /* A */,
  B: 5 /* B */,
  X: 6 /* X */,
  Y: 7 /* Y */,
  LB: 6 /* X */,
  RB: 7 /* Y */,
  LT: 6 /* X */,
  RT: 4 /* A */,
  Back: "start",
  Start: "start",
  LS: null,
  RS: 6 /* X */,
  Up: 0 /* Up */,
  Down: 1 /* Down */,
  Left: 2 /* Left */,
  Right: 3 /* Right */,
  Guide: "start"
};
var DEFAULT_KEY_BINDINGS = {
  ArrowUp: 0 /* Up */,
  ArrowDown: 1 /* Down */,
  ArrowLeft: 2 /* Left */,
  ArrowRight: 3 /* Right */,
  KeyZ: 4 /* A */,
  KeyX: 5 /* B */,
  KeyA: 6 /* X */,
  KeyS: 7 /* Y */
};
var START_KEYS = ["Escape", "Enter", "KeyP"];
var DEFAULT_CONTROL_SETTINGS = {
  invertY: false,
  lookSensitivity: 1,
  padBindings: DEFAULT_PAD_BINDINGS,
  keyBindings: DEFAULT_KEY_BINDINGS,
  touchOpacity: 0.85,
  touchScale: 1
};
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
var isConsoleButton = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 7;
function parseControlSettings(value, defaults = DEFAULT_CONTROL_SETTINGS) {
  if (typeof value !== "object" || value === null) return defaults;
  const raw = value;
  const num3 = (v, lo, hi, fallback) => typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
  const padBindings = { ...defaults.padBindings };
  if (typeof raw.padBindings === "object" && raw.padBindings !== null) {
    for (const [name, target] of Object.entries(raw.padBindings)) {
      if (!PAD_BUTTONS.includes(name)) continue;
      if (target === null || target === "start" || isConsoleButton(target)) padBindings[name] = target;
    }
  }
  let keyBindings = { ...defaults.keyBindings };
  if (typeof raw.keyBindings === "object" && raw.keyBindings !== null) {
    const entries = Object.entries(raw.keyBindings).filter(
      (entry) => /^[A-Za-z0-9]{1,24}$/.test(entry[0]) && isConsoleButton(entry[1])
    );
    if (entries.length > 0) keyBindings = Object.fromEntries(entries);
  }
  return {
    invertY: typeof raw.invertY === "boolean" ? raw.invertY : defaults.invertY,
    lookSensitivity: num3(raw.lookSensitivity, 0.25, 3, defaults.lookSensitivity),
    padBindings,
    keyBindings,
    touchOpacity: num3(raw.touchOpacity, 0.2, 1, defaults.touchOpacity),
    touchScale: num3(raw.touchScale, 0.7, 1.4, defaults.touchScale),
    ...raw.actionBindings !== void 0 ? { actionBindings: parseActionRebinds(raw.actionBindings) } : defaults.actionBindings ? { actionBindings: defaults.actionBindings } : {}
  };
}
function applyLookSettings(axes, settings) {
  const s = settings.lookSensitivity;
  const rx = clamp((axes[2] ?? 0) * s, -1, 1);
  const ry = clamp((axes[3] ?? 0) * s * (settings.invertY ? -1 : 1), -1, 1);
  return [axes[0] ?? 0, axes[1] ?? 0, rx, ry];
}
function deadZoned(x, y, deadZone = 0.18) {
  const m = Math.hypot(x, y);
  if (m < deadZone) return [0, 0];
  const k = Math.min(1, (m - deadZone) / (1 - deadZone)) / m;
  return [x * k, y * k];
}
function standardizePad(pad) {
  if (pad.mapping === "standard" || pad.mapping === void 0) return pad;
  const xbox = /x-?box|xinput|045e|360/i.test(pad.id ?? "");
  if (!xbox || pad.buttons.length < 11 || pad.axes.length < 8) return pad;
  const b = (i) => pad.buttons[i] ?? { pressed: false, value: 0 };
  const axis = (i) => pad.axes[i] ?? 0;
  const synth = (down, value = down ? 1 : 0) => ({ pressed: down, value });
  const trigger = (i) => {
    const value = (axis(i) + 1) / 2;
    return synth(value > 0.5, value);
  };
  return {
    axes: [axis(0), axis(1), axis(3), axis(4)],
    buttons: [
      b(0),
      b(1),
      b(2),
      b(3),
      b(4),
      b(5),
      trigger(2),
      trigger(5),
      b(6),
      b(7),
      b(9),
      b(10),
      synth(axis(7) < -0.5),
      synth(axis(7) > 0.5),
      synth(axis(6) < -0.5),
      synth(axis(6) > 0.5),
      b(8)
    ]
  };
}
function readPad(raw, bindings) {
  const pad = standardizePad(raw);
  let mask = 0;
  let start = false;
  const pressed = /* @__PURE__ */ new Set();
  PAD_BUTTONS.forEach((name, index) => {
    const button = pad.buttons[index];
    const down = button ? button.pressed || button.value > 0.5 : false;
    if (!down) return;
    pressed.add(name);
    const target = bindings[name];
    if (target === "start") start = true;
    else if (target !== null && target !== void 0) mask |= 1 << target;
  });
  if (bindings.Start === null && !Object.values(bindings).includes("start") && pad.buttons[9]?.pressed) start = true;
  const [lx, ly] = deadZoned(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
  const [rx, ry] = deadZoned(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
  return { mask, axes: [lx, ly, rx, ry], start, pressed };
}

// src/input.ts
var NO_KEYS = /* @__PURE__ */ new Set();
function resolveButton(keyCode, bindings = DEFAULT_KEY_BINDINGS) {
  return bindings[keyCode];
}
var GamepadState = class {
  constructor() {
    this.mask = 0;
    /** D-pad bits the left stick is pressing (kept apart so a key release can't clear them). */
    this.stickMask = 0;
    /** What a physical controller is pressing, replaced wholesale each poll. */
    this.padMask = 0;
    /** The on-screen sticks and a controller's sticks, kept apart and merged on read. */
    this.touchAxes = [0, 0, 0, 0];
    this.padAxes = [0, 0, 0, 0];
  }
  /** Analog sticks: left x, left y, right x, right y, each −1..1 (y down-positive) —
   *  per stick, whichever source (touch or controller) is leaning further. */
  get axes() {
    const out = [0, 0, 0, 0];
    for (const i of [0, 2]) {
      const t = Math.hypot(this.touchAxes[i], this.touchAxes[i + 1]);
      const p = Math.hypot(this.padAxes[i], this.padAxes[i + 1]);
      const src = p > t ? this.padAxes : this.touchAxes;
      out[i] = src[i];
      out[i + 1] = src[i + 1];
    }
    return out;
  }
  /** A controller's state this frame: its pressed console buttons and sticks. */
  setPad(mask, axes) {
    this.padMask = mask;
    for (let i = 0; i < 4; i += 1) this.padAxes[i] = axes[i] ?? 0;
  }
  press(button) {
    this.mask |= 1 << button;
  }
  release(button) {
    this.mask &= ~(1 << button);
  }
  /**
   * Set a stick's position (0 = left, 1 = right). The left stick also presses
   * the D-pad directions it leans toward, so button-only carts steer with it.
   */
  setStick(index, x, y) {
    this.touchAxes[index * 2] = x;
    this.touchAxes[index * 2 + 1] = y;
    if (index === 0) this.stickMask = stickDirections(x, y);
  }
  /** The engine-facing bitmask for player one. A controller's left stick also
   *  presses the D-pad directions it leans toward, like the on-screen one. */
  get value() {
    return this.mask | this.stickMask | this.padMask | stickDirections(this.padAxes[0], this.padAxes[1]);
  }
  reset() {
    this.mask = 0;
    this.stickMask = 0;
    this.padMask = 0;
    this.touchAxes.fill(0);
    this.padAxes.fill(0);
  }
};
var KeyboardInput = class {
  /**
   * @param bindings The key map, or a getter for it (read on every key, so a
   *   rebind from a settings menu applies at once).
   * @param onStart Called for a Start key (Enter / P) that isn't bound to a button.
   * @param claimed Keys the cart's input actions bind. They're the actions':
   *   kept from the page (no scrolling on Space), and they press no console
   *   button and never open Start.
   */
  constructor(target, state, bindings = DEFAULT_KEY_BINDINGS, onStart, claimed = () => NO_KEYS) {
    this.target = target;
    /** Every key held now (KeyboardEvent.code), bound or not — what input actions read. */
    this.held = /* @__PURE__ */ new Set();
    const current = typeof bindings === "function" ? bindings : () => bindings;
    const held = /* @__PURE__ */ new Map();
    this.onKeyDown = (event) => {
      const tag = event.target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (!typing) this.held.add(event.code);
      const button = resolveButton(event.code, current());
      if (claimed().has(event.code) && !typing) {
        event.preventDefault();
        return;
      }
      if (button !== void 0) {
        held.set(event.code, button);
        state.press(button);
        event.preventDefault();
      } else if (onStart && START_KEYS.includes(event.code) && !event.repeat) {
        if (typing || tag === "BUTTON") return;
        event.preventDefault();
        onStart();
      }
    };
    this.onKeyUp = (event) => {
      this.held.delete(event.code);
      const button = held.get(event.code) ?? resolveButton(event.code, current());
      held.delete(event.code);
      if (button !== void 0) {
        state.release(button);
      }
    };
    this.onBlur = () => this.held.clear();
    target.addEventListener("keydown", this.onKeyDown);
    target.addEventListener("keyup", this.onKeyUp);
    target.addEventListener("blur", this.onBlur);
  }
  destroy() {
    this.target.removeEventListener("keydown", this.onKeyDown);
    this.target.removeEventListener("keyup", this.onKeyUp);
    this.target.removeEventListener("blur", this.onBlur);
  }
};
var TOUCH_LAYOUT = [
  { button: 7 /* Y */, label: "Y", hint: "S", cluster: "face", col: 2, row: 1 },
  { button: 6 /* X */, label: "X", hint: "A", cluster: "face", col: 1, row: 2 },
  { button: 5 /* B */, label: "B", hint: "X", cluster: "face", col: 3, row: 2 },
  { button: 4 /* A */, label: "A", hint: "Z", cluster: "face", col: 2, row: 3 }
];
function hasTouchSupport(maxTouchPoints, coarsePointer) {
  return maxTouchPoints > 0 || coarsePointer;
}
var FACE_SIZE = "clamp(40px, 8vmin, 68px)";
var STICK_SIZE = "clamp(110px, 24vmin, 190px)";
function stickVector(dx, dy, radius, deadZone = 0.12) {
  const r = Math.max(1, radius);
  let x = dx / r;
  let y = dy / r;
  const m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
  }
  if (m < deadZone) return { x: 0, y: 0 };
  const k = (Math.min(1, m) - deadZone) / (1 - deadZone) / Math.min(1, m);
  return { x: x * k, y: y * k };
}
var TouchInput = class {
  constructor(container, state, onStart) {
    this.restorePosition = null;
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    if (view && view.getComputedStyle(container).position === "static") {
      const previous = container.style.position;
      container.style.position = "relative";
      this.restorePosition = () => {
        container.style.position = previous;
      };
    }
    this.root = doc.createElement("div");
    this.root.setAttribute("data-cbx-touch", "");
    Object.assign(this.root.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      // only the buttons catch input; the game stays visible
      zIndex: "5",
      userSelect: "none",
      webkitUserSelect: "none"
    });
    this.pad = doc.createElement("div");
    Object.assign(this.pad.style, { position: "absolute", inset: "0", pointerEvents: "none", transformOrigin: "50% 100%" });
    this.root.appendChild(this.pad);
    const face = doc.createElement("div");
    Object.assign(face.style, {
      position: "absolute",
      bottom: "4%",
      right: "3%",
      display: "grid",
      gridTemplateColumns: `repeat(3, ${FACE_SIZE})`,
      gridTemplateRows: `repeat(3, ${FACE_SIZE})`,
      gap: "4px"
    });
    this.pad.appendChild(face);
    for (const control of TOUCH_LAYOUT) face.appendChild(this.createButton(doc, control, state));
    this.createStick(doc, state, 0, { left: "4%", bottom: "6%" });
    this.rightStick = this.createStick(doc, state, 1, { right: `calc(3% + 3 * ${FACE_SIZE} + 8px + 3vmin)`, bottom: "6%" });
    this.rightStick.style.display = "none";
    if (onStart) {
      const start = doc.createElement("button");
      start.type = "button";
      start.setAttribute("data-cbx-button", "Start");
      start.setAttribute("aria-label", "Start (menu)");
      start.textContent = "\u2261 START";
      Object.assign(start.style, {
        position: "absolute",
        top: "2%",
        left: "50%",
        transform: "translateX(-50%)",
        pointerEvents: "auto",
        touchAction: "none",
        padding: "6px 14px",
        borderRadius: "999px",
        border: "2px solid rgba(255,255,255,0.45)",
        background: "rgba(20,26,40,0.55)",
        color: "rgba(255,255,255,0.92)",
        font: "700 12px/1 system-ui, sans-serif",
        letterSpacing: "1px",
        cursor: "pointer"
      });
      start.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        onStart();
      });
      this.pad.appendChild(start);
    }
    container.appendChild(this.root);
  }
  /** Apply the player's touch settings: overall opacity and size of the pad. */
  applySettings(settings) {
    this.pad.style.opacity = String(settings.touchOpacity);
    for (const child of Array.from(this.pad.children)) {
      if (child.getAttribute("data-cbx-button") === "Start") continue;
      child.style.scale = String(settings.touchScale);
      child.style.transformOrigin = child.style.left ? "0% 100%" : "100% 100%";
    }
  }
  /** Show the right stick: the cart reads analog sticks. */
  setAnalog(on) {
    this.rightStick.style.display = on ? "block" : "none";
  }
  /** A virtual thumbstick: a ring you press anywhere in, and a knob that follows the thumb. */
  createStick(doc, state, index, place2) {
    const base = doc.createElement("div");
    base.setAttribute("data-cbx-stick", index === 0 ? "left" : "right");
    base.setAttribute("aria-label", index === 0 ? "Left stick" : "Right stick");
    Object.assign(base.style, {
      position: "absolute",
      width: STICK_SIZE,
      height: STICK_SIZE,
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.4)",
      background: "radial-gradient(circle, rgba(20,26,40,0.25) 0%, rgba(20,26,40,0.5) 70%)",
      pointerEvents: "auto",
      touchAction: "none",
      webkitTouchCallout: "none",
      webkitTapHighlightColor: "transparent",
      ...place2
    });
    const knob = doc.createElement("div");
    Object.assign(knob.style, {
      position: "absolute",
      left: "30%",
      top: "30%",
      width: "40%",
      height: "40%",
      borderRadius: "50%",
      border: "2px solid rgba(255,255,255,0.6)",
      background: "rgba(92,208,255,0.35)",
      pointerEvents: "none",
      transform: "translate(0px, 0px)"
    });
    base.appendChild(knob);
    let pointer = null;
    const move = (event) => {
      const rect = base.getBoundingClientRect();
      const radius = rect.width / 2 || 1;
      const { x, y } = stickVector(event.clientX - (rect.left + radius), event.clientY - (rect.top + radius), radius);
      state.setStick(index, x, y);
      knob.style.transform = `translate(${(x * radius * 0.6).toFixed(1)}px, ${(y * radius * 0.6).toFixed(1)}px)`;
      knob.style.background = "rgba(92,208,255,0.6)";
    };
    const end = (event) => {
      if (event.pointerId !== pointer) return;
      pointer = null;
      state.setStick(index, 0, 0);
      knob.style.transform = "translate(0px, 0px)";
      knob.style.background = "rgba(92,208,255,0.35)";
    };
    base.addEventListener("pointerdown", (event) => {
      if (pointer !== null) return;
      event.preventDefault();
      pointer = event.pointerId;
      try {
        base.setPointerCapture(event.pointerId);
      } catch {
      }
      move(event);
    });
    base.addEventListener("pointermove", (event) => {
      if (event.pointerId === pointer) move(event);
    });
    base.addEventListener("pointerup", end);
    base.addEventListener("pointercancel", end);
    base.addEventListener("lostpointercapture", end);
    base.addEventListener("contextmenu", (event) => event.preventDefault());
    this.pad.appendChild(base);
    return base;
  }
  createButton(doc, control, state) {
    const element = doc.createElement("button");
    element.type = "button";
    element.setAttribute("data-cbx-button", ConsoleButton[control.button]);
    element.setAttribute("aria-label", `${ConsoleButton[control.button]} button`);
    const round = true;
    Object.assign(element.style, {
      gridColumn: String(control.col),
      gridRow: String(control.row),
      pointerEvents: "auto",
      touchAction: "none",
      // no scroll / zoom / double-tap-zoom while playing
      webkitTouchCallout: "none",
      webkitTapHighlightColor: "transparent",
      margin: "0",
      padding: "0",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: round ? "50%" : "10px",
      border: "2px solid rgba(255,255,255,0.45)",
      background: "rgba(20,26,40,0.45)",
      color: "rgba(255,255,255,0.92)",
      font: "700 clamp(14px, 3vmin, 22px)/1 system-ui, sans-serif",
      cursor: "pointer"
    });
    element.textContent = control.label;
    if (control.hint) {
      const hint = doc.createElement("span");
      hint.textContent = control.hint;
      Object.assign(hint.style, { font: "500 10px/1 system-ui, sans-serif", opacity: "0.6", marginTop: "2px" });
      element.appendChild(hint);
    }
    const held = /* @__PURE__ */ new Set();
    const setVisual = (down) => {
      element.style.background = down ? "rgba(92,208,255,0.55)" : "rgba(20,26,40,0.45)";
    };
    const press = (event) => {
      event.preventDefault();
      held.add(event.pointerId);
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
      }
      state.press(control.button);
      setVisual(true);
    };
    const release = (event) => {
      if (!held.delete(event.pointerId)) return;
      if (held.size === 0) {
        state.release(control.button);
        setVisual(false);
      }
    };
    element.addEventListener("pointerdown", press);
    element.addEventListener("pointerup", release);
    element.addEventListener("pointercancel", release);
    element.addEventListener("lostpointercapture", release);
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    return element;
  }
  destroy() {
    this.root.remove();
    this.restorePosition?.();
  }
};
var GamepadInput = class {
  constructor(nav, state, settings, onStart, claimed = () => NO_KEYS) {
    this.nav = nav;
    this.state = state;
    this.settings = settings;
    this.onStart = onStart;
    this.claimed = claimed;
    this.startHeld = false;
    /** Every controller button held at the last poll — what input actions read. */
    this.pressed = NO_KEYS;
    /** The pad index in use, so a second controller plugged in later doesn't take over mid-game. */
    this.index = null;
  }
  poll() {
    const pads = this.nav.getGamepads?.() ?? [];
    let pad = null;
    if (this.index !== null) pad = pads[this.index] ?? null;
    if (!pad || pad.connected === false) {
      pad = null;
      this.index = null;
      for (let i = 0; i < pads.length; i += 1) {
        const candidate = pads[i];
        if (candidate && candidate.connected !== false) {
          pad = candidate;
          this.index = i;
          break;
        }
      }
    }
    if (!pad) {
      this.state.setPad(0, [0, 0, 0, 0]);
      this.startHeld = false;
      this.pressed = NO_KEYS;
      return;
    }
    const claimed = this.claimed();
    let bindings = this.settings().padBindings;
    if (claimed.size > 0) bindings = Object.fromEntries(Object.entries(bindings).map(([b, t]) => [b, claimed.has(b) ? null : t]));
    const { mask, axes, start, pressed } = readPad(pad, bindings);
    this.state.setPad(mask, axes);
    this.pressed = pressed;
    if (start && !this.startHeld) this.onStart?.();
    this.startHeld = start;
  }
  /** Whether a controller is connected (for hints like "press Start"). */
  get connected() {
    return this.index !== null;
  }
};

// src/replay.ts
var REPLAY_VERSION = 1;
var DEFAULT_SEED = 0;
function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}
var ReplayError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayError";
  }
};
var ReplayRecorder = class {
  // sentinel: guarantees frame 0 is always recorded
  constructor(meta) {
    this.meta = meta;
    this.inputs = [];
    this.frame = 0;
    this.lastMask = -1;
  }
  record(mask) {
    if (mask !== this.lastMask) {
      this.inputs.push({ frame: this.frame, mask });
      this.lastMask = mask;
    }
    this.frame++;
  }
  get frameCount() {
    return this.frame;
  }
  /** Produces the immutable replay captured so far. */
  finish() {
    return {
      version: REPLAY_VERSION,
      modelId: this.meta.modelId,
      cartHash: this.meta.cartHash,
      seed: this.meta.seed ?? DEFAULT_SEED,
      frameCount: this.frame,
      inputs: this.inputs.map((change) => ({ ...change }))
    };
  }
};
var ReplaySource = class {
  constructor(inputs) {
    this.inputs = inputs;
    this.cursor = 0;
    this.currentMask = 0;
    this.lastFrame = -1;
  }
  /** The gamepad mask effective at the given frame. */
  maskForFrame(frame) {
    if (frame < this.lastFrame) {
      this.cursor = 0;
      this.currentMask = 0;
    }
    this.lastFrame = frame;
    while (this.cursor < this.inputs.length) {
      const change = this.inputs[this.cursor];
      if (!change || change.frame > frame) {
        break;
      }
      this.currentMask = change.mask;
      this.cursor++;
    }
    return this.currentMask;
  }
};
function hashCart(bytes) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function serializeReplay(replay) {
  return JSON.stringify(replay);
}
function parseReplay(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw new ReplayError("Replay is not valid JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new ReplayError("Replay must be an object");
  }
  const candidate = value;
  if (candidate.version !== REPLAY_VERSION) {
    throw new ReplayError(`Unsupported replay version: ${String(candidate.version)}`);
  }
  if (typeof candidate.cartHash !== "string" || !Array.isArray(candidate.inputs)) {
    throw new ReplayError("Replay is missing required fields");
  }
  return candidate;
}

// src/cartseed.ts
var CHUNK_CODE = 5;
var CHUNK_BINARY = 19;
var CODE_BANK_SIZE = 65536;
var CODE_BANKS = 8;
var MAX_CODE_BYTES = CODE_BANK_SIZE * CODE_BANKS - 1;
function chunks(bytes) {
  const out = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const byte0 = bytes[offset] ?? 0;
    const type = byte0 & 31;
    const field = (bytes[offset + 1] ?? 0) | (bytes[offset + 2] ?? 0) << 8;
    const size = field === 0 && (type === CHUNK_CODE || type === CHUNK_BINARY) ? CODE_BANK_SIZE : field;
    const dataStart = offset + 4;
    const dataEnd = Math.min(dataStart + size, bytes.length);
    out.push({ headerStart: offset, dataStart, dataEnd, type, bank: byte0 >> 5 });
    offset = dataStart + size;
  }
  return out;
}
function joinedCode(bytes) {
  const all = chunks(bytes);
  const byBank = /* @__PURE__ */ new Map();
  for (const chunk of all) if (chunk.type === CHUNK_CODE) byBank.set(chunk.bank, chunk);
  const banks = [...byBank.keys()].sort((a, b) => b - a);
  const parts = banks.map((bank) => bytes.subarray(byBank.get(bank).dataStart, byBank.get(bank).dataEnd));
  const length = parts.reduce((n, part) => n + part.length, 0);
  if (length === 0) return null;
  const code = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    code.set(part, at);
    at += part.length;
  }
  const nul = code.indexOf(0);
  return { code: nul >= 0 ? code.subarray(0, nul) : code, chunks: all.filter((chunk) => chunk.type === CHUNK_CODE) };
}
function codeChunks(code) {
  const count = Math.max(1, Math.ceil(code.length / CODE_BANK_SIZE));
  const out = new Uint8Array(code.length + count * 4);
  let at = 0;
  for (let k = 0; k < count; k += 1) {
    const slice = code.subarray(k * CODE_BANK_SIZE, (k + 1) * CODE_BANK_SIZE);
    const bank = count - 1 - k;
    out.set([CHUNK_CODE | bank << 5, slice.length & 255, slice.length >> 8 & 255, 0], at);
    out.set(slice, at + 4);
    at += 4 + slice.length;
  }
  return out;
}
function detectLanguage(code) {
  const firstLine = code.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/script:\s*([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase() ?? "lua";
}
function readCartCode(bytes) {
  const joined = joinedCode(bytes);
  return joined ? new TextDecoder().decode(joined.code) : null;
}
function prependLuaCode(bytes, prelude) {
  return rewriteLuaCode(bytes, (code) => `${prelude}
${code}`);
}
function appendLuaCode(bytes, postlude) {
  return rewriteLuaCode(bytes, (code) => `${code}
${postlude}`);
}
function rewriteLuaCode(bytes, rewrite) {
  const joined = joinedCode(bytes);
  if (!joined) {
    return bytes;
  }
  const code = new TextDecoder().decode(joined.code);
  if (detectLanguage(code) !== "lua") {
    return bytes;
  }
  const merged = new TextEncoder().encode(rewrite(code));
  if (merged.length > MAX_CODE_BYTES) {
    return bytes;
  }
  const replacement = codeChunks(merged);
  const first = joined.chunks[0];
  const kept = [];
  let cursor = 0;
  for (const chunk of joined.chunks) {
    kept.push(bytes.subarray(cursor, chunk.headerStart));
    if (chunk === first) kept.push(replacement);
    cursor = chunk.dataEnd;
  }
  kept.push(bytes.subarray(cursor));
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function seedCartridge(bytes, seed) {
  return prependLuaCode(bytes, `math.randomseed(${Math.trunc(seed)})`);
}

// src/sdk.ts
var CARTBOX_SDK_LUA = `local _MB = 119
local _CAP = 8
local _LB = _MB + 25
local _LCAP = 6
local _CB = _LB + 1 + _LCAP * 6
local _MCB = _CB + 2
local _MPB = _MCB + 8
local _MPCAP = 8
local _ln = 0
local _mn = 0
local function _emit(kind, id, value)
  local seq = pmem(_MB)
  local slot = seq % _CAP
  local base = _MB + 1 + slot * 3
  pmem(base, kind)
  pmem(base + 1, id)
  pmem(base + 2, value)
  pmem(_MB, seq + 1)
end
local function _hash(s)
  local h = 2166136261
  for i = 1, #s do
    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff
  end
  return h
end
local function _norm(x, y, z)
  local m = math.sqrt(x * x + y * y + z * z)
  if m < 1e-6 then return 0, 0, 1 end
  return x / m, y / m, z / m
end
local function _byte(v)
  local b = math.floor((v or 0) * 127 + 0.5)
  if b < -127 then b = -127 elseif b > 127 then b = 127 end
  if b < 0 then b = b + 256 end
  return b
end
local function _light(kind, x, y, z, radius, r, g, b, intensity, dx, dy, cone)
  if _ln >= _LCAP then return end
  local base = _LB + 1 + _ln * 6
  pmem(base, x // 1)
  pmem(base + 1, y // 1)
  pmem(base + 2, z // 1)
  pmem(base + 3, radius // 1)
  local rgb = (math.floor(r or 255) & 0xff) << 16
  rgb = rgb | ((math.floor(g or 255) & 0xff) << 8)
  rgb = rgb | (math.floor(b or 255) & 0xff)
  pmem(base + 4, rgb | (kind << 24) | (cone << 26))
  local inten = math.floor((intensity or 1) * 256)
  if inten < 0 then inten = 0 elseif inten > 0xffff then inten = 0xffff end
  pmem(base + 5, inten | (dx << 16) | (dy << 24))
  _ln = _ln + 1
  pmem(_LB, _ln)
end
cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,
  -- request(kind, value): ask the host page for something it provides (e.g. a
  -- page's matchmaking); kind and value are numbers the page defines.
  request = function(kind, value) _emit(4, (kind or 0) // 1, (value or 0) // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
  light = function(x, y, radius, r, g, b, z, intensity)
    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)
  end,
  sun = function(dx, dy, dz, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)
  end,
  -- light3d(x, y, z, radius, r, g, b, intensity): a point light in a 3D scene's
  -- world units (signed, fractional), lighting a first-person mesh view -- the
  -- 2D relight ignores it. E.g. a glow over an objective.
  light3d = function(x, y, z, radius, r, g, b, intensity)
    _light(3, (x or 0) * 64, (y or 0) * 64, (z or 0) * 64, (radius or 4) * 64, r, g, b, intensity, 0, 0, 0)
  end,
  spot = function(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    local cone = math.floor(math.cos(math.rad(angle or 30)) * 63 + 0.5)
    if cone < 0 then cone = 0 elseif cone > 63 then cone = 63 end
    _light(2, x, y, z or 12, radius, r, g, b, intensity, _byte(nx), _byte(ny), cone)
  end,
  camera = function(x, y)
    pmem(_CB, math.floor((x or 0) * 16 + 0.5) & 0xffffffff)
    pmem(_CB + 1, math.floor((y or 0) * 16 + 0.5) & 0xffffffff)
  end,
  -- Drive the 3D mesh orbit camera this frame: yaw/pitch (radians), distance in
  -- world units (0 = auto-fit the scene), fov (radians, 0 = default). Call every
  -- frame; not calling leaves the player's gentle auto-orbit in charge.
  meshcam = function(yaw, pitch, dist, fov)
    pmem(_MCB, 1)
    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 4, 0)
    pmem(_MCB + 5, 0)
    pmem(_MCB + 6, 0)
    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)
  end,
  -- Start a fresh frame's mesh-pose list. Call once before any meshpose() calls;
  -- instances you don't pose keep their authored transform.
  clearposes = function() _mn = 0 pmem(_MPB, 0) end,
  -- First-person mode: composite the cart's 2D frame as a HUD OVER the 3D scene,
  -- rather than drawing the meshes over the 2D (the default third-person showcase
  -- compositing). Call each frame AFTER the camera call with a truthy value to
  -- enable; near-black (index 0) pixels the cart leaves are the transparent "world"
  -- and everything else the cart draws is the HUD. Rides a spare bit of the
  -- mesh-camera flag word, so it costs no mailbox space.
  hud = function(on)
    local f = pmem(_MCB)
    if on and on ~= 0 then pmem(_MCB, f | 2) else pmem(_MCB, f & 0xfffffffd) end
  end,
  -- Move/rotate/scale one mesh instance (by its sidecar index) this frame, on top
  -- of its authored placement. x,y,z are world units; yaw (about Y), pitch (about
  -- X), roll (about Z) radians;
  -- scale defaults to 1 (pass 0 to hide). math.floor keeps every value integer so
  -- the bitwise mask never sees a float (the Pro core's Lua throws on that). Must
  -- match decodeMeshPoses() on the host.
  -- Optional extras: frame picks one of the instance's animation frames (0 = its
  -- base mesh, up to 127), tint recolours its tintable materials from the
  -- 15-colour tint palette (0 = none), and front (true/1) draws it over the
  -- whole scene \u2014 a held weapon that must never clip into a wall.
  meshpose = function(index, x, y, z, yaw, pitch, roll, scale, frame, tint, front)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    local word = math.floor(index or 0) & 0xff
    word = word | ((math.floor(frame or 0) & 0x7f) << 9) | ((math.floor(tint or 0) & 0xf) << 16)
    if front and front ~= 0 then word = word | 0x100000 end
    pmem(base, word)
    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 4, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 5, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 6, math.floor((roll or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)
    _mn = _mn + 1
    pmem(_MPB, _mn)
  end,
  -- HD-2D world (optional): a cart with a world sidecar draws a 3D tile terrain
  -- and stands its 2D character sprites in it as depth-sorted billboards. The
  -- world camera and billboards reuse the mesh camera/pose mailbox channels, so
  -- no engine change is needed \u2014 these are thin aliases with the world's naming.
  --
  -- Drive the world camera this frame: yaw/pitch (radians), distance (world units,
  -- 0 = auto-fit), fov (radians, 0 = default). Optional tx,ty,tz make the camera
  -- LOOK AT that point (grid x/z units, height units for y) so it follows the
  -- player; omit them (or pass 0,0,0) to frame the whole terrain. Same mailbox
  -- layout as meshcam (target rides at _MCB+4..6).
  worldcam = function(yaw, pitch, dist, fov, tx, ty, tz)
    pmem(_MCB, 1)
    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 4, math.floor((tx or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 5, math.floor((ty or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 6, math.floor((tz or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)
  end,
  -- Start a fresh frame's billboard list. Call once before billboard() calls each
  -- frame (an alias of clearposes \u2014 they share the mesh-pose channel).
  clearbillboards = function() _mn = 0 pmem(_MPB, 0) end,
  -- Place billboard index (declared in the world sidecar) at world position
  -- (x,z grid units, y height units) this frame; scale defaults to 1 (0 hides).
  -- math.floor keeps every value integer so the bitwise mask never sees a float.
  billboard = function(index, x, y, z, scale)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    pmem(base, math.floor(index or 0) & 0xff)
    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 4, 0)
    pmem(base + 5, 0)
    pmem(base + 6, 0)
    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)
    _mn = _mn + 1
    pmem(_MPB, _mn)
  end,
  -- stick(n) -> x, y: analog stick n (0 left, 1 right), each -1..1, y down-
  -- positive. Reads 0,0 with no sticks (keyboard); on a touchscreen the pad
  -- shows its right stick once a cart calls this. Uses pmem 68..69.
  stick = function(n)
    if pmem(69) ~= 0x53544b31 then pmem(69, 0x53544b31) end
    local w = pmem(68)
    local sh = (n == 1) and 16 or 0
    local x, y = (w >> sh) & 0xff, (w >> (sh + 8)) & 0xff
    if x >= 128 then x = x - 256 end
    if y >= 128 then y = y - 256 end
    return x / 127, y / 127
  end,
  -- Netplay (online multiplayer). The host page relays player state + events
  -- between browsers through pmem words 0..118 (so a netplay cart must not keep
  -- save data there); see packages/player/src/net/netplay.ts for the layout.
  -- net() -> mode (0 offline, 1 client, 2 host), my slot, humans mask, match word,
  -- and the page's status code (0 idle; the page defines the rest, e.g. searching)
  net = function()
    local h = pmem(0)
    return h & 3, (h >> 2) & 7, (h >> 8) & 0xff, pmem(1), (h >> 5) & 7
  end,
  -- netpeer(slot) -> the slot's 3 state words, and whether they are live
  netpeer = function(slot)
    local b = 3 + slot * 3
    return pmem(b), pmem(b + 1), pmem(b + 2), ((pmem(0) >> 16) & (1 << slot)) ~= 0
  end,
  -- netpublish(slot, a, b, c): publish a slot's state this tick (your own, or a
  -- bot's when you are the host)
  netpublish = function(slot, a, b, c)
    local base = 72 + slot * 3
    pmem(base, math.floor(a or 0) & 0xffffffff)
    pmem(base + 1, math.floor(b or 0) & 0xffffffff)
    pmem(base + 2, math.floor(c or 0) & 0xffffffff)
    pmem(70, pmem(70) | (1 << slot))
  end,
  -- netmatch(word): the host's shared game-state word (clients read it via net())
  netmatch = function(w) pmem(71, math.floor(w or 0) & 0xffffffff) end,
  -- netsend(a, b): broadcast a 2-word event to every other player (\u2264 10/tick)
  netsend = function(a, b)
    local n = pmem(96)
    if n >= 10 then return false end
    pmem(97 + n * 2, math.floor(a or 0) & 0xffffffff)
    pmem(98 + n * 2, math.floor(b or 0) & 0xffffffff)
    pmem(96, n + 1)
    return true
  end,
  -- netevents() -> this tick's incoming events, as a list of {a, b}
  netevents = function()
    local n = pmem(27)
    local out = {}
    for i = 0, n - 1 do out[#out + 1] = { pmem(28 + i * 2), pmem(29 + i * 2) } end
    return out
  end,
  -- Collision defaults: overridden by the injected layer when the cart has one,
  -- so cartbox.solid/mapsize are always safe to call (a cart with no collision
  -- layer simply sees every cell as non-solid).
  solid = function() return false end,
  mapsize = function() return 0, 0 end,
  -- Tile-flags default: overridden by the injected layer when the cart has one.
  flag = function() return false end,
  -- Scene objects (the cart's placed meshes by name, with parents, tags and
  -- properties): overridden by the injected scene table when the cart has meshes.
  -- An object is the 0-based index cartbox.meshpose takes, or its name.
  objects = function() return 0 end,
  find = function() return nil end,
  objname = function() return nil end,
  parent = function() return nil end,
  children = function() return {} end,
  prop = function(_, _, default) return default end,
  hastag = function() return false end,
  tagged = function() return {} end,
  -- Physics (bodies on scene objects): overridden by the injected physics calls
  -- when the cart has bodies.
  physics = function() return false end,
  body = function() return nil end,
  impulse = function() end,
  velocity = function() end,
  teleport = function() end,
  move = function() end,
  ray = function() end,
  sweep = function() end,
  hit = function() return false end,
  contacts = function() return {} end,
  entered = function() return {} end,
  exited = function() return {} end,
  inside = function() return {} end,
  motor = function() end,
  unjoin = function() end,
  physicshash = function() return 0 end,
  -- Spawning prefab copies: overridden when the cart has prefabs.
  spawn = function() return nil end,
  despawn = function() end,
  alive = function() return false end,
  -- Skeletal animation: overridden when the scene has skinned objects.
  play = function() end,
  anim = function() return nil, 0, false end,
  clips = function() return {} end,
  set = function() end,
  trigger = function() end,
  state = function() return nil end,
  setstate = function() end,
  events = function() return {} end,
  ik = function() end,
  lookat = function() end,
  ragdoll = function() end,
  unragdoll = function() end,
  shield = function() end,
  joint = function() return nil end,
  joints = function() return {} end,
  playtimeline = function() end,
  stoptimeline = function() end,
  timeline = function() return nil, 0, false end,
  timelineevents = function() return {} end,
  -- Navigation agents: overridden when the scene has a baked walkable surface.
  agent = function() end,
  obstacle = function() end,
  moveto = function() end,
  stopagent = function() end,
  removeagent = function() end,
  agentpos = function() return nil end,
  navigable = function() return false end,
  -- Spatial loading's focus: overridden when the scene streams by distance.
  streamfocus = function() end,
  burst = function() end,
  decal = function() end,
  decals = function() return {} end,
  debris = function() end,
  debrislist = function() return {} end,
  -- Sound: overridden when the scene has sounds.
  sound = function() end,
  loop = function() end,
  mix = function() end,
  sounds = function() return {} end,
  -- UI documents (EP13): replaced when the cart has any.
  ui = {
    set = function() end, get = function() return nil end,
    show = function() end, hide = function() end, shown = function() return false end,
    focus = function() end, focused = function() return nil end,
    select = function() end, selected = function() return 1 end,
    on = function() end, update = function() return nil end, draw = function() end,
  },
  effects = function() return {} end,
  -- Timeline values (EP17): replaced when the scene's timelines have value tracks.
  timelinevalue = function() return nil end,
  -- Save data (EP15b): replaced when the host keeps saves.
  save = function() return false, "saves are off here" end,
  load = function() return nil end,
  erase = function() end,
  -- Input actions (EP15): replaced when the cart has any.
  action = function() return false end,
  actionp = function() return false end,
  actionr = function() return false end,
  actions = function() return {} end,
  actionlabel = function() return "" end,
  -- Placing objects (EP14): live once the scene has the runtime.
  place = function() end,
  -- Components (EP14): replaced when any object has one.
  component = function() return nil end,
  -- Localisation (EP19b): replaced when the cart has a string table.
  text = function(k, ...)
    local a = {...}
    local t = type(a[1]) == "table" and a[1] or nil
    return (string.gsub(tostring(k), "{(%w+)}", function(n)
      local v
      if tonumber(n) then v = a[tonumber(n)] elseif t then v = t[n] end
      if v == nil then return nil end
      return tostring(v)
    end))
  end,
  language = function() return nil end,
  languages = function() return {} end,
  setlanguage = function() return false end,
  -- Accessibility (EP19b): replaced when the player has set any.
  textscale = function() return 1 end,
  colorfilter = function() return "none" end,
}`;
function injectSdk(bytes) {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}

// src/componentsSdk.ts
import { componentFields, componentValues } from "@cartbox/editor";
function luaQuote(text) {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (code < 32 || code === 127) out += `\\${code}`;
    else out += ch;
  }
  return out + '"';
}
var luaValue = (v) => typeof v === "string" ? luaQuote(v) : typeof v === "boolean" ? String(v) : Number.isFinite(v) ? String(v) : "0";
function componentsSdkLua(scene) {
  const defs = scene?.components ?? [];
  if (!scene || defs.length === 0) return null;
  const used = scene.instances.some((i) => (i.components?.length ?? 0) > 0);
  if (!used) return null;
  const byName = new Map(defs.map((d) => [d.name, d]));
  const copies = [];
  scene.instances.forEach((inst, i) => {
    for (const a of inst.components ?? []) {
      const def = byName.get(a.name);
      if (!def) continue;
      const values = componentValues(def, a);
      const objectFields = componentFields(def.code).filter((f2) => f2.type === "object").map((f2) => luaQuote(f2.name));
      const fields = Object.entries(values).map(([k, v]) => `[${luaQuote(k)}]=${luaValue(v)}`);
      const root = inst.pooled ? inst.pooled.root : -1;
      const at = [12, 13, 14].map((k) => +(inst.model[k] ?? 0).toFixed(4));
      copies.push(`{obj=${i},def=${luaQuote(def.name)},root=${root},o={${at.join(",")}},f={${fields.join(",")}},objf={${objectFields.join(",")}}}`);
    }
  });
  const prelude = `do
local SRC = {${defs.map((d) => `[${luaQuote(d.name)}]=${luaQuote(d.code)}`).join(",\n")}}
local LIST = {${copies.join(",\n")}}
local built, C, by = {}, {}, {}
local function behaviour(name)
  if built[name] == nil then
    local env = setmetatable({}, {__index = _G})
    local chunk, err = load(SRC[name], "=" .. name, "t", env)
    if chunk then
      local ok, e = pcall(chunk)
      if ok then built[name] = env else trace("component " .. name .. ": " .. tostring(e), 2); built[name] = false end
    else trace("component " .. name .. ": " .. tostring(err), 2); built[name] = false end
  end
  return built[name]
end
for _, e in ipairs(LIST) do
  local b = behaviour(e.def)
  if b then
    local self = {obj = e.obj, origin = {x = e.o[1], y = e.o[2], z = e.o[3]}}
    for k, v in pairs(e.f) do self[k] = v end
    local c = {b = b, self = self, name = e.def, root = e.root, objf = e.objf, started = false}
    C[#C + 1] = c
    by[e.obj] = by[e.obj] or {}
    table.insert(by[e.obj], c)
  end
end
-- A callback that errors is reported once and that copy stops (the rest run on).
local function call(c, fn, ...)
  local f = rawget(c.b, fn)
  if f and not c.dead then
    local ok, e = pcall(f, c.self, ...)
    if not ok then c.dead = true; trace("component " .. c.name .. " (" .. fn .. "): " .. tostring(e), 2) end
  end
end
cartbox.component = function(obj, name)
  if type(obj) == "string" and cartbox.find then obj = cartbox.find(obj) end
  for _, c in ipairs(by[obj] or {}) do if c.name == name then return c.self end end
  return nil
end
function _cbx_components_late()
  for _, c in ipairs(C) do
    if c.started and (c.root < 0 or (cartbox.alive and cartbox.alive(c.root))) then call(c, "late", 1 / 60) end
  end
end
function _cbx_components_tick()
  for _, c in ipairs(C) do
    if c.root < 0 or (cartbox.alive and cartbox.alive(c.root)) then
      if not c.started then
        c.started = true
        -- An object field names an object: look it up once it exists.
        for _, k in ipairs(c.objf) do
          local v = c.self[k]
          if type(v) == "string" then c.self[k] = (v ~= "" and cartbox.find) and cartbox.find(v) or nil end
        end
        call(c, "start")
      end
      call(c, "update", 1 / 60)
    elseif c.started then c.started = false end
  end
  if cartbox.contacts then
    for _, e in ipairs(cartbox.contacts()) do
      for side = 1, 2 do
        local me, other = e.a, e.b
        if side == 2 then me, other = e.b, e.a end
        for _, c in ipairs(by[me] or {}) do
          if c.started then call(c, e.trigger and "trigger" or "collision", other, e.started) end
        end
      end
    end
  end
end
end`;
  const postlude = `do
local _cart_tic = TIC
function TIC()
  _cbx_components_tick()
  if _cart_tic then _cart_tic() end
  _cbx_components_late()
end
end`;
  return { prelude, postlude };
}

// src/mesh/sceneObjectsSdk.ts
function luaQuote2(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code < 32 || code === 127) out += `\\${String(code).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}
function luaValue2(value) {
  if (typeof value === "string") return luaQuote2(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return Number.isFinite(value) ? String(value) : "0";
}
function sceneObjectsSdkLua(scene) {
  if (!scene || scene.instances.length === 0) return "";
  const names = [];
  const parents = [];
  const tags = [];
  const props = [];
  scene.instances.forEach((instance, i) => {
    names.push(`[${i}]=${luaQuote2(instance.name ?? "")}`);
    if ((instance.parent ?? -1) >= 0) parents.push(`[${i}]=${instance.parent}`);
    const t = instance.tags ?? [];
    if (t.length > 0) tags.push(`[${i}]={${t.map((tag) => `[${luaQuote2(tag)}]=true`).join(",")}}`);
    const entries = Object.entries(instance.props ?? {});
    if (entries.length > 0) props.push(`[${i}]={${entries.map(([k, v]) => `[${luaQuote2(k)}]=${luaValue2(v)}`).join(",")}}`);
  });
  return `do
  cartbox = cartbox or {}
  local _n = {${names.join(",")}}
  local _p = {${parents.join(",")}}
  local _t = {${tags.join(",")}}
  local _pr = {${props.join(",")}}
  local _count = ${scene.instances.length}
  local _byname = {}
  for i = _count - 1, 0, -1 do _byname[_n[i]] = i end
  local function _obj(o)
    if type(o) == "string" then return _byname[o] end
    if type(o) == "number" and o >= 0 and o < _count then return math.floor(o) end
    return nil
  end
  cartbox.objects = function() return _count end
  cartbox.find = function(name) return _byname[name] end
  cartbox.objname = function(o) local i = _obj(o) return i and _n[i] end
  cartbox.parent = function(o) local i = _obj(o) return i and _p[i] end
  cartbox.children = function(o)
    local i = _obj(o)
    local out = {}
    if i == nil then return out end
    for c = 0, _count - 1 do if _p[c] == i then out[#out + 1] = c end end
    return out
  end
  cartbox.prop = function(o, key, default)
    local i = _obj(o)
    local v = i and _pr[i] and _pr[i][key]
    if v == nil then return default end
    return v
  end
  cartbox.hastag = function(o, tag)
    local i = _obj(o)
    return (i and _t[i] and _t[i][tag]) == true
  end
  cartbox.tagged = function(tag)
    local out = {}
    for i = 0, _count - 1 do if _t[i] and _t[i][tag] then out[#out + 1] = i end end
    return out
  end
end`;
}

// src/mesh/meshScene.ts
import {
  composeModelMatrix,
  deserializeMeshAsset,
  meshBounds,
  parentIndices,
  parseSceneLighting,
  projectionMatrix,
  readMeshLibrary,
  readAnimatorSpec,
  readPhysicsSpec,
  readPhysicsWorld,
  readTimelines,
  readLevels,
  readNavMesh,
  readTerrains,
  readStreaming,
  terrainChunks,
  terrainHeight,
  effectiveLevels,
  readSceneProps,
  readSceneTags,
  worldMatrices,
  resolveMeshFrames,
  resolveMeshRef,
  viewMatrix,
  decodeLods,
  foliageBlocks,
  readFoliage,
  parseSceneAudio,
  parseParticleEffects,
  parseDecalDefs,
  parseDecalMarks,
  parseRagdollColliders,
  parseDebrisDefs,
  parseComponentDefs,
  parseAttached
} from "@cartbox/editor";
var DEFAULT_PREFAB_POOL = 8;
var MAX_PREFAB_POOL = 32;
function isFiniteTriple(value) {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}
function readTransform(value) {
  const raw = value ?? {};
  return {
    position: isFiniteTriple(raw.position) ? raw.position : [0, 0, 0],
    rotation: isFiniteTriple(raw.rotation) ? raw.rotation : [0, 0, 0],
    scale: isFiniteTriple(raw.scale) ? raw.scale : [1, 1, 1]
  };
}
function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ];
}
function sceneBounds(instances) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const instance of instances) {
    const local = meshBounds(instance.mesh);
    if (!local) continue;
    for (let corner = 0; corner < 8; corner += 1) {
      const cx = corner & 1 ? local.max[0] : local.min[0];
      const cy = corner & 2 ? local.max[1] : local.min[1];
      const cz = corner & 4 ? local.max[2] : local.min[2];
      const [wx, wy, wz] = transformPoint(instance.model, cx, cy, cz);
      minX = Math.min(minX, wx);
      minY = Math.min(minY, wy);
      minZ = Math.min(minZ, wz);
      maxX = Math.max(maxX, wx);
      maxY = Math.max(maxY, wy);
      maxZ = Math.max(maxZ, wz);
    }
  }
  if (!Number.isFinite(minX)) {
    return { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5], center: [0, 0, 0], radius: 1 };
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(1e-3, 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center, radius };
}
function parseMeshScene(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = parsed.meshes;
  if (!Array.isArray(entries)) return null;
  const library = readMeshLibrary(parsed.library);
  const componentDefs = parseComponentDefs(parsed.components);
  const componentNames = new Set(componentDefs.map((d) => d.name));
  const cache = /* @__PURE__ */ new Map();
  const load = (serialized) => {
    if (!cache.has(serialized)) {
      try {
        cache.set(serialized, deserializeMeshAsset(serialized));
      } catch {
        cache.set(serialized, null);
      }
    }
    return cache.get(serialized) ?? null;
  };
  const levelCache = /* @__PURE__ */ new Map();
  const lodOf = (mesh, stored) => {
    if (!stored) return null;
    let byBase = levelCache.get(mesh);
    if (!byBase) levelCache.set(mesh, byBase = /* @__PURE__ */ new Map());
    const key = JSON.stringify(stored);
    if (!byBase.has(key)) {
      const chain = decodeLods(mesh, stored, (level) => resolveMeshRef(level, library));
      byBase.set(key, chain ? { meshes: [mesh, ...chain.meshes], distances: chain.distances } : null);
    }
    return byBase.get(key) ?? null;
  };
  const readEntry = (record, id, parentId, identity2 = false) => {
    if (typeof record.mesh !== "string") return null;
    const resolved = resolveMeshRef(record.mesh, library);
    const mesh = resolved ? load(resolved) : null;
    if (!mesh) return null;
    const frames = resolveMeshFrames(record.frames, library).map(load).filter((frame) => frame !== null);
    const t = identity2 ? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } : readTransform(record.transform);
    const lod = lodOf(mesh, record.lods);
    const components = componentNames.size > 0 ? parseAttached(record.components, componentNames) : [];
    return {
      mesh,
      local: composeModelMatrix(t.position, t.rotation, t.scale),
      ...frames.length > 0 ? { frames } : {},
      ...lod ? { lod } : {},
      id,
      name: typeof record.name === "string" ? record.name : "Mesh",
      tags: readSceneTags(record.tags),
      props: readSceneProps(record.props),
      physics: readPhysicsSpec(record.physics),
      ...readAnimatorSpec(record.animator) ? { animator: readAnimatorSpec(record.animator) } : {},
      ...typeof record.level === "string" && record.level ? { levelId: record.level } : {},
      ...record.alwaysLoaded === true ? { alwaysLoaded: true } : {},
      ...components.length > 0 ? { components } : {},
      parentId
    };
  };
  const parsedInstances = [];
  for (const entry of entries) {
    const record = entry;
    const parsedEntry = readEntry(
      record,
      typeof record.id === "string" ? record.id : `mesh-${parsedInstances.length}`,
      typeof record.parent === "string" && record.parent ? record.parent : null
    );
    if (parsedEntry) parsedInstances.push(parsedEntry);
  }
  const poolRoots = /* @__PURE__ */ new Map();
  const prefabs = parsed.prefabs;
  if (Array.isArray(prefabs)) {
    for (const item of prefabs) {
      const prefab = item;
      if (typeof prefab.id !== "string" || !Array.isArray(prefab.nodes)) continue;
      const name = typeof prefab.name === "string" ? prefab.name : "Prefab";
      const size = typeof prefab.pool === "number" && Number.isFinite(prefab.pool) ? Math.max(0, Math.min(MAX_PREFAB_POOL, Math.floor(prefab.pool))) : DEFAULT_PREFAB_POOL;
      const nodes = prefab.nodes.filter((n) => typeof n.key === "string");
      const root = nodes.find((n) => typeof n.parent !== "string" || !n.parent);
      if (!root || size === 0) continue;
      for (let copy = 0; copy < size; copy += 1) {
        const idOf = (key) => `${prefab.id}#${copy}:${String(key)}`;
        const rootId = idOf(root.key);
        const made = [];
        for (const node of nodes) {
          const isRoot = node === root;
          const entry = readEntry(node, idOf(node.key), isRoot ? null : idOf(node.parent), isRoot);
          if (!entry) continue;
          made.push({ ...entry, ...isRoot ? { name: `${name} ${copy + 1}` } : {}, pool: { prefab: name, copy, rootId } });
        }
        if (!made.some((m) => m.id === rootId)) continue;
        parsedInstances.push(...made);
        poolRoots.set(name, [...poolRoots.get(name) ?? [], rootId]);
      }
    }
  }
  const parents = parentIndices(parsedInstances.map((p) => ({ id: p.id, parent: p.parentId })));
  const world = worldMatrices(
    parsedInstances.map((p) => p.local),
    parents
  );
  const indexOf = new Map(parsedInstances.map((p, i) => [p.id, i]));
  const levels = readLevels(parsed.levels);
  const levelOf = effectiveLevels(
    parsedInstances.map((p) => p.pool ? void 0 : p.levelId),
    parents,
    levels
  );
  const instances = parsedInstances.map(({ parentId: _parentId, pool, levelId: _levelId, ...rest }, i) => ({
    ...rest,
    model: world[i],
    parent: parents[i],
    ...pool ? { pooled: { prefab: pool.prefab, copy: pool.copy, root: indexOf.get(pool.rootId) } } : {},
    ...levelOf[i] >= 0 ? { level: levelOf[i] } : {}
  }));
  const terrains = readTerrains(parsed.terrains);
  const identity = composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
  for (const t of terrains) {
    const parent = t.parent !== void 0 ? indexOf.get(t.parent) ?? -1 : -1;
    const model = parent >= 0 ? instances[parent].model : identity;
    for (const chunk of terrainChunks(t)) {
      instances.push({
        mesh: chunk.mesh,
        ...chunk.lods.length > 0 ? { frames: chunk.lods } : {},
        model,
        local: identity,
        parent,
        id: `terrain:${t.id}:${chunk.cells[0]},${chunk.cells[1]}`,
        name: t.name,
        tags: [],
        props: {},
        physics: null,
        terrain: true,
        ...t.castShadows ? { casts: true } : {},
        detail: chunk.detail
      });
    }
  }
  const storedFoliage = parsed.foliage;
  if (Array.isArray(storedFoliage)) {
    for (const raw2 of storedFoliage) {
      const read = readFoliage(raw2, terrains);
      if (!read) continue;
      const text = resolveMeshRef(read.mesh, library);
      const mesh = text ? load(text) : null;
      const t = terrains.find((x) => x.id === read.layer.terrain);
      if (!mesh || !t) continue;
      const parent = t.parent !== void 0 ? indexOf.get(t.parent) ?? -1 : -1;
      const model = parent >= 0 ? instances[parent].model : identity;
      foliageBlocks(t, read.layer, mesh).forEach((block, k) => {
        instances.push({
          mesh: block.mesh,
          model,
          local: identity,
          parent,
          id: `foliage:${read.layer.id}:${k}`,
          name: read.layer.name,
          tags: [],
          props: {},
          physics: null,
          terrain: true,
          // On a terrain that casts, its foliage casts too (boulders shade the snow).
          ...t.castShadows ? { casts: true } : {},
          foliage: { cull: read.layer.cull, center: block.center, radius: block.radius }
        });
      });
    }
  }
  if (instances.length === 0) return null;
  const audio = parseSceneAudio(parsed.audio);
  const lighting = parseSceneLighting(parsed.lighting);
  const pools = [...poolRoots.entries()].map(([prefab, ids]) => ({ prefab, roots: ids.map((id) => indexOf.get(id)) }));
  const placed = instances.filter((instance) => !instance.pooled && !instance.terrain && (instance.level === void 0 || instance.level === 0));
  const physicsWorld = readPhysicsWorld(parsed.physicsWorld);
  const timelines = readTimelines(parsed.timelines);
  const navmesh = readNavMesh(parsed.navmesh);
  const effects = parseParticleEffects(parsed.effects);
  const decals = parseDecalDefs(parsed.decals);
  const decalMarks = parseDecalMarks(parsed.decalMarks, decals);
  const ragdollColliders = parseRagdollColliders(parsed.ragdollColliders);
  const debris = [];
  const debrisMeshes = [];
  const debrisLods = [];
  for (const def of parseDebrisDefs(parsed.debris)) {
    const source = parsedInstances.find((p) => !p.pool && p.name === def.source);
    let mesh = source?.mesh ?? null;
    let lod = source?.lod ?? null;
    if (!mesh && Array.isArray(prefabs)) {
      const prefab = prefabs.find((f2) => f2 && f2.name === def.source && Array.isArray(f2.nodes));
      const root = prefab?.nodes?.find((n) => typeof n.parent !== "string" || !n.parent);
      const entry = root ? readEntry(root, "debris", null, true) : null;
      mesh = entry?.mesh ?? null;
      lod = entry?.lod ?? null;
    }
    if (mesh && def.without) {
      const leave = new Set(def.without);
      const keep = (m) => ({ ...m, primitives: m.primitives.filter((p) => !leave.has(p.material.name)) });
      const kept = keep(mesh);
      mesh = kept.primitives.length > 0 ? kept : null;
      lod = mesh && lod ? { meshes: [mesh, ...lod.meshes.slice(1).map(keep)], distances: lod.distances } : null;
    }
    if (!mesh) continue;
    debris.push(def);
    debrisMeshes.push(mesh);
    debrisLods.push(lod);
  }
  return {
    instances,
    bounds: sceneBounds(placed.length > 0 ? placed : instances),
    ...terrains.length > 0 ? { terrains, extent: sceneBounds(instances.filter((instance) => !instance.pooled)) } : {},
    ...readStreaming(parsed.streaming) ? { streaming: readStreaming(parsed.streaming) } : {},
    ...effects.length > 0 ? { effects } : {},
    ...decals.length > 0 ? { decals } : {},
    ...decalMarks.length > 0 ? { decalMarks } : {},
    ...ragdollColliders.length > 0 ? { ragdollColliders } : {},
    ...debris.length > 0 ? { debris, debrisMeshes, ...debrisLods.some(Boolean) ? { debrisLods } : {} } : {},
    ...audio ? { audio } : {},
    ...componentDefs.length > 0 ? { components: componentDefs } : {},
    lighting,
    ...pools.length > 0 ? { pools } : {},
    ...physicsWorld ? { physicsWorld } : {},
    ...timelines.length > 0 ? { timelines } : {},
    ...levels.length > 0 ? { levels } : {},
    ...navmesh && navmesh.heights.length > 0 ? { navmesh } : {}
  };
}
function streamGroups(scene) {
  const { instances } = scene;
  const children = instances.map(() => []);
  instances.forEach((inst, i) => {
    if (inst.parent >= 0) children[inst.parent].push(i);
  });
  const groups = [];
  instances.forEach((root, r) => {
    if (root.parent >= 0 || root.pooled || root.terrain || root.alwaysLoaded || root.level !== void 0) return;
    const members = [];
    const walk = (i) => {
      members.push(i);
      for (const c of children[i]) if (!instances[c].terrain) walk(c);
    };
    walk(r);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const i of members) {
      const inst = instances[i];
      const local = meshBounds(inst.mesh);
      if (!local) continue;
      for (let corner = 0; corner < 8; corner += 1) {
        const [x, y, z] = transformPoint(inst.model, corner & 1 ? local.max[0] : local.min[0], corner & 2 ? local.max[1] : local.min[1], corner & 4 ? local.max[2] : local.min[2]);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        z1 = Math.max(z1, z);
      }
    }
    if (Number.isFinite(x0)) groups.push({ members, box: [x0, y0, z0, x1, y1, z1] });
  });
  return groups;
}
function orbitPitchAboveTerrain(scene, yaw, pitch) {
  const terrains = scene.terrains;
  if (!terrains || terrains.length === 0) return pitch;
  const { center, radius } = scene.bounds;
  const distance = radius / Math.sin(25 * Math.PI / 180) + radius;
  for (let p = pitch; p < 1.45; p += 0.05) {
    const x = center[0] + distance * Math.cos(p) * Math.sin(yaw);
    const y = center[1] + distance * Math.sin(p);
    const z = center[2] + distance * Math.cos(p) * Math.cos(yaw);
    if (terrains.every((t) => (terrainHeight(t, x, z) ?? -Infinity) + 4 < y)) return p;
  }
  return 1.45;
}
function buildOrbitCamera(bounds, yaw, pitch, aspect, options = {}) {
  const { radius } = bounds;
  const fovY = options.fov && options.fov > 0 ? options.fov : 50 * Math.PI / 180;
  const target = [
    bounds.center[0] + (options.targetOffset?.[0] ?? 0),
    bounds.center[1] + (options.targetOffset?.[1] ?? 0),
    bounds.center[2] + (options.targetOffset?.[2] ?? 0)
  ];
  const distance = options.distance && options.distance > 0 ? options.distance : radius / Math.sin(fovY / 2) + radius;
  const cosPitch = Math.cos(pitch);
  const eye = [
    target[0] + distance * cosPitch * Math.sin(yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * cosPitch * Math.cos(yaw)
  ];
  let far = distance + radius * 4;
  const extent = options.extent;
  if (extent) {
    const reach = Math.hypot(eye[0] - extent.center[0], eye[1] - extent.center[1], eye[2] - extent.center[2]) + extent.radius;
    far = Math.max(far, reach);
  }
  return {
    view: viewMatrix(eye, target),
    projection: projectionMatrix(fovY, aspect, options.near && options.near > 0 ? options.near : Math.max(0.01, radius * 0.05), far)
  };
}

// src/physics/physicsSession.ts
import { DEFAULT_SPRING_DAMPING, DEFAULT_SPRING_STIFFNESS, meshBounds as meshBounds2 } from "@cartbox/editor";

// src/physics/deterministic.ts
var GRID = 65536;
var FINE = 1048576;
var snap = (v) => Number.isFinite(v) ? Math.round(v * GRID) / GRID : 0;
var fine = (v) => Number.isFinite(v) ? Math.round(v * FINE) / FINE : 0;
var snap3 = (v) => [snap(v[0]), snap(v[1]), snap(v[2])];
var fine3 = (v) => [fine(v[0]), fine(v[1]), fine(v[2])];
var fineQ = (q) => [fine(q[0]), fine(q[1]), fine(q[2]), fine(q[3])];
function snapShape(shape) {
  switch (shape.kind) {
    case "box":
      return { kind: "box", halfExtents: snap3(shape.halfExtents), offset: snap3(shape.offset) };
    case "sphere":
      return { kind: "sphere", radius: snap(shape.radius), offset: snap3(shape.offset) };
    case "capsule":
      return { kind: "capsule", radius: snap(shape.radius), halfHeight: snap(shape.halfHeight), offset: snap3(shape.offset) };
    case "mesh":
      return { kind: "mesh", vertices: shape.vertices.map(snap), indices: shape.indices };
  }
}
function snapCastShape(shape) {
  switch (shape.kind) {
    case "sphere":
      return { kind: "sphere", radius: snap(shape.radius) };
    case "box":
      return { kind: "box", halfExtents: snap3(shape.halfExtents) };
    case "capsule":
      return { kind: "capsule", radius: snap(shape.radius), halfHeight: snap(shape.halfHeight) };
  }
}
function deterministicBackend(inner) {
  const out = {
    addBody: (desc) => inner.addBody({
      ...desc,
      shape: snapShape(desc.shape),
      position: snap3(desc.position),
      rotation: fineQ(desc.rotation),
      mass: snap(desc.mass),
      friction: snap(desc.friction),
      bounce: snap(desc.bounce),
      ...desc.gravity !== void 0 ? { gravity: snap(desc.gravity) } : {},
      ...desc.damping !== void 0 ? { damping: snap(desc.damping) } : {}
    }),
    step: (dt) => inner.step(dt),
    bodyState: (handle) => inner.bodyState(handle),
    applyImpulse: (handle, v) => inner.applyImpulse(handle, snap3(v)),
    setVelocity: (handle, v) => inner.setVelocity(handle, snap3(v)),
    teleport: (handle, p) => inner.teleport(handle, snap3(p)),
    moveCharacter: (handle, d) => inner.moveCharacter(handle, snap3(d)),
    raycast: (origin, direction, max, ignore) => inner.raycast(snap3(origin), fine3(direction), snap(max), ignore),
    setEnabled: (handle, enabled) => inner.setEnabled(handle, enabled),
    setPose: (handle, p, q) => inner.setPose(handle, snap3(p), fineQ(q)),
    drainContacts: () => inner.drainContacts(),
    overlaps: () => inner.overlaps(),
    destroy: () => inner.destroy()
  };
  if (inner.shapecast) {
    const cast = inner.shapecast.bind(inner);
    out.shapecast = (shape, origin, direction, max, ignore) => cast(snapCastShape(shape), snap3(origin), fine3(direction), snap(max), ignore);
  }
  if (inner.addJoint) {
    const add = inner.addJoint.bind(inner);
    out.addJoint = (desc) => add({
      ...desc,
      anchor1: snap3(desc.anchor1),
      frame1: fineQ(desc.frame1),
      anchor2: snap3(desc.anchor2),
      frame2: fineQ(desc.frame2),
      ...desc.limits ? { limits: [fine(desc.limits[0]), fine(desc.limits[1])] } : {},
      length: snap(desc.length),
      stiffness: snap(desc.stiffness),
      damping: snap(desc.damping)
    });
  }
  if (inner.removeJoint) out.removeJoint = inner.removeJoint.bind(inner);
  if (inner.setMotor) {
    const motor = inner.setMotor.bind(inner);
    out.setMotor = (joint, speed, force) => motor(joint, snap(speed), snap(force));
  }
  return out;
}
var f32 = new Float32Array(1);
var u32 = new Uint32Array(f32.buffer);
function physicsStateHash(states) {
  let h = 2166136261;
  const mix = (v) => {
    f32[0] = v;
    let w = u32[0];
    for (let k = 0; k < 4; k += 1) {
      h ^= w & 255;
      h = Math.imul(h, 16777619);
      w >>>= 8;
    }
  };
  for (const s of states) {
    for (const v of s.position) mix(v);
    for (const v of s.rotation) mix(v);
    for (const v of s.velocity) mix(v);
  }
  return h | 0;
}

// src/physics/physicsSession.ts
var PHYSICS_DT = 1 / 60;
function splitWorldMatrix(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1;
  const sy = Math.hypot(m[4], m[5], m[6]) || 1;
  const sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r00 = m[0] / sx, r10 = m[1] / sx, r20 = m[2] / sx;
  const r01 = m[4] / sy, r11 = m[5] / sy, r21 = m[6] / sy;
  const r02 = m[8] / sz, r12 = m[9] / sz, r22 = m[10] / sz;
  const trace = r00 + r11 + r22;
  let x, y, z, w;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (r21 - r12) / s;
    y = (r02 - r20) / s;
    z = (r10 - r01) / s;
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    w = (r21 - r12) / s;
    x = s / 4;
    y = (r01 + r10) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    w = (r02 - r20) / s;
    x = (r01 + r10) / s;
    y = s / 4;
    z = (r12 + r21) / s;
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r12 + r21) / s;
    z = s / 4;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return { position: [m[12], m[13], m[14]], rotation: [x / n, y / n, z / n, w / n], scale: [sx, sy, sz] };
}
function composeWorldMatrix(p, q, s) {
  const [x, y, z, w] = q;
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * s[0];
  m[1] = 2 * (x * y + z * w) * s[0];
  m[2] = 2 * (x * z - y * w) * s[0];
  m[4] = 2 * (x * y - z * w) * s[1];
  m[5] = (1 - 2 * (x * x + z * z)) * s[1];
  m[6] = 2 * (y * z + x * w) * s[1];
  m[8] = 2 * (x * z + y * w) * s[2];
  m[9] = 2 * (y * z - x * w) * s[2];
  m[10] = (1 - 2 * (x * x + y * y)) * s[2];
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  m[15] = 1;
  return m;
}
var qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
var qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
function qrot(q, v) {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}
var S = Math.SQRT1_2;
var HINGE_FRAME = { x: [0, 0, 0, 1], y: [0, 0, S, S], z: [0, -S, 0, S] };
function jointFrames(spec, self, target) {
  const a = splitWorldMatrix(self);
  const b = target ? splitWorldMatrix(target) : { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  const local = [spec.anchor[0] * a.scale[0], spec.anchor[1] * a.scale[1], spec.anchor[2] * a.scale[2]];
  const offset = qrot(a.rotation, local);
  const world = [a.position[0] + offset[0], a.position[1] + offset[1], a.position[2] + offset[2]];
  const inB = qconj(b.rotation);
  const anchor2 = qrot(inB, [world[0] - b.position[0], world[1] - b.position[1], world[2] - b.position[2]]);
  const pulls = spec.kind === "spring" || spec.kind === "rope";
  const frame1 = spec.kind === "hinge" ? HINGE_FRAME[spec.axis ?? "y"] : [0, 0, 0, 1];
  const deg = Math.PI / 180;
  return {
    kind: spec.kind,
    anchor1: pulls ? [0, 0, 0] : local,
    frame1,
    anchor2,
    frame2: qmul(qmul(inB, a.rotation), frame1),
    ...spec.kind === "hinge" && spec.limits ? { limits: [spec.limits[0] * deg, spec.limits[1] * deg] } : {},
    length: spec.length ?? Math.hypot(local[0], local[1], local[2]),
    stiffness: spec.stiffness ?? DEFAULT_SPRING_STIFFNESS,
    damping: spec.damping ?? DEFAULT_SPRING_DAMPING
  };
}
function fitShape(spec, mesh, scale) {
  const b = meshBounds2(mesh) ?? { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
  const half = [
    Math.max(5e-3, (b.max[0] - b.min[0]) / 2 * scale[0]),
    Math.max(5e-3, (b.max[1] - b.min[1]) / 2 * scale[1]),
    Math.max(5e-3, (b.max[2] - b.min[2]) / 2 * scale[2])
  ];
  const offset = [
    (b.max[0] + b.min[0]) / 2 * scale[0],
    (b.max[1] + b.min[1]) / 2 * scale[1],
    (b.max[2] + b.min[2]) / 2 * scale[2]
  ];
  switch (spec.shape) {
    case "sphere":
      return { kind: "sphere", radius: Math.max(half[0], half[1], half[2]), offset };
    case "capsule": {
      const radius = Math.max(0.01, Math.min(half[0], half[2]));
      return { kind: "capsule", radius, halfHeight: Math.max(0, half[1] - radius), offset };
    }
    case "mesh": {
      const positions = [];
      const indices = [];
      for (const prim of mesh.primitives) {
        const base = positions.length / 3;
        for (let i = 0; i < prim.positions.length; i += 3) {
          positions.push(prim.positions[i] * scale[0], prim.positions[i + 1] * scale[1], prim.positions[i + 2] * scale[2]);
        }
        for (const idx of prim.indices) indices.push(base + idx);
      }
      return { kind: "mesh", vertices: Float32Array.from(positions), indices: Uint32Array.from(indices) };
    }
    default:
      return { kind: "box", halfExtents: half, offset };
  }
}
function castShape(kind, a, b, c) {
  const size = (v) => Math.max(1e-3, Math.abs(v));
  switch (Math.round(kind)) {
    case PHYS_CAST_SPHERE:
      return { kind: "sphere", radius: size(a) };
    case PHYS_CAST_BOX:
      return { kind: "box", halfExtents: [size(a), size(b), size(c)] };
    case PHYS_CAST_CAPSULE:
      return { kind: "capsule", radius: size(a), halfHeight: Math.max(0, b) };
    default:
      return null;
  }
}
function physicsSlots(scene) {
  const out = [];
  scene.instances.forEach((inst, i) => {
    if (inst.physics && inst.physics.body !== "static" && out.length < PHYS_MAX_BODIES) out.push(i);
  });
  return out;
}
function sceneHasPhysics(scene) {
  return Boolean(scene?.instances.some((inst) => inst.physics));
}
var PhysicsSession = class {
  constructor(scene, backend, { deterministic } = {}) {
    this.tracked = [];
    this.byObject = /* @__PURE__ */ new Map();
    /** Bodies of reserve prefab copies (static ones too), by object index. */
    this.pooledBodies = /* @__PURE__ */ new Map();
    /** Every body's handle, by object index. */
    this.handleOf = /* @__PURE__ */ new Map();
    /** Jointed objects: what they're tied to (object, or null for the world) and the live joint. */
    this.joints = /* @__PURE__ */ new Map();
    this.rayRequests = [];
    this.rayResults = [];
    this.events = [];
    this.overlapPairs = [];
    this.tick = 0;
    this.stateHash = 0;
    this.deterministic = deterministic ?? scene.physicsWorld?.deterministic === true;
    this.backend = this.deterministic ? deterministicBackend(backend) : backend;
    const slots = new Set(physicsSlots(scene));
    scene.instances.forEach((inst, i) => {
      const spec = inst.physics;
      if (!spec || spec.body !== "static" && !slots.has(i)) return;
      const pooled = Boolean(inst.pooled);
      const { position, rotation, scale } = splitWorldMatrix(inst.model);
      const handle = this.backend.addBody({
        kind: spec.body,
        shape: fitShape(spec, inst.mesh, scale),
        position,
        rotation,
        mass: spec.mass,
        friction: spec.friction,
        bounce: spec.bounce,
        ...spec.trigger ? { trigger: true } : {},
        ...spec.gravity !== void 0 ? { gravity: spec.gravity } : {},
        ...spec.damping !== void 0 ? { damping: spec.damping } : {},
        object: i
      });
      this.handleOf.set(i, handle);
      if (pooled) {
        this.backend.setEnabled(handle, false);
        this.pooledBodies.set(i, { handle, enabled: false });
      }
      if (spec.body === "static") return;
      const t = { object: i, handle, kind: spec.body, scale, grounded: false, lastMove: [0, 0, 0], enabled: !pooled };
      this.tracked.push(t);
      this.byObject.set(i, t);
    });
    scene.instances.forEach((inst, i) => {
      const spec = inst.physics?.joint;
      if (!spec || !this.handleOf.has(i)) return;
      let target = null;
      for (let p = inst.parent; p >= 0; p = scene.instances[p].parent) {
        if (this.handleOf.has(p)) {
          target = p;
          break;
        }
      }
      this.joints.set(i, { spec, target, handle: null, pooled: Boolean(inst.pooled) });
    });
    const model = (object) => scene.instances[object]?.model ?? null;
    for (const [object, joint] of this.joints) if (!joint.pooled) this.join(object, model);
  }
  /** Create `object`'s joint from where it and its target are now (`world` gives world matrices). */
  join(object, world) {
    const joint = this.joints.get(object);
    const handle = this.handleOf.get(object);
    const self = world(object);
    if (!joint || handle === void 0 || !self || !this.backend.addJoint) return;
    this.unjoin(object);
    const target = joint.target === null ? null : world(joint.target);
    if (joint.target !== null && !target) return;
    joint.handle = this.backend.addJoint({
      ...jointFrames(joint.spec, self, target),
      body: handle,
      target: joint.target === null ? null : this.handleOf.get(joint.target)
    });
  }
  unjoin(object) {
    const joint = this.joints.get(object);
    if (joint?.handle == null) return;
    this.backend.removeJoint?.(joint.handle);
    joint.handle = null;
  }
  /** Write body state and last tick's ray results for the cart to read. */
  beforeTick(block) {
    const bodies = this.tracked.map((t) => {
      const s = this.backend.bodyState(t.handle);
      const velocity = t.kind === "character" ? t.lastMove.map((v) => v / PHYSICS_DT) : s.velocity;
      return { object: t.object, position: s.position, velocity, grounded: t.grounded, sleeping: s.sleeping };
    });
    writePhysicsState(block, this.tick, bodies, this.rayResults, this.events, this.overlapPairs, this.stateHash);
  }
  /** Apply the cart's commands, step the world, and cast the rays it asked for. */
  afterTick(block) {
    this.run(takePhysicsCommands(block));
  }
  /**
   * Take the bodies of objects in unloaded levels out of the world, and bring the
   * rest back (see levels.ts in @cartbox/editor). Prefab copies aren't in levels.
   */
  setInactive(objects) {
    for (const t of this.byObject.values()) {
      if (this.pooledBodies.has(t.object)) continue;
      const active = !objects.has(t.object);
      if (t.enabled === active) continue;
      this.backend.setEnabled(t.handle, active);
      t.enabled = active;
      t.grounded = false;
    }
  }
  /**
   * Bring a spawned prefab copy's bodies into the world, placed where the copy's
   * objects now are (`world` gives each object's world matrix), or take them out.
   */
  setCopyActive(objects, world, active) {
    for (const object of objects) {
      const body = this.pooledBodies.get(object);
      if (!body) continue;
      if (active) {
        const m = world(object);
        if (m) {
          const { position, rotation } = splitWorldMatrix(m);
          this.backend.setPose(body.handle, position, rotation);
        }
      }
      if (body.enabled !== active) this.backend.setEnabled(body.handle, active);
      body.enabled = active;
      const t = this.byObject.get(object);
      if (t) {
        t.enabled = active;
        t.grounded = false;
      }
    }
    for (const object of objects) {
      if (!this.joints.has(object)) continue;
      if (active) this.join(object, (o) => objects.includes(o) ? world(o) : this.currentWorld(o));
      else this.unjoin(object);
    }
  }
  /** A body's world matrix now (position and rotation from physics; unit scale). */
  currentWorld(object) {
    const handle = this.handleOf.get(object);
    if (handle === void 0) return null;
    const s = this.backend.bodyState(handle);
    return composeWorldMatrix(s.position, s.rotation, this.byObject.get(object)?.scale ?? [1, 1, 1]);
  }
  /** Apply a tick's commands (already taken from the block), step, and cast rays. */
  run(commands) {
    this.rayRequests = [];
    const castOptions = /* @__PURE__ */ new Map();
    for (const t of this.tracked) if (t.kind === "character") t.lastMove = [0, 0, 0];
    for (const cmd of commands) {
      const [a, b, c, d, e, f2] = cmd.v;
      if (cmd.op === PHYS_OP_CAST) {
        if (cmd.a >= 0 && cmd.a < PHYS_MAX_RAYS) {
          const ignore = Math.round(e) - 1;
          castOptions.set(cmd.a, { shape: castShape(a, b, c, d), ...ignore >= 0 ? { ignore } : {} });
        }
        continue;
      }
      if (cmd.op === PHYS_OP_RAY) {
        if (cmd.a >= 0 && cmd.a < PHYS_MAX_RAYS) {
          const len = Math.hypot(d, e, f2);
          const options = castOptions.get(cmd.a) ?? { shape: null };
          castOptions.delete(cmd.a);
          this.rayRequests[cmd.a] = len > 1e-9 ? { origin: [a, b, c], direction: [d / len, e / len, f2 / len], max: len, ...options } : null;
        }
        continue;
      }
      const t = this.byObject.get(cmd.a);
      if (!t || !t.enabled) continue;
      if (cmd.op === PHYS_OP_MOTOR || cmd.op === PHYS_OP_UNJOIN) {
        const joint = this.joints.get(cmd.a);
        if (joint?.handle == null) continue;
        if (cmd.op === PHYS_OP_UNJOIN) this.unjoin(cmd.a);
        else if (joint.spec.kind === "hinge") this.backend.setMotor?.(joint.handle, a, Math.max(0, b));
        continue;
      }
      if (cmd.op === PHYS_OP_IMPULSE && t.kind === "dynamic") this.backend.applyImpulse(t.handle, [a, b, c]);
      else if (cmd.op === PHYS_OP_VELOCITY && t.kind !== "character") this.backend.setVelocity(t.handle, [a, b, c]);
      else if (cmd.op === PHYS_OP_TELEPORT) this.backend.teleport(t.handle, [a, b, c]);
      else if (cmd.op === PHYS_OP_MOVE && t.kind === "character") {
        const before = this.backend.bodyState(t.handle).position;
        t.grounded = this.backend.moveCharacter(t.handle, [a, b, c]).grounded;
        const after = this.backend.bodyState(t.handle).position;
        t.lastMove = [after[0] - before[0], after[1] - before[1], after[2] - before[2]];
      }
    }
    this.backend.step(PHYSICS_DT);
    this.events = this.backend.drainContacts();
    this.overlapPairs = this.backend.overlaps();
    this.tick += 1;
    this.stateHash = this.hash();
    this.rayResults = [];
    for (let slot = 0; slot < PHYS_MAX_RAYS; slot += 1) {
      const req = this.rayRequests[slot];
      if (!req) this.rayResults[slot] = null;
      else if (req.shape) this.rayResults[slot] = this.backend.shapecast?.(req.shape, req.origin, req.direction, req.max, req.ignore) ?? null;
      else this.rayResults[slot] = this.backend.raycast(req.origin, req.direction, req.max, req.ignore);
    }
  }
  /**
   * A digest of every moving body's exact state (reserve copies count as absent),
   * equal on two machines exactly when their worlds match — in deterministic mode,
   * across browsers too.
   */
  hash() {
    return physicsStateHash(
      this.tracked.map((t) => t.enabled ? this.backend.bodyState(t.handle) : { position: [0, 0, 0], rotation: [0, 0, 0, 0], velocity: [0, 0, 0] })
    );
  }
  /** Last step's contact events and current trigger overlaps (live inspection, tests). */
  contacts() {
    return { events: this.events, overlaps: this.overlapPairs };
  }
  /** Each moving body's live state, by object index (live inspection). */
  inspect() {
    const out = /* @__PURE__ */ new Map();
    for (const t of this.tracked) {
      const s = this.backend.bodyState(t.handle);
      const velocity = t.kind === "character" ? t.lastMove.map((v) => v / PHYSICS_DT) : s.velocity;
      out.set(t.object, { kind: t.kind, velocity, grounded: t.grounded, active: t.enabled });
    }
    return out;
  }
  /** World matrices for every moving body this frame (scene object index → matrix). */
  overrides() {
    const out = /* @__PURE__ */ new Map();
    for (const t of this.tracked) {
      if (!t.enabled) continue;
      const s = this.backend.bodyState(t.handle);
      out.set(t.object, composeWorldMatrix(s.position, s.rotation, t.scale));
    }
    return out;
  }
  destroy() {
    this.backend.destroy();
  }
};

// src/anim/animationSession.ts
import {
  DEFAULT_ANIMATOR_FADE,
  blendPoses,
  blendWeights,
  clipTime,
  conditionHolds,
  isSkinned,
  restPose,
  sampleClip,
  skinMatrices
} from "@cartbox/editor";
function animatedObjects(scene) {
  const out = [];
  scene?.instances.forEach((inst, i) => {
    if (isSkinned(inst.mesh)) out.push(i);
  });
  return out;
}
function sceneHasAnimation(scene) {
  return animatedObjects(scene).length > 0;
}
function compileAnimator(spec, mesh) {
  const clips = mesh.clips ?? [];
  const clipIndex = (name) => name === null ? -1 : clips.findIndex((c) => c.name === name);
  const paramIndex = (name) => spec.params.findIndex((p) => p.name === name);
  const stateIndex = (name) => spec.states.findIndex((s) => s.name === name);
  const events = /* @__PURE__ */ new Map();
  spec.events.forEach((e, index) => {
    const c = clipIndex(e.clip);
    if (c < 0) return;
    events.set(c, [...events.get(c) ?? [], { time: e.time, index }]);
  });
  return {
    params: spec.params,
    states: spec.states.map((s) => {
      const points = (s.blend?.points ?? []).map((p) => ({ clip: clipIndex(p.clip), at: p.at, ...p.at2 !== void 0 ? { at2: p.at2 } : {} })).filter((p) => p.clip >= 0);
      const param = s.blend ? paramIndex(s.blend.param) : -1;
      const param2 = s.blend?.param2 ? paramIndex(s.blend.param2) : -1;
      return {
        name: s.name,
        clip: clipIndex(s.clip),
        speed: s.speed,
        loop: s.loop,
        blend: param >= 0 && points.length > 0 ? { param, param2, points } : null
      };
    }),
    transitions: spec.transitions.map((t) => ({
      from: t.from === "*" ? -1 : stateIndex(t.from),
      to: stateIndex(t.to),
      when: t.when.map((c) => ({ param: paramIndex(c.param), op: c.op, value: c.value })).filter((c) => c.param >= 0),
      fade: t.fade,
      ...t.exitTime !== void 0 ? { exitTime: t.exitTime } : {}
    })).filter((t) => t.to >= 0 && (t.from >= 0 || t.from === -1)),
    events,
    eventNames: spec.events.map((e) => e.name)
  };
}
var clipTrack = (clip, speed = 1, loop = true) => ({ state: -1, clip, time: 0, phase: 0, speed, loop, fresh: true });
function stateTrack(machine, state) {
  const s = machine.states[state];
  return { state, clip: s.clip, time: 0, phase: 0, speed: s.speed, loop: s.loop, fresh: true };
}
function blendMix(points, v, v2) {
  const weights = blendWeights(points, v, v2);
  return points.map((p, i) => ({ clip: p.clip, w: weights[i] })).filter((m) => m.w > 1e-6).sort((a, b) => b.w - a.w);
}
var AnimationSession = class {
  constructor(scene) {
    this.scene = scene;
    this.playback = /* @__PURE__ */ new Map();
    this.tick = 0;
    this.cache = null;
    /** Each object's final pose (after any adjustment, e.g. IK) as last skinned. */
    this.lastPose = /* @__PURE__ */ new Map();
    for (const i of animatedObjects(scene)) this.playback.set(i, this.fresh(i));
  }
  fresh(object) {
    const inst = this.scene.instances[object];
    const machine = inst.animator ? compileAnimator(inst.animator, inst.mesh) : null;
    const params = new Float64Array(machine?.params.length ?? 0);
    machine?.params.forEach((p, i) => params[i] = p.kind === "trigger" ? 0 : p.initial);
    const current = machine ? stateTrack(machine, 0) : clipTrack((inst.mesh.clips?.length ?? 0) > 0 ? 0 : -1);
    return { mesh: inst.mesh, machine, params, current, from: null, fade: 0, fadeElapsed: 0, fired: [] };
  }
  /** Crossfade `p` into `next` over `fade` seconds. */
  switchTo(p, next, fade) {
    const seconds = Number.isFinite(fade) ? Math.max(0, Math.min(10, fade)) : 0;
    p.from = seconds > 0 ? { ...p.current, fresh: false } : null;
    p.current = next;
    p.fade = seconds;
    p.fadeElapsed = 0;
    this.cache = null;
  }
  /** Play `clip` directly on `object` (-1 = rest), pausing its state machine. */
  play(object, clip, fade, speed, loop, start = 0) {
    const p = this.playback.get(object);
    if (!p) return;
    const clips = p.mesh.clips ?? [];
    const target = Number.isInteger(clip) && clip >= 0 && clip < clips.length ? clip : -1;
    const track = clipTrack(target, Number.isFinite(speed) ? Math.max(-10, Math.min(10, speed)) : 1, loop);
    track.time = Number.isFinite(start) ? Math.max(0, start) : 0;
    this.switchTo(p, track, fade);
  }
  /** Set a state-machine parameter (bools as 0/1; a trigger is set by any non-zero value). */
  setParam(object, param, value) {
    const p = this.playback.get(object);
    if (!p?.machine || param < 0 || param >= p.params.length || !Number.isFinite(value)) return;
    p.params[param] = p.machine.params[param].kind === "number" ? value : value !== 0 ? 1 : 0;
  }
  /** Jump to (crossfade into) a state, handing control back to the machine. */
  goto(object, state, fade = DEFAULT_ANIMATOR_FADE) {
    const p = this.playback.get(object);
    if (!p?.machine || state < 0 || state >= p.machine.states.length) return;
    this.switchTo(p, stateTrack(p.machine, state), fade);
  }
  /** Put an object back to its starting playback (a prefab copy spawned afresh). */
  reset(object) {
    if (!this.playback.has(object)) return;
    this.playback.set(object, this.fresh(object));
    this.cache = null;
  }
  /** Take any transition that's ready, then advance every playback one tick (firing clip events). */
  step(dt) {
    for (const p of this.playback.values()) {
      p.fired = [];
      if (p.machine && p.current.state >= 0) this.transition(p);
      const before = this.cursor(p, p.current);
      this.advance(p, p.current, dt);
      if (p.machine) this.fireEvents(p, before, this.cursor(p, p.current));
      p.current.fresh = false;
      if (p.from) {
        this.advance(p, p.from, dt);
        p.fadeElapsed += dt;
        if (p.fadeElapsed >= p.fade) p.from = null;
      }
    }
    this.tick += 1;
  }
  /** How far through its cycle a track is (0..1 per pass of its clip; loops keep counting). */
  progress(p, track) {
    const s = track.state >= 0 ? p.machine?.states[track.state] : void 0;
    if (s?.blend) return track.phase;
    const clip = track.clip >= 0 ? p.mesh.clips?.[track.clip] : void 0;
    return clip && clip.duration > 0 ? track.time / clip.duration : 1;
  }
  transition(p) {
    const m = p.machine;
    for (const t of m.transitions) {
      if (t.from !== -1 && t.from !== p.current.state) continue;
      if (t.from === -1 && t.to === p.current.state) continue;
      if (t.exitTime !== void 0 && this.progress(p, p.current) < t.exitTime) continue;
      if (!t.when.every((c) => conditionHolds(c.op, p.params[c.param], c.value))) continue;
      for (const c of t.when) if (m.params[c.param].kind === "trigger") p.params[c.param] = 0;
      this.switchTo(p, stateTrack(m, t.to), t.fade);
      return;
    }
  }
  /** The blend state's mix now, or null for a single clip. */
  blendOf(p, track) {
    const s = track.state >= 0 ? p.machine?.states[track.state] : void 0;
    if (!s?.blend) return null;
    const mix = blendMix(s.blend.points, p.params[s.blend.param], s.blend.param2 >= 0 ? p.params[s.blend.param2] : void 0);
    return mix.length > 0 ? mix : null;
  }
  advance(p, track, dt) {
    const blend = this.blendOf(p, track);
    if (!blend) {
      track.time += dt * track.speed;
      return;
    }
    const clips = p.mesh.clips ?? [];
    const length = blend.reduce((sum, m) => sum + (clips[m.clip]?.duration ?? 0) * m.w, 0);
    track.phase += length > 0 ? dt * track.speed / length : 0;
  }
  /** Where the playhead is for events: which clip, and seconds into it (unwrapped). */
  cursor(p, track) {
    const blend = this.blendOf(p, track);
    if (!blend) return { clip: track.clip, time: track.fresh ? track.time - 1e-9 : track.time };
    const clip = blend[0].clip;
    const d = p.mesh.clips?.[clip]?.duration ?? 0;
    return { clip, time: track.phase * d - (track.fresh ? 1e-9 : 0) };
  }
  fireEvents(p, before, after) {
    if (before.clip !== after.clip || after.clip < 0) return;
    const list = p.machine.events.get(after.clip);
    const clip = p.mesh.clips?.[after.clip];
    if (!list || !clip) return;
    const [lo, hi] = before.time <= after.time ? [before.time, after.time] : [after.time, before.time];
    const looping = p.current.loop && clip.duration > 0;
    for (const e of list) {
      if (!looping) {
        if (e.time > lo && e.time <= hi && e.time <= clip.duration) p.fired.push(e.index);
        continue;
      }
      for (let k = Math.ceil((lo - e.time) / clip.duration); e.time + k * clip.duration <= hi; k += 1) {
        const at = e.time + k * clip.duration;
        if (at > lo && p.fired.length < 16) p.fired.push(e.index);
      }
    }
  }
  /** Each animated object's clip, time and state, as the cart reads them. */
  state() {
    const out = [];
    for (const [object, p] of this.playback) {
      const shown = this.shownClip(p, p.current);
      out.push({ object, clip: shown.clip, time: shown.time, state: p.current.state });
    }
    return out;
  }
  /** Events that fired on the last step: object and the event's index in its state machine. */
  events() {
    const out = [];
    for (const [object, p] of this.playback) for (const event of p.fired) out.push({ object, event });
    return out;
  }
  /** The clip a track shows (a blend reports its stronger clip) and seconds into it. */
  shownClip(p, track) {
    const blend = this.blendOf(p, track);
    const clips = p.mesh.clips ?? [];
    if (blend) {
      const clip = blend[0].clip;
      const c2 = clips[clip];
      return { clip, time: c2 ? clipTime(c2, track.phase * c2.duration, track.loop) : 0 };
    }
    const c = track.clip >= 0 ? clips[track.clip] : void 0;
    return { clip: c ? track.clip : -1, time: c ? clipTime(c, track.time, track.loop) : 0 };
  }
  /**
   * The skinning matrices for every animated object now (object → matrices),
   * computed once per tick. `visible` skips objects not being drawn (a reserve
   * prefab copy), which then keep their last pose; `adjust` may rewrite a pose
   * before it's skinned (inverse kinematics).
   */
  matrices(visible = () => true, adjust) {
    if (this.cache?.tick === this.tick) return this.cache.matrices;
    const out = /* @__PURE__ */ new Map();
    for (const [object, p] of this.playback) {
      if (!visible(object)) continue;
      const pose = this.pose(p, p.current);
      const faded = p.from && p.fade > 0 ? blendPoses(this.pose(p, p.from), pose, Math.min(1, p.fadeElapsed / p.fade)) : pose;
      adjust?.(object, p.mesh, faded);
      this.lastPose.set(object, faded);
      out.set(object, skinMatrices(p.mesh.skin, faded));
    }
    this.cache = { tick: this.tick, matrices: out };
    return out;
  }
  /** Recompute the matrices on the next request (something that shapes the pose changed). */
  invalidate() {
    this.cache = null;
  }
  /** An object's final pose as last skinned (null before its first). */
  finalPose(object) {
    return this.lastPose.get(object) ?? null;
  }
  pose(p, track) {
    const skin = p.mesh.skin;
    const clips = p.mesh.clips ?? [];
    const blend = this.blendOf(p, track);
    if (blend) {
      const at = (c) => track.phase * c.duration;
      let pose = null;
      let total = 0;
      for (const m of blend) {
        const c = clips[m.clip];
        const sample = sampleClip(skin, c, at(c), track.loop);
        pose = pose ? blendPoses(pose, sample, m.w / (total + m.w)) : sample;
        total += m.w;
      }
      return pose;
    }
    const clip = track.clip >= 0 ? clips[track.clip] : void 0;
    return clip ? sampleClip(skin, clip, track.time, track.loop) : restPose(skin);
  }
};

// src/anim/timelineSession.ts
import { composeModelMatrix as composeModelMatrix2, crossedMarks, multiplyMat4, sampleCamera, sampleObjects, sampleValues, timelineValueNames } from "@cartbox/editor";
function timelineEventNames(timeline) {
  const names = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "events") continue;
    for (const e of track.events) if (!names.includes(e.name)) names.push(e.name);
  }
  return names;
}
var TimelineSession = class {
  constructor(scene) {
    this.scene = scene;
    this.objectIndex = /* @__PURE__ */ new Map();
    this.current = null;
    this.fired = [];
    this.timelines = scene.timelines ?? [];
    scene.instances.forEach((inst, i) => {
      if (!this.objectIndex.has(inst.id)) this.objectIndex.set(inst.id, i);
    });
    const auto = this.timelines.findIndex((t) => t.autoplay);
    if (auto >= 0) this.play(auto);
  }
  /** Play timeline `index` from `from` seconds (an invalid index stops). */
  play(index, from = 0, speed = 1) {
    const timeline = this.timelines[index];
    if (!timeline) {
      this.stop();
      return;
    }
    this.current = {
      index,
      time: Math.max(0, Math.min(timeline.duration, Number.isFinite(from) ? from : 0)),
      speed: Number.isFinite(speed) ? Math.max(0, Math.min(10, speed)) : 1,
      playing: true,
      fresh: true
    };
  }
  stop() {
    this.current = null;
  }
  /**
   * Advance one tick. Returns the animation cues passed (object index + cue) for
   * the caller to apply; the events passed are kept for {@link events}.
   */
  step(dt) {
    this.fired = [];
    const c = this.current;
    if (!c || !c.playing) return [];
    const timeline = this.timelines[c.index];
    const names = timelineEventNames(timeline);
    const cues = [];
    const collect = (t02, t12) => {
      const marks = crossedMarks(timeline, t02, t12);
      for (const { object, cue } of marks.cues) {
        const i = this.objectIndex.get(object);
        if (i !== void 0) cues.push({ object: i, cue });
      }
      for (const e of marks.events) this.fired.push(names.indexOf(e));
    };
    const t0 = c.fresh ? c.time - 1e-9 : c.time;
    c.fresh = false;
    let t1 = c.time + dt * c.speed;
    if (t1 >= timeline.duration) {
      collect(t0, timeline.duration);
      if (timeline.loop && timeline.duration > 0) {
        t1 -= timeline.duration;
        collect(-1e-9, t1);
        c.time = t1;
      } else if (timeline.hold) {
        c.time = timeline.duration;
        c.playing = false;
      } else {
        this.current = null;
      }
      return cues;
    }
    collect(t0, t1);
    c.time = t1;
    return cues;
  }
  /** What plays (or holds) now. */
  state() {
    return this.current ? { index: this.current.index, time: this.current.time, playing: this.current.playing } : { index: -1, time: 0, playing: false };
  }
  /** Indices (into the playing timeline's event names) of the events passed on the last step. */
  events() {
    return this.fired;
  }
  /** Every value track name in the scene's timelines (the cart's value slots). */
  valueNames() {
    return timelineValueNames(this.timelines);
  }
  /** The playing (or held) timeline's values now (name → value); empty when none plays. */
  values() {
    const c = this.current;
    return c ? sampleValues(this.timelines[c.index], c.time) : /* @__PURE__ */ new Map();
  }
  /** The timeline camera now (world eye, target, fov in degrees), or null. */
  camera() {
    const c = this.current;
    return c ? sampleCamera(this.timelines[c.index], c.time) : null;
  }
  /**
   * World matrices of the objects the timeline places (object index → matrix):
   * each key is relative to the object's parent, which may itself be placed by
   * the timeline.
   */
  placements() {
    const out = /* @__PURE__ */ new Map();
    const c = this.current;
    if (!c) return out;
    const locals = /* @__PURE__ */ new Map();
    for (const [id, t] of sampleObjects(this.timelines[c.index], c.time)) {
      const i = this.objectIndex.get(id);
      if (i !== void 0) locals.set(i, composeModelMatrix2(t.position, t.rotation, t.scale));
    }
    const worldOf = (i, depth = 0) => {
      const known = out.get(i);
      if (known) return known;
      const inst = this.scene.instances[i];
      const local = locals.get(i);
      if (!local) return inst.model;
      const parent = inst.parent >= 0 && depth < this.scene.instances.length ? worldOf(inst.parent, depth + 1) : null;
      const world = parent ? multiplyMat4(parent, local) : local;
      out.set(i, world);
      return world;
    };
    for (const i of locals.keys()) worldOf(i);
    return out;
  }
};

// src/physics/physicsSdk.ts
import { timelineValueNames as timelineValueNames2 } from "@cartbox/editor";
function sceneNeedsRuntime(scene, { physics = true } = {}) {
  return Boolean(
    scene && (physics && sceneHasPhysics(scene) || (scene.pools?.length ?? 0) > 0 || animatedObjects(scene).length > 0 || (scene.timelines?.length ?? 0) > 0 || (scene.levels?.length ?? 0) > 0 || Boolean(scene.navmesh) || Boolean(scene.streaming) || (scene.effects?.length ?? 0) > 0 || (scene.decals?.length ?? 0) > 0 || (scene.debris?.length ?? 0) > 0 || (scene.audio?.sounds.length ?? 0) > 0 || (scene.components?.length ?? 0) > 0)
  );
}
var luaString = (s) => JSON.stringify(s);
function runtimeSdkLua(scene, layout, { physics: engine = true } = {}) {
  if (!scene || !sceneNeedsRuntime(scene, { physics: engine })) return "";
  const physics = engine && sceneHasPhysics(scene);
  const slots = physicsSlots(scene).map((object, slot) => `[${object}]=${slot}`);
  const pools = (scene.pools ?? []).map((pool) => `[${luaString(pool.prefab)}]={${pool.roots.join(",")}}`);
  const B = physicsBlockAddress(layout);
  const R = commandRingAddress(layout);
  return `do
  cartbox = cartbox or {}
  local _B = ${B}
  local _R = ${R ?? "nil"}
  local _slot = {${slots.join(",")}}
  local _ok = false
  local function _rd(a)
    local v = peek(a) | (peek(a + 1) << 8) | (peek(a + 2) << 16) | (peek(a + 3) << 24)
    if v >= 0x80000000 then v = v - 0x100000000 end
    return v
  end
  local function _wr(a, v)
    v = math.floor(v) & 0xffffffff
    poke(a, v & 0xff) poke(a + 1, (v >> 8) & 0xff) poke(a + 2, (v >> 16) & 0xff) poke(a + 3, (v >> 24) & 0xff)
  end
  -- The host writes a magic word before every tick; until it has (code run at
  -- load time) or if the block isn't where this build expects, physics is off.
  local function _live()
    if not _ok then _ok = _rd(_B) == ${PHYS_MAGIC} end
    return _ok
  end
  local function _obj(o)
    if type(o) == "string" then return cartbox.find(o) end
    return o
  end
  local function _cmd(op, a, v1, v2, v3, v4, v5, v6)
    if not _live() then return end
    local count, cap = _B + ${PHYS_CMDS}, ${PHYS_MAX_CMDS}
    local n = _rd(count)
    if n >= cap and _R then count, cap = _R, ${commandRingMax(layout)}; n = _rd(count) end
    if n < 0 or n >= cap then return end
    local at = count + 4 + n * ${PHYS_CMD_BYTES}
    _wr(at, op) _wr(at + 4, a)
    _wr(at + 8, (v1 or 0) * ${PHYS_FIX}) _wr(at + 12, (v2 or 0) * ${PHYS_FIX}) _wr(at + 16, (v3 or 0) * ${PHYS_FIX})
    _wr(at + 20, (v4 or 0) * ${PHYS_FIX}) _wr(at + 24, (v5 or 0) * ${PHYS_FIX}) _wr(at + 28, (v6 or 0) * ${PHYS_FIX})
    _wr(count, n + 1)
    return true
  end
${physics ? PHYSICS_CALLS() : ""}
${pools.length > 0 ? SPAWN_CALLS(pools) : ""}
${ANIM_CALLS(scene)}
${TIMELINE_CALLS(scene)}${LEVEL_CALLS(scene)}${scene.navmesh ? NAV_CALLS() : ""}${scene.streaming ? STREAM_CALLS() : ""}${BURST_CALLS(scene)}${DECAL_CALLS(scene)}${DEBRIS_CALLS(scene)}${SOUND_CALLS(scene)}${SHIELD_CALLS()}${PLACE_CALLS()}end`;
}
function PHYSICS_CALLS() {
  return `  cartbox.physics = function() return _live() end
  cartbox.physicshash = function()
    if not _live() then return 0 end
    return _rd(_B + ${PHYS_HDR_HASH})
  end
  cartbox.body = function(o)
    local i = _obj(o)
    local s = i and _slot[i]
    if s == nil or not _live() then return nil end
    local at = _B + ${PHYS_BODIES} + s * ${PHYS_BODY_BYTES}
    return _rd(at + 4) / ${PHYS_FIX}, _rd(at + 8) / ${PHYS_FIX}, _rd(at + 12) / ${PHYS_FIX},
      _rd(at + 16) / ${PHYS_FIX}, _rd(at + 20) / ${PHYS_FIX}, _rd(at + 24) / ${PHYS_FIX},
      (_rd(at + 28) & 1) == 1
  end
  local function _each(op)
    return function(o, x, y, z)
      local i = _obj(o)
      if i and _slot[i] then _cmd(op, i, x, y, z) end
    end
  end
  cartbox.impulse = _each(${PHYS_OP_IMPULSE})
  cartbox.velocity = _each(${PHYS_OP_VELOCITY})
  cartbox.teleport = _each(${PHYS_OP_TELEPORT})
  cartbox.move = _each(${PHYS_OP_MOVE})
  cartbox.motor = function(o, speed, force)
    local i = _obj(o)
    if i == nil or not _slot[i] then return end
    if speed == nil then _cmd(${PHYS_OP_MOTOR}, i, 0, 0) else _cmd(${PHYS_OP_MOTOR}, i, speed, force or 1000) end
  end
  cartbox.unjoin = function(o)
    local i = _obj(o)
    if i and _slot[i] then _cmd(${PHYS_OP_UNJOIN}, i) end
  end
  -- A ray, or (kind > 0) a swept shape, from a slot: options first, then the ray.
  local function _cast(slot, kind, a, b, c, x, y, z, dx, dy, dz, max, ignore)
    slot = math.floor(slot or 0)
    if slot < 0 or slot >= ${PHYS_MAX_RAYS} then return end
    local m = math.sqrt((dx or 0)^2 + (dy or 0)^2 + (dz or 0)^2)
    if m < 1e-9 then return end
    local skip = 0
    if ignore ~= nil then skip = (_obj(ignore) or -1) + 1 end
    if kind ~= ${PHYS_CAST_RAY} or skip > 0 then _cmd(${PHYS_OP_CAST}, slot, kind, a, b, c, skip) end
    local k = (max or 100) / m
    _cmd(${PHYS_OP_RAY}, slot, x, y, z, dx * k, dy * k, dz * k)
  end
  cartbox.ray = function(slot, x, y, z, dx, dy, dz, max, ignore)
    _cast(slot, ${PHYS_CAST_RAY}, 0, 0, 0, x, y, z, dx, dy, dz, max, ignore)
  end
  cartbox.sweep = function(slot, shape, x, y, z, dx, dy, dz, max, ignore)
    if type(shape) == "number" then
      _cast(slot, ${PHYS_CAST_SPHERE}, shape, 0, 0, x, y, z, dx, dy, dz, max, ignore)
    elseif type(shape) == "table" and #shape >= 3 then
      _cast(slot, ${PHYS_CAST_BOX}, shape[1], shape[2], shape[3], x, y, z, dx, dy, dz, max, ignore)
    elseif type(shape) == "table" and #shape == 2 then
      _cast(slot, ${PHYS_CAST_CAPSULE}, shape[1], shape[2], 0, x, y, z, dx, dy, dz, max, ignore)
    end
  end
  cartbox.hit = function(slot)
    slot = math.floor(slot or 0)
    if slot < 0 or slot >= ${PHYS_MAX_RAYS} or not _live() then return false end
    local at = _B + ${PHYS_RAYS} + slot * ${PHYS_RAY_BYTES}
    local w = _rd(at)
    if w == 0 then return false end
    local obj = nil
    if w >= 2 then obj = w - 2 end
    return true, obj, _rd(at + 4) / ${PHYS_FIX}, _rd(at + 8) / ${PHYS_FIX}, _rd(at + 12) / ${PHYS_FIX},
      _rd(at + 16) / ${PHYS_FIX}, _rd(at + 20) / ${PHYS_FIX}, _rd(at + 24) / ${PHYS_FIX}, _rd(at + 28) / ${PHYS_FIX}
  end
  cartbox.contacts = function()
    local out = {}
    if not _live() then return out end
    local n = _rd(_B + ${PHYS_EVENTS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_EVENTS + 4} + k * ${PHYS_EVENT_BYTES}
      local f = _rd(at + 8)
      out[#out + 1] = { a = _rd(at), b = _rd(at + 4), started = (f & 1) == 1, trigger = (f & 2) == 2 }
    end
    return out
  end
  local function _crossed(o, started)
    local t = _obj(o)
    local out = {}
    if t == nil then return out end
    for _, e in ipairs(cartbox.contacts()) do
      if e.trigger and e.started == started then
        if e.a == t then out[#out + 1] = e.b elseif e.b == t then out[#out + 1] = e.a end
      end
    end
    return out
  end
  cartbox.entered = function(o) return _crossed(o, true) end
  cartbox.exited = function(o) return _crossed(o, false) end
  cartbox.inside = function(o)
    local t = _obj(o)
    local out = {}
    if t == nil or not _live() then return out end
    local n = _rd(_B + ${PHYS_OVERLAPS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_OVERLAPS + 4} + k * ${PHYS_OVERLAP_BYTES}
      if _rd(at) == t then out[#out + 1] = _rd(at + 4) end
    end
    return out
  end
`;
}
function SPAWN_CALLS(pools) {
  return `  local _pools = {${pools.join(",")}}
  local _alive = {}
  cartbox.spawn = function(name, x, y, z, yaw, pitch, roll)
    local roots = _pools[name]
    if roots == nil or not _live() then return nil end
    for _, r in ipairs(roots) do
      if not _alive[r] then
        _alive[r] = true
        _cmd(${PHYS_OP_SPAWN}, r, x or 0, y or 0, z or 0, yaw or 0, pitch or 0, roll or 0)
        return r
      end
    end
    return nil
  end
  cartbox.despawn = function(o)
    local i = _obj(o)
    if i ~= nil and _alive[i] then
      _alive[i] = nil
      _cmd(${PHYS_OP_DESPAWN}, i)
    end
  end
  cartbox.alive = function(o)
    local i = _obj(o)
    return i ~= nil and _alive[i] == true
  end
`;
}
function BURST_CALLS(scene) {
  const effects = scene.effects ?? [];
  if (effects.length === 0) return "";
  return `  local _fx = {${effects.map((e, i) => `[${luaString(e.name)}]=${i}`).join(",")}}
  local _fxn = {${effects.map((e) => luaString(e.name)).join(",")}}
  cartbox.burst = function(e, x, y, z, dx, dy, dz, scale)
    local i = e
    if type(e) == "string" then i = _fx[e] elseif type(e) == "number" then i = e - 1 end
    if i == nil or i < 0 or i >= ${effects.length} then return end
    local s = math.floor(math.max(0, math.min(4, scale or 1)) * 16 + 0.5)
    _cmd(${PHYS_OP_BURST}, i | (s << 8), x or 0, y or 0, z or 0, dx or 0, dy or 0, dz or 0)
  end
  cartbox.effects = function()
    local out = {}
    for k, n in ipairs(_fxn) do out[k] = n end
    return out
  end
`;
}
function DEBRIS_CALLS(scene) {
  const debris = scene.debris ?? [];
  if (debris.length === 0) return "";
  return `  local _db = {${debris.map((d, i) => `[${luaString(d.name)}]=${i}`).join(",")}}
  local _dbn = {${debris.map((d) => luaString(d.name)).join(",")}}
  cartbox.debris = function(d, x, y, z, vx, vy, vz, scale)
    local i = d
    if type(d) == "string" then i = _db[d] elseif type(d) == "number" then i = d - 1 end
    if i == nil or i < 0 or i >= ${debris.length} then return end
    local s = math.floor(math.max(0, math.min(8, scale or 1)) * 16 + 0.5)
    _cmd(${PHYS_OP_DEBRIS}, i | (s << 8), x or 0, y or 0, z or 0, vx or 0, vy or 0, vz or 0)
  end
  cartbox.debrislist = function()
    local out = {}
    for k, n in ipairs(_dbn) do out[k] = n end
    return out
  end
`;
}
function SOUND_CALLS(scene) {
  const sounds = scene.audio?.sounds ?? [];
  if (sounds.length === 0) return "";
  const buses = scene.audio?.buses ?? [];
  return `  local _snd = {${sounds.map((s, i) => `[${luaString(s.name)}]=${i}`).join(",")}}
  local _sndn = {${sounds.map((s) => luaString(s.name)).join(",")}}
  local _bus = {${buses.map((b, i) => `[${luaString(b.name)}]=${i}`).join(",")}}
  local function _sound(s)
    local i = s
    if type(s) == "string" then i = _snd[s] elseif type(s) == "number" then i = s - 1 end
    if i == nil or i < 0 or i >= ${sounds.length} then return nil end
    return i
  end
  cartbox.sound = function(s, x, y, z, volume, pitch)
    local i = _sound(s)
    if i == nil then return end
    local v = math.floor(math.max(0, math.min(4, volume or 1)) * 64 + 0.5)
    _cmd(${PHYS_OP_SOUND}, i | (v << 8), x or 0, y or 0, z or 0, pitch or 1, x and 1 or 0)
  end
  local _loops = {}
  cartbox.loop = function(slot, s, volume, x, y, z)
    slot = math.floor(slot or 1) - 1
    if slot < 0 or slot > 15 then return end
    local i = s ~= nil and _sound(s) or nil
    local key = i and string.format("%d %.2f %.1f %.1f %.1f", i, volume or 1, x or 0, y or 0, z or 0) or "off"
    if _loops[slot] == key or (key == "off" and _loops[slot] == nil) then return end
    if _cmd(${PHYS_OP_SOUND_LOOP}, slot | ((i and i + 1 or 0) << 8), volume or 1, x or 0, y or 0, z or 0, x and 1 or 0) then
      _loops[slot] = key ~= "off" and key or nil
    end
  end
  cartbox.mix = function(b, volume)
    local i = b
    if type(b) == "string" then i = _bus[b] elseif type(b) == "number" then i = b - 1 end
    if i == nil or i < 0 or i >= ${buses.length} then return end
    _cmd(${PHYS_OP_MIX}, i, math.max(0, math.min(2, volume or 1)))
  end
  cartbox.sounds = function()
    local out = {}
    for k, n in ipairs(_sndn) do out[k] = n end
    return out
  end
`;
}
function PLACE_CALLS() {
  return `  cartbox.place = function(o, x, y, z, yaw, pitch, roll, scale)
    local i = _obj(o)
    if i == nil or i > 65535 then return end
    if x == nil then return _cmd(${PHYS_OP_UNPLACE}, i) end
    local s = math.max(0, math.min(32767, math.floor((scale or 1) * 256 + 0.5)))
    return _cmd(${PHYS_OP_PLACE}, i | (s << 16), x, y or 0, z or 0, yaw or 0, pitch or 0, roll or 0)
  end
`;
}
function SHIELD_CALLS() {
  return `  local _shield = {}
  cartbox.shield = function(o, flare, shimmer, camo)
    local i = _obj(o)
    if i == nil then return end
    local key = string.format("%.2f %.2f %.2f", flare or 0, shimmer or 0, camo or 0)
    if _shield[i] == key then return end -- it stands: send changes only (retried if the queue was full)
    if _cmd(${PHYS_OP_SHIELD}, i, flare or 0, shimmer or 0, camo or 0) then _shield[i] = key end
  end
`;
}
function DECAL_CALLS(scene) {
  const decals = scene.decals ?? [];
  if (decals.length === 0) return "";
  return `  local _dc = {${decals.map((d, i) => `[${luaString(d.name)}]=${i}`).join(",")}}
  local _dcn = {${decals.map((d) => luaString(d.name)).join(",")}}
  cartbox.decal = function(d, x, y, z, nx, ny, nz, scale)
    local i = d
    if type(d) == "string" then i = _dc[d] elseif type(d) == "number" then i = d - 1 end
    if i == nil or i < 0 or i >= ${decals.length} then return end
    local s = math.floor(math.max(0, math.min(4, scale or 1)) * 16 + 0.5)
    _cmd(${PHYS_OP_DECAL}, i | (s << 8), x or 0, y or 0, z or 0, nx or 0, ny or 1, nz or 0)
  end
  cartbox.decals = function()
    local out = {}
    for k, n in ipairs(_dcn) do out[k] = n end
    return out
  end
`;
}
function STREAM_CALLS() {
  return `  cartbox.streamfocus = function(x, y, z)
    if x == nil then _cmd(${PHYS_OP_STREAM_FOCUS}, 0) else _cmd(${PHYS_OP_STREAM_FOCUS}, 1, x, y or 0, z or 0) end
  end
`;
}
function NAV_CALLS() {
  return `  local function _akey(k)
    if type(k) == "number" then return math.floor(k) end
    return _obj(k)
  end
  cartbox.navigable = function() return true end
  cartbox.agent = function(k, x, y, z, speed, radius)
    local key = _akey(k)
    if key ~= nil then _cmd(${PHYS_OP_AGENT}, key, x or 0, y or 0, z or 0, speed or 0, radius or 0, 0) end
  end
  cartbox.obstacle = function(k, x, y, z, radius)
    local key = _akey(k)
    if key ~= nil then _cmd(${PHYS_OP_AGENT}, key, x or 0, y or 0, z or 0, 0, radius or 0.4, 1) end
  end
  cartbox.moveto = function(k, x, y, z, speed)
    local key = _akey(k)
    if key ~= nil then _cmd(${PHYS_OP_AGENT_GOTO}, key, x or 0, y or 0, z or 0, speed or 0) end
  end
  cartbox.stopagent = function(k)
    local key = _akey(k)
    if key ~= nil then _cmd(${PHYS_OP_AGENT_STOP}, key) end
  end
  cartbox.removeagent = function(k)
    local key = _akey(k)
    if key ~= nil then _cmd(${PHYS_OP_AGENT_REMOVE}, key) end
  end
  cartbox.agentpos = function(k)
    local key = _akey(k)
    if key == nil or not _live() then return nil end
    local n = _rd(_B + ${PHYS_AGENTS})
    for i = 0, math.min(n, ${PHYS_MAX_AGENTS}) - 1 do
      local at = _B + ${PHYS_AGENTS + 4} + i * ${PHYS_AGENT_BYTES}
      local w = _rd(at + 12) & 0xffffffff
      if (w & 1023) == key then
        local fl = (w >> 10) & 63
        local fa = (w >> 16) & 0xffff
        if fa >= 32768 then fa = fa - 65536 end
        return _rd(at) / ${PHYS_FIX}, _rd(at + 4) / ${PHYS_FIX}, _rd(at + 8) / ${PHYS_FIX}, fa / 10000,
          (fl & ${NAV_FLAG_MOVING}) ~= 0, (fl & ${NAV_FLAG_AIR}) ~= 0, (fl & ${NAV_FLAG_ARRIVED}) ~= 0, (fl & ${NAV_FLAG_NO_PATH}) ~= 0
      end
    end
    return nil
  end
`;
}
function LEVEL_CALLS(scene) {
  const levels = scene.levels ?? [];
  if (levels.length === 0) return "";
  return `  local _lv = {${levels.map((l) => luaString(l.name)).join(",")}}
  cartbox.level = function(name)
    if name == nil then
      if not _live() then return _lv[1], nil, 0 end
      local l = _rd(_B + ${PHYS_HDR_LEVEL_LOADING})
      return _lv[_rd(_B + ${PHYS_HDR_LEVEL}) + 1], l >= 0 and _lv[l + 1] or nil, _rd(_B + ${PHYS_HDR_LEVEL_PROGRESS}) / ${PHYS_FIX}
    end
    for k, n in ipairs(_lv) do
      if n == name or k - 1 == name then
        _cmd(${PHYS_OP_LEVEL}, k - 1)
        return true
      end
    end
    return false
  end
  cartbox.levels = function()
    local out = {}
    for k, n in ipairs(_lv) do out[k] = n end
    return out
  end
`;
}
function TIMELINE_CALLS(scene) {
  const timelines = scene.timelines ?? [];
  if (timelines.length === 0) return "";
  const names = timelines.map((t) => luaString(t.name)).join(",");
  const events = timelines.map((t) => `{${timelineEventNames(t).map(luaString).join(",")}}`).join(",");
  const values = timelineValueNames2(timelines).slice(0, PHYS_MAX_TIMELINE_VALUES).map((n, i) => `[${luaString(n)}]=${i}`).join(",");
  return `  local _tl = {${names}}
  local _tlev = {${events}}
  local _tlval = {${values}}
  cartbox.timelinevalue = function(name)
    local i = _tlval[name]
    if i == nil or not _live() or i >= _rd(_B + ${PHYS_TIMELINE_VALUES}) then return nil end
    local v = _rd(_B + ${PHYS_TIMELINE_VALUES + 4} + i * 4)
    if v == ${TIMELINE_VALUE_NONE} then return nil end
    return v / ${PHYS_FIX}
  end
  cartbox.playtimeline = function(name, from, speed)
    for k, n in ipairs(_tl) do
      if n == name or k - 1 == name then
        _cmd(${PHYS_OP_TIMELINE}, k - 1, from or 0, speed or 1)
        return
      end
    end
  end
  cartbox.stoptimeline = function() _cmd(${PHYS_OP_TIMELINE}, -1) end
  cartbox.timeline = function()
    if not _live() then return nil, 0, false end
    local i = _rd(_B + ${PHYS_TIMELINE})
    if i < 0 then return nil, 0, false end
    return _tl[i + 1], _rd(_B + ${PHYS_TIMELINE + 4}) / ${PHYS_FIX}, _rd(_B + ${PHYS_TIMELINE + 8}) == 1
  end
  cartbox.timelineevents = function()
    local out = {}
    if not _live() then return out end
    local i = _rd(_B + ${PHYS_TIMELINE})
    local names = _tlev[i + 1]
    if names == nil then return out end
    local n = _rd(_B + ${PHYS_TIMELINE_EVENTS})
    for k = 0, n - 1 do out[#out + 1] = names[_rd(_B + ${PHYS_TIMELINE_EVENTS + 4} + k * 4) + 1] end
    return out
  end
`;
}
function ANIM_CALLS(scene) {
  const animated = animatedObjects(scene);
  if (animated.length === 0) return "";
  const names = animated.map((i) => `[${i}]={${(scene.instances[i].mesh.clips ?? []).map((c) => luaString(c.name)).join(",")}}`);
  const durations = animated.map((i) => `[${i}]={${(scene.instances[i].mesh.clips ?? []).map((c) => c.duration).join(",")}}`);
  const skeletons = /* @__PURE__ */ new Map();
  const skeletonTables = [];
  const jointsOf = animated.map((i) => {
    const skin = scene.instances[i].mesh.skin;
    let k = skeletons.get(skin);
    if (k === void 0) {
      k = skeletonTables.length;
      skeletons.set(skin, k);
      skeletonTables.push(`{${skin.joints.map((j) => luaString(j.name)).join(",")}}`);
    }
    return `[${i}]=_sk[${k + 1}]`;
  });
  const machines = animated.filter((i) => scene.instances[i].animator).map((i) => {
    const a = scene.instances[i].animator;
    const params = a.params.map((p, k) => `[${luaString(p.name)}]=${k}`).join(",");
    const states = a.states.map((st) => luaString(st.name)).join(",");
    const events = a.events.map((e) => luaString(e.name)).join(",");
    return `[${i}]={p={${params}},s={${states}},e={${events}}}`;
  });
  return `  local _clips = {${names.join(",")}}
  local _dur = {${durations.join(",")}}
  local _loops = {}
  cartbox.clips = function(o)
    local i = _obj(o)
    local out = {}
    for k, n in ipairs((i and _clips[i]) or {}) do out[k] = n end
    return out
  end
  cartbox.play = function(o, clip, fade, speed, loop)
    local i = _obj(o)
    local names = i and _clips[i]
    if names == nil then return end
    local c = -1
    if type(clip) == "number" then
      if clip >= 0 and clip < #names then c = math.floor(clip) end
    elseif type(clip) == "string" then
      for k, n in ipairs(names) do if n == clip then c = k - 1 end end
      if c < 0 then return end
    end
    if loop == nil then loop = true end
    _loops[i] = loop
    _cmd(${PHYS_OP_PLAY}, i, c, fade or 0.2, speed or 1, loop and 1 or 0, 0)
  end
  cartbox.anim = function(o)
    local i = _obj(o)
    if i == nil or _clips[i] == nil or not _live() then return nil, 0, false end
    local n = _rd(_B + ${PHYS_ANIMS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_ANIMS + 4} + k * ${PHYS_ANIM_BYTES}
      if _rd(at) == i then
        local c = _rd(at + 4)
        if c < 0 then return nil, 0, false end
        local t = _rd(at + 8) / ${PHYS_FIX}
        local done = _loops[i] == false and t >= (_dur[i][c + 1] or 0) - 0.0005
        return _clips[i][c + 1], t, done
      end
    end
    return nil, 0, false
  end
  local _sk = {${skeletonTables.join(",")}}
  local _jt = {${jointsOf.join(",")}}
  local _jidx = {}
  local function _joint(i, j)
    local names = _jt[i]
    if names == nil then return nil end
    if type(j) == "number" then
      if j >= 0 and j < #names then return math.floor(j) end
      return nil
    end
    local map = _jidx[names]
    if map == nil then
      map = {}
      for k, n in ipairs(names) do if map[n] == nil then map[n] = k - 1 end end
      _jidx[names] = map
    end
    return map[j]
  end
  cartbox.joints = function(o)
    local i = _obj(o)
    local out = {}
    for k, n in ipairs((i and _jt[i]) or {}) do out[k] = n end
    return out
  end
  cartbox.ik = function(o, joint, x, y, z, weight, px, py, pz)
    local i = _obj(o)
    local j = i and _joint(i, joint)
    if j == nil then return end
    if px ~= nil then _cmd(${PHYS_OP_IK_POLE}, i, j, px, py or 0, pz or 0) end
    _cmd(${PHYS_OP_IK}, i, j, x or 0, y or 0, z or 0, weight or 1)
  end
  cartbox.lookat = function(o, joint, x, y, z, weight, maxdeg)
    local i = _obj(o)
    local j = i and _joint(i, joint)
    if j ~= nil then _cmd(${PHYS_OP_LOOKAT}, i, j, x or 0, y or 0, z or 0, weight or 1, maxdeg or 60) end
  end
  cartbox.ragdoll = function(o, ix, iy, iz, joint)
    local i = _obj(o)
    if i == nil or _jt[i] == nil then return end
    local j = (joint ~= nil and _joint(i, joint)) or -1
    _cmd(${PHYS_OP_RAGDOLL}, i, 1, ix or 0, iy or 0, iz or 0, j)
  end
  cartbox.unragdoll = function(o)
    local i = _obj(o)
    if i ~= nil and _jt[i] ~= nil then _cmd(${PHYS_OP_RAGDOLL}, i, 0) end
  end
  local _watching = {}
  cartbox.joint = function(o, joint)
    local i = _obj(o)
    local j = i and _joint(i, joint)
    if j == nil or not _live() then return nil end
    local key = i * 1024 + j
    if not _watching[key] then
      _watching[key] = true
      _cmd(${PHYS_OP_WATCH}, i, j)
    end
    local n = _rd(_B + ${PHYS_JOINTS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_JOINTS + 4} + k * ${PHYS_JOINT_BYTES}
      if _rd(at) == i and _rd(at + 4) == j then
        return _rd(at + 8) / ${PHYS_FIX}, _rd(at + 12) / ${PHYS_FIX}, _rd(at + 16) / ${PHYS_FIX}
      end
    end
    return nil
  end
  local _sm = {${machines.join(",")}}
  cartbox.set = function(o, name, value)
    local i = _obj(o)
    local m = i and _sm[i]
    local k = m and m.p[name]
    if k == nil then return end
    if value == true then value = 1 elseif value == false or value == nil then value = 0 end
    _cmd(${PHYS_OP_ANIM_SET}, i, k, value)
  end
  cartbox.trigger = function(o, name)
    local i = _obj(o)
    local m = i and _sm[i]
    local k = m and m.p[name]
    if k ~= nil then _cmd(${PHYS_OP_ANIM_TRIGGER}, i, k) end
  end
  cartbox.setstate = function(o, name, fade)
    local i = _obj(o)
    local m = i and _sm[i]
    if m == nil then return end
    for k, n in ipairs(m.s) do
      if n == name then
        _loops[i] = nil
        _cmd(${PHYS_OP_ANIM_GOTO}, i, k - 1, fade or 0.2)
        return
      end
    end
  end
  cartbox.state = function(o)
    local i = _obj(o)
    local m = i and _sm[i]
    if m == nil or not _live() then return nil end
    local n = _rd(_B + ${PHYS_ANIMS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_ANIMS + 4} + k * ${PHYS_ANIM_BYTES}
      if _rd(at) == i then
        local st = _rd(at + 12)
        if st < 0 then return nil end
        return m.s[st + 1]
      end
    end
    return nil
  end
  cartbox.events = function(o)
    local i = _obj(o)
    local m = i and _sm[i]
    local out = {}
    if m == nil or not _live() then return out end
    local n = _rd(_B + ${PHYS_ANIM_EVENTS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_ANIM_EVENTS + 4} + k * ${PHYS_ANIM_EVENT_BYTES}
      if _rd(at) == i then out[#out + 1] = m.e[_rd(at + 4) + 1] end
    end
    return out
  end
`;
}
var physicsSdkLua = runtimeSdkLua;

// src/runtime/runtimeChannel.ts
import {
  composeModelMatrix as composeModelMatrix3,
  invertAffine,
  jointPosition,
  multiplyMat4 as multiplyMat42,
  Ragdoll,
  ragdollRadii,
  solveLookAt,
  solveTwoBoneIK
} from "@cartbox/editor";

// src/nav/agentCrowd.ts
import { NavGraph } from "@cartbox/editor";
var GRAVITY = 22;
var REACH = 0.18;
var OFF_ROUTE = 1.2;
var BODY_HEIGHT = 1.6;
var AgentCrowd = class {
  constructor(mesh) {
    this.agents = /* @__PURE__ */ new Map();
    this.graph = new NavGraph(mesh);
  }
  /** Place an agent (creating it): a walker, or an obstacle the cart moves. */
  place(key, pos, speed, radius, obstacle) {
    const existing = this.agents.get(key);
    const a = existing ?? {
      key,
      pos: [0, 0, 0],
      radius,
      speed,
      obstacle,
      goal: null,
      path: [],
      drops: [],
      corner: 0,
      repath: 0,
      facing: 0,
      vy: 0,
      air: false,
      landY: null,
      moving: false,
      noPath: false
    };
    a.radius = Math.max(0.05, radius);
    if (speed > 0) a.speed = speed;
    a.obstacle = obstacle;
    a.pos = obstacle ? [...pos] : this.settle(pos);
    a.vy = 0;
    a.air = false;
    if (!obstacle && existing) {
      a.path = [];
      a.repath = 0;
    }
    this.agents.set(key, a);
  }
  /** Send an agent toward a point (speed > 0 changes its speed). */
  goto(key, goal, speed = 0) {
    const a = this.agents.get(key);
    if (!a || a.obstacle) return;
    if (speed > 0) a.speed = speed;
    const moved = !a.goal || Math.hypot(goal[0] - a.goal[0], goal[1] - a.goal[1], goal[2] - a.goal[2]) > 0.75;
    a.goal = [...goal];
    if (moved) {
      a.repath = 0;
      a.path = [];
    }
  }
  stop(key) {
    const a = this.agents.get(key);
    if (!a) return;
    a.goal = null;
    a.path = [];
    a.noPath = false;
  }
  remove(key) {
    this.agents.delete(key);
  }
  /** Stand a point on the floor beneath it (or the nearest floor), unchanged when there's none. */
  settle(pos) {
    const g = this.graph;
    let f2 = g.floorAt(pos[0], pos[1] + 0.25, pos[2]);
    if (f2 < 0) f2 = g.nearest(pos[0], pos[1], pos[2], 2);
    if (f2 < 0) return [...pos];
    const fy = g.mesh.heights[f2];
    if (g.floorAt(pos[0], pos[1] + 0.25, pos[2]) === f2) return [pos[0], fy, pos[2]];
    return g.position(f2);
  }
  /** Advance every agent by `dt` seconds. */
  step(dt) {
    const list = [...this.agents.values()].sort((a, b) => a.key - b.key);
    const g = this.graph;
    const climb = g.mesh.agent.climb;
    const want = /* @__PURE__ */ new Map();
    for (const a of list) {
      if (a.obstacle) continue;
      let vx = 0;
      let vz = 0;
      if (a.goal) {
        if (a.repath > 0) a.repath -= 1;
        if (a.path.length === 0 && a.repath === 0) {
          const route = g.findRoute(a.pos, a.goal);
          a.noPath = route === null;
          a.path = route?.points ?? [];
          a.drops = route?.drop ?? [];
          a.corner = 1;
          a.repath = 30;
        }
        while (a.corner < a.path.length) {
          const c = a.path[a.corner];
          if (Math.hypot(c[0] - a.pos[0], c[2] - a.pos[2]) > REACH) break;
          if (a.drops[a.corner]) a.landY = c[1];
          a.corner += 1;
        }
        if (a.corner < a.path.length) {
          const c = a.path[a.corner];
          const dx = c[0] - a.pos[0];
          const dz = c[2] - a.pos[2];
          const d = Math.hypot(dx, dz);
          const s = Math.min(a.speed * dt, d);
          vx = dx / d * s;
          vz = dz / d * s;
        } else if (a.path.length > 0) {
          a.goal = null;
          a.path = [];
        }
      }
      want.set(a.key, [vx, 0, vz]);
    }
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.obstacle && b.obstacle) continue;
        if (Math.abs(a.pos[1] - b.pos[1]) > BODY_HEIGHT) continue;
        let dx = a.pos[0] - b.pos[0];
        let dz = a.pos[2] - b.pos[2];
        let d = Math.hypot(dx, dz);
        const overlap = a.radius + b.radius - d;
        if (overlap <= 0) continue;
        if (d < 1e-6) {
          dx = 1;
          dz = 0;
          d = 1;
        }
        const ux = dx / d;
        const uz = dz / d;
        const share = a.obstacle ? 0 : b.obstacle ? 1 : 0.5;
        const wa = want.get(a.key);
        const wb = want.get(b.key);
        if (wa) {
          wa[0] += ux * overlap * share;
          wa[2] += uz * overlap * share;
        }
        if (wb) {
          wb[0] -= ux * overlap * (1 - share);
          wb[2] -= uz * overlap * (1 - share);
        }
      }
    }
    for (const a of list) {
      if (a.obstacle) continue;
      const v = want.get(a.key);
      const before = [...a.pos];
      this.move(a, v[0], v[2], dt, climb);
      const mx = a.pos[0] - before[0];
      const mz = a.pos[2] - before[2];
      const dist = Math.hypot(mx, mz);
      a.moving = dist > a.speed * dt * 0.2;
      if (a.moving) {
        const target = Math.atan2(mx, mz);
        let delta = target - a.facing;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        a.facing += delta * 0.35;
      }
      if (a.goal && a.corner < a.path.length && a.path.length > 1) {
        const p = a.path[a.corner - 1] ?? a.path[0];
        const c = a.path[a.corner];
        if (distanceToSegment(a.pos, p, c) > OFF_ROUTE && a.repath === 0) a.path = [];
      }
    }
  }
  /** Move one agent by (dx, dz), sliding along edges, stepping and falling as the floor allows. */
  move(a, dx, dz, dt, climb) {
    const g = this.graph;
    const tryTo = (x, z) => {
      const f2 = g.floorAt(x, a.pos[1], z, climb);
      if (f2 >= 0 && a.pos[1] - g.mesh.heights[f2] <= climb) {
        a.pos = [x, a.air ? a.pos[1] : g.mesh.heights[f2], z];
        return true;
      }
      if (a.drops[a.corner]) {
        a.pos = [x, a.pos[1], z];
        a.air = true;
        return true;
      }
      return false;
    };
    if (dx !== 0 || dz !== 0) {
      if (!tryTo(a.pos[0] + dx, a.pos[2] + dz)) {
        if (!tryTo(a.pos[0] + dx, a.pos[2])) tryTo(a.pos[0], a.pos[2] + dz);
      }
    }
    const floor = g.floorAt(a.pos[0], a.pos[1], a.pos[2], climb);
    if (floor < 0 && a.air && a.landY === null) return;
    const ledge = a.path[a.corner - 1];
    if (a.drops[a.corner] && ledge && a.pos[1] >= ledge[1] - 1e-3) return;
    if (floor >= 0 && !a.air) a.landY = null;
    const fy = floor >= 0 ? g.mesh.heights[floor] : a.landY ?? -Infinity;
    if (a.air || a.pos[1] > fy + 1e-3) {
      a.vy -= GRAVITY * dt;
      a.pos[1] += a.vy * dt;
      a.air = true;
      if (a.pos[1] <= fy) {
        a.pos[1] = fy;
        a.vy = 0;
        a.air = false;
      }
      if (fy === -Infinity && a.pos[1] < -100) {
        a.pos = this.settle(a.pos);
        a.air = false;
        a.vy = 0;
      }
    }
  }
  /** Every agent as the cart reads it, in key order. */
  state() {
    return [...this.agents.values()].sort((a, b) => a.key - b.key).map((a) => ({
      key: a.key,
      position: a.pos,
      facing: a.facing,
      flags: (a.moving ? NAV_FLAG_MOVING : 0) | (a.air ? NAV_FLAG_AIR : 0) | (!a.goal ? NAV_FLAG_ARRIVED : 0) | (a.noPath ? NAV_FLAG_NO_PATH : 0) | (a.obstacle ? NAV_FLAG_OBSTACLE : 0)
    }));
  }
  /** One agent's current path corners (for inspection and tests). */
  path(key) {
    return this.agents.get(key)?.path ?? [];
  }
};
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[2] - (a[2] + dz * t));
}

// src/mesh/sceneColliders.ts
var transform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
];
function sceneColliders(scene) {
  const boxes = [...scene.ragdollColliders ?? []];
  for (const inst of scene.instances) {
    if (inst.physics?.body !== "static" || inst.physics.trigger || inst.pooled) continue;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const prim of inst.mesh.primitives)
      for (let i = 0; i < prim.positions.length; i += 3)
        for (let k = 0; k < 3; k += 1) {
          lo[k] = Math.min(lo[k], prim.positions[i + k]);
          hi[k] = Math.max(hi[k], prim.positions[i + k]);
        }
    if (!(lo[0] <= hi[0])) continue;
    const m = inst.model;
    const centre = transform(m, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]);
    const cols = [0, 1, 2].map((c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]);
    const lens = cols.map((c) => Math.hypot(c[0], c[1], c[2]) || 1);
    const axes = cols.map((c, i) => [c[0] / lens[i], c[1] / lens[i], c[2] / lens[i]]);
    boxes.push({
      center: centre,
      half: [(hi[0] - lo[0]) / 2 * lens[0], (hi[1] - lo[1]) / 2 * lens[1], (hi[2] - lo[2]) / 2 * lens[2]],
      axes: [axes[0], axes[1], axes[2]]
    });
  }
  return boxes;
}

// src/runtime/runtimeChannel.ts
var DEG = 180 / Math.PI;
var MAX_BURSTS_QUEUED = 64;
var transform2 = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
];
var RuntimeChannel = class {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    /** Spawned copies: root object index → the root's world matrix. */
    this.active = /* @__PURE__ */ new Map();
    /** Objects the cart put somewhere with cartbox.place (object → world matrix). */
    this.placed = /* @__PURE__ */ new Map();
    /** Each reserve root's objects (itself first, then its descendants). */
    this.copyObjects = /* @__PURE__ */ new Map();
    /** Standing IK / look-at requests: object → joint → request (IK before look-at). */
    this.requests = /* @__PURE__ */ new Map();
    /** A pole for the next IK request on (object, joint). */
    this.poles = /* @__PURE__ */ new Map();
    /** Levels: the current one, the one loading (-1), its progress, and a switch the cart asked for. */
    this.level = { current: -1, loading: -1, progress: 0 };
    this.levelRequest = -1;
    /** Where the cart asked spatial loading to centre (null = the camera). */
    this.focus = null;
    /** Particle bursts the cart fired since the renderer last took them. */
    this.bursts = [];
    /** Decals the cart laid since the renderer last took them. */
    this.decals = [];
    /** Debris the cart threw since the renderer last took it. */
    this.debris = [];
    this.sounds = [];
    /** Standing shield effects (cartbox.shield): object → flare, shimmer, camo. */
    this.shieldStates = /* @__PURE__ */ new Map();
    /**
     * Ragdolls (H9): object → the limp body, built from its pose the next time it
     * is skinned after cartbox.ragdoll (until then null, with the shove to give it).
     * Local and cosmetic: nothing here reaches the cart or the physics world.
     */
    this.ragdolls = /* @__PURE__ */ new Map();
    /** What ragdolls land on (the scene's static bodies and authored boxes), built on first use. */
    this.ragdollBoxes = null;
    /** Collision radii per skinned mesh. */
    this.radii = /* @__PURE__ */ new Map();
    /** Joints whose world position the cart asked for, and where they were when last skinned. */
    this.watched = /* @__PURE__ */ new Map();
    this.animation = sceneHasAnimation(scene) ? new AnimationSession(scene) : null;
    this.timeline = (scene.timelines?.length ?? 0) > 0 ? new TimelineSession(scene) : null;
    this.crowd = scene.navmesh ? new AgentCrowd(scene.navmesh) : null;
    if ((scene.levels?.length ?? 0) > 0) this.level.current = 0;
    scene.instances.forEach((inst, i) => {
      if (!inst.pooled) return;
      const list = this.copyObjects.get(inst.pooled.root) ?? [];
      if (inst.pooled.root === i) list.unshift(i);
      else list.push(i);
      this.copyObjects.set(inst.pooled.root, list);
    });
  }
  /** Write what the cart reads this tick (and the handshake word). */
  beforeTick(block) {
    if (this.physics) this.physics.beforeTick(block);
    else writePhysicsState(block, 0, [], []);
    writeAnimationState(block, this.animation?.state() ?? [], this.animation?.events() ?? []);
    writeTimelineState(block, this.timeline?.state() ?? { index: -1, time: 0, playing: false }, this.timeline?.events() ?? []);
    if (this.timeline) writeTimelineValues(block, this.timeline.valueNames(), this.timeline.values());
    writeLevelState(block, this.level);
    writeAgents(block, this.crowd?.state() ?? []);
    writeJointPositions(
      block,
      [...this.watched.values()].flatMap((w) => w.position ? [{ object: w.object, joint: w.joint, position: w.position }] : [])
    );
  }
  /**
   * Take the cart's commands: scene ops here, the rest to physics (which then
   * steps). `ring` is the overflow command ring on cores that have one (EP20):
   * its commands came after the block's.
   */
  afterTick(block, ring) {
    const commands = takePhysicsCommands(block);
    if (ring) commands.push(...takeRingCommands(ring));
    for (const cmd of commands) {
      if (cmd.op === PHYS_OP_SPAWN) this.spawn(cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_DESPAWN) this.despawn(cmd.a);
      else if (cmd.op === PHYS_OP_PLAY) {
        const [clip, fade, speed, loop, start] = cmd.v;
        this.animation?.play(cmd.a, Math.round(clip), fade, speed, loop >= 0.5, start);
      } else if (cmd.op === PHYS_OP_ANIM_SET) this.animation?.setParam(cmd.a, Math.round(cmd.v[0]), cmd.v[1]);
      else if (cmd.op === PHYS_OP_ANIM_TRIGGER) this.animation?.setParam(cmd.a, Math.round(cmd.v[0]), 1);
      else if (cmd.op === PHYS_OP_ANIM_GOTO) this.animation?.goto(cmd.a, Math.round(cmd.v[0]), cmd.v[1]);
      else if (cmd.op === PHYS_OP_IK_POLE) this.poles.set(`${cmd.a}:${Math.round(cmd.v[0])}`, [cmd.v[1], cmd.v[2], cmd.v[3]]);
      else if (cmd.op === PHYS_OP_IK || cmd.op === PHYS_OP_LOOKAT) this.request(cmd.op, cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_WATCH) this.watch(cmd.a, Math.round(cmd.v[0]));
      else if (cmd.op === PHYS_OP_LEVEL) {
        const n = this.scene.levels?.length ?? 0;
        if (cmd.a >= 0 && cmd.a < n && cmd.a !== this.level.current && cmd.a !== this.level.loading) this.levelRequest = cmd.a;
      } else if (cmd.op >= PHYS_OP_AGENT && cmd.op <= PHYS_OP_AGENT_REMOVE) this.agentCommand(cmd.op, cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_STREAM_FOCUS) this.focus = cmd.a === 1 ? [cmd.v[0], cmd.v[1], cmd.v[2]] : null;
      else if (cmd.op === PHYS_OP_BURST) {
        if (this.bursts.length < MAX_BURSTS_QUEUED)
          this.bursts.push({ effect: cmd.a & 255, at: [cmd.v[0], cmd.v[1], cmd.v[2]], dir: [cmd.v[3], cmd.v[4], cmd.v[5]], scale: (cmd.a >>> 8 & 65535) / 16 });
      } else if (cmd.op === PHYS_OP_DECAL) {
        if (this.decals.length < MAX_BURSTS_QUEUED)
          this.decals.push({ decal: cmd.a & 255, at: [cmd.v[0], cmd.v[1], cmd.v[2]], normal: [cmd.v[3], cmd.v[4], cmd.v[5]], scale: (cmd.a >>> 8 & 65535) / 16 });
      } else if (cmd.op === PHYS_OP_RAGDOLL) this.ragdollCommand(cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_SHIELD) this.shieldCommand(cmd.a, cmd.v);
      else if (cmd.op === PHYS_OP_SOUND) {
        if (this.sounds.length < MAX_BURSTS_QUEUED) {
          const v = cmd.v;
          this.sounds.push({ kind: "play", sound: cmd.a & 255, volume: (cmd.a >>> 8 & 65535) / 64, pitch: v[3] > 0 ? v[3] : 1, at: v[4] >= 0.5 ? [v[0], v[1], v[2]] : null });
        }
      } else if (cmd.op === PHYS_OP_SOUND_LOOP) {
        const v = cmd.v;
        this.sounds.push({ kind: "loop", slot: cmd.a & 255, sound: (cmd.a >>> 8 & 65535) - 1, volume: v[0], at: v[4] >= 0.5 ? [v[1], v[2], v[3]] : null });
      } else if (cmd.op === PHYS_OP_MIX) this.sounds.push({ kind: "mix", bus: cmd.a, volume: cmd.v[0] });
      else if (cmd.op === PHYS_OP_PLACE) {
        const object = cmd.a & 65535;
        const s = (cmd.a >>> 16 & 32767) / 256;
        const [x, y, z, yaw, pitch, roll] = cmd.v;
        if (object < this.scene.instances.length) this.placed.set(object, composeModelMatrix3([x, y, z], [pitch * DEG, yaw * DEG, roll * DEG], [s, s, s]));
      } else if (cmd.op === PHYS_OP_UNPLACE) this.placed.delete(cmd.a);
      else if (cmd.op === PHYS_OP_DEBRIS) {
        if (this.debris.length < MAX_BURSTS_QUEUED)
          this.debris.push({ debris: cmd.a & 255, at: [cmd.v[0], cmd.v[1], cmd.v[2]], velocity: [cmd.v[3], cmd.v[4], cmd.v[5]], scale: (cmd.a >>> 8 & 65535) / 16 });
      } else if (cmd.op === PHYS_OP_TIMELINE) {
        if (cmd.a < 0) this.timeline?.stop();
        else this.timeline?.play(cmd.a, cmd.v[0], cmd.v[1]);
      }
    }
    for (const { object, cue } of this.timeline?.step(PHYSICS_DT) ?? []) this.cue(object, cue.clip, cue.fade, cue.loop);
    this.physics?.run(commands.filter((c) => c.op < PHYS_OP_SPAWN || c.op > PHYS_OP_DESPAWN && c.op < PHYS_OP_PLAY));
    this.animation?.step(PHYSICS_DT);
    this.crowd?.step(PHYSICS_DT);
    if (this.ragdolls.size > 0) {
      const boxes = this.colliders();
      let awake = false;
      for (const r of this.ragdolls.values()) if (r.doll ? r.doll.step(PHYSICS_DT, boxes) : true) awake = true;
      if (awake) this.animation?.invalidate();
    }
  }
  /** Go limp (v0 = 1) with a shove, or take the animation back (v0 = 0). */
  ragdollCommand(object, v) {
    const inst = this.scene.instances[object];
    if (!inst?.mesh.skin) return;
    if (v[0] >= 0.5) this.ragdolls.set(object, { doll: null, impulse: [v[1], v[2], v[3]], joint: Math.round(v[4]) });
    else this.ragdolls.delete(object);
    this.animation?.invalidate();
  }
  /** Set (or, with all three 0, clear) an object's shield effect. */
  shieldCommand(object, v) {
    if (!this.scene.instances[object]) return;
    const unit = (x) => Math.max(0, Math.min(1, x ?? 0));
    const state = { flare: unit(v[0]), shimmer: unit(v[1]), camo: unit(v[2]) };
    if (state.flare === 0 && state.shimmer === 0 && state.camo === 0) this.shieldStates.delete(object);
    else this.shieldStates.set(object, state);
  }
  /** The standing shield effects (object → state); the renderer draws them on the object and everything under it. */
  shields() {
    return this.shieldStates;
  }
  /** Whether an object is a ragdoll now. */
  isRagdoll(object) {
    return this.ragdolls.has(object);
  }
  /** The boxes ragdolls collide with (see sceneColliders), built on first use. */
  colliders() {
    this.ragdollBoxes ?? (this.ragdollBoxes = sceneColliders(this.scene));
    return this.ragdollBoxes;
  }
  /** A navigation agent command (see PHYS_OP_AGENT). */
  agentCommand(op, key, v) {
    const crowd = this.crowd;
    if (!crowd || key < 0 || key > 1023) return;
    const at = [v[0], v[1], v[2]];
    if (op === PHYS_OP_AGENT) {
      if (crowd.state().length >= PHYS_MAX_AGENTS && !crowd.state().some((a) => a.key === key)) return;
      crowd.place(key, at, v[3] > 0 ? v[3] : 3, v[4] > 0 ? v[4] : crowd.graph.mesh.agent.radius, v[5] >= 0.5);
    } else if (op === PHYS_OP_AGENT_GOTO) crowd.goto(key, at, v[3]);
    else if (op === PHYS_OP_AGENT_STOP) crowd.stop(key);
    else crowd.remove(key);
  }
  /** A level switch the cart asked for since the last call (-1 for none); the player loads and activates it. */
  takeLevelRequest() {
    const request = this.levelRequest;
    this.levelRequest = -1;
    return request;
  }
  /** The level loading, and how far along (0..1), as the cart reads it. */
  setLevelLoading(level, progress) {
    this.level = { ...this.level, loading: level, progress };
  }
  /** Make `level` the current one (the loading state clears). */
  setLevel(level) {
    this.level = { current: level, loading: -1, progress: 0 };
  }
  /** The decals laid since the last call (the renderer draws them). */
  takeDecals() {
    const out = this.decals;
    this.decals = [];
    return out;
  }
  /** The debris thrown since the last call (the renderer simulates and draws it). */
  takeDebris() {
    const out = this.debris;
    this.debris = [];
    return out;
  }
  /** The sound commands since the last call (the sound system plays them). */
  takeSounds() {
    const out = this.sounds;
    this.sounds = [];
    return out;
  }
  /** The particle bursts fired since the last call (the renderer draws them). */
  takeBursts() {
    const out = this.bursts;
    this.bursts = [];
    return out;
  }
  /** Where the cart asked spatial loading to centre, or null for the camera. */
  streamFocus() {
    return this.focus;
  }
  /** The current level (-1 when the scene has none). */
  currentLevel() {
    return this.level.current;
  }
  /**
   * Skinning matrices for the animated objects being drawn (object → matrices);
   * reserve prefab copies not spawned are skipped. IK and look-at requests are
   * applied first, their world-space targets taken into each object's space with
   * `worldOf` (its world matrix this frame; by default its physics body, spawn
   * placement or authored placement).
   */
  skinning(worldOf = (o) => this.defaultWorld(o)) {
    if (!this.animation) return /* @__PURE__ */ new Map();
    const matrices = this.animation.matrices(
      (object) => {
        const pooled = this.scene.instances[object]?.pooled;
        return !pooled || this.active.has(pooled.root);
      },
      (object, mesh, pose) => this.solve(object, mesh, pose, worldOf)
    );
    for (const w of this.watched.values()) {
      const pose = this.animation.finalPose(w.object);
      const mesh = this.scene.instances[w.object]?.mesh;
      const world = worldOf(w.object);
      if (pose && mesh?.skin && world) w.position = transform2(world, jointPosition(mesh.skin, pose, w.joint));
    }
    return matrices;
  }
  /** Start a timeline cue on an object: a state of its state machine by that name, else a clip. */
  cue(object, name, fade, loop) {
    const inst = this.scene.instances[object];
    if (!inst || !this.animation) return;
    const state = inst.animator?.states.findIndex((s) => s.name === name) ?? -1;
    if (state >= 0) {
      this.animation.goto(object, state, fade);
      return;
    }
    const clip = inst.mesh.clips?.findIndex((c) => c.name === name) ?? -1;
    if (clip >= 0) this.animation.play(object, clip, fade, 1, loop);
  }
  /**
   * The camera a playing (or holding) timeline sets, as a mesh-camera override
   * (orbit about the scene centre, reproducing its eye and target), or null.
   */
  timelineCamera(hud = false) {
    const cam = this.timeline?.camera();
    if (!cam) return null;
    const c = this.scene.bounds.center;
    const dx = cam.eye[0] - cam.target[0];
    const dy = cam.eye[1] - cam.target[1];
    const dz = cam.eye[2] - cam.target[2];
    const distance = Math.max(1e-3, Math.hypot(dx, dy, dz));
    return {
      yaw: Math.atan2(dx, dz),
      pitch: Math.asin(Math.max(-1, Math.min(1, dy / distance))),
      distance,
      target: [cam.target[0] - c[0], cam.target[1] - c[1], cam.target[2] - c[2]],
      fov: cam.fov * Math.PI / 180,
      hud
    };
  }
  /** World matrices of the objects a timeline is placing (object index → matrix). */
  /** Where the cart has put objects with cartbox.place (object → world matrix). */
  placements() {
    return this.placed;
  }
  /** The playing timeline's value tracks now (EP17: name → value). */
  timelineValues() {
    return this.timeline?.values() ?? /* @__PURE__ */ new Map();
  }
  timelinePlacements() {
    return this.timeline?.placements() ?? /* @__PURE__ */ new Map();
  }
  /** Whether IK, look-at, joint watching or a ragdoll needs the objects' current world matrices. */
  needsWorld() {
    return this.requests.size > 0 || this.watched.size > 0 || this.ragdolls.size > 0;
  }
  defaultWorld(object) {
    const inst = this.scene.instances[object];
    if (!inst) return null;
    const body = this.physics?.overrides().get(object);
    if (body) return body;
    if (inst.pooled) {
      const root = this.active.get(inst.pooled.root);
      if (!root) return null;
      if (inst.pooled.root === object) return root;
      const chain = [];
      for (let i = object; i !== inst.pooled.root && i >= 0; i = this.scene.instances[i].parent) chain.unshift(this.scene.instances[i].local);
      return chain.reduce((m, local) => multiplyMat42(m, local), root);
    }
    return inst.model;
  }
  request(op, object, v) {
    const inst = this.scene.instances[object];
    const joints = inst?.mesh.skin?.joints.length ?? 0;
    const joint = Math.round(v[0]);
    if (!inst || joint < 0 || joint >= joints) return;
    const byJoint = this.requests.get(object) ?? /* @__PURE__ */ new Map();
    const weight = Math.max(0, Math.min(1, v[4]));
    const poleKey = `${object}:${joint}`;
    if (weight <= 0) byJoint.delete(joint);
    else
      byJoint.set(joint, {
        kind: op === PHYS_OP_IK ? "ik" : "look",
        target: [v[1], v[2], v[3]],
        pole: op === PHYS_OP_IK ? this.poles.get(poleKey) ?? null : null,
        weight,
        max: op === PHYS_OP_LOOKAT ? Math.max(0, Math.min(180, v[5] > 0 ? v[5] : 60)) * Math.PI / 180 : 0
      });
    this.poles.delete(poleKey);
    if (byJoint.size > 0) this.requests.set(object, byJoint);
    else this.requests.delete(object);
    this.animation?.invalidate();
  }
  watch(object, joint) {
    const key = `${object}:${joint}`;
    const joints = this.scene.instances[object]?.mesh.skin?.joints.length ?? 0;
    if (this.watched.has(key) || joint < 0 || joint >= joints || this.watched.size >= PHYS_MAX_JOINTS) return;
    this.watched.set(key, { object, joint, position: null });
  }
  /** Apply an object's standing IK (first) and look-at requests to its pose, then a ragdoll over it all. */
  solve(object, mesh, pose, worldOf) {
    const requests = this.requests.get(object);
    const skin = mesh.skin;
    const rag = this.ragdolls.get(object);
    if (!requests && !rag || !skin) return;
    const world = worldOf(object);
    if (!world) return;
    if (requests) this.solveRequests(requests, skin, pose, world);
    if (rag) {
      if (!rag.doll) {
        if (!this.radii.has(mesh)) this.radii.set(mesh, ragdollRadii(mesh));
        rag.doll = new Ragdoll(skin, pose, world, { impulse: rag.impulse, joint: rag.joint, radii: this.radii.get(mesh) ?? void 0 });
      }
      rag.doll.writePose(pose, world);
    }
  }
  solveRequests(requests, skin, pose, world) {
    const toMesh = invertAffine(world);
    if (!toMesh) return;
    const local = (p) => transform2(toMesh, p);
    for (const kind of ["ik", "look"]) {
      for (const [joint, r] of requests) {
        if (r.kind !== kind) continue;
        if (kind === "ik") solveTwoBoneIK(skin, pose, joint, local(r.target), r.pole ? local(r.pole) : null, r.weight);
        else solveLookAt(skin, pose, joint, local(r.target), r.weight, r.max);
      }
    }
  }
  /** Spawned copies' root world matrices (root object index → matrix). */
  spawned() {
    return this.active;
  }
  spawn(root, v) {
    const objects = this.copyObjects.get(root);
    if (!objects) return;
    const [x, y, z, yaw, pitch, roll] = v;
    const world = composeModelMatrix3([x, y, z], [pitch * DEG, yaw * DEG, roll * DEG], [1, 1, 1]);
    this.active.set(root, world);
    for (const object of objects) {
      this.animation?.reset(object);
      this.ragdolls.delete(object);
      this.shieldStates.delete(object);
    }
    const placed = /* @__PURE__ */ new Map([[root, world]]);
    const worldOf = (i) => {
      const known = placed.get(i);
      if (known) return known;
      const inst = this.scene.instances[i];
      if (!inst || inst.parent < 0) return null;
      const parent = worldOf(inst.parent);
      if (!parent) return null;
      const m = multiplyMat42(parent, inst.local);
      placed.set(i, m);
      return m;
    };
    this.physics?.setCopyActive(objects, worldOf, true);
  }
  despawn(root) {
    const objects = this.copyObjects.get(root);
    if (!objects || !this.active.has(root)) return;
    this.active.delete(root);
    for (const object of objects) {
      this.ragdolls.delete(object);
      this.shieldStates.delete(object);
    }
    this.physics?.setCopyActive(objects, () => null, false);
  }
  destroy() {
    this.physics?.destroy();
  }
};

// src/collisionSdk.ts
function parseCollisionField(value) {
  if (typeof value !== "object" || value === null) return null;
  const data = value;
  if (typeof data.width !== "number" || typeof data.height !== "number") return null;
  if (typeof data.bits !== "string") return null;
  if (data.width <= 0 || data.height <= 0 || !Number.isFinite(data.width) || !Number.isFinite(data.height)) {
    return null;
  }
  return { width: Math.floor(data.width), height: Math.floor(data.height), bits: data.bits };
}
function collisionSdkLua(collision) {
  const field = parseCollisionField(collision);
  if (!field || field.bits.length === 0) return "";
  const width = field.width;
  const height = field.height;
  return `do
  local _cw, _ch = ${width}, ${height}
  local function _b64(s)
    local _T = {}
    local _A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for i = 1, #_A do _T[string.byte(_A, i)] = i - 1 end
    local out, acc, bits = {}, 0, 0
    for i = 1, #s do
      local v = _T[string.byte(s, i)]
      if v then
        acc = (acc << 6) | v
        bits = bits + 6
        if bits >= 8 then
          bits = bits - 8
          out[#out + 1] = string.char((acc >> bits) & 0xff)
          acc = acc & ((1 << bits) - 1)
        end
      end
    end
    return table.concat(out)
  end
  local _cb = _b64("${field.bits}")
  cartbox = cartbox or {}
  cartbox.mapsize = function() return _cw, _ch end
  cartbox.solid = function(x, y)
    x = math.floor(x or 0)
    y = math.floor(y or 0)
    if x < 0 or x >= _cw or y < 0 or y >= _ch then return false end
    local cell = y * _cw + x
    local byte = string.byte(_cb, (cell >> 3) + 1) or 0
    return (byte & (1 << (cell & 7))) ~= 0
  end
end`;
}

// src/debug/profiler.ts
var PROFILE_SECTIONS = ["cart", "runtime", "audio", "net", "render", "shadow", "sky", "scene"];
var PROFILE_WINDOW = 60;
var SUB_PASSES = /* @__PURE__ */ new Set(["shadow", "sky", "scene"]);
var Profiler = class {
  constructor() {
    this.samples = new Map(PROFILE_SECTIONS.map((s) => [s, new Float64Array(PROFILE_WINDOW)]));
    /** The slot being filled (the open frame). */
    this.slot = 0;
    this.filled = 0;
    /** A frame has been opened (the first nextFrame opens one, closing nothing). */
    this.open = false;
  }
  /** Add `ms` to the open frame's `section`. */
  add(section, ms) {
    const row = this.samples.get(section);
    row[this.slot] = row[this.slot] + ms;
  }
  /** Close the open frame and start the next. */
  nextFrame() {
    this.slot = (this.slot + 1) % PROFILE_WINDOW;
    for (const row of this.samples.values()) row[this.slot] = 0;
    if (this.open) this.filled = Math.min(PROFILE_WINDOW - 1, this.filled + 1);
    this.open = true;
  }
  /** Averages and peaks over the closed frames in the window. */
  sections() {
    const frames = this.filled;
    const sections = {};
    const totals = new Float64Array(PROFILE_WINDOW);
    for (const section of PROFILE_SECTIONS) {
      const row = this.samples.get(section);
      let sum2 = 0;
      let max2 = 0;
      for (let k = 1; k <= frames; k += 1) {
        const i = (this.slot - k + PROFILE_WINDOW) % PROFILE_WINDOW;
        const v = row[i];
        sum2 += v;
        if (v > max2) max2 = v;
        if (!SUB_PASSES.has(section)) totals[i] = totals[i] + v;
      }
      sections[section] = { avg: frames > 0 ? sum2 / frames : 0, max: max2 };
    }
    let sum = 0;
    let max = 0;
    for (let k = 1; k <= frames; k += 1) {
      const v = totals[(this.slot - k + PROFILE_WINDOW) % PROFILE_WINDOW];
      sum += v;
      if (v > max) max = v;
    }
    return { frames, sections, total: { avg: frames > 0 ? sum / frames : 0, max } };
  }
  reset() {
    for (const row of this.samples.values()) row.fill(0);
    this.slot = 0;
    this.filled = 0;
    this.open = false;
  }
};
function estimateSceneBytes(instances, width, height) {
  const meshes = /* @__PURE__ */ new Set();
  const textures = /* @__PURE__ */ new Set();
  let bytes = width * height * 8;
  for (const instance of instances) {
    if (!meshes.has(instance.mesh)) {
      meshes.add(instance.mesh);
      for (const p of instance.mesh.primitives) bytes += p.positions.length / 3 * 32 + p.indices.length * 4;
    }
    for (const texture of instance.textures ?? []) {
      if (texture && !textures.has(texture)) {
        textures.add(texture);
        bytes += texture.width * texture.height * 4;
      }
    }
  }
  return bytes;
}

// src/flagsSdk.ts
function parseFlagsField(value) {
  if (typeof value !== "object" || value === null) return null;
  const data = value;
  if (typeof data.width !== "number" || typeof data.height !== "number") return null;
  if (typeof data.bytes !== "string") return null;
  if (data.width <= 0 || data.height <= 0 || !Number.isFinite(data.width) || !Number.isFinite(data.height)) {
    return null;
  }
  return { width: Math.floor(data.width), height: Math.floor(data.height), bytes: data.bytes };
}
function flagsSdkLua(flags) {
  const field = parseFlagsField(flags);
  if (!field || field.bytes.length === 0) return "";
  const width = field.width;
  const height = field.height;
  return `do
  local _fw, _fh = ${width}, ${height}
  local function _b64(s)
    local _T = {}
    local _A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    for i = 1, #_A do _T[string.byte(_A, i)] = i - 1 end
    local out, acc, bits = {}, 0, 0
    for i = 1, #s do
      local v = _T[string.byte(s, i)]
      if v then
        acc = (acc << 6) | v
        bits = bits + 6
        if bits >= 8 then
          bits = bits - 8
          out[#out + 1] = string.char((acc >> bits) & 0xff)
          acc = acc & ((1 << bits) - 1)
        end
      end
    end
    return table.concat(out)
  end
  local _fb = _b64("${field.bytes}")
  cartbox = cartbox or {}
  cartbox.flag = function(x, y, n)
    x = math.floor(x or 0)
    y = math.floor(y or 0)
    n = math.floor(n or 0)
    if x < 0 or x >= _fw or y < 0 or y >= _fh or n < 0 or n > 7 then return false end
    local byte = string.byte(_fb, y * _fw + x + 1) or 0
    return ((byte >> n) & 1) ~= 0
  end
end`;
}

// src/anim/animClipsSdk.ts
function flattenClip(clip) {
  const base = clip.frames.map((frame, i) => ({
    tile: frame.tile,
    w: Math.max(1, frame.tilesW),
    h: Math.max(1, frame.tilesH),
    duration: Math.max(1, Math.floor(clip.durations[i] ?? 1))
  }));
  if (clip.mode === "pingpong" && base.length > 2) {
    const reverse = base.slice(1, -1).reverse();
    return { frames: [...base, ...reverse], once: false };
  }
  return { frames: base, once: clip.mode === "once" };
}
function buildClipTable(anim) {
  if (!anim || !Array.isArray(anim.clips)) return [];
  const table = [];
  for (const clip of anim.clips) {
    if (!clip || typeof clip.name !== "string" || clip.name.length === 0) continue;
    const { frames, once } = flattenClip(clip);
    if (frames.length === 0) continue;
    let total = 0;
    const cum = [];
    for (const frame of frames) {
      total += frame.duration;
      cum.push(total);
    }
    table.push({
      name: clip.name,
      total,
      once,
      tile: frames.map((f2) => f2.tile),
      w: frames.map((f2) => f2.w),
      h: frames.map((f2) => f2.h),
      cum
    });
  }
  return table;
}
function clipFrameIndex(entry, tick) {
  if (entry.total <= 0) return 1;
  let t = Math.max(0, Math.floor(tick));
  if (entry.once) {
    if (t >= entry.total) return entry.cum.length;
  } else {
    t = t % entry.total;
  }
  for (let i = 0; i < entry.cum.length; i += 1) {
    if (t < entry.cum[i]) return i + 1;
  }
  return entry.cum.length;
}
function luaString2(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
}
function animClipsSdkLua(anim) {
  const table = buildClipTable(anim);
  if (table.length === 0) return "";
  const entries = table.map(
    (entry) => `  ["${luaString2(entry.name)}"] = { total = ${entry.total}, once = ${entry.once}, tile = {${entry.tile.join(",")}}, w = {${entry.w.join(",")}}, h = {${entry.h.join(",")}}, cum = {${entry.cum.join(",")}} }`
  );
  return `do
  cartbox = cartbox or {}
  local _clips = {
${entries.join(",\n")}
  }
  -- The frame whose cumulative window contains tick t (0-based t < total).
  local function _frameAt(c, t)
    local cum = c.cum
    for i = 1, #cum do
      if t < cum[i] then return i end
    end
    return #cum
  end
  cartbox.clip = function(name, tick)
    local c = _clips[name]
    if not c or c.total <= 0 then return 0, 1, 1 end
    local t = math.floor(tick or 0)
    if t < 0 then t = 0 end
    if c.once then
      if t >= c.total then
        local n = #c.tile
        return c.tile[n], c.w[n], c.h[n]
      end
    else
      t = t % c.total
    end
    local i = _frameAt(c, t)
    return c.tile[i], c.w[i], c.h[i]
  end
end`;
}

// src/mailbox.ts
var MAILBOX_TYPE_ACHIEVEMENT = 1;
var MAILBOX_TYPE_SCORE = 2;
var MAILBOX_TYPE_PROGRESS = 3;
var MAILBOX_TYPE_REQUEST = 4;
var MAILBOX_WORDS = 137;
var EVENT_CAPACITY = 8;
var LIGHTS_BASE = 1 + EVENT_CAPACITY * 3;
var LIGHTS_CAPACITY = 6;
var LIGHT_STRIDE = 6;
var LIGHT_INTENSITY_SCALE = 256;
var CAMERA_BASE = LIGHTS_BASE + 1 + LIGHTS_CAPACITY * LIGHT_STRIDE;
var CAMERA_SCALE = 16;
var MESH_CAM_BASE = CAMERA_BASE + 2;
var MESH_CAM_STRIDE = 8;
var MESH_CAM_ANGLE_SCALE = 1024;
var MESH_CAM_DIST_SCALE = 256;
var MESH_CAM_ACTIVE = 1;
var MESH_CAM_HUD = 2;
var MESH_POSE_BASE = MESH_CAM_BASE + MESH_CAM_STRIDE;
var MESH_POSE_CAPACITY = 8;
var MESH_POSE_STRIDE = 8;
var MESH_POSE_HIDDEN = 1 << 8;
var MESH_POSE_FRAME_SHIFT = 9;
var MESH_POSE_FRAME_MASK = 127;
var MESH_POSE_TINT_SHIFT = 16;
var MESH_POSE_TINT_MASK = 15;
var MESH_POSE_FRONT = 1 << 20;
var LIGHT_KIND_POINT = 0;
var LIGHT_KIND_SPOT = 2;
var LIGHT_KIND_WORLD = 3;
var WORLD_LIGHT_SCALE = 64;
var LIGHT_DIR_SCALE = 127;
var LIGHT_CONE_SCALE = 63;
var KIND_BY_CODE = ["point", "directional", "spot"];
function signedByte(byte2) {
  return byte2 < 128 ? byte2 : byte2 - 256;
}
function kindOf(type) {
  switch (type) {
    case MAILBOX_TYPE_ACHIEVEMENT:
      return "achievement";
    case MAILBOX_TYPE_SCORE:
      return "score";
    case MAILBOX_TYPE_PROGRESS:
      return "progress";
    case MAILBOX_TYPE_REQUEST:
      return "request";
    default:
      return "unknown";
  }
}
function decodeMailbox(words, lastSeq) {
  const seq = words[0] ?? 0;
  const capacity = words.length > 0 ? EVENT_CAPACITY : 0;
  if (capacity === 0 || seq <= lastSeq) {
    return { events: [], seq };
  }
  const start = Math.max(lastSeq, seq - capacity);
  const events = [];
  for (let i = start; i < seq; i++) {
    const slot = i % capacity;
    const base = 1 + slot * 3;
    const type = words[base] ?? 0;
    events.push({
      type,
      kind: kindOf(type),
      id: words[base + 1] ?? 0,
      value: words[base + 2] ?? 0
    });
  }
  return { events, seq };
}
function decodeLights(words) {
  if (words.length <= LIGHTS_BASE) {
    return [];
  }
  const count = Math.min(words[LIGHTS_BASE] ?? 0, LIGHTS_CAPACITY);
  const lights = [];
  for (let i = 0; i < count; i++) {
    const base = LIGHTS_BASE + 1 + i * LIGHT_STRIDE;
    const packed = words[base + 4] ?? 16777215;
    const intensityWord = words[base + 5] ?? LIGHT_INTENSITY_SCALE;
    const intensity = (intensityWord & 65535) / LIGHT_INTENSITY_SCALE;
    const light = {
      x: words[base] ?? 0,
      y: words[base + 1] ?? 0,
      z: words[base + 2] ?? 0,
      radius: words[base + 3] ?? 0,
      color: [
        (packed >>> 16 & 255) / 255 * intensity,
        (packed >>> 8 & 255) / 255 * intensity,
        (packed & 255) / 255 * intensity
      ]
    };
    const kindCode = packed >>> 24 & 3;
    if (kindCode === LIGHT_KIND_WORLD) continue;
    if (kindCode !== LIGHT_KIND_POINT) {
      light.kind = KIND_BY_CODE[kindCode] ?? "point";
      const dirX = signedByte(intensityWord >>> 16 & 255) / LIGHT_DIR_SCALE;
      const dirY = signedByte(intensityWord >>> 24 & 255) / LIGHT_DIR_SCALE;
      const dirZ = Math.sqrt(Math.max(0, 1 - dirX * dirX - dirY * dirY));
      light.direction = [dirX, dirY, dirZ];
      if (kindCode === LIGHT_KIND_SPOT) {
        light.coneCos = (packed >>> 26 & 63) / LIGHT_CONE_SCALE;
      }
    }
    lights.push(light);
  }
  return lights;
}
function decodeWorldLights(words) {
  if (words.length <= LIGHTS_BASE) return [];
  const count = Math.min(words[LIGHTS_BASE] ?? 0, LIGHTS_CAPACITY);
  const out = [];
  for (let i = 0; i < count; i++) {
    const base = LIGHTS_BASE + 1 + i * LIGHT_STRIDE;
    const packed = words[base + 4] ?? 0;
    if ((packed >>> 24 & 3) !== LIGHT_KIND_WORLD) continue;
    const intensity = ((words[base + 5] ?? LIGHT_INTENSITY_SCALE) & 65535) / LIGHT_INTENSITY_SCALE;
    const signed = (k) => ((words[base + k] ?? 0) | 0) / WORLD_LIGHT_SCALE;
    out.push({
      position: [signed(0), signed(1), signed(2)],
      range: signed(3),
      color: [
        (packed >>> 16 & 255) / 255 * intensity,
        (packed >>> 8 & 255) / 255 * intensity,
        (packed & 255) / 255 * intensity
      ]
    });
  }
  return out;
}
function decodeCamera(words) {
  if (words.length <= CAMERA_BASE + 1) {
    return { x: 0, y: 0 };
  }
  return {
    x: ((words[CAMERA_BASE] ?? 0) | 0) / CAMERA_SCALE,
    y: ((words[CAMERA_BASE + 1] ?? 0) | 0) / CAMERA_SCALE
  };
}
function decodeMeshCamera(words) {
  if (words.length <= MESH_CAM_BASE + MESH_CAM_STRIDE - 1) {
    return null;
  }
  const flags = words[MESH_CAM_BASE] ?? 0;
  if ((flags & MESH_CAM_ACTIVE) === 0) {
    return null;
  }
  const angle = (word) => (word | 0) / MESH_CAM_ANGLE_SCALE;
  const dist = (word) => (word | 0) / MESH_CAM_DIST_SCALE;
  const distanceWord = words[MESH_CAM_BASE + 3] ?? 0;
  const fovWord = words[MESH_CAM_BASE + 7] ?? 0;
  return {
    yaw: angle(words[MESH_CAM_BASE + 1] ?? 0),
    pitch: angle(words[MESH_CAM_BASE + 2] ?? 0),
    distance: distanceWord > 0 ? dist(distanceWord) : null,
    target: [dist(words[MESH_CAM_BASE + 4] ?? 0), dist(words[MESH_CAM_BASE + 5] ?? 0), dist(words[MESH_CAM_BASE + 6] ?? 0)],
    fov: fovWord > 0 ? angle(fovWord) : null,
    hud: (flags & MESH_CAM_HUD) !== 0
  };
}
function decodeMeshPoses(words) {
  if (words.length <= MESH_POSE_BASE) {
    return [];
  }
  const count = Math.min(words[MESH_POSE_BASE] ?? 0, MESH_POSE_CAPACITY);
  const poses = [];
  for (let i = 0; i < count; i += 1) {
    const base = MESH_POSE_BASE + 1 + i * MESH_POSE_STRIDE;
    const indexWord = words[base] ?? 0;
    const pos = (word) => (word | 0) / MESH_CAM_DIST_SCALE;
    const angle = (word) => (word | 0) / MESH_CAM_ANGLE_SCALE;
    poses.push({
      index: indexWord & 255,
      hidden: (indexWord & MESH_POSE_HIDDEN) !== 0,
      frame: indexWord >>> MESH_POSE_FRAME_SHIFT & MESH_POSE_FRAME_MASK,
      tint: indexWord >>> MESH_POSE_TINT_SHIFT & MESH_POSE_TINT_MASK,
      front: (indexWord & MESH_POSE_FRONT) !== 0,
      position: [pos(words[base + 1] ?? 0), pos(words[base + 2] ?? 0), pos(words[base + 3] ?? 0)],
      rotation: [angle(words[base + 4] ?? 0), angle(words[base + 5] ?? 0), angle(words[base + 6] ?? 0)],
      scale: (words[base + 7] ?? 0) / MESH_CAM_DIST_SCALE
    });
  }
  return poses;
}
function hashEventId(id) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash ^ id.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

// src/scene/cartSpriteSource.ts
var TILE_SIZE = 8;
var PIXELS_PER_TILE = TILE_SIZE * TILE_SIZE;
var SHEET_COLS = 16;
function readPixel(heap, tileBase, pixelIndex, bits) {
  if (bits === 8) return heap[tileBase + pixelIndex] ?? 0;
  const byte2 = heap[tileBase + (pixelIndex >> 1)] ?? 0;
  return pixelIndex & 1 ? byte2 >> 4 & 15 : byte2 & 15;
}
function createCartSpriteSource(module, bytes, paletteSize) {
  if (typeof module._cbx_cart_create !== "function") return null;
  const cart = module._cbx_cart_create();
  if (!cart) return null;
  const ptr = module._malloc(bytes.byteLength);
  module.HEAPU8.set(bytes, ptr);
  module._cbx_cart_load(cart, ptr, bytes.byteLength);
  module._free(ptr);
  const bits = paletteSize <= 16 ? 4 : 8;
  const bytesPerTile = bits === 8 ? PIXELS_PER_TILE : PIXELS_PER_TILE / 2;
  const bank = 0;
  const tilesPtr = module._cbx_cart_tiles_ptr(cart, bank);
  const spritesPtr = module._cbx_cart_sprites_ptr(cart, bank);
  const palettePtr = module._cbx_cart_palette_ptr(cart, bank);
  const source = {
    readRegion(page, baseTile, tilesW, tilesH) {
      const width = tilesW * TILE_SIZE;
      const height = tilesH * TILE_SIZE;
      const pixels = new Uint8ClampedArray(width * height * 4);
      const heap = module.HEAPU8;
      const sheetBase = page === 0 ? tilesPtr : spritesPtr;
      for (let ty = 0; ty < tilesH; ty += 1) {
        for (let tx = 0; tx < tilesW; tx += 1) {
          const subTile = baseTile + ty * SHEET_COLS + tx;
          const tileBase = sheetBase + subTile * bytesPerTile;
          for (let y = 0; y < TILE_SIZE; y += 1) {
            for (let x = 0; x < TILE_SIZE; x += 1) {
              const idx = readPixel(heap, tileBase, y * TILE_SIZE + x, bits);
              if (idx === 0) continue;
              const o = ((ty * TILE_SIZE + y) * width + (tx * TILE_SIZE + x)) * 4;
              const p = palettePtr + idx * 3;
              pixels[o] = heap[p] ?? 0;
              pixels[o + 1] = heap[p + 1] ?? 0;
              pixels[o + 2] = heap[p + 2] ?? 0;
              pixels[o + 3] = 255;
            }
          }
        }
      }
      return { pixels, width, height };
    }
  };
  const paletteRgb = (index) => {
    const heap = module.HEAPU8;
    const p = palettePtr + index * 3;
    return [heap[p] ?? 0, heap[p + 1] ?? 0, heap[p + 2] ?? 0];
  };
  return { source, paletteRgb, dispose: () => module._cbx_cart_delete(cart) };
}

// src/scene/parallaxScene.ts
var clampUnit = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
var lerp = (a, b, t) => a + (b - a) * t;
function parallaxOf(layer) {
  return layer.parallax ?? clampUnit(1 - layer.depth);
}
function hazeColor(rgb, haze, atmosphere) {
  const t = clampUnit(haze);
  const desat = atmosphere.desaturate * t;
  const lift = atmosphere.lift * t;
  const blend = atmosphere.density * t;
  const out = [rgb[0], rgb[1], rgb[2]];
  const luma = out[0] * 0.299 + out[1] * 0.587 + out[2] * 0.114;
  for (let c = 0; c < 3; c += 1) {
    let v = out[c];
    v = lerp(v, luma, desat);
    v = lerp(v, lerp(v, atmosphere.fog[c], 0.5), lift);
    v = lerp(v, atmosphere.fog[c], blend);
    out[c] = v;
  }
  return [out[0], out[1], out[2]];
}
function prehazeLayers(layers, atmosphere) {
  return layers.map((layer) => {
    const haze = clampUnit(layer.depth);
    if (haze <= 0) {
      return { ...layer, hazed: true };
    }
    const src = layer.pixels;
    const pixels = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i += 4) {
      const [r, g, b] = hazeColor([src[i], src[i + 1], src[i + 2]], haze, atmosphere);
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = src[i + 3];
    }
    return { ...layer, pixels, hazed: true };
  });
}
function composeParallax(out, outW, outH, layers, camera, atmosphere) {
  const ordered = [...layers].sort((a, b) => b.depth - a.depth);
  for (const layer of ordered) {
    const factor = parallaxOf(layer);
    const shiftX = Math.round(-camera.x * factor + (layer.offsetX ?? 0));
    const shiftY = Math.round(-camera.y * factor + (layer.offsetY ?? 0));
    const wrapX = layer.wrapX ?? true;
    const haze = layer.hazed ? 0 : clampUnit(layer.depth);
    const opacity = layer.opacity ?? 1;
    const emissive = layer.emissive ?? 1;
    for (let y = 0; y < outH; y += 1) {
      const sy = y - shiftY;
      if (sy < 0 || sy >= layer.height) continue;
      for (let x = 0; x < outW; x += 1) {
        let sx = x - shiftX;
        if (wrapX) sx = (sx % layer.width + layer.width) % layer.width;
        else if (sx < 0 || sx >= layer.width) continue;
        const si = (sy * layer.width + sx) * 4;
        const alpha = layer.pixels[si + 3] / 255 * opacity;
        if (alpha <= 0) continue;
        const src = [layer.pixels[si], layer.pixels[si + 1], layer.pixels[si + 2]];
        const hazed = haze > 0 ? hazeColor(src, haze, atmosphere) : src;
        const di = (y * outW + x) * 4;
        out[di] = lerp(out[di], hazed[0] * emissive, alpha);
        out[di + 1] = lerp(out[di + 1], hazed[1] * emissive, alpha);
        out[di + 2] = lerp(out[di + 2], hazed[2] * emissive, alpha);
        out[di + 3] = 255;
      }
    }
  }
}

// src/scene/sceneRender.ts
function resolveSceneLayers(spec, source) {
  return spec.layers.map((layer) => {
    const image = source.readRegion(layer.source.page, layer.source.tile, layer.source.tilesW, layer.source.tilesH);
    const resolved = {
      pixels: image.pixels,
      width: image.width,
      height: image.height,
      depth: layer.depth,
      wrapX: layer.wrapX,
      offsetY: layer.offsetY
    };
    if (layer.parallax !== void 0) resolved.parallax = layer.parallax;
    return resolved;
  });
}
function cameraAt(spec, frame, base = { x: 0, y: 0 }) {
  return {
    x: base.x + (spec.camera.autoScrollX ?? 0) * frame,
    y: base.y + (spec.camera.autoScrollY ?? 0) * frame
  };
}
function fillSky(out, width, height, atmosphere, horizonY = height) {
  const zenith = [
    Math.round(atmosphere.fog[0] * 0.16),
    Math.round(atmosphere.fog[1] * 0.16),
    Math.round(atmosphere.fog[2] * 0.22)
  ];
  for (let y = 0; y < height; y += 1) {
    const t = Math.min(1, horizonY > 0 ? y / horizonY : 1);
    const r = Math.round(zenith[0] + (atmosphere.fog[0] - zenith[0]) * t);
    const g = Math.round(zenith[1] + (atmosphere.fog[1] - zenith[1]) * t);
    const b = Math.round(zenith[2] + (atmosphere.fog[2] - zenith[2]) * t);
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
}
function renderSceneBackdrop(out, width, height, layers, spec, frame, base) {
  fillSky(out, width, height, spec.atmosphere);
  composeParallax(out, width, height, layers, cameraAt(spec, frame, base), spec.atmosphere);
}

// src/scene/sceneComposite.ts
function matchesKey(r, g, b, key, tolerance) {
  return Math.abs(r - key[0]) <= tolerance && Math.abs(g - key[1]) <= tolerance && Math.abs(b - key[2]) <= tolerance;
}
function compositeOverBackdrop(cartFrame, backdrop, width, height, keyRgb, tolerance = 0, out) {
  const target = out ?? new Uint8ClampedArray(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = cartFrame[o], g = cartFrame[o + 1], b = cartFrame[o + 2];
    if (matchesKey(r, g, b, keyRgb, tolerance)) {
      target[o] = backdrop[o];
      target[o + 1] = backdrop[o + 1];
      target[o + 2] = backdrop[o + 2];
      target[o + 3] = 255;
    } else {
      target[o] = r;
      target[o + 1] = g;
      target[o + 2] = b;
      target[o + 3] = 255;
    }
  }
  return target;
}

// src/scene/SceneBackdropSurface.ts
var SceneBackdropSurface = class {
  constructor(inner, width, height, layers, spec, keyRgb) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.spec = spec;
    this.keyRgb = keyRgb;
    this.frame = 0;
    /** The cart-published camera base, added to the scene's auto-scroll each frame. */
    this.cameraBase = { x: 0, y: 0 };
    /** Per-layer animation overrides for this frame, keyed by layer index (or null). */
    this.layerOverrides = null;
    const size = width * height * 4;
    this.hazedLayers = prehazeLayers(layers, spec.atmosphere);
    this.sky = new Uint8ClampedArray(size);
    fillSky(this.sky, width, height, spec.atmosphere);
    this.backdrop = new Uint8ClampedArray(size);
    this.composited = new Uint8ClampedArray(size);
    this.presented = new Uint8Array(this.composited.buffer);
  }
  /**
   * Set the backdrop camera the cart published this frame (via `cartbox.camera`).
   * Added to the scene's own auto-scroll, so an auto-scroll-only cart that never
   * sets it keeps panning as before with the default (0, 0).
   */
  setCameraBase(base) {
    this.cameraBase = base;
  }
  /**
   * Set this frame's per-layer animation overrides (or null for none). Applied on
   * top of the pre-hazed layers without touching their baked pixels, so the
   * frame-invariant haze cache is preserved.
   */
  setLayerOverrides(overrides) {
    this.layerOverrides = overrides;
  }
  /** The layers to composite this frame: the cached ones, plus any overrides. */
  frameLayers() {
    const overrides = this.layerOverrides;
    if (!overrides) return this.hazedLayers;
    return this.hazedLayers.map((layer, index) => {
      const override = overrides[index];
      if (!override) return layer;
      return {
        ...layer,
        offsetX: (layer.offsetX ?? 0) + (override.offsetX ?? 0),
        offsetY: (layer.offsetY ?? 0) + (override.offsetY ?? 0),
        opacity: override.opacity ?? layer.opacity,
        emissive: override.emissive ?? layer.emissive
      };
    });
  }
  blit(rgba) {
    const cartFrame = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    this.backdrop.set(this.sky);
    composeParallax(
      this.backdrop,
      this.width,
      this.height,
      this.frameLayers(),
      cameraAt(this.spec, this.frame, this.cameraBase),
      this.spec.atmosphere
    );
    compositeOverBackdrop(cartFrame, this.backdrop, this.width, this.height, this.keyRgb, 0, this.composited);
    this.inner.blit(this.presented);
    this.frame += 1;
  }
  destroy() {
    this.inner.destroy();
  }
};

// src/anim/AnimatedForegroundSurface.ts
var AnimatedForegroundSurface = class {
  constructor(inner, width, height, source) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.source = source;
    this.placements = [];
    /** Static region pixels cached by region key (page:tile:tilesW:tilesH). */
    this.regionCache = /* @__PURE__ */ new Map();
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
  }
  /** Set the placements resolved for this frame (empty for none). */
  setPlacements(placements) {
    this.placements = placements;
  }
  region(placement) {
    const { page, tile, tilesW, tilesH } = placement.region;
    const key = `${page}:${tile}:${tilesW}:${tilesH}`;
    let image = this.regionCache.get(key);
    if (!image) {
      image = this.source.readRegion(page, tile, tilesW, tilesH);
      this.regionCache.set(key, image);
    }
    return image;
  }
  blit(rgba) {
    if (this.placements.length === 0) {
      this.inner.blit(rgba);
      return;
    }
    this.output.set(rgba);
    const ordered = [...this.placements].sort((a, b) => b.depth - a.depth);
    for (const placement of ordered) this.drawPlacement(placement);
    this.inner.blit(this.presented);
  }
  /** Nearest-neighbour scale + straight-alpha composite of one placement. */
  drawPlacement(placement) {
    const opacity = Math.max(0, Math.min(1, placement.opacity));
    if (opacity <= 0) return;
    const scale = placement.scale > 0 ? placement.scale : 1;
    const image = this.region(placement);
    const destWidth = Math.max(1, Math.round(image.width * scale));
    const destHeight = Math.max(1, Math.round(image.height * scale));
    const originX = Math.round(placement.x);
    const originY = Math.round(placement.y);
    for (let dy = 0; dy < destHeight; dy += 1) {
      const y = originY + dy;
      if (y < 0 || y >= this.height) continue;
      const sy = Math.min(image.height - 1, Math.floor(dy / scale));
      for (let dx = 0; dx < destWidth; dx += 1) {
        const x = originX + dx;
        if (x < 0 || x >= this.width) continue;
        const sx = Math.min(image.width - 1, Math.floor(dx / scale));
        const si = (sy * image.width + sx) * 4;
        const alpha = image.pixels[si + 3] / 255 * opacity;
        if (alpha <= 0) continue;
        const di = (y * this.width + x) * 4;
        this.output[di] = lerp2(this.output[di], image.pixels[si], alpha);
        this.output[di + 1] = lerp2(this.output[di + 1], image.pixels[si + 1], alpha);
        this.output[di + 2] = lerp2(this.output[di + 2], image.pixels[si + 2], alpha);
        this.output[di + 3] = 255;
      }
    }
  }
  destroy() {
    this.inner.destroy();
  }
};
var lerp2 = (a, b, t) => a + (b - a) * t;

// src/anim/animPlayer.ts
var mod = (a, m) => (a % m + m) % m;
function frameSequence(clip) {
  const count = clip.frames.length;
  if (count <= 1) return [0];
  const forward = [];
  for (let i = 0; i < count; i += 1) forward.push(i);
  if (clip.mode !== "pingpong") return forward;
  for (let i = count - 2; i >= 1; i -= 1) forward.push(i);
  return forward;
}
function sampleClipFrame(clip, frame) {
  const lastIndex = clip.frames.length - 1;
  const at = (index) => ({ region: clip.frames[index], frameIndex: index });
  const tick = Math.max(0, Math.floor(frame));
  if (clip.mode === "once") {
    let acc2 = 0;
    for (let i = 0; i < clip.frames.length; i += 1) {
      acc2 += clip.durations[i];
      if (tick < acc2) return at(i);
    }
    return at(lastIndex);
  }
  const sequence = frameSequence(clip);
  const sequenceDurations = sequence.map((index) => clip.durations[index]);
  const period = sequenceDurations.reduce((sum, d) => sum + d, 0);
  if (period <= 0) return at(0);
  const local = mod(tick, period);
  let acc = 0;
  for (let step = 0; step < sequence.length; step += 1) {
    acc += sequenceDurations[step];
    if (local < acc) return at(sequence[step]);
  }
  return at(sequence[sequence.length - 1]);
}
function valueAtLocalTime(keys, local) {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (local <= first.t) return first.value;
  if (local >= last.t) return last.value;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const start = keys[i];
    const end = keys[i + 1];
    if (local < start.t || local > end.t) continue;
    const dt = end.t - start.t;
    if (dt <= 0) return end.value;
    if (start.ease === "step") return start.value;
    let u = (local - start.t) / dt;
    if (start.ease === "smooth") u = u * u * (3 - 2 * u);
    return start.value + (end.value - start.value) * u;
  }
  return last.value;
}
function sampleTrack(track, frame) {
  const keys = track.keys;
  const firstT = keys[0].t;
  const lastT = keys[keys.length - 1].t;
  if (track.mode === "hold") {
    return valueAtLocalTime(keys, Math.min(Math.max(frame, firstT), lastT));
  }
  if (track.mode === "pingpong") {
    const span2 = lastT - firstT;
    if (span2 <= 0) return keys[0].value;
    const phase = mod(frame - firstT, span2 * 2);
    const local = phase <= span2 ? firstT + phase : firstT + (span2 * 2 - phase);
    return valueAtLocalTime(keys, local);
  }
  const span = track.loopLength && track.loopLength > 0 ? track.loopLength : lastT - firstT;
  if (span <= 0) return keys[0].value;
  return valueAtLocalTime(keys, firstT + mod(frame - firstT, span));
}
function evaluate(spec, frame) {
  var _a, _b;
  const clipByName = /* @__PURE__ */ new Map();
  for (const clip of spec.clips) clipByName.set(clip.name, clip);
  const layers = {};
  const postfx = {};
  const placementOverrides = {};
  for (const track of spec.tracks) {
    const value = sampleTrack(track, frame);
    const target = track.target;
    if (target.kind === "sceneLayer") {
      (layers[_a = target.index] ?? (layers[_a] = {}))[target.channel] = value;
    } else if (target.kind === "postfx") {
      postfx[target.key] = value;
    } else {
      (placementOverrides[_b = target.index] ?? (placementOverrides[_b] = {}))[target.channel] = value;
    }
  }
  const placements = [];
  spec.placements.forEach((placement, index) => {
    const clip = clipByName.get(placement.clip);
    if (!clip) return;
    const sample = sampleClipFrame(clip, frame);
    const override = placementOverrides[index] ?? {};
    placements.push({
      region: sample.region,
      frameIndex: sample.frameIndex,
      x: override.x ?? placement.x,
      y: override.y ?? placement.y,
      opacity: override.opacity ?? placement.opacity,
      scale: override.scale ?? placement.scale,
      depth: placement.depth
    });
  });
  return { layers, postfx, placements };
}

// src/particles/particleField.ts
var TAU = Math.PI * 2;
function hash01(seed, index, salt) {
  let h = Math.imul(seed, 374761393) + Math.imul(index, 668265263) + Math.imul(salt, 2246822519) >>> 0;
  h = Math.imul(h ^ h >>> 13, 1274126177) >>> 0;
  h = (h ^ h >>> 16) >>> 0;
  return h / 4294967296;
}
function wrap(value, span) {
  return (value % span + span) % span;
}
var clamp01 = (value) => value < 0 ? 0 : value > 1 ? 1 : value;
function simulateEmitter(emitter, frame, width, height) {
  const particles = [];
  const kind = emitter.kind;
  for (let index = 0; index < emitter.count; index += 1) {
    const spawnX = hash01(emitter.seed, index, 1);
    const spawnY = hash01(emitter.seed, index, 2);
    const phase = hash01(emitter.seed, index, 3) * TAU;
    const jitter = hash01(emitter.seed, index, 4);
    let x = spawnX * width + emitter.wind * frame;
    let y;
    let streak = 0;
    let alpha = emitter.opacity;
    let size = emitter.size;
    if (kind === "rain") {
      y = spawnY * height + emitter.speed * frame;
      streak = 2 + emitter.speed * 0.6;
    } else if (kind === "snow") {
      y = spawnY * height + emitter.speed * frame;
      x += Math.sin(frame * 0.05 + phase) * 6;
      size = emitter.size * (0.7 + 0.6 * jitter);
    } else if (kind === "embers") {
      y = spawnY * height - emitter.speed * frame;
      x += Math.sin(frame * 0.08 + phase) * 4;
      const climb = wrap(y, height) / height;
      const flicker2 = 0.55 + 0.45 * Math.sin(frame * 0.3 + phase * 5);
      alpha = emitter.opacity * flicker2 * (0.3 + 0.7 * climb);
    } else {
      y = spawnY * height + emitter.speed * frame * 0.3;
      size = emitter.size * (0.8 + 0.5 * jitter);
    }
    particles.push({
      x: wrap(x, width),
      y: wrap(y, height),
      size: Math.max(1, size),
      alpha: clamp01(alpha),
      color: emitter.color,
      streak
    });
  }
  return particles;
}

// src/particles/ParticleOverlaySurface.ts
var ParticleOverlaySurface = class {
  constructor(inner, width, height, spec) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.spec = spec;
    this.frame = 0;
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
  }
  blit(rgba) {
    if (this.spec.emitters.length === 0) {
      this.inner.blit(rgba);
      return;
    }
    this.output.set(rgba);
    for (const emitter of this.spec.emitters) {
      for (const particle of simulateEmitter(emitter, this.frame, this.width, this.height)) {
        this.draw(particle);
      }
    }
    this.frame += 1;
    this.inner.blit(this.presented);
  }
  destroy() {
    this.inner.destroy();
  }
  /** Straight-alpha composite one particle: a vertical streak, or a square dot. */
  draw(particle) {
    if (particle.alpha <= 0) return;
    const half = Math.max(0, Math.floor(particle.size / 2));
    const originX = Math.round(particle.x);
    if (particle.streak > 0) {
      const top = Math.round(particle.y);
      const bottom = top + Math.round(particle.streak);
      for (let y = top; y <= bottom; y += 1) {
        for (let dx = -half; dx <= half; dx += 1) {
          this.blend(originX + dx, y, particle);
        }
      }
      return;
    }
    const originY = Math.round(particle.y);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        this.blend(originX + dx, originY + dy, particle);
      }
    }
  }
  /** Alpha-blend a particle's colour onto one framebuffer pixel (bounds-checked). */
  blend(x, y, particle) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const alpha = particle.alpha;
    this.output[index] = lerp3(this.output[index], particle.color[0], alpha);
    this.output[index + 1] = lerp3(this.output[index + 1], particle.color[1], alpha);
    this.output[index + 2] = lerp3(this.output[index + 2], particle.color[2], alpha);
    this.output[index + 3] = 255;
  }
};
var lerp3 = (a, b, t) => a + (b - a) * t;

// src/mesh/MeshOverlaySurface.ts
import {
  bakeReflectionProbesAsync,
  ParticleSystem,
  DecalSystem,
  DebrisSystem,
  applySunShafts,
  sunScreenPosition,
  sunVisibility,
  bakeSkyPanorama,
  buildSceneShadow,
  LOCAL_SHADOW_BIAS,
  LOCAL_SHADOW_SLOPE_BIAS,
  assignLocalShadowTiles,
  renderLocalShadow,
  childIndices,
  computeEnvironmentAverage,
  createLiveSkinnedMesh,
  downsamplePanorama,
  isSkinned as isSkinned2,
  renderSkyBackground,
  shieldEffect,
  composeModelMatrix as composeModelMatrix4,
  multiplyMat4 as multiplyMat43,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  withDescendants
} from "@cartbox/editor";

// src/render/sceneRenderer.ts
import {
  DEFAULT_RASTER_STYLE,
  applyLods,
  cameraPositionFromView,
  cullInstances,
  occlusionCull,
  renderGeometryBuffers,
  renderMeshScene
} from "@cartbox/editor";

// src/render/renderCaps.ts
function createTextureBudgetCache() {
  return /* @__PURE__ */ new WeakMap();
}
function triangleCount(instance) {
  let total = 0;
  for (const primitive of instance.mesh.primitives) total += primitive.indices.length / 3;
  return total;
}
function capTriangles(instances, polyBudget) {
  if (polyBudget <= 0 || instances.length === 0) return instances;
  let used = 0;
  for (let index = 0; index < instances.length; index += 1) {
    used += triangleCount(instances[index]);
    if (used > polyBudget) {
      return instances.slice(0, Math.max(1, index));
    }
  }
  return instances;
}
function fitTextureToBudget(source, budgetBytes) {
  if (budgetBytes <= 0) return source;
  let current = source;
  while (current.width * current.height * 4 > budgetBytes && (current.width > 1 || current.height > 1)) {
    current = halve(current);
  }
  return current;
}
function halve(source) {
  const width = Math.max(1, source.width >> 1);
  const height = Math.max(1, source.height >> 1);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.min(source.width - 1, x * 2);
      const x1 = Math.min(source.width - 1, x * 2 + 1);
      const y0 = Math.min(source.height - 1, y * 2);
      const y1 = Math.min(source.height - 1, y * 2 + 1);
      const at = (px, py) => (py * source.width + px) * 4;
      const a = at(x0, y0);
      const b = at(x1, y0);
      const c = at(x0, y1);
      const d = at(x1, y1);
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        data[to + channel] = (source.data[a + channel] + source.data[b + channel] + source.data[c + channel] + source.data[d + channel]) / 4;
      }
    }
  }
  return { width, height, data };
}
function capTextures(instances, budgetBytes, cache) {
  if (budgetBytes <= 0) return instances;
  let changed = false;
  const fitList = (list, onChange) => {
    if (!list) return list;
    return list.map((texture) => {
      if (!texture) return texture;
      const memo = cache.get(texture);
      if (memo) {
        if (memo !== texture) onChange();
        return memo;
      }
      const result = fitTextureToBudget(texture, budgetBytes);
      cache.set(texture, result);
      if (result !== texture) onChange();
      return result;
    });
  };
  const capped = instances.map((instance) => {
    if (!instance.textures && !instance.normalTextures && !instance.materialTextures && !instance.mrTextures && !instance.occlusionTextures && !instance.emissiveTextures && !instance.lightmapTextures && !instance.detailTextures && !instance.blendTextures) {
      return instance;
    }
    let instanceChanged = false;
    const mark = () => {
      instanceChanged = true;
    };
    const fitted = fitList(instance.textures, mark);
    const fittedNormals = fitList(instance.normalTextures, mark);
    const fittedMaterials = fitList(instance.materialTextures, mark);
    const fittedMr = fitList(instance.mrTextures, mark);
    const fittedOcclusion = fitList(instance.occlusionTextures, mark);
    const fittedEmissive = fitList(instance.emissiveTextures, mark);
    const fittedLightmaps = fitList(instance.lightmapTextures, mark);
    const fittedDetail = fitList(instance.detailTextures, mark);
    const fittedBlend = fitList(instance.blendTextures, mark);
    if (!instanceChanged) return instance;
    changed = true;
    return {
      mesh: instance.mesh,
      model: instance.model,
      textures: fitted,
      normalTextures: fittedNormals,
      materialTextures: fittedMaterials,
      mrTextures: fittedMr,
      occlusionTextures: fittedOcclusion,
      emissiveTextures: fittedEmissive,
      ...fittedLightmaps ? { lightmapTextures: fittedLightmaps } : {},
      ...fittedDetail ? { detailTextures: fittedDetail } : {},
      ...fittedBlend ? { blendTextures: fittedBlend } : {}
    };
  });
  return changed ? capped : instances;
}
function applyRenderCaps(instances, caps, cache) {
  return capTextures(capTriangles(instances, caps.polyBudget), caps.textureCacheBytes, cache);
}
function rasterStyleFor(caps) {
  return {
    zBuffer: caps.zBuffer,
    perspectiveCorrect: caps.perspectiveCorrect,
    vertexPrecision: caps.vertexPrecision,
    textureFiltering: caps.textureFiltering === "none" ? "none" : "bilinear"
  };
}
function webgpuCanHonour(style) {
  return style.zBuffer && style.perspectiveCorrect && style.vertexPrecision === "float";
}

// src/render/sceneRenderer.ts
function applyScenePasses(instances, draw) {
  let out = instances;
  if (draw.lod) {
    const [cx, cy, cz] = cameraPositionFromView(draw.view);
    out = applyLods(out, cx, cy, cz);
  }
  if (draw.cull) out = cullInstances(out, draw.view, draw.projection);
  if (draw.occlude && out.length > 1) {
    const geo = renderGeometryBuffers(out, { width: draw.width, height: draw.height, view: draw.view, projection: draw.projection });
    out = occlusionCull(out, { view: draw.view, projection: draw.projection, depth: geo.depth, width: draw.width, height: draw.height });
  }
  return out;
}
var SoftwareSceneRenderer = class {
  /**
   * @param style How to rasterise — the era behaviour a console model asks for.
   *   Defaults to the modern one, so an editor preview or a test that passes
   *   nothing renders exactly as it always has.
   */
  constructor(style = DEFAULT_RASTER_STYLE) {
    this.style = style;
    this.backend = "software";
    this.lastFrameStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };
  }
  render(instances, draw) {
    const visible = applyScenePasses(instances, draw);
    let triangles = 0;
    let drawCalls = 0;
    for (const instance of visible) {
      drawCalls += instance.mesh.primitives.length;
      for (const primitive of instance.mesh.primitives) triangles += primitive.indices.length / 3;
    }
    this.lastFrameStats = { drawCalls, instances: visible.length, triangles, gpuMs: null };
    renderMeshScene(visible, {
      width: draw.width,
      height: draw.height,
      out: draw.out,
      depth: draw.depth,
      view: draw.view,
      projection: draw.projection,
      background: draw.background,
      lightDirection: draw.lightDirection,
      ambient: draw.ambient,
      environment: draw.environment,
      shadow: draw.shadow,
      tonemap: draw.tonemap,
      ssao: draw.ssao,
      lights: draw.lights,
      localShadows: draw.localShadows,
      fog: draw.fog,
      time: draw.time,
      style: this.style
    });
  }
  dispose() {
  }
};
var CappedSceneRenderer = class {
  constructor(inner, caps) {
    this.inner = inner;
    this.caps = caps;
    this.cache = createTextureBudgetCache();
  }
  get backend() {
    return this.inner.backend;
  }
  get lastFrameStats() {
    return this.inner.lastFrameStats;
  }
  render(instances, draw) {
    this.inner.render(applyRenderCaps(instances, this.caps, this.cache), draw);
  }
  settle(draw) {
    return this.inner.settle?.(draw) ?? "current";
  }
  get ready() {
    return this.inner.ready;
  }
  dispose() {
    this.inner.dispose();
  }
};
function capsConstrainScene(caps) {
  return caps.polyBudget > 0 || caps.textureCacheBytes > 0;
}

// src/mesh/MeshOverlaySurface.ts
var RAD_TO_DEG = 180 / Math.PI;
var SUN_EASE = 0.35;
var FIRST_PERSON_NEAR = 0.05;
var SHADOW_MAP_SIZE = 1024;
var SKY_BACKDROP_SCALE = 3;
var SOFTWARE_SCALES = [1, 0.75, 0.5, 0.35, 0.25];
var SLOW_FRAME_MS = 40;
var FAST_FRAME_MS = 15;
var HUD_TRANSPARENT_SUM = 30;
var HUD_SKY = [70, 104, 152, 255];
function compositeHudOverScene(scene, hud, count) {
  if (scene.byteOffset % 4 === 0 && hud.byteOffset % 4 === 0) {
    const out = new Uint32Array(scene.buffer, scene.byteOffset, count);
    const src = new Uint32Array(hud.buffer, hud.byteOffset, count);
    for (let i = 0; i < count; i += 1) {
      const word = src[i];
      if ((word & 16777215) === 0) continue;
      if ((word & 255) + (word >>> 8 & 255) + (word >>> 16 & 255) > HUD_TRANSPARENT_SUM) out[i] = (word | 4278190080) >>> 0;
    }
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = hud[o];
    const g = hud[o + 1];
    const b = hud[o + 2];
    if (r + g + b > HUD_TRANSPARENT_SUM) {
      scene[o] = r;
      scene[o + 1] = g;
      scene[o + 2] = b;
      scene[o + 3] = 255;
    }
  }
}
var SKY_PANORAMA_WIDTH = 1536;
var SKY_PANORAMA_HEIGHT = 768;
var SKY_IBL_DOWNSAMPLE = 8;
function poseLocalMatrix(pose) {
  return composeModelMatrix4(
    pose.position,
    [pose.rotation[1] * RAD_TO_DEG, pose.rotation[0] * RAD_TO_DEG, pose.rotation[2] * RAD_TO_DEG],
    [pose.scale, pose.scale, pose.scale]
  );
}
var AUTO_ORBIT_YAW_PER_FRAME = 2 * Math.PI / 720;
var newShadowLayer = () => ({ staticDepth: null, key: "", lighting: null, matrix: null, depth: null, rects: [] });
var NEAR_CASCADE_SHARE = 0.3;
var NEAR_CASCADE_MIN = 4;
var NEAR_CASCADE_MAX = 24;
var AUTO_ORBIT_PITCH = 0.35;
var MeshOverlaySurface = class _MeshOverlaySurface {
  constructor(inner, width, height, scene, instances, frames, renderer, skyMap, environment, options = {}) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.scene = scene;
    this.instances = instances;
    this.frames = frames;
    this.renderer = renderer;
    this.skyMap = skyMap;
    this.environment = environment;
    this.options = options;
    this.frame = 0;
    this.cartCamera = null;
    this.poses = [];
    /** The sun's shadow maps (see buildShadow): the whole scene, and the near cascade round the camera (EP8b). */
    this.farShadow = newShadowLayer();
    this.nearShadow = newShadowLayer();
    /** Each casting spot/point light's cached still tiles and this frame's copies (EP8c), in tile order. */
    this.localShadowCache = [];
    /** Instances ever posed on the front layer (a held weapon): never part of the static shadow. */
    this.everFront = /* @__PURE__ */ new Set();
    /** Each mesh's local bounding box, for projecting shadow footprints. */
    this.meshBounds = /* @__PURE__ */ new WeakMap();
    /** Software-path resolution governor (see SOFTWARE_SCALES): current step and smoothed frame ms. */
    this.scaleStep = 2;
    this.frameMs = 0;
    this.framesAtStep = 0;
    this.low = null;
    /** The last sky backdrop and the view it was painted for (it depends only on
     *  where the camera points, so walking without turning reuses it). */
    this.skyCache = null;
    /**
     * Told each frame where the sky dome's sun is on screen and how much of it is
     * unblocked, for the post-FX glare and lens flare (H8); null without a sky dome.
     */
    this.onSun = null;
    /** The sun's eased visibility and last place on screen (0..1). */
    this.sunSeen = 0;
    this.sunAt = { x: 0.5, y: 0.5 };
    /** Reused buffers for the sun-shaft pass. */
    this.shaftScratch = null;
    /** The cart's world lights this frame (cartbox.light3d), added to the rig's in first person. */
    this.cartLights = [];
    /** Tinted mesh copies, per source mesh and tint index. */
    this.tintCache = /* @__PURE__ */ new Map();
    /** Draws the front layer (a held weapon) over the finished scene. */
    this.frontRenderer = new SoftwareSceneRenderer();
    /** First-person mode: draw the meshes first, then the cart's 2D frame as a HUD on top. */
    this.hud = false;
    /** The same shape for a flat scene, built on first use when physics bodies move it. */
    this.flat = null;
    /** World matrices of the objects physics moved this frame (see setBodyOverrides). */
    this.bodies = /* @__PURE__ */ new Map();
    /** Shield effects (H11): object index → the surface effect it and everything under it wear (see setShields). */
    this.effects = /* @__PURE__ */ new Map();
    this.shieldCache = /* @__PURE__ */ new Map();
    /** Spawned prefab copies: root object index → the root's world matrix (see setSpawned). */
    this.spawned = /* @__PURE__ */ new Map();
    /** Graphics quality (see quality.ts): shadows on/off and their map size, the first-person scale cap. */
    this.quality = QUALITY_PRESETS.high;
    /** Skinned instances' live meshes (their buffers are rewritten for each pose). */
    this.live = /* @__PURE__ */ new Map();
    /** The skinning matrices each live mesh was last posed with (skip re-skinning the same pose). */
    this.lastSkin = /* @__PURE__ */ new Map();
    /** Instances animated this frame: they move for the shadow cache. */
    this.animated = /* @__PURE__ */ new Set();
    /** Objects in a level that isn't the current one: not drawn, not in the static shadow (see setInactive). */
    this.inactive = /* @__PURE__ */ new Set();
    this.inactiveKey = "";
    /** Each object's world matrix as last drawn (null = hidden), or null when nothing moved. */
    this.lastPlacement = null;
    /** Copy of the cart frame kept as the HUD layer while the 3D renders into `output`. */
    this.hudFrame = null;
    /** The playtest profiler, when it's on: shadow, sky and scene time go to it. */
    this.profiler = null;
    /** Decodes a KTX2 texture (loading the decoder on first use); set by create. */
    this.decodeKtx2 = async () => null;
    /** The camera's eye this frame (terrain blocks pick their detail by distance from it). */
    this.eye = null;
    /** The last frame's view matrix (null before the first frame). */
    this.lastView = null;
    /** Foliage blocks by mesh (EP11): their cull distance and bounds. */
    this.foliage = /* @__PURE__ */ new Map();
    /** Each terrain block's world bounds, measured on first use. */
    this.blockBounds = /* @__PURE__ */ new Map();
    this.destroyed = false;
    /** The scene's 3D particle effects in flight, or null when it defines none. */
    this.particles = null;
    /** The scene's decals on its surfaces, or null when it defines none. */
    this.decals = null;
    /** Debris in flight and at rest (H10), what it lands on, and each source mesh with its textures. */
    this.debris = null;
    this.debrisBoxes = [];
    this.debrisLooks = /* @__PURE__ */ new Map();
    /** Settles once the scene's reflection probes are baked and in use (tests await it). */
    this.probesReady = Promise.resolve();
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
    this.depth = new Float32Array(width * height);
    this.pooledRoot = scene.instances.map((instance) => instance.pooled?.root ?? -1);
    this.unpooled = this.pooledRoot.some((r) => r >= 0) ? instances.filter((_, i) => this.pooledRoot[i] < 0) : instances;
    const parents = scene.instances.map((instance) => instance.parent ?? -1);
    this.hierarchy = parents.some((p) => p >= 0) ? {
      parents,
      children: childIndices(parents),
      locals: scene.instances.map((instance) => instance.local ?? instance.model)
    } : null;
  }
  /**
   * Set the world matrices of the objects physics moves (object index → matrix),
   * replacing their authored placement; their children follow, and a cart pose
   * still composes on top. The player calls this each frame from the physics session.
   */
  setBodyOverrides(bodies) {
    this.bodies = bodies;
  }
  /**
   * Set the prefab copies the cart has spawned (root object index → world matrix).
   * Reserve copies not in the map stay hidden; a spawned copy's children follow
   * its root, and its physics bodies (if any) take over from there.
   */
  setSpawned(spawned) {
    this.spawned = spawned;
  }
  /**
   * Set the shield effects the cart has standing (cartbox.shield: object →
   * flare, shimmer, camo). Each is drawn on the object and everything under it,
   * as a surface effect over its PBR materials (see shieldEffect).
   */
  setShields(shields) {
    if (shields.size === 0 && this.effects.size === 0) return;
    const effects = /* @__PURE__ */ new Map();
    for (const [object, { flare, shimmer, camo }] of shields) {
      let cached = this.shieldCache.get(object);
      if (!cached || cached.flare !== flare || cached.shimmer !== shimmer || cached.camo !== camo) {
        cached = { flare, shimmer, camo, effect: shieldEffect(flare, shimmer, camo) };
        this.shieldCache.set(object, cached);
      }
      if (cached.effect) effects.set(object, cached.effect);
    }
    for (const object of this.shieldCache.keys()) if (!shields.has(object)) this.shieldCache.delete(object);
    this.effects = effects;
  }
  /**
   * Pose the skinned objects (object index → skinning matrices, see
   * AnimationSession). Each listed object's live mesh is re-skinned when its
   * matrices changed, and it counts as moving this frame for the shadow cache.
   */
  setSkinning(skinning) {
    for (const [i, matrices] of skinning) {
      const live = this.live.get(i);
      if (!live || this.lastSkin.get(i) === matrices) continue;
      live.update(matrices);
      this.lastSkin.set(i, matrices);
    }
    this.animated = new Set([...skinning.keys()].filter((i) => this.live.has(i)));
  }
  /**
   * Apply an editor's edits to the running scene (ENGINE_PARITY_ROADMAP.md EP5):
   * objects' placements, their meshes and materials, and the lighting rig, shown
   * from the next frame without restarting the cart. `next` must be the same
   * scene structure — the same objects, parents and prefab reserves in the same
   * order — or nothing changes and this answers false (the editor then says the
   * change applies on the next run). Physics bodies keep simulating where they are.
   */
  async applySceneEdits(next) {
    const before = this.scene;
    if (next.instances.length !== before.instances.length) return false;
    for (let i = 0; i < next.instances.length; i += 1) {
      const a = before.instances[i];
      const b = next.instances[i];
      if ((a.parent ?? -1) !== (b.parent ?? -1) || (a.pooled?.root ?? -1) !== (b.pooled?.root ?? -1) || !!a.terrain !== !!b.terrain) return false;
    }
    let moved = false;
    for (let i = 0; i < next.instances.length; i += 1) {
      const a = before.instances[i];
      const b = next.instances[i];
      const local = b.local ?? b.model;
      if (!sameMatrix(a.model, b.model) || !sameMatrix(a.local ?? a.model, local)) {
        this.instances[i] = { ...this.instances[i], model: b.model };
        if (this.hierarchy) this.hierarchy.locals[i] = local;
        this.blockBounds.delete(i);
        moved = true;
      }
      if (meshSignature(a.mesh) !== meshSignature(b.mesh)) {
        const textured = await decodeMeshTextures(b.mesh, this.decodeKtx2 ?? void 0);
        const skinned = isSkinned2(b.mesh) ? createLiveSkinnedMesh(b.mesh) : null;
        if (skinned) this.live.set(i, skinned);
        else this.live.delete(i);
        this.lastSkin.delete(i);
        const lod = liveLod(b.lod, skinned);
        this.instances[i] = { ...textured, ...skinned ? { mesh: skinned.mesh } : {}, ...lod ? { lod } : {}, model: this.instances[i].model };
        moved = true;
      } else if (lodSignature(a.lod) !== lodSignature(b.lod)) {
        const { lod: _old, ...rest } = this.instances[i];
        void _old;
        const lod = liveLod(b.lod, this.live.get(i) ?? null);
        this.instances[i] = { ...rest, ...lod ? { lod } : {} };
        moved = true;
      }
    }
    if (JSON.stringify(before.lighting ?? null) !== JSON.stringify(next.lighting ?? null)) {
      const lighting = next.lighting;
      let environment = lighting ? sceneLightingEnvironment(lighting) : null;
      let skyMap = null;
      if (lighting?.sky && environment) {
        skyMap = bakeSkyPanorama(lighting.sky, SKY_PANORAMA_WIDTH, SKY_PANORAMA_HEIGHT);
        const ibl = downsamplePanorama(skyMap, SKY_IBL_DOWNSAMPLE);
        environment = { ...environment, map: ibl, average: computeEnvironmentAverage(ibl) };
      }
      this.environment = environment;
      this.skyMap = skyMap;
      this.skyCache = null;
    }
    this.scene = next;
    if (moved) {
      this.unpooled = this.pooledRoot.some((r) => r >= 0) ? this.instances.filter((_, i) => this.pooledRoot[i] < 0) : this.instances;
      this.flat = null;
      this.farShadow.key = "";
      this.nearShadow.key = "";
      this.localShadowCache = [];
    }
    return true;
  }
  /** Apply a graphics quality preset (takes effect on the next frame). */
  setQuality(quality) {
    if (quality.shadowMapSize !== this.quality.shadowMapSize) {
      this.farShadow = newShadowLayer();
      this.nearShadow = newShadowLayer();
      this.localShadowCache = [];
    }
    this.quality = quality;
  }
  /**
   * The objects of levels that aren't loaded (see levels.ts in @cartbox/editor):
   * they're hidden, and left out of the shadow, until the set changes again.
   */
  setInactive(objects) {
    this.inactive = objects;
    this.inactiveKey = [...objects].sort((a, b) => a - b).join(",");
    this.unpooled = objects.size === 0 && !this.pooledRoot.some((r) => r >= 0) ? this.instances : this.instances.filter((_, i) => this.pooledRoot[i] < 0 && !objects.has(i));
    this.lastPlacement = null;
  }
  /** Posed instances plus, in a hierarchy, everything below them: what moves this frame. */
  withChildren(indices) {
    return this.hierarchy ? withDescendants(indices, this.hierarchy.children) : new Set(indices);
  }
  /**
   * Decode every instance's base-colour textures, then build the surface. Any
   * texture that fails to decode falls back to null (flat base colour), so a
   * bad image never blocks the cart — the mesh still renders, just untextured.
   */
  static async create(inner, width, height, scene, renderer = new SoftwareSceneRenderer(), options = {}) {
    const decoded = /* @__PURE__ */ new Map();
    let ktx2 = null;
    const decodeKtx2 = (bytes) => {
      ktx2 ?? (ktx2 = options.ktx2 ? options.ktx2().catch(() => null) : Promise.resolve(null));
      return ktx2.then((decode) => decode ? decode(bytes) : null);
    };
    const images = /* @__PURE__ */ new Map();
    const texture = (mesh) => {
      let entry = decoded.get(mesh);
      if (!entry) {
        entry = decodeMeshTextures(mesh, decodeKtx2, images);
        decoded.set(mesh, entry);
      }
      return entry;
    };
    const instances = [];
    const frames = [];
    const live = /* @__PURE__ */ new Map();
    for (const [i, instance] of scene.instances.entries()) {
      const textured = await texture(instance.mesh);
      const skinned = isSkinned2(instance.mesh) ? createLiveSkinnedMesh(instance.mesh) : null;
      if (skinned) live.set(i, skinned);
      const lod = liveLod(instance.lod, skinned);
      instances.push({ ...textured, ...skinned ? { mesh: skinned.mesh } : {}, ...lod ? { lod } : {}, model: instance.model });
      frames.push(instance.frames && instance.frames.length > 0 ? await Promise.all(instance.frames.map(texture)) : null);
    }
    const lighting = scene.lighting;
    let skyMap = null;
    let environment = lighting ? sceneLightingEnvironment(lighting) : null;
    if (lighting?.sky && environment) {
      skyMap = bakeSkyPanorama(lighting.sky, SKY_PANORAMA_WIDTH, SKY_PANORAMA_HEIGHT);
      const ibl = downsamplePanorama(skyMap, SKY_IBL_DOWNSAMPLE);
      environment = { ...environment, map: ibl, average: computeEnvironmentAverage(ibl) };
    }
    const surface = new _MeshOverlaySurface(inner, width, height, scene, instances, frames, renderer, skyMap, environment, options);
    for (const [i, mesh] of live) surface.live.set(i, mesh);
    scene.instances.forEach((instance, i) => {
      if (instance.foliage) surface.foliage.set(instances[i].mesh, instance.foliage);
    });
    surface.decodeKtx2 = decodeKtx2;
    if (scene.effects && scene.effects.length > 0) surface.particles = new ParticleSystem(scene.effects);
    if (scene.decals && scene.decals.length > 0) surface.decals = new DecalSystem(scene.decals, scene.decalMarks ?? []);
    if (scene.debris && scene.debrisMeshes && scene.debris.length > 0) {
      surface.debris = new DebrisSystem(scene.debris, scene.debrisMeshes);
      surface.debrisBoxes = sceneColliders(scene);
      for (const [k, mesh] of scene.debrisMeshes.entries()) {
        const lod = scene.debrisLods?.[k];
        surface.debrisLooks.set(mesh, { ...await texture(mesh), ...lod ? { lod } : {} });
      }
    }
    if (lighting?.probes && lighting.probes.length > 0 && environment) {
      const sky = environment;
      const still = scene.instances.flatMap((inst, i) => {
        const body = inst.physics?.body;
        const moves = body === "dynamic" || body === "kinematic" || body === "character";
        return inst.pooled || isSkinned2(inst.mesh) || moves ? [] : [instances[i]];
      });
      surface.probesReady = bakeReflectionProbesAsync(lighting.probes, still, {
        lightDirection: sceneLightingKeyDirection(lighting),
        ambient: lighting.ambient,
        environment: sky,
        lights: lighting.lights
      }).then((probes) => {
        if (probes && !surface.destroyed) surface.environment = { ...sky, probes };
      }).catch(() => void 0);
    }
    return surface;
  }
  /**
   * Swap streamed textures in (see sceneStreaming.ts in @cartbox/editor): every
   * texture placeholder whose `ref` is in `images` is decoded and takes the
   * place of the flat colour it stood in for, from the next frame. Returns how
   * many objects changed.
   */
  async supplyImages(images) {
    const resolved = /* @__PURE__ */ new Map();
    const resolve = (mesh) => {
      let hit = resolved.get(mesh);
      if (!hit) {
        hit = fillPlaceholders(mesh, images);
        resolved.set(mesh, hit);
      }
      return hit;
    };
    const decoded = /* @__PURE__ */ new Map();
    const texture = (mesh) => {
      let entry = decoded.get(mesh);
      if (!entry) {
        entry = decodeMeshTextures(mesh, this.decodeKtx2);
        decoded.set(mesh, entry);
      }
      return entry;
    };
    let changed = 0;
    for (const [i, instance] of this.scene.instances.entries()) {
      const mesh = resolve(instance.mesh);
      const frames = instance.frames?.map(resolve);
      const framesChanged = frames?.some((f2, k) => f2 !== instance.frames[k]) ?? false;
      if (mesh === instance.mesh && !framesChanged) continue;
      if (mesh !== instance.mesh) {
        const { mesh: _decodedMesh, ...maps } = await texture(mesh);
        void _decodedMesh;
        this.instances[i] = { ...this.instances[i], ...maps };
      }
      if (frames && framesChanged) this.frames[i] = await Promise.all(frames.map(texture));
      changed += 1;
    }
    return changed;
  }
  /**
   * Set the cart-driven camera for the next frame(s), or null to auto-orbit. The
   * player calls this each frame from the decoded mesh-camera mailbox, so a cart
   * that stops publishing (null) smoothly hands the camera back to the auto-orbit.
   */
  setCameraOverride(camera) {
    this.cartCamera = camera;
  }
  /**
   * First-person mode: when true, the cart's 2D frame is composited as a HUD over
   * the 3D scene instead of the meshes being drawn over the 2D. The player sets it
   * each frame from the decoded mesh-camera HUD flag.
   */
  setHudMode(on) {
    this.hud = on;
  }
  /**
   * Set the per-instance poses a cart published this frame (empty to leave every
   * instance at its authored transform). The player calls this each frame from the
   * decoded mesh-pose mailbox; a pose composes on top of the instance's authored
   * placement, and a hidden pose drops the instance from the frame.
   */
  setPoseOverrides(poses) {
    this.poses = poses;
  }
  /**
   * Where a top-level object has been moved to this frame — by its physics
   * body, by being spawned, or by the cart posing it — whether or not it's
   * drawn; null when it's where it was placed (or its pose hides it).
   * Spatial loading measures a moving object here rather than where it began.
   */
  movedModel(i) {
    const body = this.bodies.get(i);
    if (body) return body;
    const spawnAt = this.pooledRoot[i] === i ? this.spawned.get(i) : void 0;
    const pose = this.poses.find((p) => p.index === i);
    if (pose?.hidden) return spawnAt ?? null;
    const base = spawnAt ?? this.instances[i]?.model;
    if (!base) return null;
    return pose ? multiplyMat43(base, poseLocalMatrix(pose)) : spawnAt ?? null;
  }
  /**
   * The world-space point lights the cart published this frame (`cartbox.light3d`
   * — an objective's glow, a muzzle flash). They light a first-person view on
   * top of the authored rig's lights.
   */
  setCartLights(lights) {
    this.cartLights = lights.map((light) => ({ kind: "point", position: light.position, color: light.color, intensity: 1, range: light.range }));
  }
  /** Report per-pass times to `profiler` (null: stop). */
  setProfiler(profiler) {
    this.profiler = profiler;
  }
  /** What the renderer drew last frame. */
  renderStats() {
    return this.renderer.lastFrameStats ?? null;
  }
  /** Bytes the scene keeps for drawing (geometry, textures, targets), estimated. */
  sceneBytes() {
    return estimateSceneBytes(this.instances, this.width, this.height);
  }
  blit(rgba) {
    const started = performance.now();
    const profiler = this.profiler;
    if (this.hud) {
      if (!this.hudFrame) this.hudFrame = new Uint8ClampedArray(this.width * this.height * 4);
      this.hudFrame.set(rgba);
    } else {
      this.output.set(rgba);
    }
    const scale = this.renderScale();
    const target = scale === 1 ? null : this.lowTarget(scale);
    const width = target ? target.width : this.width;
    const height = target ? target.height : this.height;
    const out = target ? target.out : this.output;
    const depth = target ? target.depth : this.depth;
    const cart = this.cartCamera;
    const camera = cart ? buildOrbitCamera(this.scene.bounds, cart.yaw, cart.pitch, this.width / this.height, {
      fov: cart.fov ?? void 0,
      distance: cart.distance,
      targetOffset: cart.target,
      // First-person (HUD) views put the eye inside the scene: a tight near
      // plane keeps the held weapon and adjacent walls from being clipped.
      near: this.hud ? FIRST_PERSON_NEAR : void 0,
      extent: this.scene.extent
    }) : this.autoOrbitCamera();
    const v = camera.view;
    this.lastView = v;
    this.eye = [-(v[0] * v[12] + v[1] * v[13] + v[2] * v[14]), -(v[4] * v[12] + v[5] * v[13] + v[6] * v[14]), -(v[8] * v[12] + v[9] * v[13] + v[10] * v[14])];
    const { main: instances, front, moved } = this.posedInstances();
    const lighting = this.scene.lighting;
    let mark = profiler ? performance.now() : 0;
    const shadow = lighting ? this.buildShadow(instances, moved, lighting) : null;
    if (profiler) {
      const now = performance.now();
      profiler.add("shadow", now - mark);
      mark = now;
    }
    const rig = this.hud && this.cartLights.length > 0 ? [...lighting?.lights ?? [], ...this.cartLights] : lighting?.lights;
    const local = lighting?.shadows && this.quality.shadows && rig ? this.buildLocalShadows(rig, moved) : null;
    const lights = local ? local.lights : rig;
    const skyBackdrop = this.hud && this.skyMap !== null;
    if (skyBackdrop) this.paintSky(out, width, height, camera.view, camera.projection, target ? 1 : SKY_BACKDROP_SCALE);
    if (profiler) {
      const now = performance.now();
      profiler.add("sky", now - mark);
      mark = now;
    }
    let drawn = this.foliage.size > 0 ? instances.filter((i) => this.foliageInReach(i)) : instances;
    if (this.decals) {
      this.decals.step(1 / 60);
      const marks = this.decals.sceneInstance();
      if (marks) drawn = [...drawn, marks];
    }
    if (this.debris) {
      this.debris.step(1 / 60, this.debrisBoxes);
      const pieces = this.debris.instances();
      if (pieces.length > 0) drawn = [...drawn, ...pieces.map((p) => ({ ...this.debrisLooks.get(p.mesh) ?? {}, ...p }))];
    }
    if (this.particles) {
      this.particles.step(1 / 60);
      const particles = this.particles.instanceFor([-v[2], -v[6], -v[10]], [v[1], v[5], v[9]]);
      if (particles) drawn = [...drawn, particles];
    }
    this.renderer.render(drawn, {
      width,
      height,
      out,
      depth,
      view: camera.view,
      projection: camera.projection,
      // Objects with LOD levels (EP9b) draw the one their distance calls for.
      lod: true,
      // HUD mode fills the frame with a sky so the 3D scene is opaque before the
      // HUD lands on top; third-person keeps the cart frame behind the meshes.
      background: this.hud && !skyBackdrop ? HUD_SKY : null,
      ...lighting ? {
        ambient: lighting.ambient,
        lightDirection: sceneLightingKeyDirection(lighting),
        environment: this.environment,
        tonemap: sceneLightingTonemap(lighting),
        lights,
        localShadows: local?.shadows ?? null,
        shadow,
        fog: lighting.fog ?? null
      } : {},
      // Animated emissive runs on the frame clock (60 per second), so it
      // steps with the game rather than the wall clock.
      time: this.frame / 60
    });
    if (this.onSun) this.reportSun(out, width, height, camera.view, camera.projection, skyBackdrop ? lighting?.sky ?? null : null);
    if (skyBackdrop && lighting?.shafts && lighting.sky && this.skyCache) {
      const sun = sunScreenPosition(lighting.sky.sunDirection, camera.view, camera.projection, width, height);
      if (sun) {
        this.shaftScratch ?? (this.shaftScratch = { mask: new Float32Array(0), light: new Float32Array(0) });
        applySunShafts(out, this.skyCache.pixels, width, height, sun, lighting.sky.sunColor, lighting.shafts, this.shaftScratch);
      }
    }
    if (front.length > 0) {
      this.frontRenderer.render(front, {
        width,
        height,
        out,
        depth,
        view: camera.view,
        projection: camera.projection,
        background: null,
        ...lighting ? {
          ambient: lighting.ambient,
          lightDirection: sceneLightingKeyDirection(lighting),
          environment: this.environment,
          tonemap: sceneLightingTonemap(lighting),
          lights
        } : {},
        time: this.frame / 60
      });
    }
    if (profiler) profiler.add("scene", performance.now() - mark);
    if (target) expandNearest(target.out, target.width, target.height, this.output, this.width, this.height);
    if (this.hud && this.hudFrame) compositeHudOverScene(this.output, this.hudFrame, this.width * this.height);
    this.frame += 1;
    this.inner.blit(this.presented);
    this.pace(performance.now() - started);
  }
  /** Report the sun to {@link onSun}: its place on screen and its eased visibility. */
  reportSun(out, width, height, view, projection, sky) {
    const backdrop = this.skyCache?.pixels ?? null;
    if (!sky || !backdrop) {
      this.sunSeen = 0;
      this.onSun?.(null);
      return;
    }
    const sun = sunScreenPosition(sky.sunDirection, view, projection, width, height);
    const target = sun ? sunVisibility(out, backdrop, width, height, sun) : 0;
    if (sun) this.sunAt = { x: sun.x / width, y: sun.y / height };
    this.sunSeen += (target - this.sunSeen) * SUN_EASE;
    if (this.sunSeen < 1e-3) this.sunSeen = 0;
    this.onSun?.({ x: this.sunAt.x, y: this.sunAt.y, visible: this.sunSeen });
  }
  /** Paint the sky backdrop, or copy it from last frame when the view direction hasn't changed. */
  paintSky(out, width, height, view, projection, scale) {
    const key = [width, height, scale, view[0], view[1], view[2], view[4], view[5], view[6], view[8], view[9], view[10], projection[0], projection[5]].map((n) => Math.round(n * 1e5)).join(",");
    const cache = this.skyCache;
    if (cache && cache.key === key && cache.pixels.length === width * height * 4) {
      out.set(cache.pixels);
      return;
    }
    renderSkyBackground(out, width, height, view, projection, this.skyMap, 8, scale);
    const pixels = cache && cache.pixels.length === width * height * 4 ? cache.pixels : new Uint8ClampedArray(width * height * 4);
    pixels.set(out.subarray(0, width * height * 4));
    this.skyCache = { key, pixels };
  }
  /** The 3D render scale this frame: 1, unless the software governor has stepped down. */
  renderScale() {
    if (!this.governed()) return 1;
    return Math.min(SOFTWARE_SCALES[this.scaleStep], this.quality.maxRenderScale);
  }
  /** Whether the resolution governor applies: a large first-person view on the CPU rasteriser. */
  governed() {
    return this.options.adaptiveResolution !== false && this.hud && this.renderer.backend === "software" && this.width * this.height >= 640 * 360;
  }
  /** Step the software render scale by how long frames are taking. */
  pace(ms) {
    if (!this.governed()) return;
    this.frameMs = this.framesAtStep === 0 ? ms : this.frameMs * 0.9 + ms * 0.1;
    this.framesAtStep += 1;
    if (this.frameMs > SLOW_FRAME_MS && this.framesAtStep >= 4 && this.scaleStep < SOFTWARE_SCALES.length - 1) {
      this.scaleStep += 1;
      this.framesAtStep = 0;
    } else if (this.frameMs < FAST_FRAME_MS && this.framesAtStep >= 120 && this.scaleStep > 0) {
      this.scaleStep -= 1;
      this.framesAtStep = 0;
    }
  }
  /** Scratch buffers for a reduced-size render. */
  lowTarget(scale) {
    const width = Math.max(1, Math.round(this.width * scale));
    const height = Math.max(1, Math.round(this.height * scale));
    if (!this.low || this.low.width !== width || this.low.height !== height) {
      this.low = { width, height, out: new Uint8ClampedArray(width * height * 4), depth: new Float32Array(width * height) };
    }
    return this.low;
  }
  /**
   * The instances to draw this frame. With no poses, the authored set (the fast,
   * allocation-free path). Otherwise each authored instance with any matching
   * pose composed on top — a hidden pose drops it; a pose's `frame` swaps in one
   * of its animation frames, `tint` recolours its tintable materials, and `front`
   * moves it to the front layer. A pose's transform is applied in the instance's
   * LOCAL space (authored · pose), so a cart moves an object relative to where
   * the editor placed it. `moved` lists the posed main-layer instances — the
   * only part of the shadow map that has to be redrawn each frame.
   */
  posedInstances() {
    if (this.poses.length === 0 && this.bodies.size === 0 && this.spawned.size === 0 && this.animated.size === 0 && this.effects.size === 0) {
      this.lastPlacement = null;
      return { main: this.unpooled, front: [], moved: [] };
    }
    if (this.hierarchy) return this.posedHierarchy(this.hierarchy);
    if (this.bodies.size > 0 || this.spawned.size > 0 || this.animated.size > 0 || this.effects.size > 0 || this.unpooled !== this.instances) {
      this.flat ?? (this.flat = {
        parents: this.instances.map(() => -1),
        children: this.instances.map(() => []),
        locals: this.instances.map((instance) => instance.model)
      });
      return this.posedHierarchy(this.flat);
    }
    const main = [];
    const front = [];
    const moved = [];
    for (let i = 0; i < this.instances.length; i += 1) {
      const authored = this.instances[i];
      const pose = this.poses.find((p) => p.index === i);
      if (!pose) {
        main.push(this.atDetail(i, authored));
        continue;
      }
      if (pose.hidden) continue;
      const frames = this.frames[i];
      const frame = pose.frame ?? 0;
      const source = frame > 0 && frames && frames.length > 0 ? frames[(frame - 1) % frames.length] : authored;
      const instance = {
        ...source,
        ...pose.tint ? this.tintedLook(source, pose.tint) : {},
        model: multiplyMat43(authored.model, poseLocalMatrix(pose))
      };
      if (pose.front) {
        front.push(instance);
      } else {
        main.push(instance);
        if (!this.scene.instances[i]?.terrain) moved.push(instance);
      }
    }
    return { main, front, moved };
  }
  /**
   * {@link posedInstances} for a scene with parents. A child follows its parent:
   * its world matrix is the parent's (posed) world matrix times its own local
   * transform, then its own pose. Hiding a parent hides its children and putting
   * it on the front layer brings them along; anything under a posed object counts
   * as moved for the shadow cache. Unposed objects under unposed parents keep
   * their baked world matrix.
   */
  posedHierarchy(h) {
    const byIndex = /* @__PURE__ */ new Map();
    for (const pose of this.poses) if (!byIndex.has(pose.index)) byIndex.set(pose.index, pose);
    const states = new Array(this.instances.length);
    const state = (i) => {
      const done = states[i];
      if (done) return done;
      const p = h.parents[i] ?? -1;
      const up = p >= 0 ? state(p) : null;
      const pose = byIndex.get(i);
      const body = this.bodies.get(i);
      const poolRoot = this.pooledRoot[i] ?? -1;
      const reserved = poolRoot >= 0 && !this.spawned.has(poolRoot);
      const spawnAt = poolRoot === i ? this.spawned.get(i) : void 0;
      const moved2 = Boolean(pose) || Boolean(up?.moved) || Boolean(body) || Boolean(spawnAt) || this.animated.has(i);
      let model = this.instances[i].model;
      if (moved2) {
        const base = body ?? spawnAt ?? (up ? multiplyMat43(up.model, h.locals[i]) : h.locals[i]);
        model = pose ? multiplyMat43(base, poseLocalMatrix(pose)) : base;
      }
      const out = {
        model,
        moved: moved2,
        hidden: reserved || this.inactive.has(i) || Boolean(pose?.hidden) || Boolean(up?.hidden),
        front: Boolean(pose?.front) || Boolean(up?.front),
        // A shield effect covers the object and everything under it (its weapon, say).
        effect: this.effects.get(i) ?? up?.effect ?? null
      };
      states[i] = out;
      return out;
    };
    const main = [];
    const front = [];
    const moved = [];
    const placement = new Array(this.instances.length);
    for (let i = 0; i < this.instances.length; i += 1) {
      const authored = this.instances[i];
      const s = state(i);
      placement[i] = s.hidden ? null : s.model;
      if (s.hidden) continue;
      if (!s.moved) {
        main.push(s.effect ? { ...this.atDetail(i, authored), effect: s.effect } : this.atDetail(i, authored));
        continue;
      }
      const pose = byIndex.get(i);
      const frames = this.frames[i];
      const frame = pose?.frame ?? 0;
      const source = frame > 0 && frames && frames.length > 0 ? frames[(frame - 1) % frames.length] : this.atDetail(i, authored);
      const instance = {
        ...source,
        ...pose?.tint ? this.tintedLook(source, pose.tint) : {},
        model: s.model,
        ...s.effect ? { effect: s.effect } : {}
      };
      if (s.front) front.push(instance);
      else {
        main.push(instance);
        if (!this.scene.instances[i]?.terrain) moved.push(instance);
      }
    }
    this.lastPlacement = placement;
    return { main, front, moved };
  }
  /**
   * Each object's world matrix as last drawn, null where it was hidden (live
   * inspection). Before anything has moved, the authored placement.
   */
  /**
   * Each object's world matrix for the poses, bodies and spawns set so far this
   * frame (null = hidden), worked out now rather than read from the last draw —
   * what inverse kinematics aims with before the frame is skinned.
   */
  currentPlacements() {
    this.posedInstances();
    return this.placements();
  }
  placements() {
    return this.lastPlacement ?? this.instances.map((instance, i) => this.pooledRoot[i] >= 0 || this.inactive.has(i) ? null : instance.model);
  }
  /** A tinted instance's mesh and LOD levels (each level tinted alike). */
  tintedLook(source, tint) {
    const mesh = this.tinted(source.mesh, tint);
    const lod = source.lod;
    if (!lod) return { mesh };
    return { mesh, lod: { distances: lod.distances, meshes: lod.meshes.map((m) => this.tinted(m, tint)) } };
  }
  /** A tinted copy of `mesh`, cached so its identity (and any GPU upload) is stable. */
  tinted(mesh, tint) {
    let byTint = this.tintCache.get(mesh);
    if (!byTint) {
      byTint = /* @__PURE__ */ new Map();
      this.tintCache.set(mesh, byTint);
    }
    let out = byTint.get(tint);
    if (!out) {
      out = tintMesh(mesh, tint);
      byTint.set(tint, out);
    }
    return out;
  }
  /** Where the camera was last drawn from and which way it looked: what the scene's sound hears from (EP12). */
  listenerPose() {
    const v = this.lastView;
    if (!v || !this.eye) return null;
    return { eye: this.eye, forward: [-v[2], -v[6], -v[10]], up: [v[1], v[5], v[9]] };
  }
  /** Where the camera was last drawn from (null before the first frame). */
  eyePosition() {
    return this.eye;
  }
  /** Whether an instance is in reach of the eye: anything but a foliage block is; a block is within its cull distance. */
  foliageInReach(instance) {
    const f2 = this.foliage.get(instance.mesh);
    if (!f2 || !this.eye) return true;
    const m = instance.model;
    const [x, y, z] = f2.center;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    return Math.hypot(cx - this.eye[0], cy - this.eye[1], cz - this.eye[2]) - f2.radius < f2.cull * this.quality.terrainDetail;
  }
  /**
   * A terrain block at the detail its distance from the eye calls for: full
   * within its `detail` range, half out to twice that, quarter beyond. Anything
   * else is returned as it is.
   */
  atDetail(i, authored) {
    const detail = this.scene.instances[i]?.detail;
    const lods = this.frames[i];
    if (!detail || !lods || lods.length === 0 || !this.eye) return authored;
    let b = this.blockBounds.get(i);
    if (!b) {
      const m = authored.model;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const primitive of authored.mesh.primitives) {
        const p = primitive.positions;
        for (let k = 0; k < p.length; k += 3) {
          const x = m[0] * p[k] + m[4] * p[k + 1] + m[8] * p[k + 2] + m[12];
          const y = m[1] * p[k] + m[5] * p[k + 1] + m[9] * p[k + 2] + m[13];
          const z = m[2] * p[k] + m[6] * p[k + 1] + m[10] * p[k + 2] + m[14];
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          z0 = Math.min(z0, z);
          z1 = Math.max(z1, z);
        }
      }
      b = [x0, y0, z0, x1, y1, z1];
      this.blockBounds.set(i, b);
    }
    const [ex, ey, ez] = this.eye;
    const d = Math.hypot(Math.max(b[0] - ex, 0, ex - b[3]), Math.max(b[1] - ey, 0, ey - b[4]), Math.max(b[2] - ez, 0, ez - b[5]));
    const reach = detail * this.quality.terrainDetail;
    const level = d < reach ? 0 : d < reach * 2 ? 1 : 2;
    if (level === 0) return authored;
    return { ...lods[Math.min(level, lods.length) - 1], model: authored.model };
  }
  /** The engine's gentle auto-orbit round the scene, kept above any terrain. */
  autoOrbitCamera() {
    const yaw = this.frame * AUTO_ORBIT_YAW_PER_FRAME;
    const pitch = orbitPitchAboveTerrain(this.scene, yaw, AUTO_ORBIT_PITCH);
    return buildOrbitCamera(this.scene.bounds, yaw, pitch, this.width / this.height, { extent: this.scene.extent });
  }
  /**
   * Render the scene's directional shadow map for this frame, or null when the
   * rig has shadows off / no directional light.
   *
   * Everything the cart did not pose this frame is static, so its depth is
   * rendered once and cached; each frame copies that cache and rasterises only
   * the posed (`moved`) instances over it. The cache is rebuilt when the set of
   * posed instances changes. For an arena whose map never moves, this turns a
   * full-scene shadow pass per frame into a memcpy plus a few characters.
   */
  buildShadow(instances, moved, lighting) {
    if (!lighting.shadows || !this.quality.shadows) return null;
    const size = this.quality.shadowMapSize || SHADOW_MAP_SIZE;
    const { center, radius } = this.scene.bounds;
    const key = this.staticShadowKey();
    const still = () => this.stillCasters();
    const extent = this.scene.extent;
    const reach = extent && this.scene.instances.some((inst) => inst.casts) ? Math.max(0, extent.radius * 2 - radius * 2) : 0;
    const far = this.renderShadowLayer(this.farShadow, key, still, moved, lighting, center, radius, size, reach);
    if (!far) return null;
    let near = null;
    const nearRadius = Math.min(NEAR_CASCADE_MAX, Math.max(NEAR_CASCADE_MIN, radius * NEAR_CASCADE_SHARE));
    if (this.quality.shadowCascades && this.eye && nearRadius < radius * 0.7) {
      const step = nearRadius / 2;
      const c = [Math.round(this.eye[0] / step) * step, Math.round(this.eye[1] / step) * step, Math.round(this.eye[2] / step) * step];
      const built = this.renderShadowLayer(this.nearShadow, `${key}|${c.join(",")}`, still, moved, lighting, c, nearRadius, size, Math.max(reach, radius * 2));
      if (built) near = { lightViewProj: built.lightViewProj, depth: built.depth, bias: built.bias ?? 3e-3, slopeBias: built.slopeBias ?? 0, dirty: built.dirty };
    }
    return { ...far, near };
  }
  /**
   * What the static shadow maps depend on: *which* instances are posed (not
   * whether a posed one is hidden this frame — a character dying must not
   * re-render the whole arena's shadow); a held weapon never casts, so
   * anything ever posed in front is out too.
   */
  staticShadowKey() {
    for (const i of this.withChildren(this.poses.filter((p) => p.front).map((p) => p.index))) this.everFront.add(i);
    return `${this.poses.filter((p) => !p.front).map((p) => p.index).sort((a, b) => a - b).join(",")}|${[...this.everFront].sort((a, b) => a - b).join(",")}|${[...this.bodies.keys()].join(",")}|${[...this.live.keys()].join(",")}|${this.inactiveKey}`;
  }
  /** Everything that casts and never moves: what the static shadow maps hold. */
  stillCasters() {
    const posed = this.withChildren([...this.poses.map((p) => p.index), ...this.bodies.keys(), ...this.live.keys()]);
    this.pooledRoot.forEach((root, i) => {
      if (root >= 0) posed.add(i);
    });
    const casts = (i) => !this.scene.instances[i]?.terrain || this.scene.instances[i]?.casts === true;
    return this.instances.filter((_, i) => !posed.has(i) && !this.everFront.has(i) && !this.inactive.has(i) && casts(i));
  }
  /**
   * Shadows from the spot and point lights that cast (EP8c): each light's
   * tiles of everything still, cached until the light or the still set
   * changes, copied each frame with the movers drawn over them. Returns the
   * lights with their tiles assigned, or null when none casts.
   */
  buildLocalShadows(lights, moved) {
    const assigned = assignLocalShadowTiles(lights);
    if (assigned.tiles === 0) return null;
    const statics = this.staticShadowKey();
    const tiles = [];
    let slot = 0;
    for (const light of assigned.lights) {
      if (light.shadowTile === void 0) continue;
      const key = `${JSON.stringify([light.kind, light.position, light.direction, light.range, light.innerAngle, light.outerAngle])}|${statics}`;
      let cache = this.localShadowCache[slot];
      if (!cache || cache.key !== key) {
        const built = renderLocalShadow(light, this.stillCasters());
        cache = { key, statics: built.map((t) => t.depth), frames: built.map((t) => new Float32Array(t.depth.length)) };
        this.localShadowCache[slot] = cache;
      }
      cache.frames.forEach((frame, i) => frame.set(cache.statics[i]));
      tiles.push(...renderLocalShadow(light, moved, cache.frames, false));
      slot += 1;
    }
    this.localShadowCache.length = slot;
    return { lights: assigned.lights, shadows: { tiles, bias: LOCAL_SHADOW_BIAS, slopeBias: LOCAL_SHADOW_SLOPE_BIAS } };
  }
  /**
   * One shadow map for this frame: the layer's cached static depth (redrawn
   * when `key` or the rig changes), copied, with this frame's movers drawn over
   * it — and the texels that changed since last frame, for a GPU's partial upload.
   */
  renderShadowLayer(layer, key, still, moved, lighting, center, radius, size, reach) {
    let full = false;
    if (!layer.staticDepth || layer.key !== key || layer.lighting !== lighting) {
      layer.staticDepth ?? (layer.staticDepth = new Float32Array(size * size));
      const built = buildSceneShadow(still(), lighting, center, radius, { size, depth: layer.staticDepth, reach });
      if (!built) return null;
      layer.matrix = built.lightViewProj;
      layer.key = key;
      layer.lighting = lighting;
      full = true;
    }
    const base = layer.staticDepth;
    if (full || !layer.depth) {
      layer.depth ?? (layer.depth = new Float32Array(size * size));
      layer.depth.set(base);
      full = true;
    } else {
      for (const r of layer.rects) {
        for (let y = r.y0; y < r.y1; y += 1) layer.depth.set(base.subarray(y * size + r.x0, y * size + r.x1), y * size + r.x0);
      }
    }
    const rects = moved.map((instance) => this.shadowFootprint(instance, size, layer.matrix)).filter((r) => r !== null);
    const result = buildSceneShadow(moved, lighting, center, radius, { size, depth: layer.depth, clear: false, reach });
    if (!result) return null;
    let dirty = null;
    if (!full) {
      const all = [...layer.rects, ...rects];
      if (all.length === 0) dirty = { x: 0, y: 0, width: 0, height: 0 };
      else {
        const x0 = Math.min(...all.map((r) => r.x0));
        const y0 = Math.min(...all.map((r) => r.y0));
        dirty = { x: x0, y: y0, width: Math.max(...all.map((r) => r.x1)) - x0, height: Math.max(...all.map((r) => r.y1)) - y0 };
      }
    }
    layer.rects = rects;
    return { ...result, dirty };
  }
  /**
   * The shadow-map texels an instance can cover: its bounding box through the
   * light's (orthographic) projection, padded for filtering and rounding.
   */
  shadowFootprint(instance, size, m) {
    if (!m) return null;
    let b = instance.mesh.primitives.some((p) => p.dynamic) ? void 0 : this.meshBounds.get(instance.mesh);
    if (!b) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const primitive of instance.mesh.primitives) {
        const p = primitive.positions;
        for (let i = 0; i < p.length; i += 3) {
          x0 = Math.min(x0, p[i]);
          x1 = Math.max(x1, p[i]);
          y0 = Math.min(y0, p[i + 1]);
          y1 = Math.max(y1, p[i + 1]);
          z0 = Math.min(z0, p[i + 2]);
          z1 = Math.max(z1, p[i + 2]);
        }
      }
      b = [x0, y0, z0, x1, y1, z1];
      if (!instance.mesh.primitives.some((p) => p.dynamic)) this.meshBounds.set(instance.mesh, b);
    }
    if (!Number.isFinite(b[0])) return null;
    const mm = multiplyMat43(m, instance.model);
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (let c = 0; c < 8; c += 1) {
      const x = c & 1 ? b[3] : b[0];
      const y = c & 2 ? b[4] : b[1];
      const z = c & 4 ? b[5] : b[2];
      const w = mm[3] * x + mm[7] * y + mm[11] * z + mm[15];
      const nx = (mm[0] * x + mm[4] * y + mm[8] * z + mm[12]) / w;
      const ny = (mm[1] * x + mm[5] * y + mm[9] * z + mm[13]) / w;
      const tx = (nx * 0.5 + 0.5) * size;
      const ty = (1 - (ny * 0.5 + 0.5)) * size;
      sx0 = Math.min(sx0, tx);
      sx1 = Math.max(sx1, tx);
      sy0 = Math.min(sy0, ty);
      sy1 = Math.max(sy1, ty);
    }
    const pad = 2;
    const rect = {
      x0: Math.max(0, Math.floor(sx0) - pad),
      y0: Math.max(0, Math.floor(sy0) - pad),
      x1: Math.min(size, Math.ceil(sx1) + pad),
      y1: Math.min(size, Math.ceil(sy1) + pad)
    };
    return rect.x1 > rect.x0 && rect.y1 > rect.y0 ? rect : null;
  }
  destroy() {
    this.destroyed = true;
    this.inner.destroy();
  }
  /** Throw a copy of debris `debris` (see cartbox.debris). */
  throwDebris(debris, at, velocity, scale) {
    this.debris?.throw(debris, at, velocity, scale);
  }
  /** Lay decal `decal` on a surface (see cartbox.decal). */
  decal(decal, at, normal, scale) {
    this.decals?.lay(decal, at, normal, scale);
  }
  /** Fire particle effect `effect` (see cartbox.burst). */
  burst(effect, at, dir, scale) {
    this.particles?.burst(effect, at, dir, scale);
  }
};
function fillPlaceholders(mesh, images) {
  const slots = ["baseColorImage", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage", "lightmapImage", "detailImage", "blendImage"];
  let touched = false;
  const primitives = mesh.primitives.map((primitive) => {
    let material = primitive.material;
    for (const slot of slots) {
      const image = material[slot];
      const supplied = image?.ref ? images.get(image.ref) : void 0;
      if (supplied) {
        material = { ...material, [slot]: supplied };
        touched = true;
      }
    }
    return material === primitive.material ? primitive : { ...primitive, material };
  });
  return touched ? { ...mesh, primitives } : mesh;
}
async function decodeMeshTextures(mesh, decodeKtx2, cache) {
  const decode = (image) => image.mime === "image/ktx2" ? decodeKtx2(image.bytes) : decodeTexture(image.mime, image.bytes);
  const each = (pick) => Promise.all(
    mesh.primitives.map((primitive) => {
      const image = pick(primitive.material);
      if (!image || image.bytes.length === 0) return Promise.resolve(null);
      if (!cache) return decode(image);
      let entry = cache.get(image);
      if (!entry) {
        entry = decode(image);
        cache.set(image, entry);
      }
      return entry;
    })
  );
  const [textures, normalTextures, materialTextures, mrTextures, occlusionTextures, emissiveTextures, lightmapTextures, detailTextures, blendTextures] = await Promise.all([
    each((m) => m.baseColorImage),
    // base colour
    each((m) => m.normalImage),
    // per-pixel normals (option 2)
    each((m) => m.materialImage),
    // packed specular/roughness/emissive (option 2, slice 5)
    // PBR maps for the Modern tier — absent on fantasy materials, so the
    // rasteriser stays byte-identical there.
    each((m) => m.metallicRoughnessImage),
    each((m) => m.occlusionImage),
    each((m) => m.emissiveImage),
    // A baked light map (sampled with the second UV set).
    each((m) => m.lightmapImage),
    // A finely tiled detail map (materialEffects.ts).
    each((m) => m.detailImage),
    // The blend surface of a blended primitive (terrain snow over rock).
    each((m) => m.blendImage)
  ]);
  return {
    mesh,
    textures,
    normalTextures,
    materialTextures,
    mrTextures,
    occlusionTextures,
    emissiveTextures,
    ...lightmapTextures.some((t) => t !== null) ? { lightmapTextures } : {},
    ...detailTextures.some((t) => t !== null) ? { detailTextures } : {},
    ...blendTextures.some((t) => t !== null) ? { blendTextures } : {}
  };
}
var TINT_PALETTE = [
  [1, 1, 1],
  // 0: unused (no tint)
  [0.62, 0.15, 0.13],
  // 1 red
  [0.2, 0.33, 0.62],
  // 2 blue
  [0.26, 0.45, 0.2],
  // 3 green
  [0.8, 0.42, 0.12],
  // 4 orange
  [0.42, 0.22, 0.58],
  // 5 purple
  [0.78, 0.62, 0.2],
  // 6 gold
  [0.4, 0.27, 0.16],
  // 7 brown
  [0.85, 0.45, 0.6],
  // 8 pink
  [0.85, 0.86, 0.88],
  // 9 white
  [0.14, 0.14, 0.15],
  // 10 black
  [0.45, 0.5, 0.56],
  // 11 steel
  [0.15, 0.5, 0.52],
  // 12 teal
  [0.38, 0.4, 0.2],
  // 13 olive
  [0.45, 0.06, 0.1],
  // 14 crimson
  [0.5, 0.6, 0.45]
  // 15 sage
];
function liveLod(lod, live) {
  if (!lod || lod.meshes.length < 2) return null;
  if (!live) return lod;
  const levels = lod.meshes.slice(1).map((level) => ({ ...level, primitives: level.primitives.map((p, k) => ({ ...live.mesh.primitives[k], indices: p.indices })) }));
  return { distances: lod.distances, meshes: [live.mesh, ...levels] };
}
function lodSignature(lod) {
  return lod ? `${lod.distances.join(",")}|${lod.meshes.map((m) => m.primitives.map((p) => p.indices.length).join(".")).join(",")}` : "";
}
function tintMesh(mesh, tint) {
  const color = TINT_PALETTE[tint];
  if (!color || tint === 0) return mesh;
  return {
    name: mesh.name,
    primitives: mesh.primitives.map(
      (primitive) => primitive.material.tintable ? {
        ...primitive,
        material: {
          ...primitive.material,
          baseColorFactor: [color[0], color[1], color[2], primitive.material.baseColorFactor[3]]
        }
      } : primitive
    )
  };
}
async function decodeTexture(mime, bytes) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { width: image.width, height: image.height, data: image.data };
  } catch {
    return null;
  }
}
function expandNearest(src, sw, sh, dst, dw, dh) {
  const from = new Uint32Array(src.buffer, src.byteOffset, sw * sh);
  const to = new Uint32Array(dst.buffer, dst.byteOffset, dw * dh);
  const xs = new Int32Array(dw);
  for (let x = 0; x < dw; x += 1) xs[x] = Math.min(sw - 1, Math.floor(x * sw / dw));
  let lastRow = -1;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / dh));
    const row = y * dw;
    if (sy === lastRow) {
      to.copyWithin(row, row - dw, row);
      continue;
    }
    const srow = sy * sw;
    for (let x = 0; x < dw; x += 1) to[row + x] = from[srow + xs[x]];
    lastRow = sy;
  }
}
function sameMatrix(a, b) {
  for (let i = 0; i < 16; i += 1) if (Math.abs(a[i] - b[i]) > 1e-9) return false;
  return true;
}
function meshSignature(mesh) {
  return mesh.primitives.map((p) => {
    const scalars = {};
    const images = [];
    for (const [key, value] of Object.entries(p.material)) {
      if (key.endsWith("Image")) images.push(value ? value.bytes?.length ?? 0 : 0);
      else scalars[key] = value;
    }
    return `${p.positions.length}:${p.indices.length}:${JSON.stringify(scalars)}:${images.join(",")}`;
  }).join("|");
}

// src/world/worldScene.ts
import {
  projectionMatrix as projectionMatrix2,
  viewMatrix as viewMatrix2
} from "@cartbox/editor";
var CELL_WORLD = 1;
var HEIGHT_WORLD = 0.6;
var DEFAULT_FOV = 42 * Math.PI / 180;
var DEFAULT_YAW = Math.PI / 4;
var DEFAULT_PITCH = 0.62;
function parseWorldScene(raw) {
  if (!raw) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value;
  const cols = asInt(record.cols);
  const rows = asInt(record.rows);
  const tilesPerSide = asInt(record.tilesPerSide);
  if (cols <= 0 || rows <= 0 || tilesPerSide <= 0) return null;
  const rawCells = Array.isArray(record.cells) ? record.cells : [];
  if (rawCells.length !== cols * rows) return null;
  const cells = rawCells.map((cell) => {
    const c = cell ?? {};
    return { h: Math.max(0, asInt(c.h)), sprite: Math.max(0, asInt(c.sprite)) };
  });
  const rawBillboards = Array.isArray(record.billboards) ? record.billboards : [];
  const billboards = rawBillboards.map((bb) => {
    const b = bb ?? {};
    return {
      sprite: Math.max(0, asInt(b.sprite)),
      width: asFloat(b.width, 1),
      height: asFloat(b.height, 1)
    };
  });
  const rawProps = Array.isArray(record.props) ? record.props : [];
  const props = rawProps.map((pp) => {
    const p = pp ?? {};
    return {
      sprite: Math.max(0, asInt(p.sprite)),
      x: asFloat(p.x, 0),
      y: asFloat(p.y, 0),
      z: asFloat(p.z, 0),
      width: asFloat(p.width, 1),
      height: asFloat(p.height, 1)
    };
  });
  const camera = parseCamera(record.camera);
  return { cols, rows, tilesPerSide, cells, props, billboards, camera };
}
function parseCamera(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const c = value;
  return {
    yaw: asFloat(c.yaw, DEFAULT_YAW),
    pitch: asFloat(c.pitch, DEFAULT_PITCH),
    distance: asFloat(c.distance, 0),
    fov: asFloat(c.fov, 0)
  };
}
function asInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function asFloat(value, fallback) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function cellAt(scene, i, j) {
  if (i < 0 || j < 0 || i >= scene.cols || j >= scene.rows) return { h: -1, sprite: 0 };
  return scene.cells[j * scene.cols + i] ?? { h: 0, sprite: 0 };
}
function newPrimitive() {
  return { positions: [], normals: [], uvs: [], indices: [] };
}
function pushQuad(b, p0, p1, p2, p3, normal, uv) {
  const base = b.positions.length / 3;
  for (const p of [p0, p1, p2, p3]) b.positions.push(p[0], p[1], p[2]);
  for (let k = 0; k < 4; k += 1) b.normals.push(normal[0], normal[1], normal[2]);
  b.uvs.push(uv[0], uv[1], uv[2], uv[3], uv[4], uv[5], uv[6], uv[7]);
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function buildTerrainInstances(scene, textureFor) {
  const builders = /* @__PURE__ */ new Map();
  const builderFor = (sprite) => {
    let b = builders.get(sprite);
    if (!b) {
      b = newPrimitive();
      builders.set(sprite, b);
    }
    return b;
  };
  for (let j = 0; j < scene.rows; j += 1) {
    for (let i = 0; i < scene.cols; i += 1) {
      const cell = cellAt(scene, i, j);
      const b = builderFor(cell.sprite);
      const x0 = i * CELL_WORLD;
      const x1 = x0 + CELL_WORLD;
      const z0 = j * CELL_WORLD;
      const z1 = z0 + CELL_WORLD;
      const top = cell.h * HEIGHT_WORLD;
      pushQuad(
        b,
        [x0, top, z0],
        [x0, top, z1],
        [x1, top, z1],
        [x1, top, z0],
        [0, 1, 0],
        [0, 0, 0, 1, 1, 1, 1, 0]
      );
      const sides = [
        { di: 1, dj: 0 },
        { di: -1, dj: 0 },
        { di: 0, dj: 1 },
        { di: 0, dj: -1 }
      ];
      for (const { di, dj } of sides) {
        const neighbour = cellAt(scene, i + di, j + dj);
        const bottomH = Math.max(0, neighbour.h);
        if (bottomH >= cell.h) continue;
        const bottom = bottomH * HEIGHT_WORLD;
        let e0, e1, nrm;
        if (di === 1) {
          e0 = [x1, z0];
          e1 = [x1, z1];
          nrm = [1, 0, 0];
        } else if (di === -1) {
          e0 = [x0, z1];
          e1 = [x0, z0];
          nrm = [-1, 0, 0];
        } else if (dj === 1) {
          e0 = [x1, z1];
          e1 = [x0, z1];
          nrm = [0, 0, 1];
        } else {
          e0 = [x0, z0];
          e1 = [x1, z0];
          nrm = [0, 0, -1];
        }
        pushQuad(
          b,
          [e0[0], top, e0[1]],
          [e0[0], bottom, e0[1]],
          [e1[0], bottom, e1[1]],
          [e1[0], top, e1[1]],
          nrm,
          [0, 0, 0, 1, 1, 1, 1, 0]
        );
      }
    }
  }
  const instances = [];
  for (const [sprite, b] of builders) {
    if (b.indices.length === 0) continue;
    const mesh = primitiveToMesh(`terrain-${sprite}`, b);
    instances.push({ mesh, model: identityMat4(), textures: [textureFor(sprite)] });
  }
  return instances;
}
function primitiveToMesh(name, b) {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from(b.positions),
        normals: Float32Array.from(b.normals),
        uvs: Float32Array.from(b.uvs),
        indices: Uint32Array.from(b.indices),
        material: { name: "tile", baseColorFactor: [1, 1, 1, 1], baseColorImage: null }
      }
    ]
  };
}
function buildBillboardInstance(foot, width, height, camRight, camUp, texture) {
  const hw = width / 2;
  const rx = camRight[0] * hw;
  const ry = camRight[1] * hw;
  const rz = camRight[2] * hw;
  const ux = camUp[0] * height;
  const uy = camUp[1] * height;
  const uz = camUp[2] * height;
  const [fx, fy, fz] = foot;
  const bl = [fx - rx, fy - ry, fz - rz];
  const tl = [fx - rx + ux, fy - ry + uy, fz - rz + uz];
  const tr = [fx + rx + ux, fy + ry + uy, fz + rz + uz];
  const br = [fx + rx, fy + ry, fz + rz];
  const nrm = [
    camRight[1] * camUp[2] - camRight[2] * camUp[1],
    camRight[2] * camUp[0] - camRight[0] * camUp[2],
    camRight[0] * camUp[1] - camRight[1] * camUp[0]
  ];
  const b = newPrimitive();
  pushQuad(b, bl, tl, tr, br, nrm, [0, 0, 0, 1, 1, 1, 1, 0]);
  return { mesh: primitiveToMesh("billboard", b), model: identityMat4(), textures: [texture] };
}
function makeShadowTexture(size = 24) {
  const data = new Uint8ClampedArray(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const d = Math.hypot(dx, dy);
      const dither = (x + y) % 2 === 0 ? 0 : 0.5;
      if (d < 1 && 1 - d > dither) {
        const o = (y * size + x) * 4;
        data[o] = 16;
        data[o + 1] = 18;
        data[o + 2] = 26;
        data[o + 3] = 255;
      }
    }
  }
  return { width: size, height: size, data };
}
function buildShadowInstance(foot, radius, texture) {
  const [fx, fy, fz] = foot;
  const y = fy + 0.02;
  const b = newPrimitive();
  pushQuad(
    b,
    [fx - radius, y, fz - radius],
    [fx - radius, y, fz + radius],
    [fx + radius, y, fz + radius],
    [fx + radius, y, fz - radius],
    [0, 1, 0],
    [0, 0, 0, 1, 1, 1, 1, 0]
  );
  return { mesh: primitiveToMesh("shadow", b), model: identityMat4(), textures: [texture] };
}
function worldCenter(scene) {
  let maxH = 0;
  for (const c of scene.cells) maxH = Math.max(maxH, c.h);
  const cx = scene.cols * CELL_WORLD / 2;
  const cz = scene.rows * CELL_WORLD / 2;
  const cy = maxH * HEIGHT_WORLD / 2;
  const radius = Math.max(
    1e-3,
    0.5 * Math.hypot(scene.cols * CELL_WORLD, maxH * HEIGHT_WORLD, scene.rows * CELL_WORLD)
  );
  return { center: [cx, cy, cz], radius };
}
function buildWorldCamera(scene, spec, aspect) {
  const framed = worldCenter(scene);
  const radius = framed.radius;
  const center = spec.target ? [spec.target[0] * CELL_WORLD, spec.target[1] * HEIGHT_WORLD, spec.target[2] * CELL_WORLD] : framed.center;
  const fov = spec.fov > 0 ? spec.fov : DEFAULT_FOV;
  const distance = spec.distance > 0 ? spec.distance : radius / Math.sin(fov / 2) + radius;
  const cosPitch = Math.cos(spec.pitch);
  const eye = [
    center[0] + distance * cosPitch * Math.sin(spec.yaw),
    center[1] + distance * Math.sin(spec.pitch),
    center[2] + distance * cosPitch * Math.cos(spec.yaw)
  ];
  const view = viewMatrix2(eye, center, [0, 1, 0]);
  const projection = projectionMatrix2(fov, aspect, 0.05, distance + radius * 6);
  const right = [view[0], view[4], view[8]];
  const up = [view[1], view[5], view[9]];
  return { view, projection, right, up };
}
function defaultCameraSpec(scene) {
  return scene.camera ?? { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, distance: 0, fov: 0 };
}
function identityMat4() {
  return Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// src/world/WorldOverlaySurface.ts
var WorldOverlaySurface = class {
  constructor(inner, width, height, scene, textureFor, renderer = new SoftwareSceneRenderer()) {
    this.inner = inner;
    this.width = width;
    this.height = height;
    this.scene = scene;
    this.renderer = renderer;
    this.cartCamera = null;
    this.billboards = [];
    /** The cart's key light direction (points toward the sun), for terrain shading. */
    this.sunDirection = null;
    /** Shared soft contact-shadow texture, drawn under characters and props. */
    this.shadowTexture = makeShadowTexture();
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
    this.depth = new Float32Array(width * height);
    this.terrain = buildTerrainInstances(scene, textureFor);
    this.billboardTextures = scene.billboards.map((slot) => textureFor(slot.sprite));
    this.propTextures = scene.props.map((prop) => textureFor(prop.sprite));
  }
  /** Set the cart-driven camera for the next frame(s), or null to auto-frame. */
  setCameraOverride(camera) {
    this.cartCamera = camera;
  }
  /**
   * Set the key-light direction the terrain is shaded by (the cart's `cartbox.sun`,
   * pointing toward the light), or null to fall back to a default top-down key.
   * Colour is left to the post-FX grade, so this only steers the directional
   * light/shadow that makes the 3D blocks read as solid geometry.
   */
  setSun(direction) {
    this.sunDirection = direction;
  }
  /**
   * Set the billboard positions the cart published this frame. Reuses the mesh-pose
   * mailbox: each pose's index selects a billboard slot and its position places the
   * billboard's feet; a hidden or zero-scale pose drops the billboard.
   */
  setBillboards(poses) {
    this.billboards = poses.filter((pose) => !pose.hidden && pose.index < this.scene.billboards.length).map((pose) => ({
      index: pose.index,
      x: pose.position[0],
      y: pose.position[1],
      z: pose.position[2],
      scale: pose.scale
    }));
  }
  blit(rgba) {
    this.output.set(rgba);
    const spec = this.cameraSpec();
    const camera = buildWorldCamera(this.scene, spec, this.width / this.height);
    const shadowInstances = [];
    const propInstances = [];
    for (let i = 0; i < this.scene.props.length; i += 1) {
      const prop = this.scene.props[i];
      const foot = [prop.x * CELL_WORLD, prop.y * HEIGHT_WORLD, prop.z * CELL_WORLD];
      shadowInstances.push(buildShadowInstance(foot, prop.width * 0.42, this.shadowTexture));
      propInstances.push(
        buildBillboardInstance(foot, prop.width, prop.height, camera.right, camera.up, this.propTextures[i] ?? null)
      );
    }
    const billboardInstances = [];
    for (const pose of this.billboards) {
      if (pose.scale <= 0) continue;
      const slot = this.scene.billboards[pose.index];
      const texture = this.billboardTextures[pose.index] ?? null;
      const foot = [
        pose.x * CELL_WORLD,
        pose.y * HEIGHT_WORLD,
        pose.z * CELL_WORLD
      ];
      shadowInstances.push(buildShadowInstance(foot, slot.width * pose.scale * 0.42, this.shadowTexture));
      billboardInstances.push(
        buildBillboardInstance(foot, slot.width * pose.scale, slot.height * pose.scale, camera.right, camera.up, texture)
      );
    }
    const lit = this.sunDirection !== null;
    this.renderer.render([...this.terrain, ...shadowInstances, ...propInstances, ...billboardInstances], {
      width: this.width,
      height: this.height,
      out: this.output,
      depth: this.depth,
      view: camera.view,
      projection: camera.projection,
      background: null,
      lightDirection: this.sunDirection ?? void 0,
      ambient: lit ? 0.45 : 0.62
    });
    this.inner.blit(this.presented);
  }
  cameraSpec() {
    const base = defaultCameraSpec(this.scene);
    const cart = this.cartCamera;
    if (!cart) return base;
    const cartDistance = cart.distance ?? 0;
    const cartFov = cart.fov ?? 0;
    const t = cart.target;
    const hasTarget = Boolean(t && (t[0] !== 0 || t[1] !== 0 || t[2] !== 0));
    return {
      yaw: cart.yaw,
      pitch: cart.pitch,
      distance: cartDistance > 0 ? cartDistance : base.distance,
      fov: cartFov > 0 ? cartFov : base.fov,
      target: hasTarget ? t : null
    };
  }
  destroy() {
    this.inner.destroy();
  }
};

// src/render/WebglSceneRenderer.ts
import {
  DEFAULT_RASTER_STYLE as DEFAULT_RASTER_STYLE2,
  DETAIL_FAR,
  DETAIL_NEAR,
  LIGHTMAP_RANGE,
  MAX_REFLECTION_PROBES as MAX_REFLECTION_PROBES2,
  PROBE_FADE,
  FOG_GLOW_POWER,
  PROBE_RANGE,
  EFFECT_BAND_FREQUENCY,
  EFFECT_BAND_POWER,
  EFFECT_BAND_SPEED,
  EFFECT_CAMO_CRAWL,
  cameraPositionFromView as cameraPositionFromView2,
  compiledGraphOf,
  computeSmoothNormals,
  lightProbeTexels,
  LOCAL_SHADOW_GRID,
  LOCAL_SHADOW_TILE,
  MAX_LOCAL_SHADOW_TILES,
  NEAR_CASCADE_EDGE,
  CLUSTER_INDEX_CAP,
  CLUSTER_X,
  CLUSTER_Y,
  CLUSTER_Z,
  buildLightClusters,
  orderLights,
  graphNoiseSource,
  graphShaderCode,
  graphUsesNoise,
  multiplyMat4 as multiplyMat44
} from "@cartbox/editor";

// src/render/gpuFrame.ts
import { depthLinearTerms } from "@cartbox/editor";
var SOFTWARE_WARMUP_TRIANGLES = 2e4;
var SOFTWARE_WARMUP_PIXELS = 640 * 360;
var triangleCounts = /* @__PURE__ */ new WeakMap();
function trianglesIn(instances) {
  let total = 0;
  for (const instance of instances) {
    let count = triangleCounts.get(instance.mesh);
    if (count === void 0) {
      count = instance.mesh.primitives.reduce((n, primitive) => n + primitive.indices.length / 3, 0);
      triangleCounts.set(instance.mesh, count);
    }
    total += count;
  }
  return total;
}
function presentFrame(latest, visible, draw, software) {
  if (latest) {
    compositeFrame(latest, draw);
  } else if (draw.width * draw.height <= SOFTWARE_WARMUP_PIXELS && trianglesIn(visible) <= SOFTWARE_WARMUP_TRIANGLES) {
    software.render(visible, draw);
  } else if (draw.background !== null) {
    new Uint32Array(draw.out.buffer, draw.out.byteOffset, draw.width * draw.height).fill(packRgba(draw.background));
  }
}
function compositeFrame(latest, draw) {
  const count = draw.width * draw.height;
  const source = new Uint32Array(latest.buffer, latest.byteOffset, count);
  const out = new Uint32Array(draw.out.buffer, draw.out.byteOffset, count);
  if (draw.background !== null) out.fill(packRgba(draw.background));
  const bytes = draw.out;
  for (let i = 0; i < count; i += 1) {
    const word = source[i];
    const a = word >>> 24;
    if (a === 255) out[i] = word;
    else if (word !== 0) {
      const k = (255 - a) / 255;
      const o = i * 4;
      bytes[o] = (word & 255) + bytes[o] * k;
      bytes[o + 1] = (word >>> 8 & 255) + bytes[o + 1] * k;
      bytes[o + 2] = (word >>> 16 & 255) + bytes[o + 2] * k;
      bytes[o + 3] = a + bytes[o + 3] * k;
    }
  }
}
function packRgba([r, g, b, a]) {
  return (a << 24 | b << 16 | g << 8 | r) >>> 0;
}
function sameTextures(a, b) {
  return a.base === b.base && a.mr === b.mr && a.occ === b.occ && a.emis === b.emis && a.lm === b.lm && a.detail === b.detail && a.blend === b.blend;
}
function batchInstances(instances, geometryOf, eye = [0, 0, 0]) {
  const batches = [];
  const seeThrough = [];
  const byPrimitive = /* @__PURE__ */ new Map();
  let instanceCount = 0;
  for (const instance of instances) {
    const geometries = geometryOf(instance.mesh);
    instance.mesh.primitives.forEach((primitive, index) => {
      const geometry = geometries[index];
      if (!geometry || geometry.indexCount === 0) return;
      const textures = {
        base: instance.textures?.[index] ?? null,
        mr: instance.mrTextures?.[index] ?? null,
        occ: instance.occlusionTextures?.[index] ?? null,
        emis: instance.emissiveTextures?.[index] ?? null,
        lm: primitive.uvs2 ? instance.lightmapTextures?.[index] ?? null : null,
        detail: instance.detailTextures?.[index] ?? null,
        blend: primitive.blend ? instance.blendTextures?.[index] ?? null : null
      };
      const effect = instance.effect ?? null;
      const alpha = alphaCode(primitive.material.alphaMode);
      if (alpha >= 2) {
        const c = primitiveCentre(primitive);
        const m = instance.model;
        const x = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12] - eye[0];
        const y = m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13] - eye[1];
        const z = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14] - eye[2];
        seeThrough.push({ batch: { primitive, geometry, textures, models: [instance.model], effect, alpha, first: 0 }, distance: x * x + y * y + z * z });
        instanceCount += 1;
        return;
      }
      let list = byPrimitive.get(primitive);
      if (!list) byPrimitive.set(primitive, list = []);
      let batch = list.find((b) => b.effect === effect && sameTextures(b.textures, textures));
      if (!batch) {
        batch = { primitive, geometry, textures, models: [], effect, alpha, first: 0 };
        list.push(batch);
        batches.push(batch);
      }
      batch.models.push(instance.model);
      instanceCount += 1;
    });
  }
  seeThrough.sort((a, b) => b.distance - a.distance);
  for (const { batch } of seeThrough) batches.push(batch);
  return { batches, instanceCount };
}
function alphaCode(mode) {
  return mode === "mask" ? 1 : mode === "blend" ? 2 : mode === "additive" ? 3 : 0;
}
function softEdges(material, alpha, projection) {
  const distance = alpha >= 2 ? material.softDepth ?? 0 : 0;
  if (!(distance > 0) || projection[15] !== 0) return void 0;
  return { distance, linear: depthLinearTerms(projection) };
}
var centres = /* @__PURE__ */ new WeakMap();
function primitiveCentre(primitive) {
  let c = centres.get(primitive);
  if (!c) {
    const p = primitive.positions;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      x0 = Math.min(x0, p[i]);
      x1 = Math.max(x1, p[i]);
      y0 = Math.min(y0, p[i + 1]);
      y1 = Math.max(y1, p[i + 1]);
      z0 = Math.min(z0, p[i + 2]);
      z1 = Math.max(z1, p[i + 2]);
    }
    c = Number.isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] : [0, 0, 0];
    centres.set(primitive, c);
  }
  return c;
}

// src/render/gpuTimer.ts
var WebgpuPassTimer = class _WebgpuPassTimer {
  constructor(device) {
    this.lastMs = null;
    this.reading = false;
    this.copied = false;
    this.querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    this.resolveBuffer = device.createBuffer({ size: 16, usage: 512 | 4 });
    this.readBuffer = device.createBuffer({ size: 16, usage: 8 | 1 });
  }
  /** A timer, when the device was created with `timestamp-query`. */
  static create(device) {
    try {
      return device?.features?.has?.("timestamp-query") ? new _WebgpuPassTimer(device) : null;
    } catch {
      return null;
    }
  }
  /**
   * The render pass descriptor's `timestampWrites`. A frame drawn in two passes
   * times from the first's beginning (`"begin"`) to the second's end (`"end"`).
   */
  writes(part = "both") {
    if (part === "begin") return { querySet: this.querySet, beginningOfPassWriteIndex: 0 };
    if (part === "end") return { querySet: this.querySet, endOfPassWriteIndex: 1 };
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }
  /** After the pass ends: resolve its timestamps (and copy them out unless the last copy is still being read). */
  resolve(encoder) {
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    if (this.reading) return;
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, 16);
    this.copied = true;
  }
  /** After submitting: read the copied timestamps back. */
  read() {
    if (!this.copied) return;
    this.copied = false;
    this.reading = true;
    this.readBuffer.mapAsync(1).then(() => {
      const t = new BigUint64Array(this.readBuffer.getMappedRange().slice(0));
      this.readBuffer.unmap();
      const ns = Number(t[1] - t[0]);
      if (ns > 0 && ns < 1e10) this.lastMs = ns / 1e6;
    }).catch(() => {
    }).finally(() => {
      this.reading = false;
    });
  }
  destroy() {
    this.querySet?.destroy?.();
    this.resolveBuffer?.destroy?.();
    this.readBuffer?.destroy?.();
  }
};
var WebglPassTimer = class _WebglPassTimer {
  constructor(gl, ext) {
    this.gl = gl;
    this.ext = ext;
    this.lastMs = null;
    this.pending = [];
    this.free = [];
    this.active = false;
  }
  static create(gl) {
    try {
      const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
      return ext ? new _WebglPassTimer(gl, ext) : null;
    } catch {
      return null;
    }
  }
  begin() {
    this.poll();
    if (this.pending.length >= 4) return;
    const query = this.free.pop() ?? this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.pending.push(query);
    this.active = true;
  }
  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  }
  /** Take finished results, oldest first. */
  poll() {
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT);
      if (!disjoint && ns > 0) this.lastMs = ns / 1e6;
      this.free.push(this.pending.shift());
    }
  }
  destroy() {
    for (const query of [...this.pending, ...this.free]) this.gl.deleteQuery(query);
  }
};

// src/render/scenePacking.ts
import {
  DEFAULT_DETAIL_SCALE,
  DEFAULT_DETAIL_STRENGTH,
  EFFECT_RIM_POWER,
  MAX_FOG_VOLUMES,
  MAX_REFLECTION_PROBES,
  effectActive,
  emissiveAnimation,
  spotCone,
  fogIsVolumetric
} from "@cartbox/editor";
var UNIFORM_STRIDE = 768;
var UNIFORM_BYTES_USED = 768;
var UNIFORM_FLOATS = UNIFORM_STRIDE / 4;
var LIGHT_FLOATS = 16;
var PROBE_FLOATS = 16;
function packProbes(set) {
  const probes = set ? set.probes.slice(0, MAX_REFLECTION_PROBES) : [];
  const out = new Float32Array(Math.max(1, probes.length) * PROBE_FLOATS);
  probes.forEach((p, i) => {
    const o = i * PROBE_FLOATS;
    out.set(p.min, o);
    out.set(p.max, o + 4);
    out.set(p.position, o + 8);
    out.set(p.average, o + 12);
  });
  return out;
}
function packLights(lights) {
  const out = new Float32Array(Math.max(1, lights.length) * LIGHT_FLOATS);
  lights.forEach((light, i) => {
    const base = i * LIGHT_FLOATS;
    const placed = light.kind !== "directional";
    const v = placed ? light.position ?? [0, 0, 0] : light.direction ?? [0, 1, 0];
    out[base] = v[0];
    out[base + 1] = v[1];
    out[base + 2] = v[2];
    out[base + 3] = light.kind === "spot" ? 2 : placed ? 1 : 0;
    out[base + 4] = light.color[0];
    out[base + 5] = light.color[1];
    out[base + 6] = light.color[2];
    out[base + 7] = light.intensity;
    out[base + 8] = light.range ?? 0;
    out[base + 11] = light.shadowTile ?? -1;
    if (light.kind === "spot") {
      const [cosOuter, cosInner] = spotCone(light);
      out[base + 9] = cosOuter;
      out[base + 10] = cosInner;
      const axis = light.direction ?? [0, -1, 0];
      const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      out[base + 12] = axis[0] / len;
      out[base + 13] = axis[1] / len;
      out[base + 14] = axis[2] / len;
    }
  });
  return out;
}
var OFFSET_MVP = 0;
var OFFSET_NRM = 16;
var OFFSET_BASE = 28;
var OFFSET_LIGHT = 32;
var OFFSET_VIEW = 36;
var OFFSET_PBR = 40;
var OFFSET_EMISSIVE = 44;
var OFFSET_TEXFLAGS = 48;
var OFFSET_ENV_SKY = 52;
var OFFSET_ENV_HORIZON = 56;
var OFFSET_ENV_GROUND = 60;
var OFFSET_LIGHT_MVP = 64;
var OFFSET_SHADOW = 80;
var OFFSET_ENV_META = 84;
var OFFSET_TONEMAP = 88;
var OFFSET_SSAO = 92;
var OFFSET_MODEL = 96;
var OFFSET_FOG = 112;
var OFFSET_FOG_PARAMS = 116;
var OFFSET_SHADOW2 = 120;
var OFFSET_SURFACE0 = 124;
var OFFSET_SURFACE1 = 128;
var OFFSET_SURFACE2 = 132;
var OFFSET_SURFACE3 = 136;
var OFFSET_FOG_CAM = 140;
var OFFSET_FOG_HEIGHT = 144;
var OFFSET_FOG_GLOW = 148;
var OFFSET_FOG_VOL = 152;
var OFFSET_EFFECT0 = 184;
var OFFSET_EFFECT1 = 188;
var DEFAULT_LIGHT = [0.4, 0.8, 0.6];
var DEFAULT_AMBIENT2 = 0.35;
function resolveLight(direction, ambient) {
  const [lx, ly, lz] = direction ?? DEFAULT_LIGHT;
  const length = Math.hypot(lx, ly, lz) || 1;
  return {
    direction: [lx / length, ly / length, lz / length],
    ambient: ambient ?? DEFAULT_AMBIENT2
  };
}
function alignBytesPerRow(width) {
  return Math.ceil(width * 4 / 256) * 256;
}
function normalBasis3x3(model) {
  return [model[0], model[1], model[2], model[4], model[5], model[6], model[8], model[9], model[10]];
}
function resolvePbr(material, hasMr, hasOcc, hasEmis) {
  const emissiveFactor = material.emissiveFactor;
  const isPbr = hasMr || hasOcc || hasEmis || material.metallicFactor !== void 0 || material.roughnessFactor !== void 0 || emissiveFactor !== void 0 && (emissiveFactor[0] > 0 || emissiveFactor[1] > 0 || emissiveFactor[2] > 0) || material.graph !== void 0;
  return {
    isPbr,
    metallic: material.metallicFactor ?? 1,
    roughness: material.roughnessFactor ?? 1,
    emissive: emissiveFactor ?? [0, 0, 0]
  };
}
function viewDirection(view) {
  const x = view[2];
  const y = view[6];
  const z = view[10];
  const length = Math.hypot(x, y, z);
  return length < 1e-8 ? [0, 0, 1] : [x / length, y / length, z / length];
}
var NO_SURFACE = { detailScale: DEFAULT_DETAIL_SCALE, detailStrength: 0, reflect: 1, reflectMask: false, emisOffset: [0, 0], emisGain: 1, rim: [0, 0, 0], rimPower: 1, blend: null };
function resolveSurface(material, time, hasDetail, hasMr, blend = { weights: false, textured: false }) {
  const { offset, gain } = emissiveAnimation(material, time);
  const rim = material.rim && material.rim.strength > 0 ? material.rim : null;
  return {
    detailScale: material.detailScale ?? DEFAULT_DETAIL_SCALE,
    detailStrength: hasDetail ? material.detailStrength ?? DEFAULT_DETAIL_STRENGTH : 0,
    reflect: material.reflectivity ?? 1,
    reflectMask: material.reflectionMask === true && hasMr,
    emisOffset: offset,
    emisGain: gain,
    rim: rim ? [rim.color[0] * rim.strength, rim.color[1] * rim.strength, rim.color[2] * rim.strength] : [0, 0, 0],
    rimPower: rim?.power ?? 1,
    blend: blend.weights ? { color: material.blendColor ?? [1, 1, 1], roughness: material.blendRoughness ?? null, textured: blend.textured } : null
  };
}
var INSTANCE_FLOATS = 60;
function writeInstanceTransform(target, index, transform3, base = index * INSTANCE_FLOATS) {
  for (let i = 0; i < 16; i += 1) {
    target[base + i] = transform3.mvp[i];
    target[base + 16 + i] = transform3.lightMvp ? transform3.lightMvp[i] : 0;
    target[base + 32 + i] = transform3.model[i];
  }
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) target[base + 48 + column * 4 + row] = transform3.normalBasis[column * 3 + row];
    target[base + 48 + column * 4 + 3] = 0;
  }
}
function writeInstanceUniform(target, index, uniform) {
  const base = index * UNIFORM_FLOATS;
  for (let i = 0; i < 16; i += 1) target[base + OFFSET_MVP + i] = uniform.mvp[i];
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      target[base + OFFSET_NRM + column * 4 + row] = uniform.normalBasis[column * 3 + row];
    }
  }
  target[base + OFFSET_BASE] = uniform.baseColor[0];
  target[base + OFFSET_BASE + 1] = uniform.baseColor[1];
  target[base + OFFSET_BASE + 2] = uniform.baseColor[2];
  target[base + OFFSET_BASE + 3] = uniform.baseColor[3];
  target[base + OFFSET_LIGHT] = uniform.light.direction[0];
  target[base + OFFSET_LIGHT + 1] = uniform.light.direction[1];
  target[base + OFFSET_LIGHT + 2] = uniform.light.direction[2];
  target[base + OFFSET_LIGHT + 3] = uniform.light.ambient;
  target[base + OFFSET_VIEW] = uniform.viewDir[0];
  target[base + OFFSET_VIEW + 1] = uniform.viewDir[1];
  target[base + OFFSET_VIEW + 2] = uniform.viewDir[2];
  target[base + OFFSET_VIEW + 3] = uniform.alpha?.cutoff ?? 0;
  target[base + OFFSET_PBR] = uniform.pbr.metallic;
  target[base + OFFSET_PBR + 1] = uniform.pbr.roughness;
  target[base + OFFSET_PBR + 2] = uniform.pbr.isPbr ? 1 : 0;
  target[base + OFFSET_PBR + 3] = uniform.alpha?.mode ?? 0;
  const surface = uniform.surface ?? NO_SURFACE;
  target[base + OFFSET_EMISSIVE] = uniform.pbr.emissive[0] * surface.emisGain;
  target[base + OFFSET_EMISSIVE + 1] = uniform.pbr.emissive[1] * surface.emisGain;
  target[base + OFFSET_EMISSIVE + 2] = uniform.pbr.emissive[2] * surface.emisGain;
  target[base + OFFSET_EMISSIVE + 3] = 0;
  target[base + OFFSET_TEXFLAGS] = uniform.hasTexture ? 1 : 0;
  target[base + OFFSET_TEXFLAGS + 1] = uniform.hasMrMap ? 1 : 0;
  target[base + OFFSET_TEXFLAGS + 2] = uniform.hasOcclusionMap ? 1 : 0;
  target[base + OFFSET_TEXFLAGS + 3] = uniform.hasEmissiveMap ? 1 : 0;
  const env = uniform.environment;
  target[base + OFFSET_ENV_SKY] = env ? env.sky[0] : 0;
  target[base + OFFSET_ENV_SKY + 1] = env ? env.sky[1] : 0;
  target[base + OFFSET_ENV_SKY + 2] = env ? env.sky[2] : 0;
  target[base + OFFSET_ENV_SKY + 3] = env ? 1 : 0;
  target[base + OFFSET_ENV_HORIZON] = env ? env.horizon[0] : 0;
  target[base + OFFSET_ENV_HORIZON + 1] = env ? env.horizon[1] : 0;
  target[base + OFFSET_ENV_HORIZON + 2] = env ? env.horizon[2] : 0;
  target[base + OFFSET_ENV_HORIZON + 3] = env ? env.intensity : 0;
  target[base + OFFSET_ENV_GROUND] = env ? env.ground[0] : 0;
  target[base + OFFSET_ENV_GROUND + 1] = env ? env.ground[1] : 0;
  target[base + OFFSET_ENV_GROUND + 2] = env ? env.ground[2] : 0;
  target[base + OFFSET_ENV_GROUND + 3] = 0;
  const lightMvp = uniform.lightMvp;
  for (let i = 0; i < 16; i += 1) target[base + OFFSET_LIGHT_MVP + i] = lightMvp ? lightMvp[i] : 0;
  const shadow = uniform.shadow;
  target[base + OFFSET_SHADOW] = shadow ? 1 : 0;
  target[base + OFFSET_SHADOW + 1] = shadow ? shadow.size : 0;
  target[base + OFFSET_SHADOW + 2] = shadow ? shadow.bias : 0;
  target[base + OFFSET_SHADOW + 3] = shadow ? shadow.strength : 0;
  const envMap = env && env.map ? env : null;
  const avg = envMap?.average ?? null;
  target[base + OFFSET_ENV_META] = avg ? avg[0] : 0;
  target[base + OFFSET_ENV_META + 1] = avg ? avg[1] : 0;
  target[base + OFFSET_ENV_META + 2] = avg ? avg[2] : 0;
  target[base + OFFSET_ENV_META + 3] = envMap && avg ? 1 : 0;
  const tonemap = uniform.tonemap;
  target[base + OFFSET_TONEMAP] = tonemap ? 1 : 0;
  target[base + OFFSET_TONEMAP + 1] = tonemap ? tonemap.exposure : 0;
  target[base + OFFSET_TONEMAP + 2] = uniform.soft?.distance ?? 0;
  target[base + OFFSET_TONEMAP + 3] = 0;
  target[base + OFFSET_SSAO] = uniform.hasSsao ? 1 : 0;
  target[base + OFFSET_SSAO + 1] = uniform.lightCount;
  target[base + OFFSET_SSAO + 2] = uniform.hasLightmap ? 1 : 0;
  target[base + OFFSET_SSAO + 3] = env?.probes ? Math.min(env.probes.probes.length, MAX_REFLECTION_PROBES) : 0;
  const model = uniform.model;
  for (let i = 0; i < 16; i += 1) target[base + OFFSET_MODEL + i] = model ? model[i] : i % 5 === 0 ? 1 : 0;
  const fog = uniform.fog ?? null;
  target[base + OFFSET_FOG] = fog ? fog.color[0] : 0;
  target[base + OFFSET_FOG + 1] = fog ? fog.color[1] : 0;
  target[base + OFFSET_FOG + 2] = fog ? fog.color[2] : 0;
  target[base + OFFSET_FOG + 3] = fog ? fog.density : 0;
  target[base + OFFSET_FOG_PARAMS] = fog ? 1 : 0;
  target[base + OFFSET_FOG_PARAMS + 1] = fog ? fog.start : 0;
  target[base + OFFSET_FOG_PARAMS + 2] = fog ? fog.max : 0;
  const volumetric = fog !== null && fogIsVolumetric(fog);
  target[base + OFFSET_FOG_PARAMS + 3] = volumetric ? 1 : 0;
  const eye = uniform.eye ?? [0, 0, 0];
  const layered = volumetric ? fog : null;
  const volumes = (layered?.volumes ?? []).slice(0, MAX_FOG_VOLUMES);
  const height = layered?.height ?? null;
  const glow = layered?.glow ?? null;
  target[base + OFFSET_FOG_CAM] = eye[0];
  target[base + OFFSET_FOG_CAM + 1] = eye[1];
  target[base + OFFSET_FOG_CAM + 2] = eye[2];
  target[base + OFFSET_FOG_CAM + 3] = volumes.length;
  target[base + OFFSET_FOG_HEIGHT] = height ? height.density : 0;
  target[base + OFFSET_FOG_HEIGHT + 1] = height ? height.base : 0;
  target[base + OFFSET_FOG_HEIGHT + 2] = height ? height.falloff : 0;
  target[base + OFFSET_FOG_HEIGHT + 3] = glow ? glow.strength : 0;
  target[base + OFFSET_FOG_GLOW] = glow ? glow.color[0] : 0;
  target[base + OFFSET_FOG_GLOW + 1] = glow ? glow.color[1] : 0;
  target[base + OFFSET_FOG_GLOW + 2] = glow ? glow.color[2] : 0;
  target[base + OFFSET_FOG_GLOW + 3] = 0;
  for (let i = 0; i < MAX_FOG_VOLUMES; i += 1) {
    const v = volumes[i];
    const o = base + OFFSET_FOG_VOL + i * 8;
    target[o] = v ? v.min[0] : 0;
    target[o + 1] = v ? v.min[1] : 0;
    target[o + 2] = v ? v.min[2] : 0;
    target[o + 3] = v ? v.density : 0;
    target[o + 4] = v ? v.max[0] : 0;
    target[o + 5] = v ? v.max[1] : 0;
    target[o + 6] = v ? v.max[2] : 0;
    target[o + 7] = v ? v.falloff : 0;
  }
  target[base + OFFSET_SHADOW2] = shadow ? shadow.slopeBias ?? 0 : 0;
  target[base + OFFSET_SHADOW2 + 1] = shadow && shadow.pcf ? 1 : 0;
  target[base + OFFSET_SHADOW2 + 2] = uniform.soft?.linear[0] ?? 0;
  target[base + OFFSET_SHADOW2 + 3] = uniform.soft?.linear[1] ?? 0;
  target[base + OFFSET_SURFACE0] = surface.detailScale;
  target[base + OFFSET_SURFACE0 + 1] = surface.detailStrength;
  target[base + OFFSET_SURFACE0 + 2] = surface.reflect;
  target[base + OFFSET_SURFACE0 + 3] = surface.reflectMask ? 1 : 0;
  target[base + OFFSET_SURFACE1] = surface.emisOffset[0];
  target[base + OFFSET_SURFACE1 + 1] = surface.emisOffset[1];
  target[base + OFFSET_SURFACE1 + 2] = surface.blend ? 1 : 0;
  target[base + OFFSET_SURFACE1 + 3] = surface.blend?.textured ? 1 : 0;
  const effect = effectActive(uniform.effect) ? uniform.effect : null;
  const fxRim = effect?.rim && (effect.rim[0] > 0 || effect.rim[1] > 0 || effect.rim[2] > 0) ? effect.rim : null;
  target[base + OFFSET_SURFACE2] = surface.rim[0] + (fxRim ? fxRim[0] : 0);
  target[base + OFFSET_SURFACE2 + 1] = surface.rim[1] + (fxRim ? fxRim[1] : 0);
  target[base + OFFSET_SURFACE2 + 2] = surface.rim[2] + (fxRim ? fxRim[2] : 0);
  target[base + OFFSET_SURFACE2 + 3] = fxRim ? effect.rimPower ?? EFFECT_RIM_POWER : surface.rimPower;
  target[base + OFFSET_SURFACE3] = surface.blend ? surface.blend.color[0] : 0;
  target[base + OFFSET_SURFACE3 + 1] = surface.blend ? surface.blend.color[1] : 0;
  target[base + OFFSET_SURFACE3 + 2] = surface.blend ? surface.blend.color[2] : 0;
  target[base + OFFSET_SURFACE3 + 3] = surface.blend && surface.blend.roughness !== null ? surface.blend.roughness : -1;
  target[base + OFFSET_EFFECT0] = effect?.glow ? effect.glow[0] : 0;
  target[base + OFFSET_EFFECT0 + 1] = effect?.glow ? effect.glow[1] : 0;
  target[base + OFFSET_EFFECT0 + 2] = effect?.glow ? effect.glow[2] : 0;
  target[base + OFFSET_EFFECT0 + 3] = effect ? Math.max(0, Math.min(1, effect.camo ?? 0)) : 0;
  target[base + OFFSET_EFFECT1] = effect?.bands ? effect.bands[0] : 0;
  target[base + OFFSET_EFFECT1 + 1] = effect?.bands ? effect.bands[1] : 0;
  target[base + OFFSET_EFFECT1 + 2] = effect?.bands ? effect.bands[2] : 0;
  target[base + OFFSET_EFFECT1 + 3] = uniform.time ?? 0;
}
var VERTEX_FLOATS = 11;
function interleaveVertices(positions, normals, uvs, uvs2 = null, blend = null) {
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count * VERTEX_FLOATS);
  for (let i = 0; i < count; i += 1) {
    const to = i * VERTEX_FLOATS;
    out[to] = positions[i * 3] ?? 0;
    out[to + 1] = positions[i * 3 + 1] ?? 0;
    out[to + 2] = positions[i * 3 + 2] ?? 0;
    out[to + 3] = normals[i * 3] ?? 0;
    out[to + 4] = normals[i * 3 + 1] ?? 0;
    out[to + 5] = normals[i * 3 + 2] ?? 0;
    out[to + 6] = uvs ? uvs[i * 2] ?? 0 : 0;
    out[to + 7] = uvs ? uvs[i * 2 + 1] ?? 0 : 0;
    out[to + 8] = uvs2 ? uvs2[i * 2] ?? 0 : 0;
    out[to + 9] = uvs2 ? uvs2[i * 2 + 1] ?? 0 : 0;
    out[to + 10] = blend ? blend[i] ?? 0 : 0;
  }
  return out;
}
function unpadRows(padded, width, height, bytesPerRow, reuse = null) {
  const rowBytes = width * 4;
  const out = reuse && reuse.length === rowBytes * height ? reuse : new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  return out;
}

// src/render/WebglSceneRenderer.ts
var WEBGL_INSTANCES_PER_DRAW = 64;
var WEBGL_MAX_LIGHTS = 128;
var READBACK_BUFFERS = 3;
var UNIT_BASE = 0;
var UNIT_MR = 1;
var UNIT_OCC = 2;
var UNIT_EMIS = 3;
var UNIT_SHADOW = 4;
var UNIT_ENV = 5;
var UNIT_SSAO = 6;
var UNIT_LM = 7;
var UNIT_PROBES = 8;
var UNIT_DETAIL = 9;
var UNIT_BLEND = 10;
var UNIT_SCENE_DEPTH = 11;
var UNIT_CLUSTER_TABLE = 12;
var UNIT_CLUSTER_INDEX = 13;
var UNIT_LOCAL_SHADOWS = 14;
var UNIT_PROBE_GRID = 15;
var BLOCK_UNIFORMS = 0;
var BLOCK_INSTANCES = 1;
var BLOCK_LIGHTS = 2;
var UNIFORM_BLOCK = (
  /* glsl */
  `
layout(std140) uniform Uniforms {
  mat4 mvp;
  mat3 nrm;
  vec4 base;
  vec4 light;
  vec4 view;
  vec4 pbr;
  vec4 emissive;
  vec4 texflags;
  vec4 envSky;
  vec4 envHorizon;
  vec4 envGround;
  mat4 lightMvp;
  vec4 shadow;
  vec4 envMeta;
  vec4 tonemap;
  vec4 ssaoMeta;
  mat4 model;
  vec4 fog;
  vec4 fogParams;
  vec4 shadow2;
  vec4 surface0;
  vec4 surface1;
  vec4 surface2;
  vec4 surface3;
  vec4 fogCam;
  vec4 fogHeight;
  vec4 fogGlow;
  vec4 fogVol[8];
  vec4 effect0; // rgb = surface effect glow, w = camo amount
  vec4 effect1; // rgb = surface effect bands, w = time
} u;
`
);
var VERTEX_SHADER = (
  /* glsl */
  `#version 300 es
precision highp float;
precision highp int;
${UNIFORM_BLOCK}
struct InstanceXf {
  mat4 mvp;
  mat4 lightMvp;
  mat4 model;
  mat3 nrm;
};
layout(std140) uniform Instances {
  InstanceXf xf[${WEBGL_INSTANCES_PER_DRAW}];
};
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
layout(location = 2) in vec2 uv;
layout(location = 3) in vec2 uv2;
layout(location = 4) in float bw;
out float vBw;
out vec3 vNormal;
out vec2 vUv;
out vec2 vUv2;
out vec4 vLightClip;
out vec3 vWorldPos;
out float vEyeDepth;
void main() {
  InstanceXf t = xf[gl_InstanceID];
  vec4 p = t.mvp * vec4(position, 1.0);
  vNormal = t.nrm * normal;
  vUv = uv;
  vUv2 = uv2;
  vBw = bw;
  vLightClip = t.lightMvp * vec4(position, 1.0);
  vWorldPos = (t.model * vec4(position, 1.0)).xyz;
  vEyeDepth = p.w;
  // Flip Y so the framebuffer's first row is the image's top row (see the file comment).
  gl_Position = vec4(p.x, -p.y, p.z, p.w);
}
`
);
function graphSites(graph) {
  if (!graph) return { fns: "", base: "", pbr: "", emis: "" };
  const out = graph.outputs;
  const code = graphShaderCode(graph, "glsl", {
    uv: "vUv",
    position: "vWorldPos",
    normal: "gN",
    view: "u.view.xyz",
    time: "u.effect1.w",
    baseColor: "colour.rgb",
    baseAlpha: "colour.a",
    sample: (p) => `sampleMap(tex, vec2((${p}).x, 1.0 - (${p}).y))`
  });
  const set = [
    out.baseColor !== void 0 ? `colour = vec4(g${out.baseColor}, colour.a);` : "",
    out.alpha !== void 0 ? `colour.a = clamp(g${out.alpha}.x, 0.0, 1.0);` : "",
    out.metallic !== void 0 ? `gMetal = clamp(g${out.metallic}.x, 0.0, 1.0);` : "",
    out.roughness !== void 0 ? `gRough = g${out.roughness}.x;` : "",
    out.emissive !== void 0 ? `gEmis = max(g${out.emissive}, vec3(0.0));` : ""
  ].filter(Boolean);
  return {
    fns: graphUsesNoise(graph) ? graphNoiseSource("glsl") : "",
    base: `  // The material graph (EP7).
  float gMetal = -1.0;
  float gRough = -1.0;
  vec3 gEmis = vec3(-1.0);
  {
    vec3 gN = normalize(vNormal);
    if (dot(gN, u.view.xyz) < 0.0) { gN = -gN; }
${code.split("\n").map((l) => `    ${l}`).join("\n")}
${set.map((l) => `    ${l}`).join("\n")}
  }`,
    pbr: `    if (gMetal >= 0.0) { metallic = gMetal; }
    if (gRough >= 0.0) { rough = gRough; }`,
    emis: `    if (gEmis.x >= 0.0) { emis = gEmis; }`
  };
}
var fragmentShader = (nearest, graph = null) => {
  const g = graphSites(graph);
  return (
    /* glsl */
    `#version 300 es
precision highp float;
precision highp int;
#define NEAREST ${nearest ? 1 : 0}
${UNIFORM_BLOCK}
struct Light {
  vec4 d0;
  vec4 d1;
  vec4 d2;
  vec4 d3;
};
// Clustered lights (EP8): per cell (offset, count) in an RG32UI table
// (x = tile, y = slice), the indices in an R32UI list 1024 wide; params = tile
// size (px), near plane, slice scale; info.x = global lights, info.y = 1 when cells are built.
uniform highp usampler2D clusterTable;
uniform highp usampler2D clusterIndex;
uniform vec4 clusterParams;
uniform vec4 clusterInfo;
layout(std140) uniform Lights {
  Light lights[${WEBGL_MAX_LIGHTS}];
};
uniform sampler2D tex;
uniform sampler2D mrTex;
uniform sampler2D occTex;
uniform sampler2D emisTex;
uniform highp sampler2D shadowMap;
uniform sampler2D envMap;
uniform highp sampler2D ssaoMap;
uniform sampler2D lmTex;
// Reflection probes (probeSampling.ts in @cartbox/editor): the panorama atlas
// and, per probe, box min / box max / capture point / mean colour; u.ssaoMeta.w
// counts them.
uniform sampler2D probeAtlas;
uniform sampler2D detailTex;
uniform sampler2D blendTex;
uniform highp sampler2D sceneDepth;
uniform vec4 probeData[${MAX_REFLECTION_PROBES2 * 4}];
in vec3 vNormal;
in vec2 vUv;
in vec2 vUv2;
in float vBw;
in vec4 vLightClip;
in vec3 vWorldPos;
in float vEyeDepth;
out vec4 outColor;

// Optical depth of a fog layer thinning above base (fogLayerDepth in skyDome.ts).
float fogLayer(float d, float k, float base, float cy, float dy, float len, float t0, float t1) {
  if (d <= 0.0 || t1 <= t0) return 0.0;
  float ya = cy + dy * t0 - base;
  float yb = cy + dy * t1 - base;
  float y0 = min(ya, yb);
  float y1 = max(ya, yb);
  float span = d * len * (t1 - t0);
  float h = y1 - y0;
  if (h < 1e-5) return span * exp(-k * max(0.0, y0));
  float tau = 0.0;
  if (y0 < 0.0) tau += span * (min(y1, 0.0) - y0) / h;
  if (y1 > 0.0) {
    float lo = max(y0, 0.0);
    float above = y1 - lo;
    if (k * above < 1e-4) tau += span * above * exp(-k * lo) / h;
    else tau += span * (exp(-k * lo) - exp(-k * y1)) / (k * h);
  }
  return tau;
}

// Where the segment c -> c + dir*t (t in [0, 1]) is inside a box (fogBoxSpan).
vec2 fogBox(vec3 mn, vec3 mx, vec3 c, vec3 dir) {
  float t0 = 0.0;
  float t1 = 1.0;
  for (int a = 0; a < 3; a++) {
    if (abs(dir[a]) < 1e-9) {
      if (c[a] < mn[a] || c[a] > mx[a]) return vec2(1.0, 0.0);
    } else {
      float ta = (mn[a] - c[a]) / dir[a];
      float tb = (mx[a] - c[a]) / dir[a];
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    }
  }
  return vec2(t0, t1);
}

// A material map at uv (already V-flipped). An era without filtering picks the
// texel exactly as the software rasteriser does \u2014 floor(wrap(u) \xB7 size) \u2014
// rather than trusting a driver's subtexel precision at texel boundaries.
vec4 sampleMap(sampler2D s, vec2 uv) {
#if NEAREST
  ivec2 size = textureSize(s, 0);
  vec2 f = (uv - floor(uv)) * vec2(size);
  return texelFetch(s, min(size - 1, ivec2(floor(f))), 0);
#else
  return texture(s, uv);
#endif
}

float shadowTap(float fx, float fy, float z, float ox) {
  float size = u.shadow.y;
  int tx = int(clamp(floor(fx), 0.0, size - 1.0) + ox);
  int ty = int(clamp(floor(fy), 0.0, size - 1.0));
  float stored = texelFetch(shadowMap, ivec2(tx, ty), 0).r;
  if (z > stored) { return 0.0; }
  return 1.0;
}
// One shadow map's test at a light-NDC point: the main map (ox 0) or the near
// cascade packed to its right (ox = size), with its own biases.
float shadowAt(vec3 ndc, float bias0, float slope, float ox, float cosL) {
  float size = u.shadow.y;
  float sx = (ndc.x * 0.5 + 0.5) * size;
  float sy = (1.0 - (ndc.y * 0.5 + 0.5)) * size;
  float bias = bias0;
  if (slope > 0.0) {
    float c = clamp(cosL, 0.05, 1.0);
    bias = bias + slope * min(10.0, sqrt(1.0 - c * c) / c);
  }
  float z = ndc.z - bias;
  if (u.shadow2.y < 0.5) {
    if (shadowTap(sx, sy, z, ox) < 0.5) { return 1.0 - u.shadow.w; }
    return 1.0;
  }
  float lit = (shadowTap(sx - 0.5, sy - 0.5, z, ox) + shadowTap(sx + 0.5, sy - 0.5, z, ox)
             + shadowTap(sx - 0.5, sy + 0.5, z, ox) + shadowTap(sx + 0.5, sy + 0.5, z, ox)) * 0.25;
  return 1.0 - u.shadow.w * (1.0 - lit);
}
// The near shadow cascade (EP8b): world\u2192light-clip, and (1 when present, bias, slope bias).
uniform mat4 nearShadowMvp;
uniform vec4 nearShadow;
// The sun's shadow (mirrors sunShadowVisibility): the near cascade when the
// point sits well inside it, else the main map.
float shadowFactor(vec4 lightClip, vec3 worldPos, float cosL) {
  if (u.shadow.x < 0.5) { return 1.0; }
  if (nearShadow.x > 0.5) {
    vec3 n = (nearShadowMvp * vec4(worldPos, 1.0)).xyz;
    if (abs(n.x) < ${NEAR_CASCADE_EDGE} && abs(n.y) < ${NEAR_CASCADE_EDGE} && abs(n.z) <= 1.0) {
      return shadowAt(n, nearShadow.y, nearShadow.z, u.shadow.y, cosL);
    }
  }
  vec3 ndc = lightClip.xyz / lightClip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  return shadowAt(ndc, u.shadow.z, u.shadow2.x, 0.0, cosL);
}
vec3 envGradient(float y) {
  float t = clamp(y, -1.0, 1.0);
  vec3 c;
  if (t >= 0.0) { c = mix(u.envHorizon.xyz, u.envSky.xyz, t); }
  else { c = mix(u.envHorizon.xyz, u.envGround.xyz, -t); }
  return c * u.envHorizon.w;
}
vec3 envColorDir(vec3 dir) {
  if (u.envMeta.w < 0.5) { return envGradient(dir.y); }
  vec3 d = normalize(dir);
  float uCoord = atan(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  float vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  vec2 dims = vec2(textureSize(envMap, 0));
  float wx = uCoord - floor(uCoord);
  int tx = int(clamp(floor(wx * dims.x), 0.0, dims.x - 1.0));
  int ty = int(clamp(floor(vCoord * dims.y), 0.0, dims.y - 1.0));
  return texelFetch(envMap, ivec2(tx, ty), 0).rgb * u.envHorizon.w;
}
vec3 probeSample(int i, vec3 dir) {
  vec3 d = normalize(dir);
  float uCoord = atan(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  float vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  vec2 dims = vec2(textureSize(probeAtlas, 0));
  float h = floor(dims.x * 0.5);
  int tx = int(clamp(floor((uCoord - floor(uCoord)) * dims.x), 0.0, dims.x - 1.0));
  int ty = int(clamp(floor(vCoord * h), 0.0, h - 1.0) + float(i) * h);
  return texelFetch(probeAtlas, ivec2(tx, ty), 0).rgb * ${PROBE_RANGE.toFixed(4)};
}
// The 2\xD72 ordered-dither matrix [[0, 2], [3, 1]], and the crawling camo threshold
// (surfaceEffect.ts). gl_FragCoord rows run top-first here (the vertex stage flips Y).
float bayer2(int x, int y) {
  if ((y & 1) == 1) { return (x & 1) == 1 ? 1.0 : 3.0; }
  return (x & 1) == 1 ? 2.0 : 0.0;
}
float camoThreshold(vec2 p, float time) {
  int s = int(floor(time * ${EFFECT_CAMO_CRAWL.toFixed(1)}));
  int px = int(floor(p.x)) + s;
  int py = int(floor(p.y)) + s * 3;
  return (4.0 * bayer2(px, py) + bayer2(px >> 1, py >> 1) + 0.5) / 16.0;
}
// What reaches the framebuffer (EP6): opaque and cut-out surfaces cover the
// pixel (alpha 1); a blended one leaves premultiplied colour and its coverage;
// an added one leaves its light and no coverage (see compositeFrame).
vec4 finishAlpha(vec3 rgb, float a) {
  vec3 c = clamp(rgb, vec3(0.0), vec3(1.0));
  if (u.pbr.w > 2.5) { return vec4(c * a, 0.0); }
  if (u.pbr.w > 1.5) { return vec4(c * a, a); }
  return vec4(c, 1.0);
}
vec3 envAverage() {
  if (u.envMeta.w > 0.5) { return u.envMeta.xyz * u.envHorizon.w; }
  return (u.envSky.xyz + u.envHorizon.xyz + u.envGround.xyz) / 3.0 * u.envHorizon.w;
}
float aces(float x) {
  float v = max(0.0, x);
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
}

// Spot and point light shadows (EP8c): the tile atlas, each tile's world\u2192clip
// and depth\u2192distance terms (xy), and (1 when on, bias, slope bias) in world units.
uniform highp sampler2D localAtlas;
uniform mat4 shadowTileMvp[${MAX_LOCAL_SHADOW_TILES}];
uniform vec4 shadowTileParams[${MAX_LOCAL_SHADOW_TILES}];
uniform vec4 localShadowInfo;
float localTap(float fx, float fy, float ox, float oy, float own, float a, float b) {
  float size = ${LOCAL_SHADOW_TILE}.0;
  int tx = int(clamp(floor(fx), 0.0, size - 1.0) + ox);
  int ty = int(clamp(floor(fy), 0.0, size - 1.0) + oy);
  float stored = texelFetch(localAtlas, ivec2(tx, ty), 0).r;
  if (own > b / (min(stored, 1.0) + a)) { return 0.0; }
  return 1.0;
}
// A spot/point light's shadow at P (mirrors localShadowVisibility).
float localShadow(int first, Light lgt, vec3 P, float cosL) {
  int tile = first;
  if (lgt.d0.w < 1.5) {
    vec3 d = P - lgt.d0.xyz;
    vec3 m = abs(d);
    if (m.x >= m.y && m.x >= m.z) { tile += d.x >= 0.0 ? 0 : 1; }
    else if (m.y >= m.z) { tile += d.y >= 0.0 ? 2 : 3; }
    else { tile += d.z >= 0.0 ? 4 : 5; }
  }
  vec4 c = shadowTileMvp[tile] * vec4(P, 1.0);
  if (c.w <= 0.0) { return 1.0; }
  vec3 n = c.xyz / c.w;
  if (n.x < -1.0 || n.x > 1.0 || n.y < -1.0 || n.y > 1.0 || n.z < -1.0 || n.z > 1.0) { return 1.0; }
  float size = ${LOCAL_SHADOW_TILE}.0;
  float sx = (n.x * 0.5 + 0.5) * size;
  float sy = (1.0 - (n.y * 0.5 + 0.5)) * size;
  float cc = clamp(cosL, 0.05, 1.0);
  vec4 tp = shadowTileParams[tile];
  float own = tp.y / (n.z + tp.x) - localShadowInfo.y - localShadowInfo.z * min(10.0, sqrt(1.0 - cc * cc) / cc);
  float ox = float((tile % ${LOCAL_SHADOW_GRID}) * ${LOCAL_SHADOW_TILE});
  float oy = float((tile / ${LOCAL_SHADOW_GRID}) * ${LOCAL_SHADOW_TILE});
  return (localTap(sx - 0.5, sy - 0.5, ox, oy, own, tp.x, tp.y) + localTap(sx + 0.5, sy - 0.5, ox, oy, own, tp.x, tp.y)
        + localTap(sx - 0.5, sy + 0.5, ox, oy, own, tp.x, tp.y) + localTap(sx + 0.5, sy + 0.5, ox, oy, own, tp.x, tp.y)) * 0.25;
}

// Light probes (EP9): the grid as a 3D texture (face f's probes at x = f \xB7 nx + probe x);
// its corner (w = 1 when bound), world \u2192 grid scale, and probes per axis.
uniform highp sampler3D probeGrid;
uniform vec4 probeGridMin;
uniform vec4 probeGridScale;
uniform vec4 probeGridCount;
vec3 probeFace(int face, ivec3 i, vec3 f) {
  ivec3 o = i + ivec3(face * int(probeGridCount.x + 0.5), 0, 0);
  vec3 x00 = mix(texelFetch(probeGrid, o, 0).rgb, texelFetch(probeGrid, o + ivec3(1, 0, 0), 0).rgb, f.x);
  vec3 x10 = mix(texelFetch(probeGrid, o + ivec3(0, 1, 0), 0).rgb, texelFetch(probeGrid, o + ivec3(1, 1, 0), 0).rgb, f.x);
  vec3 x01 = mix(texelFetch(probeGrid, o + ivec3(0, 0, 1), 0).rgb, texelFetch(probeGrid, o + ivec3(1, 0, 1), 0).rgb, f.x);
  vec3 x11 = mix(texelFetch(probeGrid, o + ivec3(0, 1, 1), 0).rgb, texelFetch(probeGrid, o + ivec3(1, 1, 1), 0).rgb, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
// The ambient scale from the probe grid at P for normal N (mirrors sampleLightProbes).
vec3 probeLight(vec3 P, vec3 N) {
  vec3 n = probeGridCount.xyz;
  vec3 g = clamp((P - probeGridMin.xyz) * probeGridScale.xyz, vec3(0.0), n - vec3(1.0));
  ivec3 i = min(ivec3(floor(g)), ivec3(n + vec3(0.5)) - ivec3(2));
  vec3 f = g - vec3(i);
  vec3 nn = normalize(N);
  vec3 w = nn * nn;
  return w.x * probeFace(nn.x >= 0.0 ? 0 : 1, i, f) + w.y * probeFace(nn.y >= 0.0 ? 2 : 3, i, f) + w.z * probeFace(nn.z >= 0.0 ? 4 : 5, i, f);
}

// One light's direct term (Cook-Torrance), mirroring the software rasteriser's
// light loop: point and spot lights fall off to nothing at their range, a spot
// fades across its cone, and directional lights honour the sun shadow (sf).
vec3 lightTerm(Light lgt, vec3 P, vec3 N, vec3 V, float ndv, float a2, float k, vec3 f0, float kdm, vec3 albedo, float sf) {
  vec3 Ld;
  float atten = 1.0;
  if (lgt.d0.w > 0.5) {
    vec3 toL = lgt.d0.xyz - P;
    float dist = max(length(toL), 1e-4);
    Ld = toL / dist;
    float range = lgt.d2.x;
    if (range > 0.0) { float t = max(0.0, 1.0 - dist / range); atten = t * t; }
    if (lgt.d0.w > 1.5) {
      float ct = clamp((-dot(Ld, lgt.d3.xyz) - lgt.d2.y) / (lgt.d2.z - lgt.d2.y), 0.0, 1.0);
      atten = atten * ct * ct * (3.0 - 2.0 * ct);
    }
  } else {
    Ld = normalize(lgt.d0.xyz);
  }
  float ndlL = max(0.0, dot(N, Ld));
  if (ndlL <= 0.0 || atten <= 0.0) { return vec3(0.0); }
  vec3 Hl = normalize(Ld + V);
  float ndhL = max(0.0, dot(N, Hl));
  float vdhL = max(0.0, dot(V, Hl));
  float ddL = ndhL * ndhL * (a2 - 1.0) + 1.0;
  float DL = a2 / (3.14159265 * ddL * ddL + 1e-7);
  float GL = (ndv / (ndv * (1.0 - k) + k)) * (ndlL / (ndlL * (1.0 - k) + k));
  float fpL = pow(1.0 - vdhL, 5.0);
  float specL = (DL * GL) / (4.0 * ndlL * ndv + 1e-4);
  vec3 FL = f0 + (vec3(1.0) - f0) * fpL;
  float occl = 1.0;
  if (lgt.d0.w < 0.5) { occl = sf; }
  else if (lgt.d2.w >= 0.0 && localShadowInfo.x > 0.5) { occl = localShadow(int(lgt.d2.w + 0.5), lgt, P, ndlL); }
  float w = lgt.d1.w * atten * ndlL * occl;
  return (kdm * (vec3(1.0) - FL) * albedo + FL * specL) * lgt.d1.rgb * w;
}
${g.fns}
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 colour = u.base;
  if (u.texflags.x > 0.5) {
    colour = colour * sampleMap(tex, uv);
  }
${g.base}
  // Soft edges (EP6b): a see-through surface fades out as it meets the opaque
  // scene behind it \u2014 both depths read back as view distance (shadow2.zw).
  if (u.tonemap.z > 0.0) {
    float behind = texelFetch(sceneDepth, ivec2(gl_FragCoord.xy), 0).r * 2.0 - 1.0;
    float own = gl_FragCoord.z * 2.0 - 1.0;
    colour.a *= clamp((u.shadow2.w / (behind + u.shadow2.z) - u.shadow2.w / (own + u.shadow2.z)) / u.tonemap.z, 0.0, 1.0);
  }
  if (colour.a * 255.0 < 1.0) { discard; }
  // A cut-out surface (EP6) drops what's below its threshold.
  if (u.pbr.w > 0.5 && u.pbr.w < 1.5 && colour.a < u.view.w) { discard; }

  if (u.pbr.z > 0.5) {
    // Active Camo (H11): screen-door transparency, as the rasteriser drops pixels.
    if (u.effect0.w > 0.0 && camoThreshold(gl_FragCoord.xy, u.effect1.w) < u.effect0.w) { discard; }
    vec3 N = normalize(vNormal);
    if (dot(N, u.view.xyz) < 0.0) { N = -N; }
    float metallic = u.pbr.x;
    float rough = u.pbr.y;
    float reflectK = u.surface0.z;
    if (u.texflags.y > 0.5) {
      vec4 mr = sampleMap(mrTex, uv);
      rough = rough * mr.g;
      metallic = metallic * mr.b;
      if (u.surface0.w > 0.5) { reflectK = reflectK * mr.a; }
    }
    if (u.surface1.z > 0.5 && u.surface3.w >= 0.0) { rough = mix(rough, u.surface3.w, vBw); }
${g.pbr}
    rough = clamp(rough, 0.045, 1.0);
    float ao = 1.0;
    if (u.texflags.z > 0.5) { ao = sampleMap(occTex, uv).r; }
    vec3 albedo = colour.rgb;
    if (u.surface1.z > 0.5) {
      vec3 bc = u.surface3.rgb;
      if (u.surface1.w > 0.5) { bc = bc * sampleMap(blendTex, uv).rgb; }
      albedo = mix(albedo, bc, vBw);
    }
    float dk = u.surface0.y * clamp((${DETAIL_FAR.toFixed(4)} - vEyeDepth) / ${(DETAIL_FAR - DETAIL_NEAR).toFixed(4)}, 0.0, 1.0);
    if (dk > 0.0) {
      vec3 detail = sampleMap(detailTex, vec2(vUv.x * u.surface0.x, 1.0 - vUv.y * u.surface0.x)).rgb;
      albedo = albedo * (vec3(1.0) + dk * (2.0 * detail - vec3(1.0)));
    }
    vec3 L = u.light.xyz;
    vec3 V = u.view.xyz;
    vec3 H = normalize(L + V);
    float ndl = max(0.0, dot(N, L));
    float ndv = max(1e-4, dot(N, V));
    float ndh = max(0.0, dot(N, H));
    float vdh = max(0.0, dot(V, H));
    float a2 = rough * rough * rough * rough;
    float dd = ndh * ndh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159265 * dd * dd + 1e-7);
    float k = ((rough + 1.0) * (rough + 1.0)) / 8.0;
    float G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
    float fp = pow(1.0 - vdh, 5.0);
    float specD = (D * G) / (4.0 * ndl * ndv + 1e-4);
    vec3 f0 = vec3(0.04) + (albedo - vec3(0.04)) * metallic;
    vec3 F = f0 + (vec3(1.0) - f0) * fp;
    float kdm = 1.0 - metallic;
    vec3 emis = vec3(0.0);
    vec3 ef = u.emissive.xyz;
    if (ef.r > 0.0 || ef.g > 0.0 || ef.b > 0.0) {
      vec3 es = vec3(1.0);
      if (u.texflags.w > 0.5) { es = sampleMap(emisTex, vec2(vUv.x + u.surface1.x, 1.0 - (vUv.y + u.surface1.y))).rgb; }
      emis = ef * es;
    }
${g.emis}
    vec3 amb;
    if (u.envSky.w > 0.5) {
      vec3 irr = envColorDir(N);
      vec3 R = 2.0 * ndv * N - V;
      vec3 spec = envColorDir(R);
      vec3 specAvg = envAverage();
      // Inside a reflection probe's box, reflect the room around it, box-projected
      // (mirrors the software path and the WGSL).
      int pc = int(u.ssaoMeta.w + 0.5);
      vec3 P = vWorldPos;
      for (int i = 0; i < pc; i++) {
        vec3 mn = probeData[i * 4].xyz;
        vec3 mx = probeData[i * 4 + 1].xyz;
        float inside = min(min(min(P.x - mn.x, mx.x - P.x), min(P.y - mn.y, mx.y - P.y)), min(P.z - mn.z, mx.z - P.z));
        float wgt = clamp(inside / ${PROBE_FADE.toFixed(4)}, 0.0, 1.0);
        if (wgt > 0.0) {
          vec3 Rs = mix(R, vec3(1e-6), lessThan(abs(R), vec3(1e-6)));
          vec3 tf = max((mx - P) / Rs, (mn - P) / Rs);
          float t = max(0.0, min(min(tf.x, tf.y), tf.z));
          spec = mix(spec, probeSample(i, P + R * t - probeData[i * 4 + 2].xyz), wgt);
          specAvg = mix(specAvg, probeData[i * 4 + 3].xyz, wgt);
          break;
        }
      }
      vec3 pref = mix(spec, specAvg, rough);
      amb = (irr * albedo * kdm + pref * f0 * reflectK) * ao;
    } else {
      amb = vec3(u.light.w) * albedo * ao;
    }
    // A baked light map (the second UV set) scales the sky/ambient fill,
    // mirroring the CPU path.
    if (u.ssaoMeta.z > 0.5) {
      amb = amb * texture(lmTex, vec2(vUv2.x, 1.0 - vUv2.y)).rgb * ${LIGHTMAP_RANGE.toFixed(4)};
    } else if (probeGridMin.w > 0.5) {
      amb = amb * probeLight(vWorldPos, N); // EP9: no light map, the probes light it
    }
    if (u.ssaoMeta.x > 0.5) {
      amb = amb * texelFetch(ssaoMap, ivec2(gl_FragCoord.xy), 0).r;
    }
    float sf = shadowFactor(vLightClip, vWorldPos, abs(dot(normalize(vNormal), u.light.xyz)));
    int lc = int(u.ssaoMeta.y + 0.5);
    vec3 lit;
    if (lc > 0) {
      vec3 direct = vec3(0.0);
      // The global lights (the sun, unranged lights) reach every fragment\u2026
      int ng = int(clusterInfo.x + 0.5);
      for (int i = 0; i < ${WEBGL_MAX_LIGHTS}; i = i + 1) {
        if (i >= ng) { break; }
        direct += lightTerm(lights[i], vWorldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
      }
      // \u2026the rest only the cells they touch (EP8): this fragment's cell, by pixel and depth.
      if (clusterInfo.y > 0.5 && vEyeDepth >= clusterParams.z) {
        ivec2 tile = min(ivec2(gl_FragCoord.xy / clusterParams.xy), ivec2(${CLUSTER_X - 1}, ${CLUSTER_Y - 1}));
        int slice = min(int(log(vEyeDepth / clusterParams.z) * clusterParams.w), ${CLUSTER_Z - 1});
        uvec2 cell = texelFetch(clusterTable, ivec2(tile.y * ${CLUSTER_X} + tile.x, slice), 0).xy;
        for (uint j = 0u; j < cell.y; j++) {
          uint n = cell.x + j;
          int li = int(texelFetch(clusterIndex, ivec2(int(n % 1024u), int(n / 1024u)), 0).x);
          direct += lightTerm(lights[li], vWorldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
        }
      }
      lit = direct + amb + emis;
    } else {
      lit = (kdm * (vec3(1.0) - F) * albedo + F * specD) * ndl * sf + amb + emis;
    }
    lit = lit + u.surface2.rgb * pow(1.0 - ndv, u.surface2.w);
    // A surface effect's glow, and its bands climbing the body (zero without one).
    float band = pow(0.5 + 0.5 * sin(vWorldPos.y * ${EFFECT_BAND_FREQUENCY.toFixed(1)} - u.effect1.w * ${EFFECT_BAND_SPEED.toFixed(1)}), ${EFFECT_BAND_POWER.toFixed(1)});
    lit = lit + u.effect0.rgb + u.effect1.rgb * band;
    vec3 shaded = lit;
    if (u.tonemap.x > 0.5) {
      float e = u.tonemap.y;
      shaded = vec3(aces(lit.r * e), aces(lit.g * e), aces(lit.b * e));
    }
    if (u.fogParams.x > 0.5) {
      float d = max(0.0, vEyeDepth - u.fogParams.y);
      float f = min(u.fogParams.z, 1.0 - exp(-d * u.fog.w));
      vec3 fc = u.fog.rgb;
      if (u.fogParams.w > 0.5) {
        vec3 c = u.fogCam.xyz;
        vec3 ray = vWorldPos - c;
        float len = length(ray);
        float tau = fogLayer(u.fogHeight.x, u.fogHeight.z, u.fogHeight.y, c.y, ray.y, len, 0.0, 1.0);
        int vc = int(u.fogCam.w + 0.5);
        for (int i = 0; i < 4; i++) {
          if (i >= vc) break;
          vec4 a = u.fogVol[i * 2];
          vec4 b = u.fogVol[i * 2 + 1];
          vec2 span = fogBox(a.xyz, b.xyz, c, ray);
          if (span.y > span.x) tau += fogLayer(a.w, b.w, a.y, c.y, ray.y, len, span.x, span.y);
        }
        f = 1.0 - (1.0 - f) * exp(-tau);
        if (u.fogHeight.w > 0.0) {
          float cosv = max(0.0, dot(ray, u.light.xyz) / (max(len, 1e-6) * max(length(u.light.xyz), 1e-6)));
          fc = min(vec3(1.0), fc + u.fogGlow.rgb * (u.fogHeight.w * pow(cosv, ${FOG_GLOW_POWER.toFixed(1)})));
        }
      }
      shaded = mix(clamp(shaded, vec3(0.0), vec3(1.0)), fc, f);
    }
    outColor = finishAlpha(shaded, colour.a);
    return;
  }

  // Fantasy path: two-sided Lambert on the un-renormalised normal, as the software rasteriser does.
  float nl = abs(dot(vNormal, u.light.xyz));
  float shade = u.light.w + (1.0 - u.light.w) * nl * shadowFactor(vLightClip, vWorldPos, abs(dot(normalize(vNormal), u.light.xyz)));
  outColor = finishAlpha(colour.rgb * shade, colour.a);
}
`
  );
};
function buildProgram2(gl, nearest, graph) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentShader(nearest, graph)));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL2 program failed to link: ${gl.getProgramInfoLog(program)}`);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, "Uniforms"), BLOCK_UNIFORMS);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, "Instances"), BLOCK_INSTANCES);
  gl.uniformBlockBinding(program, gl.getUniformBlockIndex(program, "Lights"), BLOCK_LIGHTS);
  gl.useProgram(program);
  const units = [
    ["tex", UNIT_BASE],
    ["mrTex", UNIT_MR],
    ["occTex", UNIT_OCC],
    ["emisTex", UNIT_EMIS],
    ["shadowMap", UNIT_SHADOW],
    ["envMap", UNIT_ENV],
    ["ssaoMap", UNIT_SSAO],
    ["lmTex", UNIT_LM],
    ["probeAtlas", UNIT_PROBES],
    ["detailTex", UNIT_DETAIL],
    ["blendTex", UNIT_BLEND],
    ["sceneDepth", UNIT_SCENE_DEPTH],
    ["clusterTable", UNIT_CLUSTER_TABLE],
    ["clusterIndex", UNIT_CLUSTER_INDEX],
    ["localAtlas", UNIT_LOCAL_SHADOWS],
    ["probeGrid", UNIT_PROBE_GRID]
  ];
  for (const [name, unit] of units) gl.uniform1i(gl.getUniformLocation(program, name), unit);
  return program;
}
function defaultContext() {
  try {
    const options = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(1, 1).getContext("webgl2", options);
    if (typeof document !== "undefined") return document.createElement("canvas").getContext("webgl2", options);
  } catch {
  }
  return null;
}
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader failed to compile: ${log}`);
  }
  return shader;
}
var WebglSceneRenderer = class _WebglSceneRenderer {
  constructor(gl, width, height, program, framebuffer, attachments, sampler, blankTexture, blankFloat, instanceAlignFloats, style) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.program = program;
    this.framebuffer = framebuffer;
    this.attachments = attachments;
    this.sampler = sampler;
    this.blankTexture = blankTexture;
    this.blankFloat = blankFloat;
    this.instanceAlignFloats = instanceAlignFloats;
    this.backend = "webgl2";
    this.meshes = /* @__PURE__ */ new WeakMap();
    this.textures = /* @__PURE__ */ new WeakMap();
    this.latest = null;
    this.destroyed = false;
    /** The context was lost: the software rasteriser draws from here on. */
    this.lost = false;
    this.uniformCapacity = 0;
    this.uniformData = new Float32Array(0);
    this.instanceFloats = 0;
    this.instanceData = new Float32Array(0);
    this.shadowTexture = null;
    this.shadowSize = 0;
    this.shadowUploaded = null;
    this.envTexture = null;
    this.envSource = null;
    this.probeTexture = null;
    this.probeSource = null;
    this.probeData = new Float32Array(MAX_REFLECTION_PROBES2 * PROBE_FLOATS);
    this.ssaoTexture = null;
    /** Readbacks in flight, oldest first. */
    this.pending = [];
    /** Frames submitted, the one `latest` holds, and the newest that got a readback (see settle). */
    this.submitted = 0;
    this.latestSeq = 0;
    this.readSeq = 0;
    /** What the last submitted frame drew (for the profiler and tests); GPU time when the browser can time it. */
    this.lastFrameStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };
    /** The clustered lights' params and info this frame (EP8; see the shader's clusterParams/clusterInfo). */
    this.clusterParams = new Float32Array(4);
    this.clusterInfo = new Float32Array(4);
    /** The near shadow cascade this frame (EP8b; see the shader's nearShadowMvp/nearShadow). */
    this.nearShadowMvp = new Float32Array(16);
    this.nearShadow = new Float32Array(4);
    /** Maps side by side in the shadow texture (2 with a near cascade), and the near map last uploaded in full. */
    this.shadowCascades = 1;
    this.nearUploaded = null;
    /** The cell table and index list as integer textures, made on first use. */
    this.clusterTextures = null;
    /** The light-probe grid (EP9): its uniforms, its 3D texture, and the grid it holds. */
    this.probeGridMin = new Float32Array(4);
    this.probeGridScale = new Float32Array(4);
    this.probeGridCount = new Float32Array(4);
    this.gridTexture = null;
    this.gridSource = null;
    this.gridBlank = null;
    /** The spot/point shadows this frame (EP8c): on/biases, each tile's view, and the atlas (made on first use). */
    this.localShadowInfo = new Float32Array(4);
    this.shadowTileMvp = new Float32Array(MAX_LOCAL_SHADOW_TILES * 16);
    this.shadowTileParams = new Float32Array(MAX_LOCAL_SHADOW_TILES * 4);
    this.localAtlas = null;
    /** Programs by material graph (EP7), linked on first use. */
    this.graphPrograms = /* @__PURE__ */ new Map();
    /** The opaque depth, as a texture the transparent pass can read (EP6b): made on first use. */
    this.sceneDepth = null;
    this.software = new SoftwareSceneRenderer(style);
    this.nearest = style.textureFiltering === "none";
    this.uniformBuffer = gl.createBuffer();
    this.instanceBuffer = gl.createBuffer();
    this.lightBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lightBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, WEBGL_MAX_LIGHTS * LIGHT_FLOATS * 4, gl.DYNAMIC_DRAW);
    this.readback = Array.from({ length: READBACK_BUFFERS }, () => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, width * height * 4, gl.STREAM_READ);
      return { buffer, fence: null, seq: 0 };
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.timer = WebglPassTimer.create(gl);
  }
  /**
   * Build the renderer for one framebuffer size, or null when WebGL2 is missing,
   * the era's style needs the software rasteriser, or anything fails to build.
   */
  static create(width, height, style = DEFAULT_RASTER_STYLE2, contextProvider = defaultContext) {
    if (!webgpuCanHonour(style)) return null;
    const gl = contextProvider();
    if (!gl) return null;
    try {
      const align = gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT);
      if (!(align > 0) || UNIFORM_STRIDE % align !== 0) return null;
      if (gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) < WEBGL_INSTANCES_PER_DRAW * INSTANCE_FLOATS * 4) return null;
      const program = buildProgram2(gl, style.textureFiltering === "none", null);
      const colour = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, colour);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colour);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("WebGL2 framebuffer incomplete");
      const filter = style.textureFiltering === "none" ? gl.NEAREST : gl.LINEAR;
      const sampler = gl.createSampler();
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const blankTexture = createTexture(gl, 1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      const blankFloat = createTexture(gl, 1, 1, gl.R32F, gl.RED, gl.FLOAT, new Float32Array([0]));
      gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return new _WebglSceneRenderer(gl, width, height, program, framebuffer, [colour, depth], sampler, blankTexture, blankFloat, Math.max(4, align / 4), style);
    } catch {
      return null;
    }
  }
  render(instances, draw) {
    if (this.destroyed) return;
    const visible = applyScenePasses(instances, draw);
    if (this.lost) {
      this.software.render(visible, draw);
      return;
    }
    this.collect();
    presentFrame(this.latest, visible, draw, this.software);
    try {
      this.submit(visible, draw);
    } catch {
      this.latest = null;
      if (this.gl.isContextLost?.()) this.lost = true;
    }
  }
  /** Take the newest finished readback, if any (never waits). */
  collect() {
    const gl = this.gl;
    while (this.pending.length > 0) {
      const slot = this.pending[0];
      const status = gl.clientWaitSync(slot.fence, 0, 0);
      if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break;
      this.pending.shift();
      gl.deleteSync(slot.fence);
      slot.fence = null;
      const bytes = this.latest && this.latest.length === this.width * this.height * 4 ? this.latest : new Uint8Array(this.width * this.height * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.latest = bytes;
      this.latestSeq = slot.seq;
    }
  }
  /** Whether a finished GPU frame exists to show (false until the first readback lands). */
  get ready() {
    return this.latest !== null;
  }
  settle(draw) {
    if (this.destroyed || this.lost) return "current";
    this.collect();
    if (this.latest) compositeFrame(this.latest, draw);
    if (this.latestSeq >= this.submitted) return "current";
    return this.readSeq >= this.submitted ? "pending" : "stale";
  }
  submit(instances, draw) {
    const gl = this.gl;
    const viewProj = multiplyMat44(draw.projection, draw.view);
    const { batches, instanceCount } = batchInstances(instances, (mesh) => this.uploadMesh(mesh), cameraPositionFromView2(draw.view));
    if (batches.length === 0) return;
    const chunks2 = [];
    let cursor = 0;
    batches.forEach((batch, index) => {
      for (let start = 0; start < batch.models.length; start += WEBGL_INSTANCES_PER_DRAW) {
        const count = Math.min(WEBGL_INSTANCES_PER_DRAW, batch.models.length - start);
        chunks2.push({ batch: index, start, count, offsetFloats: cursor });
        cursor += Math.ceil(count * INSTANCE_FLOATS / this.instanceAlignFloats) * this.instanceAlignFloats;
      }
    });
    this.ensureCapacity(batches.length, cursor + WEBGL_INSTANCES_PER_DRAW * INSTANCE_FLOATS);
    const light = resolveLight(draw.lightDirection, draw.ambient);
    const viewDir = viewDirection(draw.view);
    const eye = cameraPositionFromView2(draw.view);
    const shadow = draw.shadow ?? null;
    this.uploadShadow(shadow);
    const near = shadow?.near ?? null;
    if (near) this.nearShadowMvp.set(near.lightViewProj);
    this.nearShadow.set(near ? [1, near.bias, near.slopeBias, 0] : [0, 0, 0, 0]);
    const shadowParams = shadow ? { size: shadow.size, bias: shadow.bias ?? 3e-3, strength: shadow.strength ?? 1, slopeBias: shadow.slopeBias ?? 0, pcf: shadow.pcf ?? false } : null;
    this.uploadEnv(draw.environment?.map ?? null);
    this.uploadProbes(draw.environment?.probes ?? null);
    const ssao = draw.ssao ?? null;
    this.uploadSsao(ssao);
    const order = orderLights(draw.lights ?? []);
    const sceneLights = order.ordered.slice(0, WEBGL_MAX_LIGHTS);
    const globalCount = Math.min(order.globalCount, sceneLights.length);
    const clusters = sceneLights.length > globalCount ? buildLightClusters(sceneLights, globalCount, draw.view, draw.projection, this.width, this.height) : null;
    this.uploadClusters(clusters);
    this.uploadLocalShadows(draw.localShadows ?? null);
    this.uploadProbeGrid(draw.environment?.lightProbes ?? null);
    this.clusterParams.set(clusters?.params ?? [1, 1, 1, 1]);
    this.clusterInfo[0] = clusters ? globalCount : sceneLights.length;
    this.clusterInfo[1] = clusters ? 1 : 0;
    const packed = packLights(sceneLights);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.lightBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, packed);
    batches.forEach((batch, index) => {
      const model = batch.models[0];
      writeInstanceUniform(this.uniformData, index, {
        mvp: multiplyMat44(viewProj, model),
        normalBasis: normalBasis3x3(model),
        baseColor: batch.primitive.material.baseColorFactor,
        hasTexture: batch.textures.base !== null,
        light,
        viewDir,
        pbr: resolvePbr(batch.primitive.material, batch.textures.mr !== null, batch.textures.occ !== null, batch.textures.emis !== null),
        hasMrMap: batch.textures.mr !== null,
        hasOcclusionMap: batch.textures.occ !== null,
        hasEmissiveMap: batch.textures.emis !== null,
        environment: draw.environment ?? null,
        lightMvp: shadow ? multiplyMat44(shadow.lightViewProj, model) : null,
        shadow: shadowParams,
        tonemap: draw.tonemap ?? null,
        hasSsao: ssao !== null,
        hasLightmap: batch.textures.lm !== null,
        model,
        lightCount: sceneLights.length,
        fog: draw.fog ?? null,
        eye,
        effect: batch.effect ?? null,
        time: draw.time ?? 0,
        alpha: { mode: batch.alpha, cutoff: batch.primitive.material.alphaCutoff ?? 0.5 },
        soft: softEdges(batch.primitive.material, batch.alpha, draw.projection),
        surface: resolveSurface(batch.primitive.material, draw.time ?? 0, batch.textures.detail !== null, batch.textures.mr !== null, {
          weights: batch.primitive.blend !== void 0,
          textured: batch.textures.blend !== null
        })
      });
    });
    for (const chunk of chunks2) {
      const batch = batches[chunk.batch];
      for (let j = 0; j < chunk.count; j += 1) {
        const model = batch.models[chunk.start + j];
        writeInstanceTransform(
          this.instanceData,
          j,
          { mvp: multiplyMat44(viewProj, model), lightMvp: shadow ? multiplyMat44(shadow.lightViewProj, model) : null, model, normalBasis: normalBasis3x3(model) },
          chunk.offsetFloats + j * INSTANCE_FLOATS
        );
      }
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.uniformData, 0, batches.length * UNIFORM_FLOATS);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.instanceData, 0, cursor);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.program);
    let program = this.program;
    gl.bindBufferBase(gl.UNIFORM_BUFFER, BLOCK_LIGHTS, this.lightBuffer);
    this.bindTexture(UNIT_SHADOW, this.shadowTexture ?? this.blankFloat);
    this.bindTexture(UNIT_ENV, this.envTexture ?? this.blankTexture);
    this.bindTexture(UNIT_PROBES, this.probeTexture ?? this.blankTexture);
    this.frameUniforms(this.program);
    this.bindTexture(UNIT_SSAO, ssao ? this.ssaoTexture : this.blankFloat);
    for (let unit = UNIT_BASE; unit <= UNIT_EMIS; unit += 1) gl.bindSampler(unit, this.sampler);
    gl.bindSampler(UNIT_LM, this.sampler);
    gl.bindSampler(UNIT_DETAIL, this.sampler);
    gl.bindSampler(UNIT_BLEND, this.sampler);
    this.bindTexture(UNIT_SCENE_DEPTH, this.blankFloat);
    gl.bindSampler(UNIT_SCENE_DEPTH, null);
    const soft = batches.some((batch) => softEdges(batch.primitive.material, batch.alpha, draw.projection) !== void 0);
    let depthCopied = false;
    this.timer?.begin();
    let bound = null;
    let boundBatch = -1;
    let blendState = -1;
    const setBlend = (alpha) => {
      const state = alpha >= 2 ? alpha : 0;
      if (state === blendState) return;
      blendState = state;
      if (state === 0) {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      } else {
        gl.enable(gl.BLEND);
        gl.depthMask(false);
        if (state === 2) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      }
    };
    let triangles = 0;
    for (const chunk of chunks2) {
      const batch = batches[chunk.batch];
      const wanted = this.programOf(batch.primitive.material);
      if (wanted !== program) {
        program = wanted;
        gl.useProgram(program);
        this.frameUniforms(program);
      }
      if (soft && !depthCopied && batch.alpha >= 2) {
        this.copySceneDepth();
        depthCopied = true;
      }
      setBlend(batch.alpha);
      if (chunk.batch !== boundBatch) {
        gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK_UNIFORMS, this.uniformBuffer, chunk.batch * UNIFORM_STRIDE, UNIFORM_BYTES_USED);
        if (bound !== batch.textures) {
          this.bindTexture(UNIT_BASE, this.textureFor(batch.textures.base));
          this.bindTexture(UNIT_MR, this.textureFor(batch.textures.mr));
          this.bindTexture(UNIT_OCC, this.textureFor(batch.textures.occ));
          this.bindTexture(UNIT_EMIS, this.textureFor(batch.textures.emis));
          this.bindTexture(UNIT_LM, this.textureFor(batch.textures.lm));
          this.bindTexture(UNIT_DETAIL, this.textureFor(batch.textures.detail));
          this.bindTexture(UNIT_BLEND, this.textureFor(batch.textures.blend));
          bound = batch.textures;
        }
        gl.bindVertexArray(batch.geometry.vao);
        boundBatch = chunk.batch;
      }
      gl.bindBufferRange(gl.UNIFORM_BUFFER, BLOCK_INSTANCES, this.instanceBuffer, chunk.offsetFloats * 4, WEBGL_INSTANCES_PER_DRAW * INSTANCE_FLOATS * 4);
      gl.drawElementsInstanced(gl.TRIANGLES, batch.geometry.indexCount, gl.UNSIGNED_INT, 0, chunk.count);
      triangles += batch.geometry.indexCount / 3 * chunk.count;
    }
    gl.bindVertexArray(null);
    setBlend(0);
    this.timer?.end();
    this.lastFrameStats = { drawCalls: chunks2.length, instances: instanceCount, triangles, gpuMs: this.timer?.lastMs ?? null };
    this.submitted += 1;
    const slot = this.readback.find((s) => s.fence === null);
    if (slot) {
      slot.seq = this.submitted;
      this.readSeq = this.submitted;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buffer);
      gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this.pending.push(slot);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.flush();
  }
  /** The per-frame uniforms a program needs (probes, clusters), set when it's put to use. */
  frameUniforms(program) {
    const gl = this.gl;
    gl.uniform4fv(gl.getUniformLocation(program, "probeData"), this.probeData);
    gl.uniform4fv(gl.getUniformLocation(program, "clusterParams"), this.clusterParams);
    gl.uniform4fv(gl.getUniformLocation(program, "clusterInfo"), this.clusterInfo);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, "nearShadowMvp"), false, this.nearShadowMvp);
    gl.uniform4fv(gl.getUniformLocation(program, "nearShadow"), this.nearShadow);
    gl.uniform4fv(gl.getUniformLocation(program, "localShadowInfo"), this.localShadowInfo);
    gl.uniform4fv(gl.getUniformLocation(program, "probeGridMin"), this.probeGridMin);
    gl.uniform4fv(gl.getUniformLocation(program, "probeGridScale"), this.probeGridScale);
    gl.uniform4fv(gl.getUniformLocation(program, "probeGridCount"), this.probeGridCount);
    if (this.localShadowInfo[0] > 0) {
      gl.uniformMatrix4fv(gl.getUniformLocation(program, "shadowTileMvp"), false, this.shadowTileMvp);
      gl.uniform4fv(gl.getUniformLocation(program, "shadowTileParams"), this.shadowTileParams);
    }
  }
  /** Point the probe uniforms at a frame's grid (uploading it once per grid), and bind it (a blank when there's none). */
  uploadProbeGrid(grid) {
    const gl = this.gl;
    if (grid && grid !== this.gridSource) {
      if (this.gridTexture) gl.deleteTexture(this.gridTexture);
      const [nx, ny, nz] = grid.counts;
      gl.activeTexture(gl.TEXTURE0 + UNIT_PROBE_GRID);
      this.gridTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.gridTexture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, nx * 6, ny, nz, 0, gl.RGBA, gl.FLOAT, lightProbeTexels(grid));
      this.gridSource = grid;
    }
    this.probeGridMin.set(grid ? [...grid.min, 1] : [0, 0, 0, 0]);
    if (grid) {
      this.probeGridScale.set([0, 1, 2].map((a) => (grid.counts[a] - 1) / (grid.max[a] - grid.min[a] || 1)));
      this.probeGridCount.set(grid.counts);
    }
    gl.activeTexture(gl.TEXTURE0 + UNIT_PROBE_GRID);
    gl.bindTexture(gl.TEXTURE_3D, grid ? this.gridTexture : this.blankProbe());
    gl.bindSampler(UNIT_PROBE_GRID, null);
  }
  /** A 1×1×1 stand-in so the 3D sampler always has a complete texture. */
  blankProbe() {
    if (!this.gridBlank) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + UNIT_PROBE_GRID);
      this.gridBlank = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.gridBlank);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, 1, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    }
    return this.gridBlank;
  }
  /** Upload a frame's shadow tiles into the atlas, and bind it (a blank stands in when there are none). */
  uploadLocalShadows(local) {
    const gl = this.gl;
    const on = local && local.tiles.length > 0;
    this.localShadowInfo.set(on ? [1, local.bias, local.slopeBias, 0] : [0, 0, 0, 0]);
    if (on) {
      if (!this.localAtlas) {
        const side = LOCAL_SHADOW_TILE * LOCAL_SHADOW_GRID;
        gl.activeTexture(gl.TEXTURE0 + UNIT_LOCAL_SHADOWS);
        this.localAtlas = createTexture(gl, side, side, gl.R32F, gl.RED, gl.FLOAT, null);
      }
      this.bindTexture(UNIT_LOCAL_SHADOWS, this.localAtlas);
      local.tiles.slice(0, MAX_LOCAL_SHADOW_TILES).forEach((tile, i) => {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, i % LOCAL_SHADOW_GRID * LOCAL_SHADOW_TILE, Math.floor(i / LOCAL_SHADOW_GRID) * LOCAL_SHADOW_TILE, LOCAL_SHADOW_TILE, LOCAL_SHADOW_TILE, gl.RED, gl.FLOAT, tile.depth);
        this.shadowTileMvp.set(tile.lightViewProj, i * 16);
        this.shadowTileParams.set(tile.linear, i * 4);
      });
    }
    this.bindTexture(UNIT_LOCAL_SHADOWS, this.localAtlas ?? this.blankFloat);
    gl.bindSampler(UNIT_LOCAL_SHADOWS, null);
  }
  /** Upload a frame's cells (only the index rows in use), and bind both textures. */
  uploadClusters(clusters) {
    const gl = this.gl;
    if (!this.clusterTextures) {
      const make = (internal, w, h) => {
        const texture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + UNIT_CLUSTER_TABLE);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        return texture;
      };
      this.clusterTextures = { table: make(gl.RG32UI, CLUSTER_X * CLUSTER_Y, CLUSTER_Z), index: make(gl.R32UI, 1024, CLUSTER_INDEX_CAP / 1024) };
    }
    if (clusters) {
      this.bindTexture(UNIT_CLUSTER_TABLE, this.clusterTextures.table);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CLUSTER_X * CLUSTER_Y, CLUSTER_Z, gl.RG_INTEGER, gl.UNSIGNED_INT, clusters.table);
      const rows = Math.ceil(clusters.used / 1024);
      if (rows > 0) {
        this.bindTexture(UNIT_CLUSTER_INDEX, this.clusterTextures.index);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, rows, gl.RED_INTEGER, gl.UNSIGNED_INT, clusters.indices.subarray(0, rows * 1024));
      }
    }
    this.bindTexture(UNIT_CLUSTER_TABLE, this.clusterTextures.table);
    this.bindTexture(UNIT_CLUSTER_INDEX, this.clusterTextures.index);
    gl.bindSampler(UNIT_CLUSTER_TABLE, null);
    gl.bindSampler(UNIT_CLUSTER_INDEX, null);
  }
  /** The program a material draws with: the plain one, or its graph's variant. */
  programOf(material) {
    const graph = compiledGraphOf(material);
    if (!graph) return this.program;
    let program = this.graphPrograms.get(graph.key);
    if (!program) {
      try {
        program = buildProgram2(this.gl, this.nearest, graph);
      } catch {
        program = this.program;
      }
      this.graphPrograms.set(graph.key, program);
    }
    return program;
  }
  /** Copy the main framebuffer's depth into {@link sceneDepth} and bind it, leaving the main framebuffer bound. */
  copySceneDepth() {
    const gl = this.gl;
    if (!this.sceneDepth) {
      const texture = gl.createTexture();
      this.bindTexture(UNIT_SCENE_DEPTH, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
      this.sceneDepth = { texture, framebuffer };
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneDepth.framebuffer);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    this.bindTexture(UNIT_SCENE_DEPTH, this.sceneDepth.texture);
  }
  ensureCapacity(draws, instanceFloats) {
    const gl = this.gl;
    if (draws > this.uniformCapacity) {
      this.uniformCapacity = Math.max(draws, this.uniformCapacity * 2, 8);
      this.uniformData = new Float32Array(this.uniformCapacity * UNIFORM_FLOATS);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
      gl.bufferData(gl.UNIFORM_BUFFER, this.uniformData.byteLength, gl.DYNAMIC_DRAW);
    }
    if (instanceFloats > this.instanceFloats) {
      this.instanceFloats = Math.max(instanceFloats, this.instanceFloats * 2);
      this.instanceData = new Float32Array(this.instanceFloats);
      gl.bindBuffer(gl.UNIFORM_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.UNIFORM_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
    }
  }
  bindTexture(unit, texture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
  }
  textureFor(source) {
    if (!source) return this.blankTexture;
    let texture = this.textures.get(source);
    if (!texture) {
      texture = createTexture(this.gl, source.width, source.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, toBytes(source.data));
      this.textures.set(source, texture);
    }
    return texture;
  }
  uploadShadow(shadow) {
    const gl = this.gl;
    if (!shadow) return;
    const cascades = shadow.near ? 2 : 1;
    if (shadow.size !== this.shadowSize || cascades !== this.shadowCascades || !this.shadowTexture) {
      if (this.shadowTexture) gl.deleteTexture(this.shadowTexture);
      this.shadowTexture = createTexture(gl, shadow.size * cascades, shadow.size, gl.R32F, gl.RED, gl.FLOAT, null);
      this.shadowSize = shadow.size;
      this.shadowCascades = cascades;
      this.shadowUploaded = null;
      this.nearUploaded = null;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    const dirty = shadow.dirty;
    if (dirty && this.shadowUploaded === shadow.depth) {
      if (dirty.width > 0 && dirty.height > 0) {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, shadow.size);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, dirty.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, dirty.y);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, dirty.x, dirty.y, dirty.width, dirty.height, gl.RED, gl.FLOAT, shadow.depth);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, shadow.size, shadow.size, gl.RED, gl.FLOAT, shadow.depth);
      this.shadowUploaded = shadow.depth;
    }
    const near = shadow.near;
    if (near) {
      const nd = near.dirty;
      if (nd && this.nearUploaded === near.depth) {
        if (nd.width > 0 && nd.height > 0) {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, shadow.size);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, nd.x);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, nd.y);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, shadow.size + nd.x, nd.y, nd.width, nd.height, gl.RED, gl.FLOAT, near.depth);
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
        }
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, shadow.size, 0, shadow.size, shadow.size, gl.RED, gl.FLOAT, near.depth);
        this.nearUploaded = near.depth;
      }
    }
  }
  uploadEnv(map) {
    if (map === this.envSource) return;
    if (this.envTexture) this.gl.deleteTexture(this.envTexture);
    this.envTexture = map ? createTexture(this.gl, map.width, map.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, toBytes(map.data)) : null;
    this.envSource = map;
  }
  uploadProbes(set) {
    const atlas = set?.atlas ?? null;
    if (atlas === this.probeSource) return;
    if (this.probeTexture) this.gl.deleteTexture(this.probeTexture);
    this.probeTexture = atlas ? createTexture(this.gl, atlas.width, atlas.height, this.gl.RGBA8, this.gl.RGBA, this.gl.UNSIGNED_BYTE, toBytes(atlas.data)) : null;
    this.probeSource = atlas;
    this.probeData.fill(0);
    this.probeData.set(packProbes(set).subarray(0, this.probeData.length));
  }
  uploadSsao(ao) {
    if (!ao) return;
    const gl = this.gl;
    if (!this.ssaoTexture) this.ssaoTexture = createTexture(gl, this.width, this.height, gl.R32F, gl.RED, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.ssaoTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RED, gl.FLOAT, ao);
  }
  /** Upload (once) a mesh's primitives; a live skinned primitive re-uploads when its revision moves on. */
  uploadMesh(mesh) {
    const gl = this.gl;
    const cached = this.meshes.get(mesh);
    if (cached) {
      mesh.primitives.forEach((primitive, i) => {
        const g = cached[i];
        if (!primitive.dynamic || !g || g.revision === primitive.dynamic.revision) return;
        const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.vertexBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null));
        g.revision = primitive.dynamic.revision;
      });
      return cached;
    }
    const uploaded = mesh.primitives.map((primitive) => {
      const normals = primitive.normals ?? computeSmoothNormals(primitive.positions, primitive.indices);
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vertexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null), primitive.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      const stride = VERTEX_FLOATS * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 32);
      gl.enableVertexAttribArray(4);
      gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 40);
      const indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, primitive.indices, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      return {
        vao,
        vertexBuffer,
        indexBuffer,
        indexCount: primitive.indices.length,
        ...primitive.dynamic ? { revision: primitive.dynamic.revision } : {}
      };
    });
    this.meshes.set(mesh, uploaded);
    return uploaded;
  }
  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.latest = null;
    this.software.dispose();
    const gl = this.gl;
    try {
      for (const slot of this.readback) {
        if (slot.fence) gl.deleteSync(slot.fence);
        gl.deleteBuffer(slot.buffer);
      }
      gl.deleteBuffer(this.uniformBuffer);
      gl.deleteBuffer(this.instanceBuffer);
      gl.deleteBuffer(this.lightBuffer);
      for (const t of [this.blankTexture, this.blankFloat, this.shadowTexture, this.envTexture, this.probeTexture, this.ssaoTexture]) if (t) gl.deleteTexture(t);
      gl.deleteFramebuffer(this.framebuffer);
      if (this.localAtlas) gl.deleteTexture(this.localAtlas);
      if (this.gridTexture) gl.deleteTexture(this.gridTexture);
      if (this.gridBlank) gl.deleteTexture(this.gridBlank);
      if (this.clusterTextures) {
        gl.deleteTexture(this.clusterTextures.table);
        gl.deleteTexture(this.clusterTextures.index);
      }
      if (this.sceneDepth) {
        gl.deleteTexture(this.sceneDepth.texture);
        gl.deleteFramebuffer(this.sceneDepth.framebuffer);
      }
      this.timer?.destroy();
      for (const rb of this.attachments) gl.deleteRenderbuffer(rb);
      gl.deleteSampler(this.sampler);
      gl.deleteProgram(this.program);
      for (const program of this.graphPrograms.values()) if (program !== this.program) gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
    }
  }
};
function createTexture(gl, width, height, internal, format, type, data) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
  return texture;
}
function toBytes(data) {
  return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// src/render/WebgpuSceneRenderer.ts
import {
  DEFAULT_RASTER_STYLE as DEFAULT_RASTER_STYLE3,
  DETAIL_FAR as DETAIL_FAR2,
  DETAIL_NEAR as DETAIL_NEAR2,
  LIGHTMAP_RANGE as LIGHTMAP_RANGE2,
  MAX_REFLECTION_PROBES as MAX_REFLECTION_PROBES3,
  PROBE_FADE as PROBE_FADE2,
  FOG_GLOW_POWER as FOG_GLOW_POWER2,
  PROBE_RANGE as PROBE_RANGE2,
  EFFECT_BAND_FREQUENCY as EFFECT_BAND_FREQUENCY2,
  EFFECT_BAND_POWER as EFFECT_BAND_POWER2,
  EFFECT_BAND_SPEED as EFFECT_BAND_SPEED2,
  EFFECT_CAMO_CRAWL as EFFECT_CAMO_CRAWL2,
  cameraPositionFromView as cameraPositionFromView3,
  compiledGraphOf as compiledGraphOf2,
  computeSmoothNormals as computeSmoothNormals2,
  lightProbeTexels as lightProbeTexels2,
  LOCAL_SHADOW_GRID as LOCAL_SHADOW_GRID2,
  LOCAL_SHADOW_TILE as LOCAL_SHADOW_TILE2,
  MAX_LOCAL_SHADOW_TILES as MAX_LOCAL_SHADOW_TILES2,
  NEAR_CASCADE_EDGE as NEAR_CASCADE_EDGE2,
  CLUSTER_CELLS,
  CLUSTER_INDEX_CAP as CLUSTER_INDEX_CAP2,
  CLUSTER_X as CLUSTER_X2,
  CLUSTER_Y as CLUSTER_Y2,
  CLUSTER_Z as CLUSTER_Z2,
  buildLightClusters as buildLightClusters2,
  orderLights as orderLights2,
  graphNoiseSource as graphNoiseSource2,
  graphShaderCode as graphShaderCode2,
  graphUsesNoise as graphUsesNoise2,
  multiplyMat4 as multiplyMat45
} from "@cartbox/editor";
var FRAME_BYTES = 176;
var READBACK_BUFFERS2 = 3;
var SHADER_STAGE_VERTEX = 1;
var SHADER_STAGE_FRAGMENT = 2;
function graphSites2(graph) {
  if (!graph) return { fns: "", base: "", pbr: "", emis: "" };
  const out = graph.outputs;
  const code = graphShaderCode2(graph, "wgsl", {
    uv: "in.uv",
    position: "in.worldPos",
    normal: "gN",
    view: "u.view.xyz",
    time: "u.effect1.w",
    baseColor: "colour.rgb",
    baseAlpha: "colour.a",
    sample: (p) => `textureSample(tex, samp, vec2<f32>((${p}).x, 1.0 - (${p}).y))`
  });
  const set = [
    out.baseColor !== void 0 ? `colour = vec4<f32>(g${out.baseColor}, colour.a);` : "",
    out.alpha !== void 0 ? `colour.a = clamp(g${out.alpha}.x, 0.0, 1.0);` : "",
    out.metallic !== void 0 ? `gMetal = clamp(g${out.metallic}.x, 0.0, 1.0);` : "",
    out.roughness !== void 0 ? `gRough = g${out.roughness}.x;` : "",
    out.emissive !== void 0 ? `gEmis = max(g${out.emissive}, vec3<f32>(0.0));` : ""
  ].filter(Boolean);
  return {
    fns: graphUsesNoise2(graph) ? graphNoiseSource2("wgsl") : "",
    base: `  // The material graph (EP7).
  var gMetal = -1.0;
  var gRough = -1.0;
  var gEmis = vec3<f32>(-1.0);
  {
    var gN = normalize(in.normal);
    if (dot(gN, u.view.xyz) < 0.0) { gN = -gN; }
${code.split("\n").map((l) => `    ${l}`).join("\n")}
${set.map((l) => `    ${l}`).join("\n")}
  }`,
    pbr: `    if (gMetal >= 0.0) { metallic = gMetal; }
    if (gRough >= 0.0) { rough = gRough; }`,
    emis: `    if (gEmis.x >= 0.0) { emis = gEmis; }`
  };
}
function sceneShader(graph = null) {
  const g = graphSites2(graph);
  return (
    /* wgsl */
    `
struct Uniforms {
  mvp: mat4x4<f32>,
  nrm: mat3x3<f32>,
  base: vec4<f32>,
  light: vec4<f32>,     // xyz = normalised direction, w = ambient floor
  view: vec4<f32>,      // xyz = direction towards the viewer (Modern PBR)
  pbr: vec4<f32>,       // x = metallic, y = roughness, z = 1 when PBR
  emissive: vec4<f32>,  // xyz = emissive factor
  texflags: vec4<f32>,  // x = base, y = mr, z = occlusion, w = emissive
  envSky: vec4<f32>,    // xyz = sky colour, w = 1 when an environment is set
  envHorizon: vec4<f32>,// xyz = horizon colour, w = intensity
  envGround: vec4<f32>, // xyz = ground colour
  lightMvp: mat4x4<f32>,// world\u2192light-clip for shadow mapping
  shadow: vec4<f32>,    // x = 1 when shadowed, y = map size, z = bias, w = strength
  envMeta: vec4<f32>,   // xyz = env-map mean radiance, w = 1 when an env map is bound
  tonemap: vec4<f32>,   // x = 1 when tone-mapping, y = exposure
  ssaoMeta: vec4<f32>,  // x = 1 when an SSAO buffer is bound, y = light count, z = 1 when a light map is bound
  model: mat4x4<f32>,   // this draw's world matrix (point-light world position)
  fog: vec4<f32>,       // rgb = fog colour, w = density
  fogParams: vec4<f32>, // x = 1 when fogged, y = start distance, z = max amount
  shadow2: vec4<f32>,   // x = slope-scaled bias, y = 1 for 2x2 PCF
  surface0: vec4<f32>,  // x = detail scale, y = detail strength, z = reflectivity, w = 1 when MR alpha masks it
  surface1: vec4<f32>,  // xy = emissive UV offset
  surface2: vec4<f32>,  // rgb = rim colour \xD7 strength, w = rim power
  surface3: vec4<f32>,  // rgb = blend-surface colour, w = its roughness (< 0 keeps)
  fogCam: vec4<f32>,    // xyz = eye (world), w = fog volume count
  fogHeight: vec4<f32>, // x = height-fog density, y = base, z = falloff, w = glow strength
  fogGlow: vec4<f32>,   // rgb = sun-glow colour
  fogVol: array<vec4<f32>, 8>, // per volume: min xyz + density, max xyz + falloff
  effect0: vec4<f32>,   // rgb = surface effect glow, w = camo amount
  effect1: vec4<f32>,   // rgb = surface effect bands, w = time
};

// A Modern-tier light (see packLights): d0 = dir/pos + kind, d1 = colour +
// intensity, d2.x = point range. Read from a shared storage buffer.
struct Light {
  d0: vec4<f32>,
  d1: vec4<f32>,
  d2: vec4<f32>,
  d3: vec4<f32>,
};
// Per-frame globals. Clustered lights (EP8): clusterParams = tile size (px),
// near plane, slice scale; clusterInfo.x = global lights (looped by every
// fragment), .y = 1 when cells are built. The near shadow cascade (EP8b):
// world\u2192light-clip, and nearShadow = (1 when present, bias, slope bias).
struct Frame {
  clusterParams: vec4<f32>,
  clusterInfo: vec4<f32>,
  nearMvp: mat4x4<f32>,
  nearShadow: vec4<f32>,
  localShadow: vec4<f32>, // EP8c: x = 1 when spot/point shadows are on, y = bias, z = slope bias (world units)
  probeMin: vec4<f32>,    // EP9: the probe grid's corner, w = 1 when a grid is bound
  probeScale: vec4<f32>,  // world \u2192 grid units per axis: (count \u2212 1) / (max \u2212 min)
  probeCount: vec4<f32>,  // probes per axis
};
// One spot/point shadow tile (EP8c): world\u2192clip, and params.xy = depth\u2192distance terms.
struct ShadowTile {
  mvp: mat4x4<f32>,
  params: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var mrTex: texture_2d<f32>;
@group(0) @binding(4) var occTex: texture_2d<f32>;
@group(0) @binding(5) var emisTex: texture_2d<f32>;
// The shadow map: light-NDC depth in R, generated on the CPU by renderShadowMap
// and uploaded as r32float, so the GPU samples the *same* map the software path
// tests against. Unfilterable, read via textureLoad (nearest) \u2014 matching the
// software compare exactly.
@group(0) @binding(6) var shadowMap: texture_2d<f32>;
// The equirectangular environment map, read via textureLoad (nearest) to match
// sampleEquirectRgb in meshRasterizer.ts. Bound to a 1x1 blank when unused.
@group(0) @binding(7) var envMap: texture_2d<f32>;
// The screen-space AO buffer (CPU-generated by computeSsao, uploaded r32float),
// sampled per fragment by its framebuffer pixel \u2014 the same buffer the software
// path multiplies its ambient by. Bound to a 1x1 blank when unused.
@group(0) @binding(8) var ssaoMap: texture_2d<f32>;
// The Modern-tier light list (packLights); the uniform's ssaoMeta.y bounds the
// loop, so a spare 1-light buffer is bound when there are none.
@group(0) @binding(9) var<storage, read> lights: array<Light>;
// Per-instance transforms (see "Instancing" above), indexed by instance_index \u2014
// which counts from the draw's firstInstance, so each batch reads its own run.
struct InstanceXf {
  mvp: mat4x4<f32>,
  lightMvp: mat4x4<f32>,
  model: mat4x4<f32>,
  nrm: mat3x3<f32>,
};
@group(0) @binding(10) var<storage, read> xf: array<InstanceXf>;
// A baked light map, sampled with the second UV set (1x1 white when none).
@group(0) @binding(11) var lmTex: texture_2d<f32>;
// Reflection probes (probeSampling.ts in @cartbox/editor): every probe's
// panorama stacked in one atlas, and each one's box, capture point and mean
// colour; the uniform's ssaoMeta.w counts them (a zeroed slot when none).
struct Probe {
  mn: vec4<f32>,
  mx: vec4<f32>,
  pos: vec4<f32>,
  avg: vec4<f32>,
};
@group(0) @binding(12) var probeAtlas: texture_2d<f32>;
@group(0) @binding(13) var<storage, read> probes: array<Probe>;
// A finely tiled detail map (materialEffects.ts; 1x1 white when none \u2014 the
// uniform's surface0.y gates it).
@group(0) @binding(14) var detailTex: texture_2d<f32>;
// The blend surface's map (terrain snow over rock), mixed by the vertex weight.
@group(0) @binding(15) var blendTex: texture_2d<f32>;
// The opaque pass's depth (EP6b), read by the see-through pass for soft edges;
// the opaque pass binds a blank in its place.
@group(1) @binding(0) var sceneDepth: texture_depth_2d;
// Clustered lights (EP8): per cell (offset, count) into the index list.
@group(1) @binding(1) var<storage, read> clusterTable: array<vec2<u32>>;
@group(1) @binding(2) var<storage, read> clusterIndex: array<u32>;
@group(1) @binding(3) var<uniform> frame: Frame;
// Spot and point light shadows (EP8c): the tile atlas and each tile's view.
@group(1) @binding(4) var localAtlas: texture_2d<f32>;
@group(1) @binding(5) var<storage, read> shadowTiles: array<ShadowTile>;
// Light probes (EP9): the grid as a 3D texture, face f's probes at x = f \xB7 nx + probe x.
@group(1) @binding(6) var probeGrid: texture_3d<f32>;

// Optical depth of a fog layer thinning above base, along the ray from the eye
// (height cy, rise dy, length len) over t in [t0, t1] \u2014 fogLayerDepth in skyDome.ts.
fn fogLayer(d: f32, k: f32, base: f32, cy: f32, dy: f32, len: f32, t0: f32, t1: f32) -> f32 {
  if (d <= 0.0 || t1 <= t0) { return 0.0; }
  let ya = cy + dy * t0 - base;
  let yb = cy + dy * t1 - base;
  let y0 = min(ya, yb);
  let y1 = max(ya, yb);
  let span = d * len * (t1 - t0);
  let h = y1 - y0;
  if (h < 1e-5) { return span * exp(-k * max(0.0, y0)); }
  var tau = 0.0;
  if (y0 < 0.0) { tau = tau + span * (min(y1, 0.0) - y0) / h; }
  if (y1 > 0.0) {
    let lo = max(y0, 0.0);
    let above = y1 - lo;
    if (k * above < 1e-4) {
      tau = tau + span * above * exp(-k * lo) / h;
    } else {
      tau = tau + span * (exp(-k * lo) - exp(-k * y1)) / (k * h);
    }
  }
  return tau;
}

// Where the segment c \u2192 c + dir\xB7t (t in [0, 1]) is inside a box: (t0, t1), or t0 >= t1 when it misses.
fn fogBox(mn: vec3<f32>, mx: vec3<f32>, c: vec3<f32>, dir: vec3<f32>) -> vec2<f32> {
  var t0 = 0.0;
  var t1 = 1.0;
  for (var a = 0; a < 3; a = a + 1) {
    if (abs(dir[a]) < 1e-9) {
      if (c[a] < mn[a] || c[a] > mx[a]) { return vec2<f32>(1.0, 0.0); }
    } else {
      let ta = (mn[a] - c[a]) / dir[a];
      let tb = (mx[a] - c[a]) / dir[a];
      t0 = max(t0, min(ta, tb));
      t1 = min(t1, max(ta, tb));
    }
  }
  return vec2<f32>(t0, t1);
}

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) lightClip: vec4<f32>,
  @location(3) worldPos: vec3<f32>,
  @location(4) eyeDepth: f32,
  @location(5) uv2: vec2<f32>,
  @location(6) bw: f32,
};

// Directional shadow test, mirroring rasterizeTriangle in meshRasterizer.ts:
// project into the light's frame, look up the nearest depth the light sees, and
// return 1 (lit) or 1\u2212strength (occluded). The light is orthographic (w = 1).
fn shadowTap(fx: f32, fy: f32, z: f32, ox: f32) -> f32 {
  let size = u.shadow.y;
  let tx = i32(clamp(floor(fx), 0.0, size - 1.0) + ox);
  let ty = i32(clamp(floor(fy), 0.0, size - 1.0));
  let stored = textureLoad(shadowMap, vec2<i32>(tx, ty), 0).r;
  if (z > stored) { return 0.0; }
  return 1.0;
}
// cosL = |N.L| of the geometric normal against the key light, for the slope bias.
// Mirrors shadowVisibility in meshRasterizer.ts.
// One shadow map's test at a light-NDC point: the main map (ox 0) or the near
// cascade packed to its right (ox = size), with its own biases.
fn shadowAt(ndc: vec3<f32>, bias0: f32, slope: f32, ox: f32, cosL: f32) -> f32 {
  let size = u.shadow.y;
  let sx = (ndc.x * 0.5 + 0.5) * size;
  let sy = (1.0 - (ndc.y * 0.5 + 0.5)) * size;
  var bias = bias0;
  if (slope > 0.0) {
    let c = clamp(cosL, 0.05, 1.0);
    bias = bias + slope * min(10.0, sqrt(1.0 - c * c) / c);
  }
  let z = ndc.z - bias;
  if (u.shadow2.y < 0.5) {
    if (shadowTap(sx, sy, z, ox) < 0.5) { return 1.0 - u.shadow.w; }
    return 1.0;
  }
  let lit = (shadowTap(sx - 0.5, sy - 0.5, z, ox) + shadowTap(sx + 0.5, sy - 0.5, z, ox)
           + shadowTap(sx - 0.5, sy + 0.5, z, ox) + shadowTap(sx + 0.5, sy + 0.5, z, ox)) * 0.25;
  return 1.0 - u.shadow.w * (1.0 - lit);
}
// The sun's shadow (mirrors sunShadowVisibility): the near cascade (EP8b) when
// the point sits well inside it, else the main map.
fn shadowFactor(lightClip: vec4<f32>, worldPos: vec3<f32>, cosL: f32) -> f32 {
  if (u.shadow.x < 0.5) { return 1.0; }
  if (frame.nearShadow.x > 0.5) {
    let n = (frame.nearMvp * vec4<f32>(worldPos, 1.0)).xyz;
    if (abs(n.x) < ${NEAR_CASCADE_EDGE2} && abs(n.y) < ${NEAR_CASCADE_EDGE2} && abs(n.z) <= 1.0) {
      return shadowAt(n, frame.nearShadow.y, frame.nearShadow.z, u.shadow.y, cosL);
    }
  }
  let ndc = lightClip.xyz / lightClip.w;
  if (ndc.x < -1.0 || ndc.x > 1.0 || ndc.y < -1.0 || ndc.y > 1.0 || ndc.z < -1.0 || ndc.z > 1.0) {
    return 1.0;
  }
  return shadowAt(ndc, u.shadow.z, u.shadow2.x, 0.0, cosL);
}

// Analytic environment (Phase 3 IBL), mirroring environmentColor /
// environmentAverage in meshRasterizer.ts: a sky/horizon/ground vertical
// gradient sampled by a direction's Y. WGSL mix(a,b,k) = a+(b-a)*k, matching the
// software helper exactly.
fn envGradient(y: f32) -> vec3<f32> {
  let t = clamp(y, -1.0, 1.0);
  var c: vec3<f32>;
  if (t >= 0.0) { c = mix(u.envHorizon.xyz, u.envSky.xyz, t); }
  else { c = mix(u.envHorizon.xyz, u.envGround.xyz, -t); }
  return c * u.envHorizon.w; // .w = intensity
}
// Sample the environment along a full direction: an equirectangular map when one
// is bound (envMeta.w), else the analytic gradient (Y only). Mirrors
// sampleEnvironmentDir in meshRasterizer.ts \u2014 nearest via textureLoad.
fn envColorDir(dir: vec3<f32>) -> vec3<f32> {
  if (u.envMeta.w < 0.5) { return envGradient(dir.y); }
  let d = normalize(dir);
  let uCoord = atan2(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  let vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  let dims = vec2<f32>(textureDimensions(envMap, 0));
  let wx = uCoord - floor(uCoord);
  let tx = i32(clamp(floor(wx * dims.x), 0.0, dims.x - 1.0));
  let ty = i32(clamp(floor(vCoord * dims.y), 0.0, dims.y - 1.0));
  return textureLoad(envMap, vec2<i32>(tx, ty), 0).rgb * u.envHorizon.w;
}
// Probe i's panorama along a direction, nearest \u2014 mirrors sampleProbe.
fn probeSample(i: i32, dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let uCoord = atan2(d.z, d.x) / (2.0 * 3.14159265) + 0.5;
  let vCoord = acos(clamp(d.y, -1.0, 1.0)) / 3.14159265;
  let dims = vec2<f32>(textureDimensions(probeAtlas, 0));
  let h = floor(dims.x * 0.5);
  let tx = i32(clamp(floor((uCoord - floor(uCoord)) * dims.x), 0.0, dims.x - 1.0));
  let ty = i32(clamp(floor(vCoord * h), 0.0, h - 1.0) + f32(i) * h);
  return textureLoad(probeAtlas, vec2<i32>(tx, ty), 0).rgb * ${PROBE_RANGE2.toFixed(4)};
}
// The 2\xD72 ordered-dither matrix [[0, 2], [3, 1]], and the crawling camo threshold (surfaceEffect.ts).
fn bayer2(x: i32, y: i32) -> f32 {
  if ((y & 1) == 1) { return select(3.0, 1.0, (x & 1) == 1); }
  return select(0.0, 2.0, (x & 1) == 1);
}
fn camoThreshold(p: vec2<f32>, time: f32) -> f32 {
  let s = i32(floor(time * ${EFFECT_CAMO_CRAWL2.toFixed(1)}));
  let px = i32(floor(p.x)) + s;
  let py = i32(floor(p.y)) + s * 3;
  return (4.0 * bayer2(px, py) + bayer2(px >> 1u, py >> 1u) + 0.5) / 16.0;
}
// What reaches the framebuffer (EP6): opaque and cut-out surfaces cover the
// pixel (alpha 1); a blended one leaves premultiplied colour and its coverage
// (the pipeline blends it over what's there); an added one leaves its light
// and no coverage (the pipeline adds it). compositeFrame reads the same codes.
fn finishAlpha(rgb: vec3<f32>, a: f32) -> vec4<f32> {
  let c = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
  if (u.pbr.w > 2.5) { return vec4<f32>(c * a, 0.0); }
  if (u.pbr.w > 1.5) { return vec4<f32>(c * a, a); }
  return vec4<f32>(c, 1.0);
}
// A spot/point light's shadow at P (mirrors localShadowVisibility): the tile
// that sees it (a point light's face by dominant axis), a 2\xD72 PCF of distance
// compares against a slope-scaled world bias.
fn localTap(fx: f32, fy: f32, ox: f32, oy: f32, own: f32, a: f32, b: f32) -> f32 {
  let size = ${LOCAL_SHADOW_TILE2}.0;
  let tx = i32(clamp(floor(fx), 0.0, size - 1.0) + ox);
  let ty = i32(clamp(floor(fy), 0.0, size - 1.0) + oy);
  let stored = textureLoad(localAtlas, vec2<i32>(tx, ty), 0).r;
  if (own > b / (min(stored, 1.0) + a)) { return 0.0; }
  return 1.0;
}
fn localShadow(first: i32, lgt: Light, P: vec3<f32>, cosL: f32) -> f32 {
  var tile = first;
  if (lgt.d0.w < 1.5) {
    let d = P - lgt.d0.xyz;
    let m = abs(d);
    if (m.x >= m.y && m.x >= m.z) { tile = tile + select(1, 0, d.x >= 0.0); }
    else if (m.y >= m.z) { tile = tile + select(3, 2, d.y >= 0.0); }
    else { tile = tile + select(5, 4, d.z >= 0.0); }
  }
  let t = shadowTiles[tile];
  let c = t.mvp * vec4<f32>(P, 1.0);
  if (c.w <= 0.0) { return 1.0; }
  let n = c.xyz / c.w;
  if (n.x < -1.0 || n.x > 1.0 || n.y < -1.0 || n.y > 1.0 || n.z < -1.0 || n.z > 1.0) { return 1.0; }
  let size = ${LOCAL_SHADOW_TILE2}.0;
  let sx = (n.x * 0.5 + 0.5) * size;
  let sy = (1.0 - (n.y * 0.5 + 0.5)) * size;
  let cc = clamp(cosL, 0.05, 1.0);
  let own = t.params.y / (n.z + t.params.x) - frame.localShadow.y - frame.localShadow.z * min(10.0, sqrt(1.0 - cc * cc) / cc);
  let ox = f32((tile % ${LOCAL_SHADOW_GRID2}) * ${LOCAL_SHADOW_TILE2});
  let oy = f32((tile / ${LOCAL_SHADOW_GRID2}) * ${LOCAL_SHADOW_TILE2});
  return (localTap(sx - 0.5, sy - 0.5, ox, oy, own, t.params.x, t.params.y) + localTap(sx + 0.5, sy - 0.5, ox, oy, own, t.params.x, t.params.y)
        + localTap(sx - 0.5, sy + 0.5, ox, oy, own, t.params.x, t.params.y) + localTap(sx + 0.5, sy + 0.5, ox, oy, own, t.params.x, t.params.y)) * 0.25;
}

// One ambient-cube face of the probe grid at grid cell i + fraction f (trilinear).
fn probeFace(face: i32, i: vec3<i32>, f: vec3<f32>) -> vec3<f32> {
  let o = i + vec3<i32>(face * i32(frame.probeCount.x + 0.5), 0, 0);
  let x00 = mix(textureLoad(probeGrid, o, 0).rgb, textureLoad(probeGrid, o + vec3<i32>(1, 0, 0), 0).rgb, f.x);
  let x10 = mix(textureLoad(probeGrid, o + vec3<i32>(0, 1, 0), 0).rgb, textureLoad(probeGrid, o + vec3<i32>(1, 1, 0), 0).rgb, f.x);
  let x01 = mix(textureLoad(probeGrid, o + vec3<i32>(0, 0, 1), 0).rgb, textureLoad(probeGrid, o + vec3<i32>(1, 0, 1), 0).rgb, f.x);
  let x11 = mix(textureLoad(probeGrid, o + vec3<i32>(0, 1, 1), 0).rgb, textureLoad(probeGrid, o + vec3<i32>(1, 1, 1), 0).rgb, f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
// The ambient scale from the probe grid at P for normal N (mirrors sampleLightProbes).
fn probeLight(P: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
  let n = frame.probeCount.xyz;
  let g = clamp((P - frame.probeMin.xyz) * frame.probeScale.xyz, vec3<f32>(0.0), n - vec3<f32>(1.0));
  let i = min(vec3<i32>(floor(g)), vec3<i32>(n + vec3<f32>(0.5)) - vec3<i32>(2));
  let f = g - vec3<f32>(i);
  let nn = normalize(N);
  let w = nn * nn;
  return w.x * probeFace(select(1, 0, nn.x >= 0.0), i, f)
       + w.y * probeFace(select(3, 2, nn.y >= 0.0), i, f)
       + w.z * probeFace(select(5, 4, nn.z >= 0.0), i, f);
}

// One light's direct term (Cook-Torrance), mirroring the software rasteriser's
// light loop: point and spot lights fall off to nothing at their range, a spot
// fades across its cone, and directional lights honour the sun shadow (sf).
fn lightTerm(lgt: Light, P: vec3<f32>, N: vec3<f32>, V: vec3<f32>, ndv: f32, a2: f32, k: f32, f0: vec3<f32>, kdm: f32, albedo: vec3<f32>, sf: f32) -> vec3<f32> {
  var Ld: vec3<f32>;
  var atten = 1.0;
  if (lgt.d0.w > 0.5) { // point or spot
    let toL = lgt.d0.xyz - P;
    let dist = max(length(toL), 1e-4);
    Ld = toL / dist;
    let range = lgt.d2.x;
    if (range > 0.0) { let t = max(0.0, 1.0 - dist / range); atten = t * t; }
    if (lgt.d0.w > 1.5) {
      let ct = clamp((-dot(Ld, lgt.d3.xyz) - lgt.d2.y) / (lgt.d2.z - lgt.d2.y), 0.0, 1.0);
      atten = atten * ct * ct * (3.0 - 2.0 * ct);
    }
  } else {
    Ld = normalize(lgt.d0.xyz);
  }
  let ndlL = max(0.0, dot(N, Ld));
  if (ndlL <= 0.0 || atten <= 0.0) { return vec3<f32>(0.0); }
  let Hl = normalize(Ld + V);
  let ndhL = max(0.0, dot(N, Hl));
  let vdhL = max(0.0, dot(V, Hl));
  let ddL = ndhL * ndhL * (a2 - 1.0) + 1.0;
  let DL = a2 / (3.14159265 * ddL * ddL + 1e-7);
  let GL = (ndv / (ndv * (1.0 - k) + k)) * (ndlL / (ndlL * (1.0 - k) + k));
  let fpL = pow(1.0 - vdhL, 5.0);
  let specL = (DL * GL) / (4.0 * ndlL * ndv + 1e-4);
  let FL = f0 + (vec3<f32>(1.0) - f0) * fpL;
  var occl = 1.0;
  if (lgt.d0.w < 0.5) { occl = sf; }
  else if (lgt.d2.w >= 0.0 && frame.localShadow.x > 0.5) { occl = localShadow(i32(lgt.d2.w + 0.5), lgt, P, ndlL); }
  let w = lgt.d1.w * atten * ndlL * occl;
  return (kdm * (vec3<f32>(1.0) - FL) * albedo + FL * specL) * lgt.d1.rgb * w;
}

fn envAverage() -> vec3<f32> {
  if (u.envMeta.w > 0.5) { return u.envMeta.xyz * u.envHorizon.w; }
  return (u.envSky.xyz + u.envHorizon.xyz + u.envGround.xyz) / 3.0 * u.envHorizon.w;
}
// ACES filmic tone map (Narkowicz), per channel, mirroring acesFilmic in
// meshRasterizer.ts. Applied only to the Modern-tier PBR radiance.
fn aces(x: f32) -> f32 {
  let v = max(0.0, x);
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
}

@vertex
fn vs(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) uv2: vec2<f32>,
  @location(4) bw: f32,
  @builtin(instance_index) instance: u32,
) -> VSOut {
  var out: VSOut;
  let t = xf[instance];
  out.pos = t.mvp * vec4<f32>(position, 1.0);
  out.normal = t.nrm * normal;
  out.uv = uv;
  out.uv2 = uv2;
  out.bw = bw;
  out.lightClip = t.lightMvp * vec4<f32>(position, 1.0);
  out.worldPos = (t.model * vec4<f32>(position, 1.0)).xyz;
  out.eyeDepth = out.pos.w; // clip w = view depth, for distance fog
  return out;
}

${g.fns}
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  // glTF's V origin is top-left, so flip; the sampler wraps and (per era) filters.
  let uv = vec2<f32>(in.uv.x, 1.0 - in.uv.y);

  var colour = u.base;
  if (u.texflags.x > 0.5) {
    colour = colour * textureSample(tex, samp, uv);
  }
${g.base}
  // The CPU path skips a texel whose combined alpha is below 1/255 rather than
  // blending it, so this is a discard and not an alpha-blend state.
  // Soft edges (EP6b): a see-through surface fades out as it meets the opaque
  // scene behind it \u2014 both depths read back as view distance (shadow2.zw).
  if (u.tonemap.z > 0.0) {
    let behind = textureLoad(sceneDepth, vec2<i32>(in.pos.xy), 0);
    colour.a *= clamp((u.shadow2.w / (behind + u.shadow2.z) - u.shadow2.w / (in.pos.z + u.shadow2.z)) / u.tonemap.z, 0.0, 1.0);
  }
  if (colour.a * 255.0 < 1.0) { discard; }
  // A cut-out surface (EP6) drops what's below its threshold.
  if (u.pbr.w > 0.5 && u.pbr.w < 1.5 && colour.a < u.view.w) { discard; }

  if (u.pbr.z > 0.5) {
    // Active Camo (H11): screen-door transparency, as the rasteriser drops pixels.
    if (u.effect0.w > 0.0 && camoThreshold(in.pos.xy, u.effect1.w) < u.effect0.w) { discard; }
    // --- Modern tier: metallic-roughness BRDF (Cook-Torrance) ---
    // Mirrors the software rasteriser's PBR branch (meshRasterizer.ts) term for
    // term, in the engine's non-linear byte space (a linear/HDR pipeline is a
    // later phase). Small float32-vs-float64 differences from pow/GGX are
    // expected; the fantasy path below stays byte-identical.
    var N = normalize(in.normal);
    if (dot(N, u.view.xyz) < 0.0) { N = -N; } // two-sided: flip toward the viewer
    var metallic = u.pbr.x;
    var rough = u.pbr.y;
    var reflectK = u.surface0.z;
    if (u.texflags.y > 0.5) {
      let mr = textureSample(mrTex, samp, uv);
      rough = rough * mr.g;   // glTF packs roughness in G,
      metallic = metallic * mr.b; // metallic in B
      if (u.surface0.w > 0.5) { reflectK = reflectK * mr.a; } // the reflection mask
    }
    // The blend surface's roughness, by the vertex weight (surface3.w < 0 keeps).
    if (u.surface1.z > 0.5 && u.surface3.w >= 0.0) { rough = mix(rough, u.surface3.w, in.bw); }
${g.pbr}
    rough = clamp(rough, 0.045, 1.0); // a perfectly-smooth NDF blows up
    var ao = 1.0;
    if (u.texflags.z > 0.5) { ao = textureSample(occTex, samp, uv).r; }
    var albedo = colour.rgb;
    // A second surface blended in by the vertex weight (snow drifting over rock).
    let blendTexel = textureSample(blendTex, samp, uv).rgb;
    if (u.surface1.z > 0.5) {
      var bc = u.surface3.rgb;
      if (u.surface1.w > 0.5) { bc = bc * blendTexel; }
      albedo = mix(albedo, bc, in.bw);
    }
    // A detail map, tiled finely and blended in up close (mid-grey neutral),
    // fading with eye depth \u2014 mirrors the software path.
    let dk = u.surface0.y * clamp((${DETAIL_FAR2.toFixed(4)} - in.eyeDepth) / ${(DETAIL_FAR2 - DETAIL_NEAR2).toFixed(4)}, 0.0, 1.0);
    let detail = textureSample(detailTex, samp, vec2<f32>(in.uv.x * u.surface0.x, 1.0 - in.uv.y * u.surface0.x)).rgb;
    if (dk > 0.0) { albedo = albedo * (vec3<f32>(1.0) + dk * (2.0 * detail - vec3<f32>(1.0))); }
    let L = u.light.xyz;
    let V = u.view.xyz;
    let H = normalize(L + V);
    let ndl = max(0.0, dot(N, L));
    let ndv = max(1e-4, dot(N, V));
    let ndh = max(0.0, dot(N, H));
    let vdh = max(0.0, dot(V, H));
    let a2 = rough * rough * rough * rough;   // (rough^2)^2 for the GGX NDF
    let dd = ndh * ndh * (a2 - 1.0) + 1.0;
    let D = a2 / (3.14159265 * dd * dd + 1e-7);
    let k = ((rough + 1.0) * (rough + 1.0)) / 8.0; // Schlick-GGX (direct)
    let G = (ndv / (ndv * (1.0 - k) + k)) * (ndl / (ndl * (1.0 - k) + k));
    let fp = pow(1.0 - vdh, 5.0);              // Fresnel-Schlick
    let specD = (D * G) / (4.0 * ndl * ndv + 1e-4);
    let f0 = vec3<f32>(0.04) + (albedo - vec3<f32>(0.04)) * metallic;
    let F = f0 + (vec3<f32>(1.0) - f0) * fp;
    let kdm = 1.0 - metallic;                  // metals have no diffuse
    var emis = vec3<f32>(0.0);
    let ef = u.emissive.xyz;
    if (ef.r > 0.0 || ef.g > 0.0 || ef.b > 0.0) {
      var es = vec3<f32>(1.0);
      if (u.texflags.w > 0.5) { es = textureSample(emisTex, samp, vec2<f32>(in.uv.x + u.surface1.x, 1.0 - (in.uv.y + u.surface1.y))).rgb; }
      emis = ef * es;
    }
${g.emis}
    // Ambient / image-based lighting, mirroring the software rasteriser: with an
    // environment, a diffuse irradiance along N + a specular reflection along R
    // blurred toward the average by roughness; without one, the flat ambient.
    var amb: vec3<f32>;
    if (u.envSky.w > 0.5) {
      let irr = envColorDir(N);
      let R = 2.0 * ndv * N - V;
      var spec = envColorDir(R);
      var specAvg = envAverage();
      // Inside a reflection probe's box (the smallest first), reflect the room
      // around it, box-projected from this point, fading to the sky at the box's
      // faces \u2014 mirroring pickProbe/boxProject in probeSampling.ts.
      let pc = i32(u.ssaoMeta.w + 0.5);
      let P = in.worldPos;
      for (var i = 0; i < pc; i = i + 1) {
        let pr = probes[i];
        let inside = min(min(min(P.x - pr.mn.x, pr.mx.x - P.x), min(P.y - pr.mn.y, pr.mx.y - P.y)), min(P.z - pr.mn.z, pr.mx.z - P.z));
        let wgt = clamp(inside / ${PROBE_FADE2.toFixed(4)}, 0.0, 1.0);
        if (wgt > 0.0) {
          let Rs = select(R, vec3<f32>(1e-6), abs(R) < vec3<f32>(1e-6));
          let tf = max((pr.mx.xyz - P) / Rs, (pr.mn.xyz - P) / Rs);
          let t = max(0.0, min(min(tf.x, tf.y), tf.z));
          spec = mix(spec, probeSample(i, P + R * t - pr.pos.xyz), wgt);
          specAvg = mix(specAvg, pr.avg.xyz, wgt);
          break;
        }
      }
      let pref = mix(spec, specAvg, rough);
      amb = (irr * albedo * kdm + pref * f0 * reflectK) * ao;
    } else {
      amb = vec3<f32>(u.light.w) * albedo * ao;
    }
    // A baked light map (the second UV set) scales the sky/ambient fill by how
    // much of it reaches this point, bounce included \u2014 mirroring the CPU path.
    // Sampled unconditionally (uniform control flow), applied when bound.
    let lmUv = vec2<f32>(in.uv2.x, 1.0 - in.uv2.y);
    let lm = textureSample(lmTex, samp, lmUv).rgb * ${LIGHTMAP_RANGE2};
    if (u.ssaoMeta.z > 0.5) { amb = amb * lm; }
    else if (frame.probeMin.w > 0.5) { amb = amb * probeLight(in.worldPos, N); } // EP9: no light map, the probes light it
    // Screen-space AO darkens only the ambient fill, sampled at this fragment's
    // framebuffer pixel (matching the software path's ssao[di]).
    if (u.ssaoMeta.x > 0.5) {
      amb = amb * textureLoad(ssaoMap, vec2<i32>(in.pos.xy), 0).r;
    }
    // The direct light is what a shadow occludes; ambient/IBL still fills it.
    let sf = shadowFactor(in.lightClip, in.worldPos, abs(dot(normalize(in.normal), u.light.xyz)));
    let lc = i32(u.ssaoMeta.y + 0.5);
    var lit: vec3<f32>;
    if (lc > 0) {
      // --- Multi-light forward accumulation (Modern tier) ---
      // Mirrors meshRasterizer.ts: each light re-evaluates the direct term with
      // shared N/ndv/f0/kdm/a2/k; point lights fall off to nothing at their range.
      var direct = vec3<f32>(0.0);
      // The global lights (the sun, unranged lights) reach every fragment\u2026
      let ng = i32(frame.clusterInfo.x + 0.5);
      for (var i = 0; i < ng; i = i + 1) {
        direct = direct + lightTerm(lights[i], in.worldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
      }
      // \u2026the rest only the cells they touch (EP8): this fragment's cell, by pixel and depth.
      if (frame.clusterInfo.y > 0.5 && in.eyeDepth >= frame.clusterParams.z) {
        let tile = min(vec2<u32>(in.pos.xy / frame.clusterParams.xy), vec2<u32>(${CLUSTER_X2 - 1}u, ${CLUSTER_Y2 - 1}u));
        let slice = min(u32(log(in.eyeDepth / frame.clusterParams.z) * frame.clusterParams.w), ${CLUSTER_Z2 - 1}u);
        let cell = clusterTable[(slice * ${CLUSTER_Y2}u + tile.y) * ${CLUSTER_X2}u + tile.x];
        for (var j = 0u; j < cell.y; j = j + 1u) {
          direct = direct + lightTerm(lights[clusterIndex[cell.x + j]], in.worldPos, N, V, ndv, a2, k, f0, kdm, albedo, sf);
        }
      }
      lit = direct + amb + emis;
    } else {
      lit = (kdm * (vec3<f32>(1.0) - F) * albedo + F * specD) * ndl * sf + amb + emis;
    }
    // A fresnel rim, light at grazing angles (zero when the material has none).
    lit = lit + u.surface2.rgb * pow(1.0 - ndv, u.surface2.w);
    // A surface effect's glow, and its bands climbing the body (zero without one).
    let band = pow(0.5 + 0.5 * sin(in.worldPos.y * ${EFFECT_BAND_FREQUENCY2.toFixed(1)} - u.effect1.w * ${EFFECT_BAND_SPEED2.toFixed(1)}), ${EFFECT_BAND_POWER2.toFixed(1)});
    lit = lit + u.effect0.rgb + u.effect1.rgb * band;
    // HDR: expose + ACES roll-off, or write the linear colour straight through.
    var shaded = lit;
    if (u.tonemap.x > 0.5) {
      let e = u.tonemap.y;
      shaded = vec3<f32>(aces(lit.r * e), aces(lit.g * e), aces(lit.b * e));
    }
    // Fog in display space, mirroring applyFog in skyDome.ts: distance fog by
    // eye depth, then height and volume fog along the ray from the eye, toward
    // the fog colour brightened by the sun glow.
    if (u.fogParams.x > 0.5) {
      let d = max(0.0, in.eyeDepth - u.fogParams.y);
      var f = min(u.fogParams.z, 1.0 - exp(-d * u.fog.w));
      var fc = u.fog.rgb;
      if (u.fogParams.w > 0.5) {
        let c = u.fogCam.xyz;
        let ray = in.worldPos - c;
        let len = length(ray);
        var tau = fogLayer(u.fogHeight.x, u.fogHeight.z, u.fogHeight.y, c.y, ray.y, len, 0.0, 1.0);
        let vc = i32(u.fogCam.w + 0.5);
        for (var i = 0; i < vc; i = i + 1) {
          let a = u.fogVol[i * 2];
          let b = u.fogVol[i * 2 + 1];
          let span = fogBox(a.xyz, b.xyz, c, ray);
          if (span.y > span.x) { tau = tau + fogLayer(a.w, b.w, a.y, c.y, ray.y, len, span.x, span.y); }
        }
        f = 1.0 - (1.0 - f) * exp(-tau);
        if (u.fogHeight.w > 0.0) {
          let cosv = max(0.0, dot(ray, u.light.xyz) / (max(len, 1e-6) * max(length(u.light.xyz), 1e-6)));
          fc = min(vec3<f32>(1.0), fc + u.fogGlow.rgb * (u.fogHeight.w * pow(cosv, ${FOG_GLOW_POWER2.toFixed(1)})));
        }
      }
      shaded = mix(clamp(shaded, vec3<f32>(0.0), vec3<f32>(1.0)), fc, f);
    }
    return finishAlpha(shaded, colour.a);
  }

  // --- Fantasy path (byte-identical when no shadow; shadow scales the direct term) ---
  // Two-sided Lambert: abs(N\xB7L) so inconsistent winding still lights. The normal
  // is deliberately NOT renormalised \u2014 the software rasteriser interpolates and
  // dots without normalising, and parity with it is the contract here. Both
  // therefore skew identically under non-uniform scale.
  let nl = abs(dot(in.normal, u.light.xyz));
  let shade = u.light.w + (1.0 - u.light.w) * nl * shadowFactor(in.lightClip, in.worldPos, abs(dot(normalize(in.normal), u.light.xyz)));
  return finishAlpha(colour.rgb * shade, colour.a);
}
`
  );
}
var WebgpuSceneRenderer = class _WebgpuSceneRenderer {
  constructor(device, width, height, pipeline, pipelinesFor, bindGroupLayout, colourTexture, depthTexture, depthGroups, sampler, blankTexture, blankShadow, readback, bytesPerRow, style) {
    this.device = device;
    this.width = width;
    this.height = height;
    this.pipeline = pipeline;
    this.pipelinesFor = pipelinesFor;
    this.bindGroupLayout = bindGroupLayout;
    this.colourTexture = colourTexture;
    this.depthTexture = depthTexture;
    this.depthGroups = depthGroups;
    this.sampler = sampler;
    this.blankTexture = blankTexture;
    this.blankShadow = blankShadow;
    this.readback = readback;
    this.bytesPerRow = bytesPerRow;
    this.backend = "webgpu";
    this.meshes = /* @__PURE__ */ new WeakMap();
    this.textures = /* @__PURE__ */ new WeakMap();
    // Not readonly: a resized uniform buffer invalidates every cached group at
    // once, and WeakMap has no clear(), so the map itself is replaced.
    this.bindGroups = /* @__PURE__ */ new WeakMap();
    /** Most recent completed readback, or null before the first one lands. */
    this.latest = null;
    /** Frames submitted, the one `latest` holds, and the newest that got a readback (see settle). */
    this.submitted = 0;
    this.latestSeq = 0;
    this.readSeq = 0;
    /** The shadow depth array last uploaded in full, so a frame that changed only
     *  a region of it (its `dirty` rect) uploads just that region. */
    this.shadowUploaded = null;
    this.uniformCapacity = 0;
    this.uniformBuffer = null;
    this.uniformData = new Float32Array(0);
    this.destroyed = false;
    this.shadowMapSize = 0;
    /** Maps side by side in the shadow texture: 1, or 2 with a near cascade (EP8b). */
    this.shadowCascades = 1;
    /** The near cascade's depth array last uploaded in full (as shadowUploaded is the main map's). */
    this.nearUploaded = null;
    this.envMapSource = null;
    /** The SSAO buffer: a lazily-created width×height r32float upload target, and
     *  what binding 8 currently references (that upload, or the 1x1 blank). */
    this.ssaoTexture = null;
    /** The Modern-tier light storage buffer, grown as needed; always ≥ 1 light. */
    this.lightBuffer = null;
    this.lightBufferFloats = 0;
    this.probeSource = null;
    /** The probe boxes (binding 13): room for every probe a scene may carry. */
    this.probeBuffer = null;
    /** Per-instance transforms (binding 10), grown as needed. */
    this.instanceBuffer = null;
    this.instanceCapacity = 0;
    this.instanceData = new Float32Array(0);
    /** What the last submitted frame drew (for the profiler and tests); GPU time when the device can time it. */
    this.lastFrameStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };
    /** Shader variants by material graph (EP7), built on first use. */
    this.graphPipelines = /* @__PURE__ */ new Map();
    this.software = new SoftwareSceneRenderer(style);
    this.shadowTexture = blankShadow;
    this.envTexture = blankTexture;
    this.probeTexture = blankTexture;
    this.ssaoBound = blankShadow;
    this.timer = WebgpuPassTimer.create(device);
  }
  /**
   * Point the SSAO slot at a width×height r32float upload of `ao` (created once,
   * lazily), or the 1x1 blank when there is none; a change invalidates cached
   * bind groups (binding 8 moved).
   */
  bindSsao(ao) {
    if (ao) {
      if (!this.ssaoTexture) {
        this.ssaoTexture = this.device.createTexture({
          size: { width: this.width, height: this.height },
          format: "r32float",
          usage: 4 | 2
          // TEXTURE_BINDING | COPY_DST
        });
      }
      this.device.queue.writeTexture(
        { texture: this.ssaoTexture },
        ao,
        { bytesPerRow: this.width * 4, rowsPerImage: this.height },
        { width: this.width, height: this.height }
      );
      if (this.ssaoBound !== this.ssaoTexture) {
        this.ssaoBound = this.ssaoTexture;
        this.bindGroups = /* @__PURE__ */ new WeakMap();
      }
    } else if (this.ssaoBound !== this.blankShadow) {
      this.ssaoBound = this.blankShadow;
      this.bindGroups = /* @__PURE__ */ new WeakMap();
    }
  }
  /**
   * Upload the packed light list, growing the storage buffer when it needs more
   * room (a grow changes identity, so invalidate cached bind groups). The buffer
   * always holds at least one light so binding 9 is never empty.
   */
  uploadLights(packed) {
    if (!this.lightBuffer || packed.length > this.lightBufferFloats) {
      destroySafely(this.lightBuffer);
      this.lightBufferFloats = Math.max(packed.length, this.lightBufferFloats * 2, 12);
      this.lightBuffer = this.device.createBuffer({
        size: this.lightBufferFloats * 4,
        usage: 128 | 8
        // STORAGE | COPY_DST
      });
      this.bindGroups = /* @__PURE__ */ new WeakMap();
    }
    this.device.queue.writeBuffer(this.lightBuffer, 0, packed, 0, packed.length);
  }
  /**
   * Build the renderer for one framebuffer size. Returns null on any failure, so
   * the factory falls back to software rather than the caller seeing an
   * exception mid-frame.
   */
  static async create(device, width, height, style = DEFAULT_RASTER_STYLE3) {
    if (!webgpuCanHonour(style)) return null;
    try {
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT,
            buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_BYTES_USED }
          },
          { binding: 1, visibility: SHADER_STAGE_FRAGMENT, sampler: { type: "filtering" } },
          { binding: 2, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // Modern-tier metallic-roughness maps. A non-PBR draw binds the 1x1
          // blank for all three and the shader ignores them (pbr.z = 0), so the
          // layout is one shape for every draw.
          { binding: 3, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 4, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 5, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // The shadow map is r32float — not filterable — and read via textureLoad,
          // so it declares unfilterable-float and needs no sampler.
          { binding: 6, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } },
          // The equirectangular environment map (rgba8unorm), read via textureLoad.
          { binding: 7, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // The SSAO buffer (r32float), read per fragment via textureLoad.
          { binding: 8, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } },
          // The Modern-tier light list, read-only storage.
          { binding: 9, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          // Per-instance transforms, read by the vertex stage.
          { binding: 10, visibility: SHADER_STAGE_VERTEX, buffer: { type: "read-only-storage" } },
          { binding: 11, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          // Reflection probes: the panorama atlas (read via textureLoad) and their boxes.
          { binding: 12, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 13, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          // The detail map, and the blend surface's map.
          { binding: 14, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } },
          { binding: 15, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "float" } }
        ]
      });
      const depthLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "depth" } },
          { binding: 1, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          { binding: 3, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "uniform" } },
          { binding: 4, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float" } },
          { binding: 5, visibility: SHADER_STAGE_FRAGMENT, buffer: { type: "read-only-storage" } },
          { binding: 6, visibility: SHADER_STAGE_FRAGMENT, texture: { sampleType: "unfilterable-float", viewDimension: "3d" } }
        ]
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout, depthLayout] });
      const pipelinesFor = (code) => {
        const module = device.createShaderModule({ code });
        const pipelineFor = (blend, depthWrite) => device.createRenderPipeline({
          layout,
          vertex: {
            module,
            entryPoint: "vs",
            buffers: [
              {
                // Interleaved position(3) + normal(3) + uv(2) + light-map uv(2).
                arrayStride: 44,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: "float32x3" },
                  { shaderLocation: 1, offset: 12, format: "float32x3" },
                  { shaderLocation: 2, offset: 24, format: "float32x2" },
                  { shaderLocation: 3, offset: 32, format: "float32x2" },
                  { shaderLocation: 4, offset: 40, format: "float32" }
                ]
              }
            ]
          },
          fragment: {
            module,
            entryPoint: "fs",
            // rgba8unorm, never rgba8unorm-srgb: the framebuffer these bytes land
            // in is the same 8-bit buffer the CPU path writes, so any gamma
            // conversion here would show up as the GPU path looking washed out.
            targets: [blend ? { format: "rgba8unorm", blend } : { format: "rgba8unorm" }]
          },
          // cullMode "none" matches the software rasteriser, which draws both
          // faces (its Lambert is two-sided for exactly this reason).
          primitive: { topology: "triangle-list", cullMode: "none" },
          depthStencil: { format: "depth24plus", depthWriteEnabled: depthWrite, depthCompare: "less" }
        });
        return {
          opaque: pipelineFor(null, true),
          blend: pipelineFor({ color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } }, false),
          add: pipelineFor({ color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }, false)
        };
      };
      const pipeline = pipelinesFor(sceneShader());
      const colourTexture = device.createTexture({
        size: { width, height },
        format: "rgba8unorm",
        usage: 16 | 1
        // RENDER_ATTACHMENT | COPY_SRC
      });
      const depthTexture = device.createTexture({
        size: { width, height },
        format: "depth24plus",
        usage: 16 | 4
        // RENDER_ATTACHMENT | TEXTURE_BINDING (soft edges read it)
      });
      const blankDepth = device.createTexture({
        size: { width: 1, height: 1 },
        format: "depth24plus",
        usage: 16 | 4
        // RENDER_ATTACHMENT | TEXTURE_BINDING
      });
      const clusterBuffers = {
        table: device.createBuffer({ size: CLUSTER_CELLS * 8, usage: 128 | 8 }),
        // STORAGE | COPY_DST
        index: device.createBuffer({ size: CLUSTER_INDEX_CAP2 * 4, usage: 128 | 8 }),
        params: device.createBuffer({ size: FRAME_BYTES, usage: 64 | 8 })
        // UNIFORM | COPY_DST
      };
      const shadowTiles = device.createBuffer({ size: MAX_LOCAL_SHADOW_TILES2 * 80, usage: 128 | 8 });
      const atlasBlank = device.createTexture({ size: { width: 1, height: 1 }, format: "r32float", usage: 4 | 2 });
      const probesBlank = device.createTexture({ size: { width: 1, height: 1, depthOrArrayLayers: 1 }, dimension: "3d", format: "rgba32float", usage: 4 | 2 });
      const makeGroups = (atlas, probes) => {
        const shared = [
          { binding: 1, resource: { buffer: clusterBuffers.table } },
          { binding: 2, resource: { buffer: clusterBuffers.index } },
          { binding: 3, resource: { buffer: clusterBuffers.params } },
          { binding: 4, resource: atlas.createView() },
          { binding: 5, resource: { buffer: shadowTiles } },
          { binding: 6, resource: probes.createView({ dimension: "3d" }) }
        ];
        return {
          blank: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: blankDepth.createView() }, ...shared] }),
          scene: device.createBindGroup({ layout: depthLayout, entries: [{ binding: 0, resource: depthTexture.createView() }, ...shared] })
        };
      };
      const depthGroups = {
        ...makeGroups(atlasBlank, probesBlank),
        blankTexture: blankDepth,
        clusters: clusterBuffers,
        shadowTiles,
        atlas: atlasBlank,
        atlasBlank: true,
        probes: probesBlank,
        probesBlank: true,
        probeSource: null,
        makeGroups
      };
      const filter = style.textureFiltering === "none" ? "nearest" : "linear";
      const sampler = device.createSampler({
        magFilter: filter,
        minFilter: filter,
        addressModeU: "repeat",
        addressModeV: "repeat"
      });
      const blankTexture = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba8unorm",
        usage: 4 | 2
        // TEXTURE_BINDING | COPY_DST
      });
      device.queue.writeTexture(
        { texture: blankTexture },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
      );
      const blankShadow = device.createTexture({
        size: { width: 1, height: 1 },
        format: "r32float",
        usage: 4 | 2
        // TEXTURE_BINDING | COPY_DST
      });
      device.queue.writeTexture(
        { texture: blankShadow },
        new Float32Array([0]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 }
      );
      const bytesPerRow = alignBytesPerRow(width);
      const readback = Array.from({ length: READBACK_BUFFERS2 }, () => ({
        buffer: device.createBuffer({
          size: bytesPerRow * height,
          usage: 8 | 1
          // MAP_READ | COPY_DST
        }),
        busy: false
      }));
      return new _WebgpuSceneRenderer(
        device,
        width,
        height,
        pipeline,
        pipelinesFor,
        bindGroupLayout,
        colourTexture,
        depthTexture,
        depthGroups,
        sampler,
        blankTexture,
        blankShadow,
        readback,
        bytesPerRow,
        style
      );
    } catch {
      return null;
    }
  }
  /**
   * Point the shadow slot at an r32float sized to `size`, (re)creating it on a
   * size change and invalidating cached bind groups (binding 6 identity moved).
   * `size` 0 restores the 1x1 blank for a frame with no shadow.
   */
  ensureShadowTexture(size, cascades = 1) {
    if (size === this.shadowMapSize && cascades === this.shadowCascades) return;
    this.shadowCascades = cascades;
    this.shadowUploaded = null;
    this.nearUploaded = null;
    if (size === 0) {
      if (this.shadowTexture !== this.blankShadow) this.shadowTexture = this.blankShadow;
    } else {
      destroySafely(this.shadowMapSize > 0 ? this.shadowTexture : null);
      this.shadowTexture = this.device.createTexture({
        size: { width: size * cascades, height: size },
        format: "r32float",
        usage: 4 | 2
        // TEXTURE_BINDING | COPY_DST
      });
    }
    this.shadowMapSize = size;
    this.bindGroups = /* @__PURE__ */ new WeakMap();
  }
  /**
   * Point the env-map slot at an rgba8unorm upload of `map`, once per distinct
   * source object; null restores the 1x1 blank. A change invalidates cached bind
   * groups (binding 7 moved).
   */
  ensureEnvTexture(map) {
    if (map === this.envMapSource) return;
    if (this.envMapSource) destroySafely(this.envTexture);
    this.envTexture = map ? this.uploadRgba(map) : this.blankTexture;
    this.envMapSource = map;
    this.bindGroups = /* @__PURE__ */ new WeakMap();
  }
  /** The same for the reflection-probe atlas (binding 12), plus the boxes (binding 13). */
  ensureProbes(set) {
    const atlas = set?.atlas ?? null;
    if (!this.probeBuffer) {
      this.probeBuffer = this.device.createBuffer({ size: MAX_REFLECTION_PROBES3 * PROBE_FLOATS * 4, usage: 128 | 8 });
      this.bindGroups = /* @__PURE__ */ new WeakMap();
    }
    if (atlas === this.probeSource) return;
    if (this.probeSource) destroySafely(this.probeTexture);
    this.probeTexture = atlas ? this.uploadRgba(atlas) : this.blankTexture;
    this.probeSource = atlas;
    const packed = packProbes(set);
    this.device.queue.writeBuffer(this.probeBuffer, 0, packed, 0, packed.length);
    this.bindGroups = /* @__PURE__ */ new WeakMap();
  }
  /** A one-off rgba8unorm upload of a decoded image. */
  uploadRgba(map) {
    const texture = this.device.createTexture({
      size: { width: map.width, height: map.height },
      format: "rgba8unorm",
      usage: 4 | 2
      // TEXTURE_BINDING | COPY_DST
    });
    this.device.queue.writeTexture({ texture }, map.data, { bytesPerRow: map.width * 4, rowsPerImage: map.height }, { width: map.width, height: map.height });
    return texture;
  }
  render(instances, draw) {
    if (this.destroyed) return;
    const visible = applyScenePasses(instances, draw);
    presentFrame(this.latest, visible, draw, this.software);
    try {
      this.submit(visible, draw);
    } catch {
      this.latest = null;
    }
  }
  /** Whether a finished GPU frame exists to show (false until the first readback lands). */
  get ready() {
    return this.latest !== null;
  }
  settle(draw) {
    if (this.destroyed) return "current";
    if (this.latest) compositeFrame(this.latest, draw);
    if (this.latestSeq >= this.submitted) return "current";
    return this.readSeq >= this.submitted ? "pending" : "stale";
  }
  /** Encode and submit one frame, and start a readback if a buffer is free. */
  submit(instances, draw) {
    const viewProj = multiplyMat45(draw.projection, draw.view);
    const { batches: draws, instanceCount } = batchInstances(instances, (mesh) => this.uploadMesh(mesh), cameraPositionFromView3(draw.view));
    if (draws.length === 0) return;
    this.ensureUniformCapacity(draws.length);
    this.ensureInstanceCapacity(instanceCount);
    const light = resolveLight(draw.lightDirection, draw.ambient);
    const viewDir = viewDirection(draw.view);
    const eye = cameraPositionFromView3(draw.view);
    const shadow = draw.shadow ?? null;
    this.ensureShadowTexture(shadow ? shadow.size : 0, shadow?.near ? 2 : 1);
    if (shadow?.near) {
      const near = shadow.near;
      const dirty = near.dirty;
      if (dirty && this.nearUploaded === near.depth) {
        if (dirty.width > 0 && dirty.height > 0) {
          this.device.queue.writeTexture(
            { texture: this.shadowTexture, origin: { x: shadow.size + dirty.x, y: dirty.y } },
            near.depth,
            { offset: (dirty.y * shadow.size + dirty.x) * 4, bytesPerRow: shadow.size * 4, rowsPerImage: dirty.height },
            { width: dirty.width, height: dirty.height }
          );
        }
      } else {
        this.device.queue.writeTexture({ texture: this.shadowTexture, origin: { x: shadow.size, y: 0 } }, near.depth, { bytesPerRow: shadow.size * 4, rowsPerImage: shadow.size }, { width: shadow.size, height: shadow.size });
        this.nearUploaded = near.depth;
      }
    } else {
      this.nearUploaded = null;
    }
    if (shadow) {
      const dirty = shadow.dirty;
      if (dirty && this.shadowUploaded === shadow.depth) {
        if (dirty.width > 0 && dirty.height > 0) {
          this.device.queue.writeTexture(
            { texture: this.shadowTexture, origin: { x: dirty.x, y: dirty.y } },
            shadow.depth,
            { offset: (dirty.y * shadow.size + dirty.x) * 4, bytesPerRow: shadow.size * 4, rowsPerImage: dirty.height },
            { width: dirty.width, height: dirty.height }
          );
        }
      } else {
        this.device.queue.writeTexture(
          { texture: this.shadowTexture },
          shadow.depth,
          { bytesPerRow: shadow.size * 4, rowsPerImage: shadow.size },
          { width: shadow.size, height: shadow.size }
        );
        this.shadowUploaded = shadow.depth;
      }
    }
    const shadowParams = shadow ? { size: shadow.size, bias: shadow.bias ?? 3e-3, strength: shadow.strength ?? 1, slopeBias: shadow.slopeBias ?? 0, pcf: shadow.pcf ?? false } : null;
    this.ensureEnvTexture(draw.environment?.map ?? null);
    this.ensureProbes(draw.environment?.probes ?? null);
    const ssao = draw.ssao ?? null;
    this.bindSsao(ssao);
    const { ordered } = this.clusterLights(draw);
    this.uploadLights(packLights(ordered));
    const lightCount = ordered.length;
    let next = 0;
    draws.forEach((entry, index) => {
      entry.first = next;
      for (const model2 of entry.models) {
        writeInstanceTransform(this.instanceData, next, {
          mvp: multiplyMat45(viewProj, model2),
          lightMvp: shadow ? multiplyMat45(shadow.lightViewProj, model2) : null,
          model: model2,
          normalBasis: normalBasis3x3(model2)
        });
        next += 1;
      }
      const model = entry.models[0];
      const pbr = resolvePbr(
        entry.primitive.material,
        entry.textures.mr !== null,
        entry.textures.occ !== null,
        entry.textures.emis !== null
      );
      writeInstanceUniform(this.uniformData, index, {
        mvp: multiplyMat45(viewProj, model),
        normalBasis: normalBasis3x3(model),
        baseColor: entry.primitive.material.baseColorFactor,
        hasTexture: entry.textures.base !== null,
        light,
        viewDir,
        pbr,
        hasMrMap: entry.textures.mr !== null,
        hasOcclusionMap: entry.textures.occ !== null,
        hasEmissiveMap: entry.textures.emis !== null,
        environment: draw.environment ?? null,
        lightMvp: shadow ? multiplyMat45(shadow.lightViewProj, model) : null,
        shadow: shadowParams,
        tonemap: draw.tonemap ?? null,
        hasSsao: ssao !== null,
        hasLightmap: entry.textures.lm !== null,
        model,
        lightCount,
        fog: draw.fog ?? null,
        eye,
        effect: entry.effect ?? null,
        time: draw.time ?? 0,
        alpha: { mode: entry.alpha, cutoff: entry.primitive.material.alphaCutoff ?? 0.5 },
        soft: softEdges(entry.primitive.material, entry.alpha, draw.projection),
        surface: resolveSurface(entry.primitive.material, draw.time ?? 0, entry.textures.detail !== null, entry.textures.mr !== null, {
          weights: entry.primitive.blend !== void 0,
          textured: entry.textures.blend !== null
        })
      });
    });
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData, 0, draws.length * UNIFORM_FLOATS);
    this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData, 0, instanceCount * INSTANCE_FLOATS);
    let triangles = 0;
    for (const entry of draws) triangles += entry.geometry.indexCount / 3 * entry.models.length;
    this.lastFrameStats = { drawCalls: draws.length, instances: instanceCount, triangles, gpuMs: this.timer?.lastMs ?? null };
    const split = draws.some((entry) => softEdges(entry.primitive.material, entry.alpha, draw.projection) !== void 0);
    const firstSeeThrough = split ? draws.findIndex((entry) => entry.alpha >= 2) : -1;
    const encoder = this.device.createCommandEncoder();
    const drawRange = (pass2, from, to, depthGroup) => {
      pass2.setBindGroup(1, depthGroup);
      let bound = null;
      for (let index = from; index < to; index += 1) {
        const entry = draws[index];
        const set = this.pipelinesOf(entry.primitive.material);
        const wanted = entry.alpha === 3 ? set.add : entry.alpha === 2 ? set.blend : set.opaque;
        if (wanted !== bound) {
          pass2.setPipeline(wanted);
          bound = wanted;
        }
        pass2.setBindGroup(0, this.bindGroupFor(entry.primitive, entry.textures), [index * UNIFORM_STRIDE]);
        pass2.setVertexBuffer(0, entry.geometry.vertexBuffer);
        pass2.setIndexBuffer(entry.geometry.indexBuffer, "uint32");
        pass2.drawIndexed(entry.geometry.indexCount, entry.models.length, 0, 0, entry.first);
      }
    };
    const opaqueEnd = firstSeeThrough >= 0 ? firstSeeThrough : draws.length;
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.colourTexture.createView(),
          // Transparent black: every untouched pixel reads as "nothing drawn",
          // which is what lets the composite leave the cart's frame showing.
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      },
      ...this.timer ? { timestampWrites: this.timer.writes(firstSeeThrough >= 0 ? "begin" : "both") } : {}
    });
    drawRange(pass, 0, opaqueEnd, this.depthGroups.blank);
    pass.end();
    if (firstSeeThrough >= 0) {
      const seeThrough = encoder.beginRenderPass({
        colorAttachments: [{ view: this.colourTexture.createView(), loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: this.depthTexture.createView(), depthReadOnly: true },
        ...this.timer ? { timestampWrites: this.timer.writes("end") } : {}
      });
      drawRange(seeThrough, firstSeeThrough, draws.length, this.depthGroups.scene);
      seeThrough.end();
    }
    this.timer?.resolve(encoder);
    this.submitted += 1;
    const slot = this.readback.find((entry) => !entry.busy);
    if (slot) {
      slot.busy = true;
      slot.seq = this.submitted;
      this.readSeq = this.submitted;
      encoder.copyTextureToBuffer(
        { texture: this.colourTexture },
        { buffer: slot.buffer, bytesPerRow: this.bytesPerRow, rowsPerImage: this.height },
        { width: this.width, height: this.height }
      );
      this.device.queue.submit([encoder.finish()]);
      this.timer?.read();
      void this.drain(slot);
    } else {
      this.device.queue.submit([encoder.finish()]);
      this.timer?.read();
    }
  }
  /** The pipelines a material draws with: the plain shader's, or its graph's variant. */
  pipelinesOf(material) {
    const graph = compiledGraphOf2(material);
    if (!graph) return this.pipeline;
    let set = this.graphPipelines.get(graph.key);
    if (!set) {
      set = this.pipelinesFor(sceneShader(graph));
      this.graphPipelines.set(graph.key, set);
    }
    return set;
  }
  /**
   * Order the frame's lights (global first), build the clustered cells, and
   * write both and their params. An orthographic view (no cells) loops every light.
   */
  clusterLights(draw) {
    const { ordered, globalCount } = orderLights2(draw.lights ?? []);
    const clusters = ordered.length > globalCount ? buildLightClusters2(ordered, globalCount, draw.view, draw.projection, this.width, this.height) : null;
    const buffers = this.depthGroups.clusters;
    if (clusters) {
      this.device.queue.writeBuffer(buffers.table, 0, clusters.table);
      this.device.queue.writeBuffer(buffers.index, 0, clusters.indices, 0, Math.max(4, Math.ceil(clusters.used / 4) * 4));
    }
    const near = draw.shadow?.near ?? null;
    const frame = new Float32Array(FRAME_BYTES / 4);
    frame.set(clusters?.params ?? [1, 1, 1, 1], 0);
    frame.set([clusters ? globalCount : ordered.length, clusters ? 1 : 0], 4);
    if (near) {
      frame.set(near.lightViewProj, 8);
      frame.set([1, near.bias, near.slopeBias], 24);
    }
    const local = draw.localShadows ?? null;
    if (local && local.tiles.length > 0) frame.set([1, local.bias, local.slopeBias], 28);
    const grid = draw.environment?.lightProbes ?? null;
    if (grid) {
      this.uploadProbeGrid(grid);
      frame.set([...grid.min, 1], 32);
      frame.set([0, 1, 2].map((a) => (grid.counts[a] - 1) / (grid.max[a] - grid.min[a] || 1)), 36);
      frame.set(grid.counts, 40);
    }
    this.device.queue.writeBuffer(buffers.params, 0, frame);
    this.uploadLocalShadows(local);
    return { ordered, globalCount, clusters };
  }
  /** Upload a probe grid (EP9) as a 3D texture, once per grid, rebuilding group 1 to point at it. */
  uploadProbeGrid(grid) {
    const groups = this.depthGroups;
    if (groups.probeSource === grid) return;
    const [nx, ny, nz] = grid.counts;
    if (!groups.probesBlank) destroySafely(groups.probes);
    groups.probes = this.device.createTexture({ size: { width: nx * 6, height: ny, depthOrArrayLayers: nz }, dimension: "3d", format: "rgba32float", usage: 4 | 2 });
    groups.probesBlank = false;
    groups.probeSource = grid;
    this.device.queue.writeTexture({ texture: groups.probes }, lightProbeTexels2(grid), { bytesPerRow: nx * 6 * 16, rowsPerImage: ny }, { width: nx * 6, height: ny, depthOrArrayLayers: nz });
    Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
  }
  /** Upload the spot/point shadow tiles (EP8c): each tile into its atlas cell, and every tile's view. */
  uploadLocalShadows(local) {
    if (!local || local.tiles.length === 0) return;
    const groups = this.depthGroups;
    if (groups.atlasBlank) {
      const side = LOCAL_SHADOW_TILE2 * LOCAL_SHADOW_GRID2;
      groups.atlas = this.device.createTexture({ size: { width: side, height: side }, format: "r32float", usage: 4 | 2 });
      groups.atlasBlank = false;
      Object.assign(groups, groups.makeGroups(groups.atlas, groups.probes));
    }
    const views = new Float32Array(MAX_LOCAL_SHADOW_TILES2 * 20);
    local.tiles.slice(0, MAX_LOCAL_SHADOW_TILES2).forEach((tile, i) => {
      this.device.queue.writeTexture(
        { texture: groups.atlas, origin: { x: i % LOCAL_SHADOW_GRID2 * LOCAL_SHADOW_TILE2, y: Math.floor(i / LOCAL_SHADOW_GRID2) * LOCAL_SHADOW_TILE2 } },
        tile.depth,
        { bytesPerRow: LOCAL_SHADOW_TILE2 * 4, rowsPerImage: LOCAL_SHADOW_TILE2 },
        { width: LOCAL_SHADOW_TILE2, height: LOCAL_SHADOW_TILE2 }
      );
      views.set(tile.lightViewProj, i * 20);
      views.set(tile.linear, i * 20 + 16);
    });
    this.device.queue.writeBuffer(groups.shadowTiles, 0, views);
  }
  /** Await one readback and publish it as the newest frame. */
  async drain(slot) {
    try {
      await slot.buffer.mapAsync(1);
      if (this.destroyed) return;
      if ((slot.seq ?? 0) >= this.latestSeq) {
        const padded = new Uint8Array(slot.buffer.getMappedRange());
        this.latest = unpadRows(padded, this.width, this.height, this.bytesPerRow, this.latest);
        this.latestSeq = slot.seq ?? 0;
      }
      slot.buffer.unmap();
    } catch {
    } finally {
      slot.busy = false;
    }
  }
  /** Grow the per-draw uniform buffer to hold at least `count` draws. */
  ensureUniformCapacity(count) {
    if (count <= this.uniformCapacity) return;
    this.uniformBuffer?.destroy?.();
    this.uniformCapacity = Math.max(count, this.uniformCapacity * 2, 8);
    this.uniformBuffer = this.device.createBuffer({
      size: this.uniformCapacity * UNIFORM_STRIDE,
      usage: 64 | 8
      // UNIFORM | COPY_DST
    });
    this.uniformData = new Float32Array(this.uniformCapacity * UNIFORM_FLOATS);
    this.bindGroups = /* @__PURE__ */ new WeakMap();
  }
  /** Grow the per-instance transform buffer to hold at least `count` instances. */
  ensureInstanceCapacity(count) {
    if (count <= this.instanceCapacity) return;
    destroySafely(this.instanceBuffer);
    this.instanceCapacity = Math.max(count, this.instanceCapacity * 2, 16);
    this.instanceBuffer = this.device.createBuffer({
      size: this.instanceCapacity * INSTANCE_FLOATS * 4,
      usage: 128 | 8
      // STORAGE | COPY_DST
    });
    this.instanceData = new Float32Array(this.instanceCapacity * INSTANCE_FLOATS);
    this.bindGroups = /* @__PURE__ */ new WeakMap();
  }
  /**
   * Upload (once) a mesh's primitives as interleaved vertex + index buffers. A
   * live skinned primitive (`dynamic`) re-uploads its vertices into the same
   * buffer whenever its revision moves on.
   */
  uploadMesh(mesh) {
    const cached = this.meshes.get(mesh);
    if (cached) {
      mesh.primitives.forEach((primitive, i) => {
        const gpu = cached[i];
        if (!primitive.dynamic || !gpu || gpu.revision === primitive.dynamic.revision) return;
        const normals = primitive.normals ?? computeSmoothNormals2(primitive.positions, primitive.indices);
        this.device.queue.writeBuffer(gpu.vertexBuffer, 0, interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null));
        gpu.revision = primitive.dynamic.revision;
      });
      return cached;
    }
    const uploaded = mesh.primitives.map((primitive) => {
      const normals = primitive.normals ?? computeSmoothNormals2(primitive.positions, primitive.indices);
      const vertices = interleaveVertices(primitive.positions, normals, primitive.uvs, primitive.uvs2 ?? null, primitive.blend ?? null);
      const vertexBuffer = this.device.createBuffer({
        size: Math.max(40, vertices.byteLength),
        usage: 32 | 8
        // VERTEX | COPY_DST
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, vertices);
      const indexBuffer = this.device.createBuffer({
        size: Math.max(4, primitive.indices.byteLength),
        usage: 16 | 8
        // INDEX | COPY_DST
      });
      this.device.queue.writeBuffer(indexBuffer, 0, primitive.indices);
      return {
        vertexBuffer,
        indexBuffer,
        indexCount: primitive.indices.length,
        ...primitive.dynamic ? { revision: primitive.dynamic.revision } : {}
      };
    });
    this.meshes.set(mesh, uploaded);
    return uploaded;
  }
  /** The bind group for one primitive, rebuilt if any of its textures changed. */
  bindGroupFor(primitive, textures) {
    const cached = this.bindGroups.get(primitive);
    if (cached && cached.source.base === textures.base && cached.source.mr === textures.mr && cached.source.occ === textures.occ && cached.source.emis === textures.emis && cached.source.lm === textures.lm && cached.source.detail === textures.detail && cached.source.blend === textures.blend) {
      return cached.group;
    }
    const view = (texture) => (texture ? this.uploadTexture(texture) : this.blankTexture).createView();
    const group = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: UNIFORM_STRIDE } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: view(textures.base) },
        { binding: 3, resource: view(textures.mr) },
        { binding: 4, resource: view(textures.occ) },
        { binding: 5, resource: view(textures.emis) },
        // The active shadow map (or the 1x1 blank). Its identity only moves on a
        // size change, which invalidates this whole cache, so a cached group
        // always references the current one.
        { binding: 6, resource: this.shadowTexture.createView() },
        // The active env map (or the 1x1 white blank); likewise cache-invalidated.
        { binding: 7, resource: this.envTexture.createView() },
        // The active SSAO buffer (or the 1x1 blank); likewise cache-invalidated.
        { binding: 8, resource: this.ssaoBound.createView() },
        // The light storage buffer; a grow changes identity and invalidates the cache.
        { binding: 9, resource: { buffer: this.lightBuffer } },
        // The instance transforms; a grow changes identity and invalidates the cache.
        { binding: 10, resource: { buffer: this.instanceBuffer } },
        // The baked light map (or the 1x1 white blank; the uniform flag gates it).
        { binding: 11, resource: view(textures.lm) },
        // The probe atlas (or the blank) and boxes; a change invalidates the cache.
        { binding: 12, resource: this.probeTexture.createView() },
        { binding: 13, resource: { buffer: this.probeBuffer } },
        // The detail map (or the 1x1 white blank; the uniform gates it).
        { binding: 14, resource: view(textures.detail) },
        { binding: 15, resource: view(textures.blend) }
      ]
    });
    this.bindGroups.set(primitive, { group, source: { ...textures } });
    return group;
  }
  /** Upload (once) a decoded texture. */
  uploadTexture(source) {
    const cached = this.textures.get(source);
    if (cached) return cached;
    const texture = this.device.createTexture({
      size: { width: source.width, height: source.height },
      format: "rgba8unorm",
      usage: 4 | 2
      // TEXTURE_BINDING | COPY_DST
    });
    this.device.queue.writeTexture(
      { texture },
      source.data,
      { bytesPerRow: source.width * 4, rowsPerImage: source.height },
      { width: source.width, height: source.height }
    );
    this.textures.set(source, texture);
    return texture;
  }
  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.latest = null;
    this.software.dispose();
    destroySafely(this.colourTexture);
    destroySafely(this.depthTexture);
    destroySafely(this.depthGroups.blankTexture);
    destroySafely(this.depthGroups.clusters.table);
    destroySafely(this.depthGroups.clusters.index);
    destroySafely(this.depthGroups.clusters.params);
    destroySafely(this.depthGroups.shadowTiles);
    destroySafely(this.depthGroups.atlas);
    destroySafely(this.depthGroups.probes);
    destroySafely(this.blankTexture);
    destroySafely(this.blankShadow);
    if (this.shadowTexture !== this.blankShadow) destroySafely(this.shadowTexture);
    if (this.envTexture !== this.blankTexture) destroySafely(this.envTexture);
    if (this.probeTexture !== this.blankTexture) destroySafely(this.probeTexture);
    destroySafely(this.probeBuffer);
    destroySafely(this.ssaoTexture);
    destroySafely(this.lightBuffer);
    destroySafely(this.instanceBuffer);
    destroySafely(this.uniformBuffer);
    for (const slot of this.readback) destroySafely(slot.buffer);
    this.timer?.destroy();
  }
};
function destroySafely(resource) {
  try {
    resource?.destroy?.();
  } catch {
  }
}

// src/render/createSceneRenderer.ts
async function createSceneRenderer(width, height, caps, deviceProvider = getWebgpuDevice, glProvider) {
  const style = rasterStyleFor(caps);
  const device = await deviceProvider();
  let renderer = null;
  if (device) renderer = await WebgpuSceneRenderer.create(device, width, height, style);
  renderer ?? (renderer = WebglSceneRenderer.create(width, height, style, glProvider));
  renderer ?? (renderer = new SoftwareSceneRenderer(style));
  return capsConstrainScene(caps) ? new CappedSceneRenderer(renderer, caps) : renderer;
}

// src/player.ts
import { SpatialLoader, actionMask, reboundActions, colorFilterSvg, DEFAULT_ACCESSIBILITY } from "@cartbox/editor";
function shouldUseTouch(scheme, view) {
  if (scheme === "touch") return true;
  if (scheme === "keyboard") return false;
  const coarse = view.matchMedia?.("(pointer: coarse)").matches ?? false;
  return hasTouchSupport(view.navigator?.maxTouchPoints ?? 0, coarse);
}
var NO_HELD = /* @__PURE__ */ new Set();
var nextColorFilterId = 0;
var NO_OVERRIDES = /* @__PURE__ */ new Map();
var Player = class {
  constructor(container, options) {
    this.container = container;
    this.options = options;
    this.gamepad = new GamepadState();
    /** The scene's sounds (EP12), once loaded. */
    this.sounds = null;
    /** The graphics preset in effect (resolved from the quality option once the renderer is known). */
    this.qualitySettings = QUALITY_PRESETS.high;
    /** Presented-frame clock for animation, kept in lockstep with the scene backdrop. */
    this.presentFrame = 0;
    /** The cart reads analog sticks (it opted in via cartbox.stick). */
    this.analogCart = false;
    /** Input actions (EP15): the cart's, with the player's rebinding, and the keys they claim. */
    this.actions = [];
    this.actionKeys = /* @__PURE__ */ new Set();
    this.actionPad = /* @__PURE__ */ new Set();
    /** Where the input block sits (bytes after pmem word 0), when the cart has actions; and last tick's mask. */
    this.inputOffset = null;
    this.lastActions = 0;
    /** Save data (EP15b): where the save block sits (bytes after pmem word 0), and its size. */
    this.saveBlock = null;
    this.controlSettings = DEFAULT_CONTROL_SETTINGS;
    this.volume = 1;
    /** False while a host menu is open: the game keeps running but sees no input. */
    this.inputEnabled = true;
    /**
     * The cart's runtime channel (physics bodies and/or spawnable prefabs), its
     * physics world if any, and where the shared block sits (bytes after pmem word 0).
     */
    this.runtime = null;
    this.tickFrame = 0;
    this.lastMailboxSeq = 0;
    /** Error-generation counter last seen from the engine; a rise means a new error. */
    this.lastErrorSeq = 0;
    /** Lines of injected code above the cart's own: error line N is cart line N − this. */
    this.lineOffset = 0;
    /** The debug block (bytes after pmem word 0), when the editor's console is on. */
    this.debugOffset = null;
    /** Lines in the cart's own code (for telling its lines from the injected code after it). */
    this.lineCount = 0;
    /** The debugger (options.debug): breakpoints and watches still to write, lines that can break, and where the cart is stopped. */
    this.debugState = null;
    this.speed = 1;
    /** The playtest profiler, while it's on (see setProfiling). */
    this.profiler = null;
    /** Recent netplay byte totals, for traffic per second. */
    this.netSamples = [];
    this.frameHandle = 0;
    this.lastFrameTime = 0;
    this.frameAccumulatorMs = 0;
    this.destroyed = false;
    this.abortController = new AbortController();
    this.running = false;
    /** The colour filter's SVG definition, while one is applied (EP19b). */
    this.colorFilterNode = null;
    this.colorFilterBefore = null;
    /**
     * Fixed-timestep loop: advance one console frame per 1/60s of elapsed time.
     * Decoupling console frames from the display refresh keeps game speed correct
     * on 120Hz+ screens and after the tab was backgrounded.
     */
    this.loop = (now) => {
      if (!this.running) return;
      this.frameAccumulatorMs += (now - this.lastFrameTime) * this.speed;
      this.lastFrameTime = now;
      this.controllerInput?.poll();
      const maxFramesPerRender = 4;
      const frameMs = frameDurationMs(this.model);
      let advanced = 0;
      while (this.frameAccumulatorMs >= frameMs && advanced < maxFramesPerRender && this.running) {
        this.tickOnce(this.speed === 1);
        this.frameAccumulatorMs -= frameMs;
        advanced++;
      }
      if (advanced > 0) {
        this.present();
      }
      this.frameHandle = this.view.requestAnimationFrame(this.loop);
    };
    /** Turn the profiler on (it starts empty) or off. */
    /** An editor's camera, looking at the 3D scene instead of the cart's (see PlayerHandle.setEditorCamera). */
    this.editorCamera = null;
    /** Counts level loads, so a load overtaken by a newer switch doesn't activate. */
    this.levelLoads = 0;
    /** Objects out of the current level. */
    this.levelInactive = /* @__PURE__ */ new Set();
    /** Spatial loading, when the scene streams by distance: the loader and what it has unloaded. */
    this.spatial = null;
    /** The player's settings now (EP19b): text size and colour filter, read by the cart each tick. */
    this.settings = DEFAULT_ACCESSIBILITY;
    /** The language to play in (1-based in the cart's table; 0 for none) and a revision bumped when it changes. */
    this.languageIndex = 0;
    this.settingsRevision = 1;
    const view = container.ownerDocument.defaultView;
    if (!view) {
      throw new Error("Container is not attached to a window");
    }
    this.view = view;
    this.model = getModel(options.modelId);
    if (options.controlSettings) this.controlSettings = options.controlSettings;
  }
  /** Filter the finished frame (see PlayerHandle.setColorFilter): an SVG colour matrix on the container. */
  setColorFilter(filter, kind = "correct") {
    const style = this.container.style;
    this.colorFilterNode?.remove();
    this.colorFilterNode = null;
    const id = `cbx-color-filter-${nextColorFilterId += 1}`;
    const svg = colorFilterSvg(filter, kind, id);
    if (!svg) {
      if (this.colorFilterBefore !== null) style.filter = this.colorFilterBefore;
      this.colorFilterBefore = null;
      return;
    }
    const holder = this.container.ownerDocument.createElement("div");
    holder.innerHTML = svg;
    this.colorFilterNode = holder.firstElementChild;
    if (this.colorFilterNode) this.container.appendChild(this.colorFilterNode);
    if (this.colorFilterBefore === null) this.colorFilterBefore = style.filter;
    style.filter = `url(#${id})`;
  }
  /** Apply new control settings at once (see PlayerHandle.setControlSettings). */
  setControlSettings(settings) {
    this.controlSettings = settings;
    this.touch?.applySettings(settings);
    this.rebindActions();
  }
  /** The cart's actions with the player's rebinding applied (EP15). */
  rebindActions() {
    this.actions = reboundActions(this.options.actions ?? [], this.controlSettings.actionBindings);
    this.actionKeys = new Set(this.actions.flatMap((a) => a.keys));
    this.actionPad = new Set(this.actions.flatMap((a) => a.pad));
  }
  /** The actions held now (bit i = action i), from every device. */
  heldActions() {
    if (this.actions.length === 0) return 0;
    return actionMask(this.actions, { keys: this.keyboard?.held ?? NO_HELD, pad: this.controllerInput?.pressed ?? NO_HELD, buttons: this.gamepad.value });
  }
  /** Let the game see input (true) or hold it neutral (false) — e.g. under a menu. */
  setInputEnabled(enabled) {
    this.inputEnabled = enabled;
  }
  /** Master volume, 0..1. */
  setVolume(volume) {
    this.volume = volume;
    this.audio?.setVolume(volume);
  }
  /** Loads the cartridge and engine, then starts (or arms) playback. */
  async start() {
    const filter = this.options.accessibility?.colorFilter;
    if (filter && filter !== "none") this.setColorFilter(filter);
    try {
      const engineUrl = this.options.engineUrl ?? this.model.engineUrl;
      const [bytes, module] = await Promise.all([
        fetchCartridge(this.options.cartUrl, this.abortController.signal),
        loadEngineModule(engineUrl, this.options.engineWasm)
      ]);
      if (this.destroyed) return;
      const sampleRate = this.options.sampleRate ?? this.model.sampleRate;
      const seed = this.options.replay ? this.options.replay.seed : randomSeed();
      const seeded = seedCartridge(bytes, seed);
      let prepared = seeded;
      const layout = RAM_LAYOUTS[this.model.id];
      const debug = this.options.debug;
      const cartCode = readCartCode(bytes);
      let ownCode = cartCode;
      if ((this.options.onTrace || debug) && layout) {
        if (debug && cartCode !== null) {
          const instrumented = instrumentLua(cartCode);
          if (instrumented.lines.length > 0) {
            prepared = appendLuaCode(rewriteLuaCode(prepared, (code) => code.slice(0, code.length - cartCode.length) + instrumented.code), debugPostlude());
            ownCode = instrumented.code;
            this.debugState = {
              breakpoints: effectiveBreakpoints(debug.breakpoints ?? [], instrumented.lines),
              watches: debug.watches ?? [],
              dirty: true,
              breakable: instrumented.lines,
              paused: null
            };
          }
        }
        prepared = prependLuaCode(prepared, debugSdkLua(debugBlockAddress(layout), { debugger: this.debugState !== null }));
        this.debugOffset = debugBlockAddress(layout) - layout.pmemAddress;
      }
      const components = componentsSdkLua(this.options.mesh);
      if (components) prepared = appendLuaCode(prependLuaCode(prepared, components.prelude), components.postlude);
      const collisionLua = collisionSdkLua(this.options.collision);
      if (collisionLua) prepared = prependLuaCode(prepared, collisionLua);
      const flagsLua = flagsSdkLua(this.options.flags);
      if (flagsLua) prepared = prependLuaCode(prepared, flagsLua);
      const animClipsLua = animClipsSdkLua(this.options.anim);
      if (animClipsLua) prepared = prependLuaCode(prepared, animClipsLua);
      if (layout && this.options.onSave) {
        prepared = prependLuaCode(prepared, saveSdkLua(layout, this.options.saveData ?? null));
        this.saveBlock = { offset: saveBlockAddress(layout) - layout.pmemAddress, bytes: saveBlockBytes(layout) };
      }
      this.rebindActions();
      const actionsLua = layout ? actionsSdkLua(this.actions, layout) : "";
      if (actionsLua && layout) {
        prepared = prependLuaCode(prepared, actionsLua);
        this.inputOffset = inputBlockAddress(layout) - layout.pmemAddress;
      }
      this.settings = this.options.accessibility ?? DEFAULT_ACCESSIBILITY;
      this.languageIndex = this.languageIndexFor(this.options.languages);
      const stringsLua = stringsSdkLua(
        this.options.strings,
        playLanguage(this.options.strings, this.options.languages),
        this.options.accessibility,
        layout ? inputBlockAddress(layout) : null
      );
      if (stringsLua && layout) {
        prepared = prependLuaCode(prepared, stringsLua);
        this.inputOffset = inputBlockAddress(layout) - layout.pmemAddress;
      }
      const uiLua = uiSdkLua(this.options.ui, this.model.width, this.model.height);
      if (uiLua) prepared = prependLuaCode(prepared, uiLua);
      const sceneLua = sceneObjectsSdkLua(this.options.mesh);
      if (sceneLua) prepared = prependLuaCode(prepared, sceneLua);
      const mesh = this.options.mesh;
      const runtimeLua = layout && mesh ? runtimeSdkLua(mesh, layout, { physics: Boolean(this.options.physics) }) : "";
      if (runtimeLua && mesh && layout) {
        prepared = prependLuaCode(prepared, runtimeLua);
        let physics = null;
        if (sceneHasPhysics(mesh) && this.options.physics) {
          const deterministic = mesh.physicsWorld?.deterministic === true;
          const backend = await this.options.physics({ deterministic });
          if (this.destroyed) {
            backend.destroy();
            return;
          }
          physics = new PhysicsSession(mesh, backend, { deterministic });
        }
        this.runtime = {
          channel: new RuntimeChannel(mesh, physics),
          physics,
          offset: physicsBlockAddress(layout) - layout.pmemAddress,
          // The overflow command ring (EP20), where the core's RAM affords one.
          ring: hasCommandRing(layout) ? commandRingAddress(layout) - layout.pmemAddress : null,
          ringBytes: commandRingBytes(layout)
        };
      }
      const preparedBytes = injectSdk(prepared);
      this.lineOffset = codeLineOffset(ownCode, readCartCode(preparedBytes));
      this.lineCount = cartCode === null ? 0 : cartCode.split("\n").length;
      this.console = createConsole(module, this.model, sampleRate);
      if (!this.console.loadCartridge(preparedBytes)) {
        throw new Error("Engine rejected the cartridge");
      }
      const ring = this.commandRing();
      if (ring) resetCommandRing(ring);
      this.console.setMaterialCapture(Boolean(this.options.lighting));
      this.lastMailboxSeq = this.console.readMailbox()[0] ?? 0;
      this.lastErrorSeq = this.console.readError()?.seq ?? 0;
      const scale = this.options.scale ?? "fit";
      const scene = this.options.scene;
      this.anim = this.options.anim;
      const wantsForeground = Boolean(this.anim && this.anim.placements.length > 0);
      const world = this.options.world;
      let backdrop = null;
      if (scene || wantsForeground || world) {
        this.cartSource = createCartSpriteSource(module, preparedBytes, this.model.paletteSize) ?? void 0;
      }
      if (scene && this.cartSource) {
        backdrop = {
          layers: resolveSceneLayers(scene, this.cartSource.source),
          keyRgb: this.cartSource.paletteRgb(scene.keyColor)
        };
      }
      const makeBaseSurface = async (target) => {
        let surface = this.options.lighting ? this.litSurface = await LitCanvasSurface.create(target, scale, this.model, this.options.lighting) : new CanvasSurface(target, scale, this.model);
        const particles = this.options.particles;
        if (particles && particles.emitters.length > 0) {
          surface = new ParticleOverlaySurface(surface, this.model.width, this.model.height, particles);
        }
        const mesh2 = this.options.mesh;
        if (mesh2 || world && this.cartSource) {
          this.sceneRenderer = await createSceneRenderer(
            this.model.width,
            this.model.height,
            this.model.renderCaps
          );
        }
        this.qualitySettings = resolveQuality(this.options.quality, browserDeviceHints(this.sceneRenderer ? this.sceneRenderer.backend !== "software" : void 0));
        if (mesh2) {
          surface = this.meshSurface = await MeshOverlaySurface.create(
            surface,
            this.model.width,
            this.model.height,
            mesh2,
            this.sceneRenderer,
            this.options.ktx2 ? { ktx2: this.options.ktx2 } : {}
          );
          this.meshSurface.setQuality(this.qualitySettings);
          this.meshSurface.setProfiler(this.profiler);
          if ((mesh2.levels?.length ?? 0) > 0) this.activateLevel(0);
          if (mesh2.streaming) {
            const groups = streamGroups(mesh2);
            if (groups.length > 0) this.spatial = { loader: new SpatialLoader(groups, mesh2.streaming), unloaded: /* @__PURE__ */ new Set() };
          }
        }
        if (world && this.cartSource) {
          surface = this.worldSurface = new WorldOverlaySurface(
            surface,
            this.model.width,
            this.model.height,
            world,
            makeWorldTextureLookup(this.cartSource, world.tilesPerSide),
            this.sceneRenderer
          );
        }
        if (wantsForeground && this.cartSource) {
          surface = this.foregroundSurface = new AnimatedForegroundSurface(
            surface,
            this.model.width,
            this.model.height,
            this.cartSource.source
          );
        }
        if (scene && backdrop) {
          surface = this.sceneSurface = new SceneBackdropSurface(
            surface,
            this.model.width,
            this.model.height,
            backdrop.layers,
            scene,
            backdrop.keyRgb
          );
        }
        return surface;
      };
      const postFx = this.options.postFx;
      this.basePostFx = postFx;
      const shownFx = postFx ? applyQualityToPostFx(postFx, this.qualitySettings) : void 0;
      if (shownFx && anyPostFxEnabled(shownFx)) {
        const fx = await PostFxSurface.create(this.container, scale, this.model, shownFx, makeBaseSurface);
        if (fx) this.postFxSurface = fx;
        if (fx && this.meshSurface) this.meshSurface.onSun = (sun) => fx.setSun(sun);
        this.surface = fx ?? await makeBaseSurface(this.container);
      } else {
        this.surface = await makeBaseSurface(this.container);
      }
      if (this.destroyed) {
        this.surface.destroy();
        return;
      }
      this.audio = new AudioController(sampleRate);
      this.audio.setVolume(this.options.volume ?? this.volume);
      const sceneAudio = this.options.mesh?.audio;
      if (sceneAudio) {
        const mesh2 = this.options.mesh;
        void SoundSystem.create(this.audio.audioContext, sceneAudio, this.audio.output, (id) => mesh2.instances.findIndex((i) => i.id === id)).then((system) => {
          if (this.destroyed) system.dispose();
          else this.sounds = system;
        }).catch(() => {
        });
      }
      if (this.options.volume !== void 0) this.volume = this.options.volume;
      this.setupReplay(bytes, seed);
      this.renderSingleFrame();
      this.options.onReady?.();
      if (this.options.autostart ?? false) {
        void this.resume();
      }
    } catch (error) {
      if (this.destroyed) return;
      this.fail(error);
    }
  }
  attachInput() {
    const scheme = this.options.controls ?? "auto";
    const onStart = this.options.onStart;
    if (scheme !== "touch") {
      this.keyboard = new KeyboardInput(this.view, this.gamepad, () => this.controlSettings.keyBindings, onStart, () => this.actionKeys);
      this.controllerInput = new GamepadInput(this.view.navigator, this.gamepad, () => this.controlSettings, onStart, () => this.actionPad);
    }
    if (shouldUseTouch(scheme, this.view)) {
      this.touch = new TouchInput(this.container, this.gamepad, onStart);
      this.touch.applySettings(this.controlSettings);
    }
  }
  /**
   * Chooses the input source. In playback mode the console is driven by the
   * replay and no user input is attached; otherwise live input is attached and
   * (unless disabled) the session is recorded.
   */
  setupReplay(cartBytes, seed) {
    if (this.options.replay) {
      this.replaySource = new ReplaySource(this.options.replay.inputs);
      return;
    }
    this.attachInput();
    if (this.options.record !== false) {
      this.recorder = new ReplayRecorder({
        modelId: this.model.id,
        cartHash: hashCart(cartBytes),
        seed
      });
    }
  }
  /** The replay captured so far, or null when not recording. */
  getReplay() {
    return this.recorder ? this.recorder.finish() : null;
  }
  async resume() {
    if (this.destroyed || !this.console) return;
    if (!this.running) {
      this.running = true;
      this.lastFrameTime = this.view.performance.now();
      this.frameAccumulatorMs = 0;
      this.frameHandle = this.view.requestAnimationFrame(this.loop);
    }
    try {
      await this.audio?.resume();
    } catch {
    }
  }
  /** Run at `scale` × normal speed (clamped to 0.25 … 4). */
  setTimeScale(scale) {
    this.speed = Number.isFinite(scale) ? Math.min(4, Math.max(0.25, scale)) : 1;
  }
  timeScale() {
    return this.speed;
  }
  /** While paused, advance one frame and show it (not while stopped at a breakpoint: use debugContinue). */
  stepFrame() {
    if (this.running || this.destroyed || !this.console || this.debugState?.paused) return;
    this.tickOnce(false);
    this.present();
  }
  frame() {
    return this.tickFrame;
  }
  pause() {
    if (!this.running) return;
    this.running = false;
    this.view.cancelAnimationFrame(this.frameHandle);
    this.gamepad.reset();
    void this.audio?.pause();
  }
  setEditorCamera(camera) {
    this.editorCamera = camera;
  }
  /** Apply an editor's edits to the running 3D scene (see PlayerHandle.updateMeshScene). */
  async updateMeshScene(scene) {
    if (!this.meshSurface) return false;
    return this.meshSurface.applySceneEdits(scene);
  }
  setProfiling(on) {
    if (on === (this.profiler !== null)) return;
    this.profiler = on ? new Profiler() : null;
    this.netSamples = [];
    this.meshSurface?.setProfiler(this.profiler);
  }
  /** Where the last second or so of frames spent their time, and what the scene drew; null while profiling is off. */
  profile() {
    const profiler = this.profiler;
    if (!profiler) return null;
    const { frames, sections, total } = profiler.sections();
    const stats = this.meshSurface?.renderStats() ?? null;
    const heap = this.view.performance.memory?.usedJSHeapSize;
    let net = null;
    const traffic = this.options.netplay?.traffic();
    if (traffic) {
      const at = this.view.performance.now();
      this.netSamples.push({ at, ...traffic });
      while (this.netSamples.length > 2 && at - this.netSamples[0].at > 2e3) this.netSamples.shift();
      const first = this.netSamples[0];
      const seconds = (at - first.at) / 1e3;
      net = {
        sent: traffic.sent,
        received: traffic.received,
        sentPerSecond: seconds > 0 ? (traffic.sent - first.sent) / seconds : 0,
        receivedPerSecond: seconds > 0 ? (traffic.received - first.received) / seconds : 0
      };
    }
    return {
      frames,
      sections,
      total,
      render: stats && this.sceneRenderer ? { ...stats, backend: this.sceneRenderer.backend } : null,
      memory: {
        wasm: this.console?.memoryBytes() ?? 0,
        jsHeap: typeof heap === "number" ? heap : null,
        scene: this.meshSurface ? this.meshSurface.sceneBytes() : null
      },
      net
    };
  }
  /** Run one console frame. `withSound` false drops its audio (stepping, or off 1× speed). */
  tickOnce(withSound = true) {
    const profiler = this.profiler;
    profiler?.nextFrame();
    const clock = this.view.performance;
    let mark = profiler ? clock.now() : 0;
    const lap = (section) => {
      if (!profiler) return;
      const now = clock.now();
      profiler.add(section, now - mark);
      mark = now;
    };
    const input = (this.replaySource ? this.replaySource.maskForFrame(this.tickFrame) : this.inputEnabled ? this.gamepad.value | this.heldActions() << 8 : 0) >>> 0;
    const mask = input & 255;
    this.feedActions(input >>> 8);
    const net = this.options.netplay;
    if (net && this.console) {
      const words = this.console.netWords();
      if (words) net.beforeTick(words);
    }
    lap("net");
    this.feedSticks();
    const runtimeBlock = this.runtimeBlock();
    if (runtimeBlock) this.runtime.channel.beforeTick(runtimeBlock);
    const debugBlock = this.debugBlock();
    if (debugBlock) this.armDebug(debugBlock);
    lap("runtime");
    const frame = this.tickFrame + 1;
    this.console?.tick(mask);
    lap("cart");
    if (debugBlock) {
      this.drainDebug(frame);
      this.checkPause();
    }
    const afterBlock = runtimeBlock ? this.runtimeBlock() : null;
    if (afterBlock) {
      this.runtime.channel.afterTick(afterBlock, this.commandRing());
      this.pollLevelRequest();
      for (const b of this.runtime.channel.takeBursts()) this.meshSurface?.burst(b.effect, b.at, b.dir, b.scale);
      for (const d of this.runtime.channel.takeDecals()) this.meshSurface?.decal(d.decal, d.at, d.normal, d.scale);
      for (const d of this.runtime.channel.takeDebris()) this.meshSurface?.throwDebris(d.debris, d.at, d.velocity, d.scale);
      for (const c of this.runtime.channel.takeSounds()) {
        if (!this.sounds) continue;
        if (c.kind === "play") {
          if (withSound) this.sounds.play(c.sound, c.volume, c.pitch, c.at);
        } else if (c.kind === "loop") this.sounds.loop(c.slot, c.sound, c.volume, c.at);
        else this.sounds.mix(c.bus, c.volume);
      }
    }
    if (this.sounds && this.runtime) {
      for (const [name, v] of this.runtime.channel.timelineValues()) {
        if (!name.startsWith("bus:")) continue;
        const bus = this.sounds.busIndex(name.slice(4));
        if (bus >= 0) this.sounds.mix(bus, v);
      }
    }
    if (this.sounds && this.meshSurface) {
      const pose = this.meshSurface.listenerPose();
      if (pose) this.sounds.listen(pose.eye, pose.forward, pose.up);
      this.sounds.follow(this.meshSurface.placements());
    }
    this.updateSpatialLoading();
    lap("runtime");
    if (net && this.console) {
      const words = this.console.netWords();
      if (words) net.afterTick(words);
    }
    lap("net");
    this.recorder?.record(input);
    this.pollSave();
    this.tickFrame++;
    if (this.console && this.options.onRuntimeError) {
      const error = this.console.readError();
      if (error && error.seq > this.lastErrorSeq) {
        this.lastErrorSeq = error.seq;
        if (error.message) this.options.onRuntimeError(remapErrorLines(error.message, this.lineOffset));
      }
    }
    this.pollEvents();
    const samples = this.console?.readAudioSamples();
    if (withSound && samples && samples.length > 0) {
      this.audio?.enqueue(samples);
    }
    lap("audio");
  }
  /**
   * Change the graphics preset live ("auto" re-detects). Shadows and the 3D
   * resolution follow at once; effects the preset turns off go off now, and ones
   * it turns back on need the post-effect stage to have been started with some
   * effect on.
   */
  setQuality(choice) {
    this.qualitySettings = resolveQuality(choice, browserDeviceHints(this.sceneRenderer ? this.sceneRenderer.backend !== "software" : void 0));
    this.meshSurface?.setQuality(this.qualitySettings);
    if (this.postFxSurface && this.basePostFx) this.postFxSurface.setSettings(applyQualityToPostFx(this.basePostFx, this.qualitySettings));
  }
  /**
   * Hand the running scene streamed textures, by the `ref` of the placeholder
   * each fills (for asset-backed textures, the asset's content hash): they
   * replace the flat colours their placeholders drew. Resolves with how many
   * objects changed (0 before the scene is up, or for no matching placeholder).
   */
  async supplyTextures(images) {
    if (!this.meshSurface) return 0;
    return this.meshSurface.supplyImages(images);
  }
  /**
   * Start a level switch the cart asked for: load the level's assets through the
   * host (a published cart fetches its textures), then make it current.
   */
  pollLevelRequest() {
    const channel = this.runtime?.channel;
    const scene = this.options.mesh;
    const request = channel?.takeLevelRequest() ?? -1;
    if (!channel || !scene?.levels || request < 0) return;
    const level = scene.levels[request];
    const load = this.options.levelAssets;
    if (!load) {
      this.activateLevel(request);
      return;
    }
    const token = ++this.levelLoads;
    const progress = (p) => {
      if (token !== this.levelLoads || this.destroyed) return;
      channel.setLevelLoading(request, p);
      this.options.onLevel?.({ level: scene.levels[channel.currentLevel()]?.name ?? "", loading: level.name, progress: p });
    };
    progress(0);
    const done = () => {
      if (token === this.levelLoads && !this.destroyed) this.activateLevel(request);
    };
    load(level, progress).then(done, done);
  }
  /** Hide (and take out of physics) everything a level or spatial loading has out. */
  applyInactive() {
    const inactive = /* @__PURE__ */ new Set([...this.levelInactive, ...this.spatial?.unloaded ?? []]);
    this.meshSurface?.setInactive(inactive);
    this.runtime?.physics?.setInactive(inactive);
  }
  /**
   * Spatial loading: load what's in range of the focus (where the cart put it,
   * else the camera) and unload what's out; ask the host for the assets of
   * objects coming near.
   */
  updateSpatialLoading() {
    const spatial = this.spatial;
    const scene = this.options.mesh;
    if (!spatial || !scene) return;
    const focus = this.runtime?.channel.streamFocus() ?? this.meshSurface?.eyePosition() ?? scene.bounds.center;
    const surface = this.meshSurface;
    const moved = (g) => {
      const root = spatial.loader.groups[g].members[0];
      const now = surface?.movedModel(root);
      if (!now) return null;
      const placed = scene.instances[root].model;
      return [now[12] - placed[12], now[13] - placed[13], now[14] - placed[14]];
    };
    const { changed, approached } = spatial.loader.update(focus, moved);
    if (changed) {
      spatial.unloaded = spatial.loader.unloaded();
      this.applyInactive();
    }
    if (approached.length > 0 && this.options.streamAssets) {
      this.options.streamAssets(approached.map((g) => scene.instances[spatial.loader.groups[g].members[0]].id));
    }
  }
  /** Make a level current: its objects (and the always-loaded ones) show and simulate; the rest are hidden. */
  activateLevel(level) {
    const scene = this.options.mesh;
    if (!scene?.levels) return;
    const inactive = /* @__PURE__ */ new Set();
    scene.instances.forEach((inst, i) => {
      if (inst.level !== void 0 && inst.level !== level) inactive.add(i);
    });
    this.levelInactive = inactive;
    this.applyInactive();
    this.runtime?.channel.setLevel(level);
    this.options.onLevel?.({ level: scene.levels[level]?.name ?? "", loading: null, progress: 1 });
  }
  /** The graphics preset in effect. */
  quality() {
    return this.qualitySettings.level;
  }
  /** Live inspection: every scene object's placement and state this frame. */
  inspect() {
    const scene = this.options.mesh;
    if (!scene) return [];
    const placements = this.meshSurface?.placements() ?? scene.instances.map((inst) => inst.pooled ? null : inst.model);
    const bodies = this.runtime?.physics?.inspect() ?? /* @__PURE__ */ new Map();
    const spawned = this.runtime?.channel.spawned() ?? /* @__PURE__ */ new Map();
    const playback = new Map((this.runtime?.channel.animation?.state() ?? []).map((p) => [p.object, p]));
    return scene.instances.map((inst, index) => {
      const m = placements[index] ?? inst.model;
      const body = bodies.get(index);
      const anim = playback.get(index);
      return {
        index,
        name: inst.name,
        parent: inst.parent,
        position: [m[12], m[13], m[14]],
        visible: placements[index] !== null && placements[index] !== void 0,
        tags: inst.tags,
        props: inst.props,
        ...body ? { body } : {},
        ...inst.pooled ? { prefab: { name: inst.pooled.prefab, spawned: spawned.has(inst.pooled.root) } } : {},
        ...anim ? { animation: { clip: anim.clip >= 0 ? inst.mesh.clips?.[anim.clip]?.name ?? null : null, time: anim.time } } : {}
      };
    });
  }
  /** A DataView over the runtime block (re-fetched: WASM memory growth detaches views). */
  runtimeBlock() {
    if (!this.runtime || !this.console) return null;
    const bytes = this.console.ramView(this.runtime.offset, PHYS_BLOCK_BYTES);
    return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  }
  /** A DataView over the overflow command ring (EP20), on cores that have one. */
  commandRing() {
    if (!this.runtime || this.runtime.ring === null || !this.console) return null;
    const bytes = this.console.ramView(this.runtime.ring, this.runtime.ringBytes);
    return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  }
  /** A DataView over the debug block, when the console is on (re-fetched, like runtimeBlock). */
  debugBlock() {
    if (this.debugOffset === null || !this.console) return null;
    const bytes = this.console.ramView(this.debugOffset, DEBUG_BLOCK_BYTES);
    return bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  }
  /** Before a tick: the magic and line numbers, and any new breakpoints or watches. */
  armDebug(block) {
    armDebugBlock(block, this.lineOffset, this.lineCount);
    const state = this.debugState;
    if (state?.dirty) {
      writeBreakpoints(block, state.breakpoints);
      writeWatches(block, state.watches);
      state.dirty = false;
    }
  }
  /** After a tick: if the cart stopped at a breakpoint, stop the loop and say where. */
  checkPause() {
    const state = this.debugState;
    const block = this.debugBlock();
    if (!state || !block) return;
    const pause = readPause(block, state.watches.length);
    state.paused = pause;
    if (!pause) return;
    this.pause();
    this.options.debug?.onPause?.(pause);
  }
  /** The debugger: which lines to stop at (moved on to the next line that can break, by the caller's choice). */
  setBreakpoints(lines) {
    if (!this.debugState) return;
    this.debugState.breakpoints = effectiveBreakpoints(lines, this.debugState.breakable);
    this.debugState.dirty = true;
    const block = this.debugBlock();
    if (block) this.armDebug(block);
  }
  /** The debugger: expressions to evaluate wherever the cart stops (re-evaluated now if it's stopped). */
  setWatches(expressions) {
    const state = this.debugState;
    if (!state) return;
    state.watches = [...expressions];
    state.dirty = true;
    const block = this.debugBlock();
    if (!block || !this.console) return;
    this.armDebug(block);
    if (state.paused) {
      sendDebugCommand(block, DebugCommand.refresh);
      this.console.tick(0);
      const pause = readPause(this.debugBlock(), state.watches.length);
      state.paused = pause;
      if (pause) this.options.debug?.onPause?.(pause);
    }
  }
  /** The debugger: carry on from a stop — to the next breakpoint, or one statement (into, over, out). */
  debugContinue(step = "continue") {
    const state = this.debugState;
    const block = this.debugBlock();
    if (!state?.paused || !block) return;
    sendDebugCommand(block, DebugCommand[step]);
    state.paused = null;
    this.options.debug?.onPause?.(null);
    void this.resume();
  }
  /** Where the cart is stopped, or null. */
  debugPaused() {
    return this.debugState?.paused ?? null;
  }
  /** Lines the debugger can stop at (ascending); empty without the debugger. */
  breakableLines() {
    return this.debugState?.breakable ?? [];
  }
  /** Hand the console the traces the cart printed during `frame`. */
  drainDebug(frame) {
    const block = this.debugBlock();
    const onTrace = this.options.onTrace;
    if (!block || !onTrace) return;
    const { traces, dropped } = drainTraces(block);
    for (const trace of traces) onTrace(trace.text, trace.color, frame);
    if (dropped > 0) onTrace(`(${dropped} more trace${dropped === 1 ? "" : "s"} this frame didn't fit)`, 15, frame);
  }
  /** Reads any platform events the cart emitted this frame and dispatches them. */
  pollEvents() {
    const onEvent = this.options.onEvent;
    if (!onEvent || !this.console) {
      return;
    }
    const { events, seq } = decodeMailbox(this.console.readMailbox(), this.lastMailboxSeq);
    this.lastMailboxSeq = seq;
    for (const event of events) {
      onEvent(event);
    }
  }
  present() {
    const started = this.profiler ? this.view.performance.now() : 0;
    this.presentFrameNow();
    this.profiler?.add("render", this.view.performance.now() - started);
  }
  presentFrameNow() {
    const framebuffer = this.console?.readFramebuffer();
    if (framebuffer) {
      if (this.litSurface && this.console) {
        this.litSurface.setCartLights(decodeLights(this.console.readMailbox()));
        this.litSurface.setCartMaterial(this.console.readMaterial());
        this.litSurface.setCartEmissive(this.console.readEmissive());
      }
      if (this.sceneSurface && this.console) {
        this.sceneSurface.setCameraBase(decodeCamera(this.console.readMailbox()));
      }
      if (this.meshSurface && this.console) {
        const mailbox = this.console.readMailbox();
        const meshCamera = decodeMeshCamera(mailbox);
        this.meshSurface.setCameraOverride(meshCamera);
        this.meshSurface.setHudMode(meshCamera?.hud ?? false);
        this.meshSurface.setPoseOverrides(decodeMeshPoses(mailbox));
        if (this.runtime) {
          const cutscene = this.runtime.channel.timelineCamera(meshCamera?.hud ?? false);
          if (cutscene) this.meshSurface.setCameraOverride(cutscene);
          const scripted = this.runtime.channel.timelinePlacements();
          const put = this.runtime.channel.placements();
          const bodies = this.runtime.physics?.overrides();
          this.meshSurface.setBodyOverrides(scripted.size > 0 || put.size > 0 ? new Map([...bodies ?? [], ...put, ...scripted]) : bodies ?? NO_OVERRIDES);
          this.meshSurface.setSpawned(this.runtime.channel.spawned());
          this.meshSurface.setShields(this.runtime.channel.shields());
          const placed = this.runtime.channel.needsWorld() ? this.meshSurface.currentPlacements() : null;
          this.meshSurface.setSkinning(placed ? this.runtime.channel.skinning((o) => placed[o] ?? null) : this.runtime.channel.skinning());
        }
        this.meshSurface.setCartLights(decodeWorldLights(mailbox));
        if (this.editorCamera) {
          this.meshSurface.setCameraOverride(this.editorCamera);
          this.meshSurface.setHudMode(false);
        }
      }
      if (this.worldSurface && this.console) {
        const mailbox = this.console.readMailbox();
        this.worldSurface.setCameraOverride(decodeMeshCamera(mailbox));
        this.worldSurface.setBillboards(decodeMeshPoses(mailbox));
        const sun = decodeLights(mailbox).find((light) => light.kind === "directional");
        this.worldSurface.setSun(sun?.direction ?? null);
      }
      this.applyAnimation();
      this.surface?.blit(framebuffer);
      this.presentFrame += 1;
      this.options.onFrame?.();
    }
  }
  /**
   * Sample the declared animation at the current presented frame and route it to
   * the surfaces that consume it. Feeds the scene backdrop's layer overrides, the
   * foreground placements, and (only when animated) the post-FX values. Runs before
   * blit so the composite reflects this frame; a no-op when no anim is declared.
   */
  applyAnimation() {
    if (!this.anim) return;
    const state = evaluate(this.anim, this.presentFrame);
    if (this.sceneSurface) {
      const hasLayerOverrides = Object.keys(state.layers).length > 0;
      this.sceneSurface.setLayerOverrides(hasLayerOverrides ? state.layers : null);
    }
    this.foregroundSurface?.setPlacements(state.placements);
    if (this.postFxSurface && this.basePostFx && Object.keys(state.postfx).length > 0) {
      this.postFxSurface.setSettings(
        applyQualityToPostFx({ ...this.basePostFx, values: { ...this.basePostFx.values, ...state.postfx } }, this.qualitySettings)
      );
    }
  }
  renderSingleFrame() {
    this.tickOnce();
    this.present();
  }
  /**
   * Analog sticks (see sticks.ts): once the cart has read a stick — the SDK marks
   * pmem with its opt-in — write the sticks before every tick, and show the
   * touch pad's right stick. Until then nothing is written, so a cart's own use
   * of those pmem words is left alone.
   */
  feedSticks() {
    const words = this.console?.netWords();
    if (!words) return;
    if (!this.analogCart) {
      if (words[STICK_OPTIN_WORD] !== STICK_OPTIN_MAGIC) return;
      this.analogCart = true;
      this.touch?.setAnalog(true);
    }
    words[STICK_WORD] = this.replaySource || !this.inputEnabled ? 0 : packSticks(applyLookSettings(this.gamepad.axes, this.controlSettings));
  }
  /** Save data (EP15b): hand a save the cart made this tick to the host. */
  pollSave() {
    if (!this.saveBlock || !this.console) return;
    const bytes = this.console.ramView(this.saveBlock.offset, this.saveBlock.bytes);
    if (!bytes) return;
    const block = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    armSaveBlock(block);
    const save = takeSave(block);
    if (save) this.options.onSave?.(save.data);
  }
  /** Input actions (EP15): this tick's mask and last tick's into the input block. */
  feedActions(held) {
    if (this.inputOffset === null || !this.console) return;
    const bytes = this.console.ramView(this.inputOffset, INPUT_BLOCK_BYTES);
    if (!bytes) return;
    const block = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    writeInputBlock(block, held, this.lastActions);
    writeInputSettings(block, this.settings, this.languageIndex, this.settingsRevision);
    this.lastActions = held;
  }
  languageIndexFor(preferred) {
    const table = this.options.strings;
    const language = playLanguage(table, preferred);
    return table && language ? table.languages.indexOf(language) + 1 : 0;
  }
  /** Change text size and colour filter at once (see PlayerHandle.setAccessibility). */
  setAccessibility(settings) {
    this.settings = settings;
    this.setColorFilter(settings.colorFilter);
  }
  /** Play in the first of these languages the cart has, from the next tick (see PlayerHandle.setLanguages). */
  setLanguages(preferred) {
    const index = this.languageIndexFor(preferred);
    if (index === this.languageIndex) return;
    this.languageIndex = index;
    this.settingsRevision = this.settingsRevision % 255 + 1;
  }
  fail(error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.options.onError?.(normalized);
    this.destroy();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.setColorFilter("none");
    this.running = false;
    this.abortController.abort();
    this.view.cancelAnimationFrame(this.frameHandle);
    this.keyboard?.destroy();
    this.touch?.destroy();
    this.runtime?.channel.destroy();
    this.runtime = null;
    this.sounds?.dispose();
    this.audio?.destroy();
    this.surface?.destroy();
    this.sceneRenderer?.dispose();
    this.cartSource?.dispose();
    this.console?.dispose();
  }
};
function makeWorldTextureLookup(cartSource, tilesPerSide) {
  const cache = /* @__PURE__ */ new Map();
  return (sprite) => {
    const cached = cache.get(sprite);
    if (cached !== void 0) return cached;
    const region = cartSource.source.readRegion(0, sprite, tilesPerSide, tilesPerSide);
    const texture = region.width > 0 && region.height > 0 ? { width: region.width, height: region.height, data: region.pixels } : null;
    cache.set(sprite, texture);
    return texture;
  };
}

// src/verify.ts
function runReplayEvents(console2, replay, options = {}) {
  const source = new ReplaySource(replay.inputs);
  let lastSeq = decodeMailbox(console2.readMailbox(), 0).seq;
  const events = [];
  let lastActions = 0;
  for (let frame = 0; frame < replay.frameCount; frame++) {
    const input = source.maskForFrame(frame) >>> 0;
    if (options.inputOffset !== void 0) {
      const bytes = console2.ramView(options.inputOffset, INPUT_BLOCK_BYTES);
      if (bytes) writeInputBlock(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), input >>> 8, lastActions);
      lastActions = input >>> 8;
    }
    console2.tick(input & 255);
    const read = decodeMailbox(console2.readMailbox(), lastSeq);
    lastSeq = read.seq;
    events.push(...read.events);
  }
  return events;
}
function extractScore(events) {
  let best = null;
  for (const event of events) {
    if (event.kind === "score") {
      best = best === null ? event.value : Math.max(best, event.value);
    }
  }
  return best;
}
function extractUnlocks(events) {
  const ids = /* @__PURE__ */ new Set();
  for (const event of events) {
    if (event.kind === "achievement") {
      ids.add(event.id);
    }
  }
  return [...ids];
}
function verifyReplayScore(console2, replay, claimedScore, options = {}) {
  const events = runReplayEvents(console2, replay, options);
  const score = extractScore(events);
  return {
    score,
    unlocks: extractUnlocks(events),
    verified: score !== null && score === claimedScore
  };
}

// src/achievements.ts
function resolveUnlockedAchievements(unlockHashes, registered) {
  const unlocked = new Set(unlockHashes.map((hash) => hash >>> 0));
  return registered.filter((achievement) => unlocked.has(achievement.hash >>> 0));
}

// src/fx/lensModel.ts
var TILT_SHIFT_FEATHER = 0.35;
var EPSILON2 = 1e-3;
function clamp012(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
function tiltShiftBlur(y, focus, range) {
  const outside = Math.abs(y - focus) - Math.max(0, range);
  if (outside <= 0) return 0;
  return clamp012(outside / TILT_SHIFT_FEATHER);
}
function reflectionSampleY(y, horizon) {
  return horizon - (y - horizon);
}
function reflectionFade(y, horizon, falloff) {
  const below = y - horizon;
  if (below <= 0) return 0;
  return clamp012(1 - below / Math.max(EPSILON2, falloff));
}

// src/scene/sceneModel.ts
var MAX_LAYERS = 8;
var MAX_TILE = 255;
var MAX_TILES_PER_SIDE = 32;
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var clamp2 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
var clampInt = (v, lo, hi) => Math.round(clamp2(v, lo, hi));
function parseRgb(raw, fallback) {
  if (!Array.isArray(raw) || raw.length < 3) return fallback;
  return [
    clampInt(num(raw[0], fallback[0]), 0, 255),
    clampInt(num(raw[1], fallback[1]), 0, 255),
    clampInt(num(raw[2], fallback[2]), 0, 255)
  ];
}
var DEFAULT_ATMOSPHERE = {
  fog: [96, 116, 168],
  density: 0.85,
  desaturate: 0.7,
  lift: 0.4
};
function parseRegion(raw) {
  if (!isObject(raw)) return null;
  const page = raw.page === 1 ? 1 : 0;
  const tile = clampInt(num(raw.tile, -1), 0, MAX_TILE);
  const tilesW = clampInt(num(raw.tilesW, 1), 1, MAX_TILES_PER_SIDE);
  const tilesH = clampInt(num(raw.tilesH, 1), 1, MAX_TILES_PER_SIDE);
  if (!Number.isInteger(tile) || num(raw.tile, -1) < 0) return null;
  return { page, tile, tilesW, tilesH };
}
function parseLayer(raw) {
  if (!isObject(raw)) return null;
  const source = parseRegion(raw.source);
  if (!source) return null;
  const layer = {
    source,
    depth: clamp2(num(raw.depth, 0.5), 0, 1),
    wrapX: raw.wrapX === void 0 ? true : Boolean(raw.wrapX),
    offsetY: Math.round(num(raw.offsetY, 0))
  };
  if (typeof raw.parallax === "number" && Number.isFinite(raw.parallax)) {
    layer.parallax = clamp2(raw.parallax, 0, 4);
  }
  return layer;
}
function parseScene(raw) {
  if (!isObject(raw)) return null;
  const layersRaw = Array.isArray(raw.layers) ? raw.layers : [];
  const layers = [];
  for (const entry of layersRaw) {
    if (layers.length >= MAX_LAYERS) break;
    const layer = parseLayer(entry);
    if (layer) layers.push(layer);
  }
  if (layers.length === 0) return null;
  const atmoRaw = isObject(raw.atmosphere) ? raw.atmosphere : {};
  const atmosphere = {
    fog: parseRgb(atmoRaw.fog, DEFAULT_ATMOSPHERE.fog),
    density: clamp2(num(atmoRaw.density, DEFAULT_ATMOSPHERE.density), 0, 1),
    desaturate: clamp2(num(atmoRaw.desaturate, DEFAULT_ATMOSPHERE.desaturate), 0, 1),
    lift: clamp2(num(atmoRaw.lift, DEFAULT_ATMOSPHERE.lift), 0, 1)
  };
  const camRaw = isObject(raw.camera) ? raw.camera : {};
  const camera = {
    autoScrollX: num(camRaw.autoScrollX, 0),
    autoScrollY: num(camRaw.autoScrollY, 0)
  };
  const keyColor = clampInt(num(raw.keyColor, 0), 0, MAX_TILE);
  return { layers, atmosphere, camera, keyColor };
}

// src/anim/animModel.ts
var MAX_CLIPS = 32;
var MAX_TRACKS = 64;
var MAX_PLACEMENTS = 32;
var MAX_KEYS = 64;
var MAX_FRAMES = 64;
var MAX_TILE2 = 255;
var MAX_TILES_PER_SIDE2 = 32;
var MAX_LAYER_INDEX = 7;
var MAX_FRAME_TICKS = 600;
var isObject2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var num2 = (v, fallback) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
var clamp3 = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
var clampInt2 = (v, lo, hi) => Math.round(clamp3(v, lo, hi));
var ANIM_MODES = /* @__PURE__ */ new Set(["loop", "pingpong", "once"]);
var TRACK_MODES = /* @__PURE__ */ new Set(["loop", "pingpong", "hold"]);
var EASES = /* @__PURE__ */ new Set(["linear", "step", "smooth"]);
var LAYER_CHANNELS = /* @__PURE__ */ new Set(["opacity", "offsetX", "offsetY", "emissive"]);
var PLACEMENT_CHANNELS = /* @__PURE__ */ new Set(["x", "y", "opacity", "scale"]);
function parseRegion2(raw) {
  if (!isObject2(raw)) return null;
  if (typeof raw.tile !== "number" || !Number.isFinite(raw.tile) || raw.tile < 0) return null;
  return {
    page: raw.page === 1 ? 1 : 0,
    tile: clampInt2(raw.tile, 0, MAX_TILE2),
    tilesW: clampInt2(num2(raw.tilesW, 1), 1, MAX_TILES_PER_SIDE2),
    tilesH: clampInt2(num2(raw.tilesH, 1), 1, MAX_TILES_PER_SIDE2)
  };
}
function parseClip(raw) {
  if (!isObject2(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  const framesRaw = Array.isArray(raw.frames) ? raw.frames : [];
  const frames = [];
  for (const entry of framesRaw) {
    if (frames.length >= MAX_FRAMES) break;
    const region = parseRegion2(entry);
    if (region) frames.push(region);
  }
  if (frames.length === 0) return null;
  const durationsRaw = Array.isArray(raw.durations) ? raw.durations : [];
  const durations = frames.map((_, i) => clampInt2(num2(durationsRaw[i], 1), 1, MAX_FRAME_TICKS));
  const mode = ANIM_MODES.has(raw.mode) ? raw.mode : "loop";
  return { name: raw.name, frames, durations, mode };
}
function parseKeyframe(raw) {
  if (!isObject2(raw)) return null;
  if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return null;
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) return null;
  return { t: raw.t, value: raw.value, ease: EASES.has(raw.ease) ? raw.ease : "linear" };
}
function parseTarget(raw, placementCount) {
  if (!isObject2(raw)) return null;
  if (raw.kind === "sceneLayer") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index > MAX_LAYER_INDEX) return null;
    if (!LAYER_CHANNELS.has(raw.channel)) return null;
    return { kind: "sceneLayer", index: raw.index, channel: raw.channel };
  }
  if (raw.kind === "postfx") {
    if (typeof raw.key !== "string" || raw.key.length === 0) return null;
    return { kind: "postfx", key: raw.key };
  }
  if (raw.kind === "placement") {
    if (typeof raw.index !== "number" || !Number.isInteger(raw.index) || raw.index < 0 || raw.index >= placementCount) return null;
    if (!PLACEMENT_CHANNELS.has(raw.channel)) return null;
    return { kind: "placement", index: raw.index, channel: raw.channel };
  }
  return null;
}
function parseTrack(raw, placementCount) {
  if (!isObject2(raw)) return null;
  const target = parseTarget(raw.target, placementCount);
  if (!target) return null;
  const keysRaw = Array.isArray(raw.keys) ? raw.keys : [];
  const keys = [];
  for (const entry of keysRaw) {
    if (keys.length >= MAX_KEYS) break;
    const key = parseKeyframe(entry);
    if (key) keys.push(key);
  }
  if (keys.length === 0) return null;
  keys.sort((a, b) => a.t - b.t);
  const track = {
    target,
    keys,
    mode: TRACK_MODES.has(raw.mode) ? raw.mode : "loop"
  };
  if (typeof raw.loopLength === "number" && Number.isFinite(raw.loopLength) && raw.loopLength > 0) {
    track.loopLength = raw.loopLength;
  }
  return track;
}
function parsePlacement(raw, clipNames) {
  if (!isObject2(raw)) return null;
  if (typeof raw.clip !== "string" || !clipNames.has(raw.clip)) return null;
  return {
    clip: raw.clip,
    x: num2(raw.x, 0),
    y: num2(raw.y, 0),
    depth: clamp3(num2(raw.depth, 0), 0, 1),
    opacity: clamp3(num2(raw.opacity, 1), 0, 1),
    scale: Math.max(0.01, num2(raw.scale, 1))
  };
}
function parseAnim(raw) {
  if (!isObject2(raw)) return null;
  const clips = [];
  const clipNames = /* @__PURE__ */ new Set();
  for (const entry of Array.isArray(raw.clips) ? raw.clips : []) {
    if (clips.length >= MAX_CLIPS) break;
    const clip = parseClip(entry);
    if (clip && !clipNames.has(clip.name)) {
      clipNames.add(clip.name);
      clips.push(clip);
    }
  }
  const placements = [];
  for (const entry of Array.isArray(raw.placements) ? raw.placements : []) {
    if (placements.length >= MAX_PLACEMENTS) break;
    const placement = parsePlacement(entry, clipNames);
    if (placement) placements.push(placement);
  }
  const tracks = [];
  for (const entry of Array.isArray(raw.tracks) ? raw.tracks : []) {
    if (tracks.length >= MAX_TRACKS) break;
    const track = parseTrack(entry, placements.length);
    if (track) tracks.push(track);
  }
  if (clips.length === 0 && tracks.length === 0 && placements.length === 0) return null;
  return { clips, tracks, placements };
}

// src/anim/generators.ts
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    return state / 4294967296;
  };
}
function pulse(period, min, max) {
  const half = Math.max(1, Math.round(period / 2));
  return {
    keys: [
      { t: 0, value: min, ease: "smooth" },
      { t: half, value: max, ease: "smooth" }
    ],
    mode: "pingpong"
  };
}
function sway(period, amplitude, center = 0) {
  const half = Math.max(1, Math.round(period / 2));
  return {
    keys: [
      { t: 0, value: center - amplitude, ease: "smooth" },
      { t: half, value: center + amplitude, ease: "smooth" }
    ],
    mode: "pingpong"
  };
}
function drift(period, distance) {
  const length = Math.max(1, Math.round(period));
  return {
    keys: [
      { t: 0, value: 0, ease: "linear" },
      { t: length, value: distance, ease: "linear" }
    ],
    mode: "loop",
    loopLength: length
  };
}
function flicker(period, min, max, steps = 8, seed = 1) {
  const length = Math.max(2, Math.round(period));
  const count = Math.max(2, Math.min(64, Math.min(Math.round(steps), length)));
  const random = seededRandom(seed);
  const keys = [];
  let previousT = -1;
  for (let i = 0; i < count; i += 1) {
    let t = Math.floor(i / count * length);
    if (t <= previousT) t = previousT + 1;
    previousT = t;
    keys.push({ t, value: min + (max - min) * random(), ease: "step" });
  }
  return { keys, mode: "loop", loopLength: length };
}

// src/particles/particleModel.ts
var PARTICLE_KINDS = ["rain", "snow", "embers", "fog"];
var MAX_EMITTERS = 6;
var MAX_PARTICLES_PER_EMITTER = 600;
var PRESETS = {
  rain: { count: 220, color: [180, 205, 235], opacity: 0.35, size: 1, speed: 9, wind: -1.2 },
  snow: { count: 140, color: [235, 240, 255], opacity: 0.75, size: 2, speed: 1.4, wind: 0.3 },
  embers: { count: 60, color: [255, 150, 60], opacity: 0.9, size: 1, speed: 0.7, wind: 0.4 },
  fog: { count: 18, color: [150, 160, 180], opacity: 0.12, size: 7, speed: 0.25, wind: 0.5 }
};
function emitterPreset(kind, seed) {
  return { kind, seed, ...PRESETS[kind] };
}
function clamp4(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
function readNumber(raw, min, max, fallback) {
  return typeof raw === "number" && Number.isFinite(raw) ? clamp4(raw, min, max) : fallback;
}
function readColor(raw, fallback) {
  if (!Array.isArray(raw) || raw.length !== 3) return [...fallback];
  const channels = raw.map((c) => typeof c === "number" && Number.isFinite(c) ? clamp4(Math.round(c), 0, 255) : null);
  if (channels.some((c) => c === null)) return [...fallback];
  return channels;
}
function parseEmitter(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw;
  const kind = record.kind;
  if (typeof kind !== "string" || !PARTICLE_KINDS.includes(kind)) return null;
  const preset = PRESETS[kind];
  return {
    kind,
    count: Math.round(readNumber(record.count, 1, MAX_PARTICLES_PER_EMITTER, preset.count)),
    color: readColor(record.color, preset.color),
    opacity: readNumber(record.opacity, 0, 1, preset.opacity),
    size: readNumber(record.size, 1, 8, preset.size),
    speed: readNumber(record.speed, 0, 12, preset.speed),
    wind: readNumber(record.wind, -6, 6, preset.wind),
    seed: Math.round(readNumber(record.seed, 0, 4294967295, 1))
  };
}
function parseParticles(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const rawEmitters = raw.emitters;
  if (!Array.isArray(rawEmitters)) return null;
  const emitters = [];
  for (const entry of rawEmitters) {
    if (emitters.length >= MAX_EMITTERS) break;
    const emitter = parseEmitter(entry);
    if (emitter) emitters.push(emitter);
  }
  return emitters.length > 0 ? { emitters } : null;
}

// src/net/NetSession.ts
function netSendInterval(players) {
  return players <= 2 ? 4 : players <= 4 ? 6 : 8;
}
var KEEPALIVE_TICKS = 60;
var STALE_MS = 3e3;
var NetSession = class {
  constructor(transport, now = () => Date.now()) {
    this.transport = transport;
    this.now = now;
    this.peers = [];
    this.connected = false;
    this.joinedAt = Date.now();
    this.remote = /* @__PURE__ */ new Map();
    this.pendingEvents = [];
    this.hostMatch = 0;
    this.statusCode = 0;
    this.tick = 0;
    this.outEvents = [];
    this.outStates = /* @__PURE__ */ new Map();
    /** What the last message carried (states + match), and when — to skip repeats. */
    this.lastSent = "";
    this.lastSentTick = -Infinity;
    this.listeners = /* @__PURE__ */ new Set();
    /** Bytes sent and received so far, as JSON on the wire (for the profiler). */
    this.sentBytes = 0;
    this.receivedBytes = 0;
    transport.onPeers((peers) => {
      this.peers = [...peers].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      this.emit();
    });
    transport.onMessage((message) => this.receive(message));
  }
  /** Bytes this session has sent and received, measured as the messages' JSON. */
  traffic() {
    return { sent: this.sentBytes, received: this.receivedBytes };
  }
  /** Forget the current room's state (remote players, queued events, the host's
   *  match word) — for moving to another room without carrying anything over. */
  resetRoom() {
    this.remote.clear();
    this.pendingEvents.length = 0;
    this.outEvents.length = 0;
    this.outStates = /* @__PURE__ */ new Map();
    this.hostMatch = 0;
    this.lastSent = "";
  }
  /** A status for the cart (0..7, read as net()'s fifth value) — e.g. matchmaking progress. */
  setStatus(code) {
    this.statusCode = code & 7;
  }
  /** Join the room. */
  async connect(name) {
    await this.transport.connect(this.joinedAt, name);
    this.connected = true;
    this.emit();
  }
  close() {
    this.connected = false;
    this.transport.close();
    this.emit();
  }
  /** This browser's slot (0..7), or -1 while the room is full/unknown. */
  get mySlot() {
    const index = this.peers.findIndex((p) => p.id === this.transport.selfId);
    return index >= 0 && index < NET_SLOTS ? index : -1;
  }
  get isHost() {
    return this.mySlot === 0;
  }
  status() {
    return { connected: this.connected, peers: this.peers, mySlot: this.mySlot, isHost: this.isHost };
  }
  /** Subscribe to room changes (membership, connection). */
  onStatus(listener) {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }
  /** Fill the cart's inbox before a tick. `words` is a live view of pmem 0..118. */
  beforeTick(words) {
    const mySlot = this.mySlot;
    if (!this.connected || mySlot < 0) {
      writeNetInbox(words, { mode: 0, mySlot: 0, status: this.statusCode, humans: 0, live: 0, match: 0, seq: this.tick, slots: [], events: [] });
      return;
    }
    const now = this.now();
    let humans = 0;
    for (let slot = 0; slot < Math.min(NET_SLOTS, this.peers.length); slot += 1) humans |= 1 << slot;
    let live = 0;
    const slots = [];
    for (let slot = 0; slot < NET_SLOTS; slot += 1) {
      const entry = slot === mySlot ? void 0 : this.remote.get(slot);
      if (entry && now - entry.at < STALE_MS) {
        slots.push(entry.state);
        live |= 1 << slot;
      } else {
        slots.push(null);
      }
    }
    const events = this.pendingEvents.slice(0, NET_IN_EVENT_CAPACITY);
    const delivered = writeNetInbox(words, {
      mode: this.isHost ? NET_MODE_HOST : NET_MODE_CLIENT,
      status: this.statusCode,
      mySlot,
      humans,
      live,
      match: this.hostMatch,
      seq: this.tick,
      slots,
      events
    });
    this.pendingEvents.splice(0, delivered);
  }
  /** Relay what the cart published during the tick, and clear its outbox. */
  afterTick(words) {
    const out = takeNetOutbox(words);
    this.tick += 1;
    if (!this.connected || this.mySlot < 0) return;
    for (const event of out.events) if (this.outEvents.length < 200) this.outEvents.push(event);
    for (const [slot, state] of out.states) this.outStates.set(slot, state);
    if (this.isHost) this.hostMatch = out.match;
    if (this.tick % netSendInterval(this.peers.length) !== 0) return;
    const message = {};
    if (this.outStates.size > 0) message.s = [...this.outStates].map(([slot, w]) => [slot, w[0], w[1], w[2]]);
    if (this.isHost) message.m = this.hostMatch;
    this.outStates = /* @__PURE__ */ new Map();
    const signature = JSON.stringify([message.s ?? null, message.m ?? null]);
    if (this.outEvents.length === 0 && signature === this.lastSent && this.tick - this.lastSentTick < KEEPALIVE_TICKS) return;
    if (this.outEvents.length > 0) message.e = this.outEvents.splice(0);
    if (message.s || message.e || message.m !== void 0) {
      this.transport.send(message);
      this.sentBytes += JSON.stringify(message).length;
      this.lastSent = signature;
      this.lastSentTick = this.tick;
    }
  }
  receive(message) {
    this.receivedBytes += JSON.stringify(message).length;
    const now = this.now();
    for (const [slot, a, b, c] of message.s ?? []) {
      if (slot >= 0 && slot < NET_SLOTS && slot !== this.mySlot) this.remote.set(slot, { state: [a, b, c], at: now });
    }
    for (const event of message.e ?? []) if (this.pendingEvents.length < 200) this.pendingEvents.push(event);
    if (message.m !== void 0 && !this.isHost) this.hostMatch = message.m;
  }
  emit() {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }
};
var MemoryNetHub = class {
  constructor() {
    this.members = /* @__PURE__ */ new Map();
  }
  transport(id) {
    const transport = new MemoryTransport(id, this);
    this.members.set(id, { peer: null, transport });
    return transport;
  }
  /** @internal */
  join(id, peer) {
    const member = this.members.get(id);
    if (member) member.peer = peer;
    this.announce();
  }
  /** @internal */
  leave(id) {
    this.members.delete(id);
    this.announce();
  }
  /** @internal */
  deliver(from, message) {
    const wire = JSON.stringify(message);
    for (const [id, member] of this.members) if (id !== from && member.peer) member.transport.receive(JSON.parse(wire), from);
  }
  announce() {
    const peers = [...this.members.values()].flatMap((m) => m.peer ? [m.peer] : []);
    for (const member of this.members.values()) if (member.peer) member.transport.peers(peers);
  }
};
var MemoryTransport = class {
  constructor(selfId, hub) {
    this.selfId = selfId;
    this.hub = hub;
    this.messageHandler = null;
    this.peersHandler = null;
  }
  async connect(joinedAt, name) {
    this.hub.join(this.selfId, { id: this.selfId, joinedAt, name });
  }
  send(message) {
    this.hub.deliver(this.selfId, message);
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onPeers(handler) {
    this.peersHandler = handler;
  }
  close() {
    this.hub.leave(this.selfId);
  }
  /** @internal */
  receive(message, from) {
    this.messageHandler?.(message, from);
  }
  /** @internal */
  peers(peers) {
    this.peersHandler?.(peers);
  }
};
var BroadcastChannelTransport = class {
  constructor(room) {
    this.room = room;
    this.channel = null;
    this.messageHandler = null;
    this.peersHandler = null;
    this.seen = /* @__PURE__ */ new Map();
    this.heartbeat = null;
    this.self = null;
    this.selfId = `tab-${Math.random().toString(36).slice(2, 10)}`;
  }
  async connect(joinedAt, name) {
    this.self = { id: this.selfId, joinedAt, name };
    this.channel = new BroadcastChannel(`cartbox-net:${this.room}`);
    this.channel.onmessage = (event) => {
      const data = event.data;
      if (data.from === this.selfId) return;
      if (data.kind === "hello" && data.peer) {
        const known = this.seen.has(data.from);
        this.seen.set(data.from, { peer: data.peer, at: Date.now() });
        if (!known) this.publishPeers();
      } else if (data.kind === "bye") {
        this.seen.delete(data.from);
        this.publishPeers();
      } else if (data.kind === "msg" && data.message) {
        this.messageHandler?.(data.message, data.from);
      }
    };
    const hello = () => {
      this.channel?.postMessage({ kind: "hello", from: this.selfId, peer: this.self });
      const now = Date.now();
      let changed = false;
      for (const [id, entry] of this.seen) {
        if (now - entry.at > 3500) {
          this.seen.delete(id);
          changed = true;
        }
      }
      if (changed) this.publishPeers();
    };
    hello();
    this.heartbeat = setInterval(hello, 1e3);
    this.publishPeers();
  }
  send(message) {
    this.channel?.postMessage({ kind: "msg", from: this.selfId, message });
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onPeers(handler) {
    this.peersHandler = handler;
  }
  close() {
    this.channel?.postMessage({ kind: "bye", from: this.selfId });
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.channel?.close();
    this.channel = null;
  }
  publishPeers() {
    const peers = [...this.seen.values()].map((entry) => entry.peer);
    if (this.self) peers.push(this.self);
    this.peersHandler?.(peers);
  }
};
var SwitchableTransport = class {
  constructor() {
    this.inner = null;
    this.idle = `idle-${Math.random().toString(36).slice(2, 10)}`;
    this.messageHandler = null;
    this.peersHandler = null;
  }
  get selfId() {
    return this.inner?.selfId ?? this.idle;
  }
  /** The room transport in use, or null. */
  get current() {
    return this.inner;
  }
  async connect(_joinedAt, name) {
    this.name = name;
    this.peersHandler?.([]);
  }
  /** Leave the current room (if any) and join `next` (or stay out when null). */
  async use(next) {
    const previous = this.inner;
    this.inner = null;
    previous?.close();
    this.peersHandler?.([]);
    if (!next) return;
    this.inner = next;
    next.onMessage((message, from) => {
      if (this.inner === next) this.messageHandler?.(message, from);
    });
    next.onPeers((peers) => {
      if (this.inner === next) this.peersHandler?.(peers);
    });
    await next.connect(Date.now(), this.name);
  }
  send(message) {
    this.inner?.send(message);
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onPeers(handler) {
    this.peersHandler = handler;
  }
  close() {
    void this.use(null);
  }
};

// src/index.ts
function mount(container, options) {
  const player = new Player(container, options);
  void player.start();
  return {
    pause: () => player.pause(),
    resume: () => void player.resume(),
    destroy: () => player.destroy(),
    getReplay: () => player.getReplay(),
    get running() {
      return player.running;
    },
    setControlSettings: (settings) => player.setControlSettings(settings),
    setVolume: (volume) => player.setVolume(volume),
    setColorFilter: (filter, kind) => player.setColorFilter(filter, kind),
    setAccessibility: (settings) => player.setAccessibility(settings),
    setLanguages: (preferred) => player.setLanguages(preferred),
    setInputEnabled: (enabled) => player.setInputEnabled(enabled),
    inspect: () => player.inspect(),
    setQuality: (choice) => player.setQuality(choice),
    supplyTextures: (textures) => player.supplyTextures(textures),
    setTimeScale: (scale) => player.setTimeScale(scale),
    timeScale: () => player.timeScale(),
    stepFrame: () => player.stepFrame(),
    frame: () => player.frame(),
    setBreakpoints: (lines) => player.setBreakpoints(lines),
    setWatches: (expressions) => player.setWatches(expressions),
    debugContinue: (step) => player.debugContinue(step),
    debugPaused: () => player.debugPaused(),
    breakableLines: () => player.breakableLines(),
    setProfiling: (on) => player.setProfiling(on),
    profile: () => player.profile(),
    quality: () => player.quality(),
    setEditorCamera: (camera) => player.setEditorCamera(camera),
    updateMeshScene: (scene) => player.updateMeshScene(scene)
  };
}
export {
  AgentCrowd,
  AnimatedForegroundSurface,
  AnimationSession,
  BLOOM_KNEE,
  BloomPyramid,
  BroadcastChannelTransport,
  CAMERA_BASE,
  CAMERA_SCALE,
  CARTBOX_SDK_LUA,
  CELL_WORLD,
  CMD_RING_BYTES,
  CMD_RING_MAX,
  CappedSceneRenderer,
  CartridgeLoadError,
  ConsoleButton,
  DEFAULT_AMBIENT2 as DEFAULT_AMBIENT,
  DEFAULT_ATMOSPHERE,
  DEFAULT_CONTROL_SETTINGS,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_LIGHT,
  DEFAULT_MODEL_ID,
  DEFAULT_PAD_BINDINGS,
  DebugCommand,
  EVENT_CAPACITY,
  EngineLoadError,
  FLARE_GHOSTS,
  FLARE_GHOST_GAIN,
  FLARE_SPIKE_POWER,
  GamepadInput,
  HEIGHT_WORLD,
  INPUT_BLOCK_BYTES,
  INPUT_MAGIC,
  INPUT_SETTINGS,
  INSTANCE_FLOATS,
  LIGHTS_BASE,
  LIGHTS_CAPACITY,
  LIGHT_FLOATS,
  LIGHT_STRIDE,
  LOOP_SLOTS,
  LightingLayer,
  LitCanvasSurface,
  MAILBOX_TYPE_ACHIEVEMENT,
  MAILBOX_TYPE_PROGRESS,
  MAILBOX_TYPE_SCORE,
  MAILBOX_WORDS,
  MAX_EMITTERS,
  MAX_PARTICLES_PER_EMITTER,
  MAX_PYRAMID_LEVELS,
  MAX_VOICES,
  MESH_CAM_ANGLE_SCALE,
  MESH_CAM_BASE,
  MESH_CAM_DIST_SCALE,
  MESH_CAM_STRIDE,
  MESH_POSE_BASE,
  MESH_POSE_CAPACITY,
  MESH_POSE_HIDDEN,
  MESH_POSE_STRIDE,
  MIN_PYRAMID_DIMENSION,
  MODELS,
  MemoryNetHub,
  MeshOverlaySurface,
  NET_MODE_CLIENT,
  NET_MODE_HOST,
  NET_MODE_OFFLINE,
  NET_SLOTS,
  NET_WORDS,
  NORMAL_DIRECTION_COUNT,
  NORMAL_VECTORS,
  NetSession,
  PAD_BUTTONS,
  PARTICLE_KINDS,
  PHYSICS_DT,
  PHYS_BLOCK_BYTES,
  PHYS_MAGIC,
  POST_FX_EFFECTS,
  PROFILE_SECTIONS,
  PROFILE_WINDOW,
  ParticleOverlaySurface,
  PhysicsSession,
  PostFxPass,
  PostFxSurface,
  Profiler,
  QUALITY_LEVELS,
  QUALITY_PRESETS,
  RAM_LAYOUTS,
  REPLAY_VERSION,
  ReplayError,
  ReplayRecorder,
  ReplaySource,
  RuntimeChannel,
  SAVE_MAGIC,
  SOFTWARE_RASTER_CAPS,
  START_KEYS,
  SceneBackdropSurface,
  SoftwareSceneRenderer,
  SoundSystem,
  SwitchableTransport,
  TILT_SHIFT_FEATHER,
  UNIFORM_BYTES_USED,
  UNIFORM_FLOATS,
  UNIFORM_STRIDE,
  VERTEX_FLOATS,
  WEBGL_INSTANCES_PER_DRAW,
  WEBGL_MAX_LIGHTS,
  WebglSceneRenderer,
  WebgpuLightingLayer,
  WebgpuSceneRenderer,
  WorldOverlaySurface,
  acesFilmic,
  acesFilmicChannel,
  actionsSdkLua,
  alignBytesPerRow,
  animClipsSdkLua,
  animatedObjects,
  anyPostFxEnabled,
  appendLuaCode,
  applyLookSettings,
  applyQualityToPostFx,
  applyRenderCaps,
  armDebugBlock,
  armSaveBlock,
  breakableLine,
  browserDeviceHints,
  browserSpeaker,
  buildBillboardInstance,
  buildClipTable,
  buildOrbitCamera,
  buildShadowInstance,
  buildTerrainInstances,
  buildWorldCamera,
  cameraAt,
  capTextures,
  capTriangles,
  capsConstrainScene,
  cellAt,
  clipFrameIndex,
  codeChunks,
  codeLineOffset,
  collisionSdkLua,
  commandRingAddress,
  commandRingBytes,
  commandRingMax,
  commandsPerTick,
  compileAnimator,
  componentsSdkLua,
  composeParallax,
  composeWorldMatrix,
  compositeOverBackdrop,
  createCartSpriteSource,
  createConsole,
  createFlatMaterial,
  createLightingLayer,
  createSceneRenderer,
  createTextureBudgetCache,
  deadZoned,
  debugBlockAddress,
  debugPostlude,
  debugSdkLua,
  decodeCamera,
  decodeLights,
  decodeMailbox,
  decodeMeshCamera,
  decodeMeshPoses,
  decodeWorldLights,
  defaultPostFxSettings,
  detectQuality,
  deterministicBackend,
  drift,
  effectiveBreakpoints,
  emitterPreset,
  errorStack,
  estimateSceneBytes,
  evaluate,
  extractScore,
  extractUnlocks,
  fillSky,
  fitShape,
  fitTextureToBudget,
  flagsSdkLua,
  flicker,
  frameDurationMs,
  framebufferBytes,
  getModel,
  getWebgpuDevice,
  hasCommandRing,
  hashCart,
  hashEventId,
  hexToRgb01,
  injectSdk,
  inputBlockAddress,
  instrumentLua,
  interleaveVertices,
  interpolateNormal,
  jointFrames,
  lensFlareAt,
  loadEngineModule,
  makeShadowTexture,
  mount,
  nearestDirection,
  netSendInterval,
  normalBasis3x3,
  normalVector,
  orbitPitchAboveTerrain,
  packLights,
  paramKey,
  parseAnim,
  parseCollisionField,
  parseControlSettings,
  parseFlagsField,
  parseMeshScene,
  parseParticles,
  parsePauseInfo,
  parsePostFxSettings,
  parseReplay,
  parseScene,
  parseWorldScene,
  physicsBlockAddress,
  physicsSdkLua,
  physicsSlots,
  physicsStateHash,
  playLanguage,
  prehazeLayers,
  prependLuaCode,
  pulse,
  pyramidLevelCount,
  pyramidLevelSize,
  randomSeed,
  rasterStyleFor,
  readCartCode,
  readPad,
  readPause,
  readSidecarActions,
  readSidecarUi,
  reflectionFade,
  reflectionSampleY,
  remapErrorLines,
  renderSceneBackdrop,
  resolveButton,
  resolveLight,
  resolvePbr,
  resolveQuality,
  resolveSceneLayers,
  resolveSupersample,
  resolveUnlockedAchievements,
  rewriteLuaCode,
  runReplayEvents,
  runtimeSdkLua,
  sampleClipFrame,
  sampleNormalBilinear,
  sampleScalarBilinear,
  sampleTrack,
  saveBlockAddress,
  saveBlockBytes,
  saveCapacity,
  saveSdkLua,
  sceneHasAnimation,
  sceneHasPhysics,
  sceneNeedsRuntime,
  sceneObjectsSdkLua,
  seedCartridge,
  sendDebugCommand,
  serializeReplay,
  shade,
  simulateEmitter,
  softKneePrefilter,
  splitWorldMatrix,
  standardizePad,
  streamGroups,
  stringsSdkLua,
  sway,
  takeNetOutbox,
  takePhysicsCommands,
  takeRingCommands,
  takeSave,
  tiltShiftBlur,
  tokenizeLua,
  uiSdkLua,
  uniformsFromSettings,
  unpadRows,
  validSave,
  verifyReplayScore,
  viewDirection,
  webgpuCanHonour,
  worldCenter,
  writeBreakpoints,
  writeInputBlock,
  writeInputSettings,
  writeInstanceTransform,
  writeInstanceUniform,
  writeNetInbox,
  writePhysicsState,
  writeWatches
};
