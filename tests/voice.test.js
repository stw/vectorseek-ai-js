import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal browser stubs; voice.js reads these at import / construct time.
const FakeRec = { last: null };

async function load({ recognition = true, synthesis = true } = {}) {
    vi.resetModules();
    const spoken = [];
    const win = {};
    if (synthesis) {
        win.speechSynthesis = { speak: vi.fn(u => spoken.push(u)), cancel: vi.fn() };
        win.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        globalThis.SpeechSynthesisUtterance = win.SpeechSynthesisUtterance;
    }
    if (recognition) {
        win.SpeechRecognition = class {
            constructor() {
                FakeRec.last = this;
                this.start = vi.fn(() => this.onstart && this.onstart());
                this.stop = vi.fn(() => this.onend && this.onend());
                this.abort = vi.fn();
            }
        };
    }
    globalThis.window = win;
    globalThis.document = { documentElement: { lang: "en-US" } };
    Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });
    const mod = await import("../src/voice.js");
    return { mod, spoken, win };
}

describe("cleanForSpeech", () => {
    let c;
    beforeEach(async () => { c = (await load()).mod.cleanForSpeech; });

    it("strips markdown formatting", () => {
        expect(c("## Title\n- **Bold** and _it_ `code`")).toBe("Title Bold and it code");
    });
    it("keeps link labels, drops urls", () => {
        expect(c("see [the docs](https://x.com/a) or https://y.com/b now")).toBe("see the docs or now");
    });
    it("removes citation markers, html, code fences", () => {
        expect(c("Yes [1][2] <b>sure</b>\n```js\nx=1\n```\ndone")).toBe("Yes sure done");
    });
    it("handles empty / nullish input", () => {
        expect(c("")).toBe("");
        expect(c(null)).toBe("");
        expect(c(undefined)).toBe("");
    });
});

describe("splitSentences", () => {
    let split;
    beforeEach(async () => { split = (await load()).mod.splitSentences; });

    it("splits complete sentences and keeps the unfinished rest", () => {
        const r = split("Hello there. It works! And then");
        expect(r.sentences).toEqual(["Hello there. ", "It works! "]);
        expect(r.rest).toBe("And then");
    });
    it("does not split decimals", () => {
        const r = split("It costs 3.5 million dollars");
        expect(r.sentences).toEqual([]);
        expect(r.rest).toBe("It costs 3.5 million dollars");
    });
    it("splits on newlines", () => {
        const r = split("- a\n- b\nTail");
        expect(r.sentences).toEqual(["- a\n", "- b\n"]);
        expect(r.rest).toBe("Tail");
    });
    it("returns nothing for empty buffer", () => {
        expect(split("")).toEqual({ sentences: [], rest: "" });
    });
});

describe("feature detection", () => {
    it("reports support when APIs exist", async () => {
        const { mod } = await load();
        expect(mod.recognitionSupported()).toBe(true);
        expect(mod.synthesisSupported()).toBe(true);
    });
    it("reports no support when missing", async () => {
        const { mod } = await load({ recognition: false, synthesis: false });
        expect(mod.recognitionSupported()).toBe(false);
        expect(mod.synthesisSupported()).toBe(false);
    });
});

describe("Speaker", () => {
    it("speaks streamed sentences and flushes the remainder", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.start();
        s.feed("Hello wor");
        expect(spoken).toHaveLength(0);
        s.feed("ld. How are");
        expect(spoken.map(u => u.text)).toEqual(["Hello world."]);
        s.feed(" you");
        s.flush();
        expect(spoken.map(u => u.text)).toEqual(["Hello world.", "How are you"]);
        expect(s.active).toBe(false);
    });
    it("is silent unless started (typed queries)", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.feed("Hello world. ");
        s.flush();
        expect(spoken).toHaveLength(0);
    });
    it("is silent when muted and cancels current speech", async () => {
        const { mod, spoken, win } = await load();
        const s = new mod.Speaker();
        s.start();
        s.setMuted(true);
        expect(win.speechSynthesis.cancel).toHaveBeenCalled();
        s.feed("Hello world. ");
        expect(spoken).toHaveLength(0);
    });
    it("skips segments that clean to empty", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.start();
        s.feed("https://example.com/x \n");
        expect(spoken).toHaveLength(0);
    });
    it("cancel stops speech and clears state", async () => {
        const { mod, win } = await load();
        const s = new mod.Speaker();
        s.start();
        s.feed("partial");
        win.speechSynthesis.speaking = true;
        s.cancel();
        expect(win.speechSynthesis.cancel).toHaveBeenCalled();
        expect(s.buffer).toBe("");
        expect(s.active).toBe(false);
    });
    it("cancel does not touch synthesis when idle (avoids aborting Safari recognition)", async () => {
        const { mod, win } = await load();
        const s = new mod.Speaker();
        s.start();
        s.cancel();
        expect(win.speechSynthesis.cancel).not.toHaveBeenCalled();
    });
    it("unlock primes synthesis only once", async () => {
        const { mod, spoken } = await load();
        const s = new mod.Speaker();
        s.unlock();
        s.unlock();
        expect(spoken).toHaveLength(1);
        expect(spoken[0].volume).toBe(0);
    });
    it("does nothing without speechSynthesis", async () => {
        const { mod } = await load({ synthesis: false });
        const s = new mod.Speaker();
        expect(s.supported).toBe(false);
        expect(() => { s.start(); s.feed("Hi there. "); s.flush(); s.cancel(); s.unlock(); }).not.toThrow();
    });
});

