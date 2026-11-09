import { describe, it, expect, vi, afterEach } from "vitest";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

let recognizers;

async function load({ ua = MAC, platform = "MacIntel", touch = 0, audioSession = true, voices = [], synthesis = true } = {}) {
    vi.resetModules();
    const spoken = [];
    const plays = [];
    const created = { audio: 0 };
    const win = {};
    if (synthesis) {
        win.speechSynthesis = {
            speaking: false, pending: false, paused: false,
            speak: vi.fn(u => { spoken.push(u); }),
            cancel: vi.fn(),
            resume: vi.fn(function () { win.speechSynthesis.paused = false; }),
            getVoices: () => voices,
        };
        win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
        globalThis.SpeechSynthesisUtterance = win.SpeechSynthesisUtterance;
    }
    recognizers = [];
    win.SpeechRecognition = class {
        constructor() { recognizers.push(this); this.start = vi.fn(() => this.onstart && this.onstart()); this.stop = vi.fn(); this.abort = vi.fn(); }
    };
    win.MediaRecorder = class {
        static isTypeSupported() { return true; }
        constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
        start() { this.state = "recording"; }
        stop() { this.state = "inactive"; this.onstop && this.onstop(); }
    };
    globalThis.window = win;
    globalThis.document = { documentElement: { lang: "en-US" } };
    const track = { stop: vi.fn() };
    const nav = { language: "en-US", userAgent: ua, platform, maxTouchPoints: touch,
        mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } };
    const sessions = [];
    if (audioSession) {
        let type = "auto";
        nav.audioSession = { get type() { return type; }, set type(v) { type = v; sessions.push(v); } };
    }
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
    globalThis.Audio = class {
        constructor() { created.audio++; this.src = ""; this.paused = false; }
        play() {
            const el = this;
            plays.push({ url: this.src, end: () => el.onended && el.onended() });
            if (Audio.reject) return Promise.reject(Object.assign(new Error("not allowed"), { name: Audio.reject }));
            return Promise.resolve();
        }
        pause() { this.paused = true; }
    };
    Audio.reject = null;
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++n}`);
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["mp3"]) }));
    const mod = await import("../src/voice.js");
    return { mod, spoken, plays, created, sessions, track, win };
}
const micro = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));
afterEach(() => { vi.useRealTimers(); });

describe("platform detection", () => {
    it("recognises iPhone and iPad", async () => {
        expect((await load({ ua: IPHONE, platform: "iPhone", touch: 5 })).mod.isIOSLike()).toBe(true);
    });
    it("recognises iPadOS in desktop mode (a Mac with a touch screen)", async () => {
        expect((await load({ ua: MAC, platform: "MacIntel", touch: 5 })).mod.isIOSLike()).toBe(true);
    });
    it("a real Mac is not iOS", async () => {
        expect((await load({ ua: MAC, platform: "MacIntel", touch: 0 })).mod.isIOSLike()).toBe(false);
    });
});

describe("audio session (restores full volume after the microphone has been used)", () => {
    it("switches to playback when a spoken answer begins", async () => {
        const { mod, sessions } = await load();
        const s = new mod.Speaker();
        s.start();
        expect(sessions).toEqual(["playback"]);
    });

    it("is requested again before each sentence and clip, but only changes when needed", async () => {
        const { mod, sessions } = await load();
        const s = new mod.Speaker();
        s.start(); s.feed("One. Two. Three. ");
        expect(sessions).toEqual(["playback"]);                 // already playback: no redundant writes
    });

    it("uses play-and-record while the microphone is recording and goes back to playback afterwards", async () => {
        const { mod, sessions, track } = await load();
        mod.setAudioSession("playback");
        sessions.length = 0;
        const d = new mod.ServerDictation({ endpoint: "/x", key: "k" });
        await d.start();
        expect(sessions).toEqual(["play-and-record"]);
        d.abort();
        await wait();
        expect(track.stop).toHaveBeenCalled();
        expect(sessions).toEqual(["play-and-record", "playback"]);
    });

    it("is a harmless no-op where the API does not exist", async () => {
        const { mod } = await load({ audioSession: false });
        expect(() => { mod.setAudioSession("playback"); new mod.Speaker().start(); }).not.toThrow();
    });

    it("swallows errors from the API", async () => {
        const { mod } = await load();
        Object.defineProperty(navigator, "audioSession", { value: { type: "auto", set type(v) { throw new Error("denied"); } }, configurable: true });
        expect(() => mod.setAudioSession("playback")).not.toThrow();
    });
});

describe("browser voice hardening", () => {
    it("sets volume, rate and pitch explicitly and keeps the utterance referenced until it ends", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.start(); s.feed("Hello there. ");
        const u = spoken[0];
        expect([u.volume, u.rate, u.pitch]).toEqual([1, 1, 1]);
        expect(s._utterances.has(u)).toBe(true);
        u.onend(); await micro();
        expect(s._utterances.has(u)).toBe(false);
    });

    it("picks the best matching local voice for the page language", async () => {
        const voices = [
            { name: "French", lang: "fr-FR", localService: true },
            { name: "US remote", lang: "en-US", localService: false },
            { name: "US local", lang: "en-US", localService: true },
            { name: "UK local", lang: "en-GB", localService: true },
        ];
        const { mod, spoken } = await load({ voices });
        const s = new mod.Speaker({ lang: "en-US" });
        s.start(); s.feed("Hello there. ");
        expect(spoken[0].voice.name).toBe("US local");
    });

    it("falls back to another voice for the same language, and to the default when nothing matches", async () => {
        const gb = await load({ voices: [{ name: "UK", lang: "en-GB", localService: true }] });
        const s1 = new gb.mod.Speaker({ lang: "en-US" });
        s1.start(); s1.feed("Hello there. ");
        expect(gb.spoken[0].voice.name).toBe("UK");

        const none = await load({ voices: [{ name: "French", lang: "fr-FR", localService: true }] });
        const s2 = new none.mod.Speaker({ lang: "en-US" });
        s2.start(); s2.feed("Hello there. ");
        expect(none.spoken[0].voice).toBeUndefined();            // let the browser choose
    });

    it("works before the browser has loaded its voice list", async () => {
        const { mod, spoken } = await load({ voices: [] });
        const s = new mod.Speaker();
        s.start(); s.feed("Hello there. ");
        expect(spoken).toHaveLength(1);
    });

    it("resumes a paused speech engine before speaking (iOS can be left paused)", async () => {
        const { mod, win } = await load();
        win.speechSynthesis.paused = true;
        const s = new mod.Speaker();
        s.start(); s.feed("Hello there. ");
        expect(win.speechSynthesis.resume).toHaveBeenCalledTimes(1);
    });
});

describe("unlocking audio inside a tap (iOS only lets speech start from one)", () => {
    it("on iOS the tap primes speech and plays a silent clip through the shared element", async () => {
        const { mod, spoken, plays } = await load({ ua: IPHONE, platform: "iPhone", touch: 5 });
        const s = new mod.Speaker();
        s.unlockForGesture();
        expect(spoken).toHaveLength(1);
        expect(spoken[0].text).toBe("");
        expect(spoken[0].volume).toBe(0);                       // silent
        expect(plays).toHaveLength(1);
        expect(plays[0].url).toMatch(/^blob:/);
    });

    it("elsewhere it does nothing (on desktop Safari speaking while recognition starts aborts the recognition)", async () => {
        const { mod, spoken, plays } = await load();
        new mod.Speaker().unlockForGesture();
        expect(spoken).toHaveLength(0);
        expect(plays).toHaveLength(0);
    });

    it("unlocks once, unless forced", async () => {
        const { mod, spoken } = await load({ ua: IPHONE, platform: "iPhone", touch: 5 });
        const s = new mod.Speaker();
        s.unlockForGesture(); s.unlockForGesture();
        expect(spoken).toHaveLength(1);
        s.unlock(true);
        expect(spoken).toHaveLength(2);
    });

    it("the silent clip is released after it has played", async () => {
        const { mod } = await load({ ua: IPHONE, platform: "iPhone", touch: 5 });
        new mod.Speaker().unlockForGesture();
        await micro();
        expect(URL.revokeObjectURL).toHaveBeenCalled();
    });
});

describe("server voice uses one shared, unlocked audio element", () => {
    it("creates a single Audio element for the whole answer, and for later answers", async () => {
        const { mod, plays, created } = await load();
        const s = new mod.Speaker();
        s.setServer({ endpoint: "/speak", key: "k" });
        s.start(); s.feed("One. Two. Three. "); s.flush();
        await wait();
        plays[0].end(); await wait();
        plays[1].end(); await wait();
        plays[2].end(); await wait();
        expect(plays).toHaveLength(3);
        expect(created.audio).toBe(1);

        s.start(); s.feed("A second answer. "); s.flush();       // after cancel() as well
        await wait();
        expect(created.audio).toBe(1);
    });

    it("the unlocked element is the one that later plays the clips", async () => {
        const { mod, plays, created } = await load({ ua: IPHONE, platform: "iPhone", touch: 5 });
        const s = new mod.Speaker();
        s.setServer({ endpoint: "/speak", key: "k" });
        s.unlockForGesture();                                    // the mic tap
        s.start(); s.feed("An answer. "); s.flush();
        await wait();
        expect(created.audio).toBe(1);                           // not a fresh, locked element per clip
        expect(plays).toHaveLength(2);                           // silent unlock clip + the real clip
    });
});

describe("when the browser refuses to speak without a tap", () => {
    it("remembers the text, tells the page, and replays it on the next tap", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        const events = [];
        s.onBlockedChange = (b) => events.push(b);
        s.start(); s.feed("First sentence. Second sentence. ");
        spoken[0].onerror({ error: "not-allowed" });
        spoken[1].onerror({ error: "not-allowed" });
        await micro();
        expect(s.blocked).toBe(true);
        expect(events).toEqual([true]);                          // reported once
        const before = spoken.length;
        s.replayBlocked();                                       // the visitor taps the speaker button
        expect(s.blocked).toBe(false);
        expect(events).toEqual([true, false]);
        const replayed = spoken.slice(before);
        expect(replayed[0].text).toBe("");                       // the silent unlock that the tap performs
        expect(replayed[0].volume).toBe(0);
        expect(replayed.slice(1).map(u => u.text)).toEqual(["First sentence.", "Second sentence."]);
    });

    it("normal interruptions are not treated as a block", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.start(); s.feed("One. ");
        spoken[0].onerror({ error: "interrupted" });
        spoken[0].onerror({ error: "canceled" });
        expect(s.blocked).toBe(false);
    });

    it("a refused audio clip is held for a tap instead of falling back to speech (which would be refused too)", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.setServer({ endpoint: "/speak", key: "k" });
        Audio.reject = "NotAllowedError";
        s.start(); s.feed("Needs a tap. "); s.flush();
        await wait();
        expect(s.blocked).toBe(true);
        expect(spoken.filter(u => u.text === "Needs a tap.")).toHaveLength(0);
        Audio.reject = null;
        s.replayBlocked();
        await wait();
        expect(s.blocked).toBe(false);
    });

    it("other playback failures still fall back to the browser voice", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.setServer({ endpoint: "/speak", key: "k" });
        Audio.reject = "EncodingError";
        s.start(); s.feed("Falls back. "); s.flush();
        await wait();
        expect(s.blocked).toBe(false);
        expect(spoken.map(u => u.text)).toContain("Falls back.");
    });

    it("starting a new answer clears the blocked state", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        const events = [];
        s.onBlockedChange = (b) => events.push(b);
        s.start(); s.feed("One. ");
        spoken[0].onerror({ error: "not-allowed" });
        s.start();
        expect(s.blocked).toBe(false);
        expect(events).toEqual([true, false]);
    });
});

describe("recognition aborted right after it starts (Safari)", () => {
    it("is retried once, silently", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const cb = { onEnd: vi.fn(), onError: vi.fn(), onStart: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        recognizers[0].onerror({ error: "aborted" });
        recognizers[0].onend();
        expect(cb.onEnd).not.toHaveBeenCalled();                 // no flicker, no "didn't catch that"
        expect(cb.onError).not.toHaveBeenCalled();
        vi.advanceTimersByTime(400);
        expect(recognizers).toHaveLength(2);                     // a second attempt
        expect(recognizers[1].start).toHaveBeenCalled();
    });

    it("only once: a second abort ends normally", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const cb = { onEnd: vi.fn(), onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        recognizers[0].onerror({ error: "aborted" }); recognizers[0].onend();
        vi.advanceTimersByTime(400);
        recognizers[1].onerror({ error: "aborted" }); recognizers[1].onend();
        vi.advanceTimersByTime(2000);
        expect(recognizers).toHaveLength(2);
        expect(cb.onEnd).toHaveBeenCalledTimes(1);
    });

    it("never retries a deliberate abort", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const d = new mod.Dictation({});
        d.start();
        d.abort();
        recognizers[0].onerror({ error: "aborted" }); recognizers[0].onend();
        vi.advanceTimersByTime(2000);
        expect(recognizers).toHaveLength(1);
    });

    it("never retries once something was heard, or when the abort comes late", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const d = new mod.Dictation({});
        d.start();
        vi.advanceTimersByTime(3000);                            // not "right after starting"
        recognizers[0].onerror({ error: "aborted" }); recognizers[0].onend();
        vi.advanceTimersByTime(2000);
        expect(recognizers).toHaveLength(1);
    });

    it("a fresh manual start gets its own retry again", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const d = new mod.Dictation({});
        d.start();
        recognizers[0].onerror({ error: "aborted" }); recognizers[0].onend();
        vi.advanceTimersByTime(400);
        recognizers[1].onend();                                  // ends normally
        d.start();
        recognizers[2].onerror({ error: "aborted" }); recognizers[2].onend();
        vi.advanceTimersByTime(400);
        expect(recognizers).toHaveLength(4);
    });
});
