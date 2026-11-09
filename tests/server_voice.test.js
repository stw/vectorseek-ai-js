import { describe, it, expect, vi } from "vitest";

// Browser stubs for MediaRecorder / getUserMedia / fetch.
async function load({ native = false, recorder = true, brave = false, getUserMedia } = {}) {
    vi.resetModules();
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const recorders = [];

    const win = {};
    if (native) {
        win.SpeechRecognition = class {
            constructor() { natives.push(this); this.start = vi.fn(() => this.onstart && this.onstart()); this.stop = vi.fn(); this.abort = vi.fn(); }
        };
    }
    if (recorder) {
        win.MediaRecorder = class {
            static isTypeSupported(t) { return t === "audio/webm;codecs=opus"; }
            constructor(s, opts) {
                this.state = "inactive"; this.mimeType = (opts && opts.mimeType) || "audio/webm";
                recorders.push(this);
            }
            start() { this.state = "recording"; }
            stop() {
                this.state = "inactive";
                this.ondataavailable && this.ondataavailable({ data: new Blob(["abc"]) });
                this.onstop && this.onstop();
            }
        };
    }
    globalThis.window = win;
    globalThis.document = { documentElement: { lang: "en-US" } };
    const nav = { language: "en-US" };
    if (recorder) nav.mediaDevices = { getUserMedia: getUserMedia || vi.fn(async () => stream) };
    if (brave) nav.brave = {};
    Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true });
    const natives = [];
    const mod = await import("../src/voice.js");
    return { mod, track, recorders, natives };
}

function mockFetch(response) {
    const f = vi.fn(async () => response);
    globalThis.fetch = f;
    return f;
}
const ok = (text) => ({ ok: true, status: 200, json: async () => ({ text }) });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });
const tick = () => new Promise(r => setTimeout(r, 0));