describe("Dictation", () => {
    function result(text, isFinal) {
        const r = [{ transcript: text }];
        r.isFinal = isFinal;
        return { resultIndex: 0, results: [r] };
    }

    it("streams interim text and delivers the final transcript on end", async () => {
        const { mod } = await load();
        const cb = { onStart: vi.fn(), onInterim: vi.fn(), onFinal: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        expect(cb.onStart).toHaveBeenCalled();
        expect(d.listening).toBe(true);
        FakeRec.last.onresult(result("what is", false));
        expect(cb.onInterim).toHaveBeenLastCalledWith("what is");
        FakeRec.last.onresult(result("what is voice", true));
        FakeRec.last.onend();
        expect(cb.onFinal).toHaveBeenCalledWith("what is voice");
        expect(cb.onEnd).toHaveBeenCalled();
        expect(d.listening).toBe(false);
    });
    it("does not call onFinal when nothing was heard", async () => {
        const { mod } = await load();
        const cb = { onFinal: vi.fn(), onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        FakeRec.last.onerror({ error: "no-speech" });
        FakeRec.last.onend();
        expect(cb.onError).toHaveBeenCalledWith("No speech detected, please try again.");
        expect(cb.onFinal).not.toHaveBeenCalled();
    });
    it("maps permission errors and ignores aborts", async () => {
        const { mod } = await load();
        const cb = { onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        FakeRec.last.onerror({ error: "not-allowed" });
        expect(cb.onError).toHaveBeenCalledWith("Microphone access was denied.");
        cb.onError.mockClear();
        FakeRec.last.onerror({ error: "aborted" });
        expect(cb.onError).not.toHaveBeenCalled();
    });
    it("reports a message when the session ends silently with no result or error", async () => {
        const { mod } = await load();
        const cb = { onError: vi.fn(), onFinal: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        FakeRec.last.onend();
        expect(cb.onError).toHaveBeenCalledWith("Didn't catch that, please try again.");
        expect(cb.onFinal).not.toHaveBeenCalled();
    });
    it("shows a Brave-specific message on a silent end in Brave", async () => {
        const { mod } = await load();
        Object.defineProperty(globalThis, "navigator", { value: { language: "en-US", brave: {} }, configurable: true });
        const cb = { onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        FakeRec.last.onend();
        expect(cb.onError.mock.calls[0][0]).toMatch(/Brave/);
    });
    it("stays quiet when the session is aborted by the page", async () => {
        const { mod } = await load();
        const cb = { onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        d.abort();
        FakeRec.last.onend();
        expect(cb.onError).not.toHaveBeenCalled();
    });
    it("toggle starts then stops", async () => {
        const { mod } = await load();
        const d = new mod.Dictation({});
        d.toggle();
        const rec = FakeRec.last;
        expect(d.listening).toBe(true);
        d.toggle();
        expect(rec.stop).toHaveBeenCalled();
        expect(d.listening).toBe(false);
    });
    it("is a no-op when unsupported", async () => {
        const { mod } = await load({ recognition: false });
        const d = new mod.Dictation({});
        expect(d.supported).toBe(false);
        expect(() => d.start()).not.toThrow();
        expect(d.listening).toBe(false);
    });
});


describe("Dictation.abort", () => {
    function result(text, isFinal) {
        const r = [{ transcript: text }];
        r.isFinal = isFinal;
        return { resultIndex: 0, results: [r] };
    }

    it("discards what was heard instead of delivering it", async () => {
        const { mod } = await load();
        const cb = { onFinal: vi.fn(), onEnd: vi.fn(), onError: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        const rec = d.rec;
        rec.onresult(result("something half said", true));
        d.abort();
        rec.onend();
        expect(cb.onFinal).not.toHaveBeenCalled();
        expect(cb.onError).not.toHaveBeenCalled();           // an abort is not a failure
        expect(cb.onEnd).toHaveBeenCalled();
        expect(d.listening).toBe(false);
    });

    it("a normal stop still delivers it", async () => {
        const { mod } = await load();
        const cb = { onFinal: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start();
        const rec = d.rec;
        rec.onresult(result("send this", true));
        rec.onend();
        expect(cb.onFinal).toHaveBeenCalledWith("send this");
    });

    it("a new session after an abort delivers normally again", async () => {
        const { mod } = await load();
        const cb = { onFinal: vi.fn() };
        const d = new mod.Dictation(cb);
        d.start(); d.abort(); d.rec.onend();
        d.start();
        const rec = d.rec;
        rec.onresult(result("second try", true));
        rec.onend();
        expect(cb.onFinal).toHaveBeenCalledWith("second try");
    });
});
