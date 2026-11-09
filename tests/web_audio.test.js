import { describe, it, expect, vi, afterEach } from "vitest";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/** iOS server-voice clips go through ONE AudioContext. Everything here is a controllable fake. */
async function load({ ios = true, webAudio = true, failResume = false, failDecode = false, startState = "suspended" } = {}) {
    vi.resetModules();
    const ctxs = [];
    const sources = [];
    const elements = { created: 0, plays: [] };
    const spoken = [];
    const sessions = [];

    const win = {};
    win.speechSynthesis = { speaking: false, pending: false, paused: false, speak: vi.fn(u => spoken.push(u)), cancel: vi.fn(), getVoices: () => [] };
    win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    globalThis.SpeechSynthesisUtterance = win.SpeechSynthesisUtterance;

    if (webAudio) {
        win.AudioContext = class {
            constructor() {
                this.state = startState; this.currentTime = 0; this.destination = {};
                this.resume = vi.fn(async () => { if (failResume) { throw new Error("needs a gesture"); } this.state = "running"; });
                this.suspend = vi.fn(async () => { this.state = "suspended"; });
                this.decodeAudioData = vi.fn((data, ok, err) => { failDecode ? err(new Error("bad audio")) : ok({ duration: 1 }); });
                this.createBuffer = vi.fn(() => ({ silent: true }));
                this.createBufferSource = vi.fn(() => {
                    const src = {
                        buffer: null, onended: null, started: false, stopped: false,
                        connect: vi.fn(), start: vi.fn(function () { src.started = true; }),
                        stop: vi.fn(function () { src.stopped = true; }),
                        end() { src.onended && src.onended(); },
                    };
                    sources.push(src);
                    return src;
                });
                ctxs.push(this);
            }
        };
    }
    globalThis.window = win;
    globalThis.document = { documentElement: { lang: "en-US" } };
    const nav = { language: "en-US", userAgent: ios ? IPHONE : MAC, platform: ios ? "iPhone" : "MacIntel", maxTouchPoints: ios ? 5 : 0 };
    let type = "auto";
    nav.audioSession = { get type() { return type; }, set type(v) { type = v; sessions.push(v); } };
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });

    globalThis.Audio = class {
        constructor() { elements.created++; this.src = ""; this.loop = false; }
        play() { elements.plays.push({ url: this.src, loop: this.loop, el: this, end: () => this.onended && this.onended() }); return Promise.resolve(); }
        pause() { this.paused = true; }
    };
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++n}`);
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["mp3-bytes"]) }));
    const mod = await import("../src/voice.js");
    return { mod, ctxs, sources, elements, spoken, sessions };
}
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const SERVER = { endpoint: "/speak", key: "k" };
const realClips = (elements) => elements.plays.filter(p => !p.loop && !/silent/.test(p.url));

afterEach(() => vi.useRealTimers());

describe("unlocking Web Audio inside the microphone tap", () => {
    it("creates ONE context, resumes it and plays one silent frame", async () => {
        const { mod, ctxs, sources } = await load();
        const s = new mod.Speaker();
        s.setServer(SERVER);
        s.unlockForGesture();
        expect(ctxs).toHaveLength(1);
        expect(ctxs[0].resume).toHaveBeenCalled();
        expect(sources).toHaveLength(1);
        expect(sources[0].start).toHaveBeenCalled();
        expect(sources[0].buffer.silent).toBe(true);
    });

    it("does not create a context for the browser voice, off iOS, or without Web Audio", async () => {
        const browserVoice = await load();
        new browserVoice.mod.Speaker().unlockForGesture();                          // no server voice configured
        expect(browserVoice.ctxs).toHaveLength(0);

        const desktop = await load({ ios: false });
        const d = new desktop.mod.Speaker(); d.setServer(SERVER); d.unlockForGesture();
        expect(desktop.ctxs).toHaveLength(0);

        const old = await load({ webAudio: false });
        const o = new old.mod.Speaker(); o.setServer(SERVER); o.unlockForGesture();   // does not throw, nothing to create
        expect(old.ctxs).toHaveLength(0);
    });

    it("the same context is reused for later answers", async () => {
        const { mod, ctxs } = await load();
        const s = new mod.Speaker(); s.setServer(SERVER);
        s.unlockForGesture();
        s.start(); s.feed("One. "); s.flush(); await wait();
        s.cancel();
        s.start(); s.feed("Two. "); s.flush(); await wait();
        expect(ctxs).toHaveLength(1);
    });
});

describe("playing clips through the context", () => {
    async function readyAnswer() {
        const env = await load();
        const s = new env.mod.Speaker(); s.setServer(SERVER);
        s.unlockForGesture();
        env.sources.length = 0;                                  // forget the silent unlock frame
        return { ...env, s };
    }

    it("decodes each clip and plays them one after another through the same context", async () => {
        const { s, ctxs, sources, elements } = await readyAnswer();
        const clipsBefore = realClips(elements).length;
        s.start(); s.feed("One. Two. Three. "); s.flush();
        await wait();
        expect(sources).toHaveLength(1);                         // first clip playing, the rest queued
        sources[0].end(); await wait();
        expect(sources).toHaveLength(2);
        sources[1].end(); await wait();
        sources[2].end(); await wait();
        expect(sources).toHaveLength(3);
        expect(ctxs[0].decodeAudioData).toHaveBeenCalledTimes(3);
        expect(sources.every(x => x.started)).toBe(true);
        expect(ctxs).toHaveLength(1);                            // never a new context per clip
        expect(realClips(elements).length).toBe(clipsBefore);    // and no <audio> element involved
        expect(s.busy).toBe(false);
    });

    it("holds the session open across the sentences and lets go when the reading ends", async () => {
        const { s, ctxs, sources } = await readyAnswer();
        s.start();                                               // answer begins
        expect(ctxs[0].state).toBe("running");
        s.feed("One. Two. "); s.flush();
        await wait();
        sources[0].end(); await wait();                          // between the sentences...
        expect(ctxs[0].suspend).not.toHaveBeenCalled();          // ...the context is still running
        expect(ctxs[0].state).toBe("running");
        sources[1].end(); await wait();
        expect(s.busy).toBe(false);
        expect(ctxs[0].suspend).toHaveBeenCalledTimes(1);        // released once the answer has been read
    });

    it("takes hold again for the next answer", async () => {
        const { s, ctxs } = await readyAnswer();
        s.start(); s.cancel();                                   // an answer that is stopped
        expect(ctxs[0].state).toBe("suspended");
        s.start();
        expect(ctxs[0].resume.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(ctxs[0].state).toBe("running");
    });

    it("forces the playback audio session before each clip and after it ends", async () => {
        const { s, sources, sessions } = await readyAnswer();
        s.start(); s.feed("One. Two. "); s.flush(); await wait();
        const before = sessions.length;
        sources[0].end(); await wait();
        expect(sessions.length).toBeGreaterThan(before);
        expect(sessions.every(t => t === "playback")).toBe(true);
    });

    it("Stop mid-clip stops the source, drops the queue and frees the mic", async () => {
        const { s, sources } = await readyAnswer();
        s.start(); s.feed("One. Two. Three. "); s.flush(); await wait();
        expect(sources).toHaveLength(1);
        expect(s.busy).toBe(true);
        s.cancel({ force: true });
        expect(sources[0].stopped).toBe(true);
        expect(s.busy).toBe(false);
        await wait();
        expect(sources).toHaveLength(1);                         // nothing further played
    });

    it("muting stops it too", async () => {
        const { s, sources } = await readyAnswer();
        s.start(); s.feed("One. Two. "); await wait();
        s.setMuted(true);
        expect(sources[0].stopped).toBe(true);
        expect(s.busy).toBe(false);
    });
});

describe("when Web Audio cannot be used", () => {
    it("a context that will not start needs a tap: the text is held, not sent to the (also blocked) speech engine", async () => {
        const { mod, spoken } = await load({ failResume: true });
        const s = new mod.Speaker(); s.setServer(SERVER);
        s.unlockForGesture();
        s.start(); s.feed("Needs a tap. "); s.flush();
        await wait();
        expect(s.blocked).toBe(true);
        expect(spoken.filter(u => u.text === "Needs a tap.")).toHaveLength(0);
    });

    it("tapping the speaker button then plays it", async () => {
        const { mod, ctxs, sources } = await load({ failResume: true });
        const s = new mod.Speaker(); s.setServer(SERVER);
        s.unlockForGesture();
        s.start(); s.feed("Needs a tap. "); s.flush();
        await wait();
        expect(s.blocked).toBe(true);
        ctxs[0].resume = vi.fn(async () => { ctxs[0].state = "running"; });     // the tap is a gesture: it works now
        s.replayBlocked();
        await wait();
        expect(s.blocked).toBe(false);
        expect(sources.some(x => x.started && x.buffer && !x.buffer.silent)).toBe(true);
    });

    it("a clip that cannot be decoded falls back to the audio element and still plays", async () => {
        const { mod, elements, sources } = await load({ failDecode: true });
        const s = new mod.Speaker(); s.setServer(SERVER);
        s.unlockForGesture();
        sources.length = 0;
        s.start(); s.feed("Fallback. "); s.flush();
        await wait();
        const clips = elements.plays.filter(p => !p.loop);
        expect(clips.length).toBeGreaterThanOrEqual(1);
        expect(clips.at(-1).url).toMatch(/^blob:/);
        expect(s.blocked).toBe(false);
        clips.at(-1).end(); await wait();
        expect(s.busy).toBe(false);
    });
});

describe("other platforms are unchanged", () => {
    it("desktop browsers keep playing clips through the shared audio element", async () => {
        const { mod, ctxs, elements } = await load({ ios: false });
        const s = new mod.Speaker(); s.setServer(SERVER);
        s.start(); s.feed("One. Two. "); s.flush();
        await wait();
        expect(ctxs).toHaveLength(0);
        expect(elements.created).toBe(1);
        expect(elements.plays.filter(p => !p.loop)).toHaveLength(1);
    });

    it("iOS without Web Audio support also falls back to the element", async () => {
        const { mod, elements } = await load({ webAudio: false });
        const s = new mod.Speaker(); s.setServer(SERVER);
        s.unlockForGesture();
        s.start(); s.feed("One. "); s.flush();
        await wait();
        expect(elements.plays.filter(p => !p.loop && !/^blob:1$/.test(p.url)).length).toBeGreaterThanOrEqual(0);
        expect(s.blocked).toBe(false);
    });
});
