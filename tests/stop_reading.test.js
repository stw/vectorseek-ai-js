import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// speechSynthesis stub where the test decides when each utterance finishes.
async function load({ synthesis = true } = {}) {
    vi.resetModules();
    const utterances = [];
    const win = {};
    if (synthesis) {
        win.speechSynthesis = {
            speaking: false, pending: false,
            speak: vi.fn(u => utterances.push(u)),
            cancel: vi.fn(),
        };
        win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
        globalThis.SpeechSynthesisUtterance = win.SpeechSynthesisUtterance;
    }
    globalThis.window = win;
    globalThis.document = { documentElement: { lang: "en-US" } };
    Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });
    const mod = await import("../src/voice.js");
    return { mod, utterances };
}

afterEach(() => vi.useRealTimers());

// let the promise callbacks that follow an utterance "end" event run
const micro = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe("Speaker.busy (browser voice)", () => {
    it("is busy from the start of a voice answer until the last sentence has been read", async () => {
        const { mod, utterances } = await load();
        const events = [];
        const s = new mod.Speaker();
        s.onBusyChange = b => events.push(b);

        expect(s.busy).toBe(false);
        s.start();                                  // answer is being generated
        expect(s.busy).toBe(true);
        s.feed("First sentence. Second sentence. ");
        s.flush();                                  // stream finished, speech still queued
        expect(s.busy).toBe(true);

        utterances[0].onend();
        await micro();
        expect(s.busy).toBe(true);                  // one left
        utterances[1].onend();
        await micro();
        expect(s.busy).toBe(false);
        expect(events).toEqual([true, false]);      // fires on change only
    });

    it("typed queries are never busy", async () => {
        const { mod } = await load();
        const events = [];
        const s = new mod.Speaker();
        s.onBusyChange = b => events.push(b);
        s.feed("Hello there. ");
        s.flush();
        expect(s.busy).toBe(false);
        expect(events).toEqual([]);
    });

    it("cancel (the Stop button) ends busy immediately, even mid-speech", async () => {
        const { mod, utterances } = await load();
        const events = [];
        const s = new mod.Speaker();
        s.onBusyChange = b => events.push(b);
        s.start();
        s.feed("One. Two. Three. ");
        expect(utterances).toHaveLength(3);
        s.cancel();
        expect(s.busy).toBe(false);
        expect(events).toEqual([true, false]);
    });

    it("late 'end' events from cancelled speech do not corrupt the next answer", async () => {
        const { mod, utterances } = await load();
        const s = new mod.Speaker();
        s.start();
        s.feed("Old one. ");
        const old = utterances[0];
        s.cancel();

        s.start();
        s.feed("New one. ");
        old.onend();                                // stale event arrives late
        expect(s.busy).toBe(true);                  // the new answer is still being read
        utterances[1].onend();
        await micro();
        s.flush();
        expect(s.busy).toBe(false);
    });

    it("is never busy while muted, and muting stops it", async () => {
        const { mod } = await load();
        const events = [];
        const s = new mod.Speaker();
        s.onBusyChange = b => events.push(b);
        s.start();
        expect(s.busy).toBe(true);
        s.setMuted(true);
        expect(s.busy).toBe(false);
        s.start();
        expect(s.busy).toBe(false);
        expect(events).toEqual([true, false]);
    });

    it("a missing 'end' event cannot leave it busy forever", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const s = new mod.Speaker();
        s.start();
        s.feed("Never finishes. ");
        s.flush();
        expect(s.busy).toBe(true);
        vi.advanceTimersByTime(20000);              // utterance watchdog
        await Promise.resolve();
        expect(s.busy).toBe(false);
    });

    it("an answer with no end-of-stream marker is treated as finished after the idle timeout", async () => {
        vi.useFakeTimers();
        const { mod, utterances } = await load();
        const s = new mod.Speaker();
        s.start();
        s.feed("Query limit reached. ");            // no flush() ever arrives
        utterances[0].onend();
        await micro();
        expect(s.busy).toBe(true);                  // still "streaming" as far as we know
        vi.advanceTimersByTime(s.idleMs + 10);
        expect(s.busy).toBe(false);
    });

    it("new text keeps resetting the idle timeout", async () => {
        vi.useFakeTimers();
        const { mod } = await load();
        const s = new mod.Speaker();
        s.start();
        vi.advanceTimersByTime(s.idleMs - 1000);
        s.feed("Still going");
        vi.advanceTimersByTime(s.idleMs - 1000);
        expect(s.active).toBe(true);
    });
});

describe("Speaker.busy (server voice)", () => {
    beforeEach(() => {
        globalThis.Audio = class {
            constructor() { this.src = ""; this.paused = false; }
            play() {
                this.paused = false;
                const el = this;
                Audio.all.push({ url: this.src, get paused() { return el.paused; }, onended: () => el.onended && el.onended() });
                return Promise.resolve();
            }
            pause() { this.paused = true; }
        };
        Audio.all = [];
        URL.createObjectURL = vi.fn(() => "blob:x");
        URL.revokeObjectURL = vi.fn();
        globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) }));
    });
    const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

    it("is busy until every queued clip has played", async () => {
        const { mod } = await load();
        const s = new mod.Speaker();
        s.setServer({ endpoint: "/speak", key: "k" });
        const events = [];
        s.onBusyChange = b => events.push(b);
        s.start();
        s.feed("One. Two. ");
        s.flush();
        await wait();
        expect(s.busy).toBe(true);                  // first clip "playing"
        Audio.all[0].onended();
        await wait();
        expect(s.busy).toBe(true);
        Audio.all[1].onended();
        await wait();
        expect(s.busy).toBe(false);
        expect(events).toEqual([true, false]);
    });

    it("Stop mid-clip frees it and drops the queue", async () => {
        const { mod } = await load();
        const s = new mod.Speaker();
        s.setServer({ endpoint: "/speak", key: "k" });
        s.start();
        s.feed("One. Two. Three. ");
        await wait();
        expect(s.busy).toBe(true);
        s.cancel();
        expect(s.busy).toBe(false);
        await wait();
        expect(Audio.all).toHaveLength(1);          // nothing further played
        expect(s.busy).toBe(false);
    });
});