describe("ServerDictation", () => {
    it("is unsupported without an endpoint or MediaRecorder", async () => {
        const a = await load();
        expect(new a.mod.ServerDictation({}).supported).toBe(false);
        const b = await load({ recorder: false });
        expect(new b.mod.ServerDictation({ endpoint: "/x" }).supported).toBe(false);
    });

    it("records, uploads on stop and delivers the transcript", async () => {
        const { mod, track, recorders } = await load();
        const fetchMock = mockFetch(ok("hello world"));
        const cb = { onStart: vi.fn(), onProcessing: vi.fn(), onFinal: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
        const d = new mod.ServerDictation({ endpoint: "/api/voice/transcribe", key: "k1", ...cb });

        await d.start();
        expect(cb.onStart).toHaveBeenCalled();
        expect(d.listening).toBe(true);
        expect(recorders[0].mimeType).toBe("audio/webm;codecs=opus");

        d.stop();
        await tick();
        expect(track.stop).toHaveBeenCalled();           // microphone released
        expect(cb.onEnd).toHaveBeenCalled();
        expect(cb.onProcessing).toHaveBeenCalled();

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("/api/voice/transcribe");
        expect(init.method).toBe("POST");
        expect(init.body.get("key")).toBe("k1");
        expect(init.body.get("lang")).toBe("en-US");
        expect(init.body.get("audio")).toBeTruthy();
        expect(cb.onFinal).toHaveBeenCalledWith("hello world");
        expect(d.listening).toBe(false);
    });

    it("is busy from the end of recording until the transcript has been handled", async () => {
        const { mod } = await load();
        let release;
        globalThis.fetch = vi.fn(() => new Promise(r => { release = () => r(ok("done")); }));
        const seen = [];
        const d = new mod.ServerDictation({
            endpoint: "/x",
            onEnd: () => seen.push(["end", d.busy]),
            onFinal: () => seen.push(["final", d.busy]),
        });
        await d.start();
        expect(d.busy).toBe(false);          // recording, not waiting
        d.stop();
        await tick();
        expect(d.busy).toBe(true);           // uploading
        release();
        await tick();
        expect(d.busy).toBe(false);
        expect(seen).toEqual([["end", true], ["final", false]]);   // UI sees busy at onEnd, free at onFinal
    });

    it("is not busy when nothing was uploaded (aborted or no speech)", async () => {
        const { mod } = await load();
        mockFetch(ok("x"));
        const seen = [];
        const d = new mod.ServerDictation({ endpoint: "/x", onEnd: () => seen.push(d.busy) });
        await d.start();
        d.abort();
        await tick();
        expect(seen).toEqual([false]);
        expect(d.busy).toBe(false);
    });

    it("is not busy after an error response", async () => {
        const { mod } = await load();
        mockFetch(fail(500));
        const d = new mod.ServerDictation({ endpoint: "/x", onError: () => {} });
        await d.start(); d.stop(); await tick();
        expect(d.busy).toBe(false);
    });

    it("reports permission denied", async () => {
        const denied = vi.fn(async () => { const e = new Error("no"); e.name = "NotAllowedError"; throw e; });
        const { mod } = await load({ getUserMedia: denied });
        const cb = { onError: vi.fn(), onEnd: vi.fn() };
        const d = new mod.ServerDictation({ endpoint: "/x", ...cb });
        await d.start();
        expect(cb.onError).toHaveBeenCalledWith("Microphone access was denied.");
        expect(d.listening).toBe(false);
    });

    it("maps server error statuses to messages", async () => {
        for (const [status, text] of [[402, /limit/], [403, /disabled/], [429, /Too many/], [500, /failed/]]) {
            const { mod } = await load();
            mockFetch(fail(status));
            const cb = { onError: vi.fn(), onFinal: vi.fn() };
            const d = new mod.ServerDictation({ endpoint: "/x", ...cb });
            await d.start(); d.stop(); await tick();
            expect(cb.onError.mock.calls[0][0]).toMatch(text);
            expect(cb.onFinal).not.toHaveBeenCalled();
        }
    });

    it("reports a message for an empty transcript", async () => {
        const { mod } = await load();
        mockFetch(ok("   "));
        const cb = { onError: vi.fn(), onFinal: vi.fn() };
        const d = new mod.ServerDictation({ endpoint: "/x", ...cb });
        await d.start(); d.stop(); await tick();
        expect(cb.onError).toHaveBeenCalledWith("Didn't catch that, please try again.");
        expect(cb.onFinal).not.toHaveBeenCalled();
    });

    it("handles network failure", async () => {
        const { mod } = await load();
        globalThis.fetch = vi.fn(async () => { throw new Error("offline"); });
        const cb = { onError: vi.fn() };
        const d = new mod.ServerDictation({ endpoint: "/x", ...cb });
        await d.start(); d.stop(); await tick();
        expect(cb.onError).toHaveBeenCalledWith("Voice input failed.");
    });

    it("abort releases the mic and does not upload", async () => {
        const { mod, track } = await load();
        const fetchMock = mockFetch(ok("x"));
        const cb = { onFinal: vi.fn() };
        const d = new mod.ServerDictation({ endpoint: "/x", ...cb });
        await d.start();
        d.abort();
        await tick();
        expect(track.stop).toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(cb.onFinal).not.toHaveBeenCalled();
    });

    it("toggle starts then stops", async () => {
        const { mod, recorders } = await load();
        mockFetch(ok("hi"));
        const d = new mod.ServerDictation({ endpoint: "/x" });
        d.toggle(); await tick();
        expect(d.listening).toBe(true);
        d.toggle(); await tick();
        expect(recorders[0].state).toBe("inactive");
    });
});

describe("VoiceInput engine selection", () => {
    const server = { endpoint: "/api/voice/transcribe", key: "k" };

    it("uses native recognition when it is available", async () => {
        const { mod, natives } = await load({ native: true });
        const v = new mod.VoiceInput({});
        v.setServer(server);
        expect(v.useServer).toBe(false);
        v.start();
        expect(natives).toHaveLength(1);
    });

    it("uses the server in Brave even though recognition exists", async () => {
        const { mod, natives, recorders } = await load({ native: true, brave: true });
        mockFetch(ok("x"));
        const v = new mod.VoiceInput({});
        v.setServer(server);
        expect(v.useServer).toBe(true);
        v.start(); await tick();
        expect(natives).toHaveLength(0);
        expect(recorders).toHaveLength(1);
    });

    it("uses the server when native recognition is missing", async () => {
        const { mod } = await load({ native: false });
        const v = new mod.VoiceInput({});
        v.setServer(server);
        expect(v.supported).toBe(true);
        expect(v.useServer).toBe(true);
    });

    it("is unsupported with neither engine", async () => {
        const { mod } = await load({ native: false, recorder: false });
        const v = new mod.VoiceInput({});
        v.setServer(server);
        expect(v.supported).toBe(false);
    });

    it("VoiceInput.busy follows the active engine", async () => {
        const { mod } = await load({ native: false });
        let release;
        globalThis.fetch = vi.fn(() => new Promise(r => { release = () => r(ok("x")); }));
        const v = new mod.VoiceInput({});
        v.setServer(server);
        expect(v.busy).toBe(false);
        v.start(); await tick();
        expect(v.listening).toBe(true);
        expect(v.busy).toBe(false);
        v.stop(); await tick();
        expect(v.busy).toBe(true);
        release(); await tick();
        expect(v.busy).toBe(false);
    });

    it("ignores the server until it is configured", async () => {
        const { mod } = await load({ native: false });
        const v = new mod.VoiceInput({});
        expect(v.supported).toBe(false);
        v.setServer(server);
        expect(v.supported).toBe(true);
        v.setServer(null);
        expect(v.supported).toBe(false);
    });

    it("switches to the server after a native network error", async () => {
        const { mod, natives } = await load({ native: true });
        const cb = { onError: vi.fn(), onEnd: vi.fn() };
        const v = new mod.VoiceInput(cb);
        v.setServer(server);
        v.start();
        natives[0].onerror({ error: "network" });
        expect(v.forceServer).toBe(true);
        expect(v.useServer).toBe(true);
        expect(cb.onError).toHaveBeenCalledWith("Switched to cloud voice input, click the mic again.");
    });

    it("switches to the server after a silent native end", async () => {
        const { mod, natives } = await load({ native: true });
        const v = new mod.VoiceInput({ onError: vi.fn(), onEnd: vi.fn() });
        v.setServer(server);
        v.start();
        natives[0].onend();
        expect(v.forceServer).toBe(true);
    });

    it("without a server, native network errors surface normally", async () => {
        const { mod, natives } = await load({ native: true });
        const cb = { onError: vi.fn() };
        const v = new mod.VoiceInput(cb);
        v.start();
        natives[0].onerror({ error: "network" });
        expect(v.forceServer).toBe(false);
        expect(cb.onError.mock.calls[0][0]).toMatch(/unavailable/);
    });
});

describe("ServerDictation microphone safety", () => {
    it("releases the microphone if MediaRecorder.start() throws", async () => {
        const { mod, track } = await load();
        window.MediaRecorder = class {
            static isTypeSupported() { return false; }
            start() { throw new Error("boom"); }
        };
        const cb = { onError: vi.fn(), onEnd: vi.fn(), onStart: vi.fn() };
        const d = new mod.ServerDictation({ endpoint: "/x", ...cb });
        await d.start();
        expect(track.stop).toHaveBeenCalled();
        expect(d.listening).toBe(false);
        expect(cb.onStart).not.toHaveBeenCalled();
        expect(cb.onError).toHaveBeenCalledWith("Voice input failed.");
    });
});
