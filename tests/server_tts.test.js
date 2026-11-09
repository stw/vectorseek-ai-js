import { describe, it, expect, vi } from "vitest";

// Stubs: speechSynthesis (instant), Audio (controllable), fetch, URL blob helpers.
async function load({ synthesis = true } = {}) {
    vi.resetModules();
    const spoken = [];
    const audios = [];
    const win = {};
    if (synthesis) {
        win.speechSynthesis = {
            speaking: false, pending: false,
            speak: vi.fn(u => { spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 0); }),
            cancel: vi.fn(),
        };
        win.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
        globalThis.SpeechSynthesisUtterance = win.SpeechSynthesisUtterance;
    }
    globalThis.window = win;
    globalThis.document = { documentElement: { lang: "en-US" } };
    Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });
    // ONE shared element is reused for every clip (that is what keeps it unlocked on iOS); `audios` records
    // each clip that is played through it.
    globalThis.Audio = class {
        constructor() { this.src = ""; this.paused = false; }
        play() {
            this.paused = false;
            const el = this;
            audios.push({ url: this.src, get paused() { return el.paused; }, onended: () => el.onended && el.onended() });
            if (Audio.reject) return Promise.reject(Object.assign(new Error("blocked"), { name: Audio.rejectName || "Error" }));
            if (Audio.autoEnd) setTimeout(() => this.onended && this.onended(), 0);
            return Promise.resolve();
        }
        pause() { this.paused = true; }
    };
    Audio.autoEnd = true;
    Audio.reject = false;
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:${++n}`);
    URL.revokeObjectURL = vi.fn();
    const mod = await import("../src/voice.js");
    return { mod, spoken, audios, win };
}

const okAudio = () => ({ ok: true, status: 200, blob: async () => new Blob(["mp3"]) });
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const server = { endpoint: "/api/voice/speak", key: "k1" };

describe("Speaker with a server voice", () => {
    it("fetches each sentence with the project key and plays them in order", async () => {
        const { mod, audios } = await load();
        const fetchMock = vi.fn(async () => okAudio());
        globalThis.fetch = fetchMock;
        const s = new mod.Speaker();
        s.setServer(server);
        s.start();
        s.feed("First one. Second one. ");
        s.flush();
        await wait();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const body = fetchMock.mock.calls[0][1].body;
        expect(fetchMock.mock.calls[0][0]).toBe("/api/voice/speak");
        expect(body.get("key")).toBe("k1");
        expect(body.get("text")).toBe("First one.");
        expect(fetchMock.mock.calls[1][1].body.get("text")).toBe("Second one.");
        expect(audios.map(a => a.url)).toEqual(["blob:1", "blob:2"]);
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    });

    it("does not use the browser voice when the server voice works", async () => {
        const { mod, spoken } = await load();
        globalThis.fetch = vi.fn(async () => okAudio());
        const s = new mod.Speaker();
        s.setServer(server);
        s.start();
        s.feed("Hello there. ");
        await wait();
        expect(spoken).toHaveLength(0);
    });

    it("falls back to the browser voice when the request fails", async () => {
        const { mod, spoken } = await load();
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502 }));
        const s = new mod.Speaker();
        s.setServer(server);
        s.start();
        s.feed("Hello there. ");
        await wait();
        expect(spoken).toEqual(["Hello there."]);
    });

    it("falls back when the network throws", async () => {
        const { mod, spoken } = await load();
        globalThis.fetch = vi.fn(async () => { throw new Error("offline"); });
        const s = new mod.Speaker();
        s.setServer(server);
        s.start();
        s.feed("Hello there. ");
        await wait();
        expect(spoken).toEqual(["Hello there."]);
    });

    it("falls back when audio playback is blocked (autoplay)", async () => {
        const { mod, spoken } = await load();
        globalThis.fetch = vi.fn(async () => okAudio());
        const s = new mod.Speaker();
        s.setServer(server);
        Audio.reject = true;
        s.start();
        s.feed("Hello there. ");
        await wait();
        expect(spoken).toEqual(["Hello there."]);
    });

    it("works without browser speechSynthesis when a server voice is set", async () => {
        const { mod, audios } = await load({ synthesis: false });
        globalThis.fetch = vi.fn(async () => okAudio());
        const s = new mod.Speaker();
        expect(s.supported).toBe(false);
        s.setServer(server);
        expect(s.supported).toBe(true);
        s.start();
        s.feed("Hello there. ");
        await wait();
        expect(audios).toHaveLength(1);
    });

    it("cancel stops current audio, drops the queue and allows new speech afterwards", async () => {
        const { mod, audios } = await load();
        globalThis.fetch = vi.fn(async () => okAudio());
        const s = new mod.Speaker();
        s.setServer(server);
        Audio.autoEnd = false;                 // first clip "plays" until cancelled
        s.start();
        s.feed("One. Two. Three. ");
        await wait();
        expect(audios).toHaveLength(1);        // only the first is playing; others queued
        s.cancel();
        expect(audios[0].paused).toBe(true);
        await wait();
        expect(audios).toHaveLength(1);        // queue was dropped

        Audio.autoEnd = true;                  // pump must not be stuck
        s.start();
        s.feed("Again. ");
        await wait();
        expect(audios).toHaveLength(2);
    });

    it("muting stops audio and silences further speech", async () => {
        const { mod, audios } = await load();
        globalThis.fetch = vi.fn(async () => okAudio());
        const s = new mod.Speaker();
        s.setServer(server);
        Audio.autoEnd = false;
        s.start();
        s.feed("One. ");
        await wait();
        s.setMuted(true);
        expect(audios[0].paused).toBe(true);
        s.feed("Two. ");
        await wait();
        expect(audios).toHaveLength(1);
    });

    it("clearing the server returns to the browser voice", async () => {
        const { mod, spoken } = await load();
        globalThis.fetch = vi.fn(async () => okAudio());
        const s = new mod.Speaker();
        s.setServer(server);
        s.setServer(null);
        expect(s.usesServer).toBe(false);
        s.start();
        s.feed("Hello there. ");
        await wait();
        expect(spoken).toEqual(["Hello there."]);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
