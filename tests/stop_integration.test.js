// @vitest-environment happy-dom
// End to end: real Speaker + real createVoiceUi + the same Stop wiring the front ends use.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mod, mic, stop, status, speaker, ui, utterances, audios;

async function setup({ server = false } = {}) {
    vi.resetModules();
    document.body.innerHTML = `
      <button id="mic" type="button" aria-label="Ask by voice"></button>
      <button id="stop" type="button" hidden></button>
      <div id="status"></div>`;
    mic = document.getElementById("mic");
    stop = document.getElementById("stop");
    status = document.getElementById("status");

    utterances = [];
    audios = [];
    // like a real browser: speaking turns true as soon as something is queued
    window.speechSynthesis = {
        speaking: false, pending: false,
        speak: vi.fn(function (u) { utterances.push(u); window.speechSynthesis.speaking = true; }),
        cancel: vi.fn(function () { window.speechSynthesis.speaking = false; }),
    };
    globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    window.SpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;
    globalThis.Audio = class {
        constructor(url) { this.url = url; this.paused = false; audios.push(this); }
        play() { return Promise.resolve(); }
        pause() { this.paused = true; }
    };
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) }));

    mod = await import("../src/voice.js");
    speaker = new mod.Speaker();
    if (server) speaker.setServer({ endpoint: "/speak", key: "k" });
    ui = mod.createVoiceUi({ mic, stop, status, isBusy: () => false });

    // exactly what the front ends do
    speaker.onBusyChange = ui.onSpeaking;
    stop.addEventListener("click", () => {
        speaker.cancel({ force: true });
        ui.reset();
    });
}

const micro = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

/** what the page does for a dictated question: dictation ends, question submitted, speaker started */
function voiceQuestionSubmitted() {
    ui.onStart(); ui.onEnd(); ui.onFinal();
    speaker.cancel();
    speaker.start();
}

afterEach(() => vi.useRealTimers());

describe("browser voice", () => {
    beforeEach(() => setup());

    it("idle: mic enabled, no Stop", () => {
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("pressing Stop mid-answer stops the speech and re-enables the mic", () => {
        voiceQuestionSubmitted();
        speaker.feed("First sentence. Second sentence. Third sentence. ");
        expect(mic.disabled).toBe(true);
        expect(stop.hidden).toBe(false);

        stop.click();

        expect(window.speechSynthesis.cancel).toHaveBeenCalled();
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
        expect(mic.getAttribute("aria-label")).toBe("Ask by voice");
        expect(status.textContent).toBe("");
    });

    it("pressing Stop before the first sentence is ready (answer still being generated)", () => {
        voiceQuestionSubmitted();
        expect(mic.disabled).toBe(true);
        expect(stop.hidden).toBe(false);
        stop.click();
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("text still arriving after Stop is not spoken and does not lock the mic again", async () => {
        voiceQuestionSubmitted();
        speaker.feed("One. ");
        stop.click();
        const spokenBefore = utterances.length;

        speaker.feed("More text that is still streaming in. ");   // the server keeps sending
        speaker.flush();                                          // end-of-answer marker
        expect(utterances.length).toBe(spokenBefore);
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("when the whole answer has been read, Stop disappears and the mic is re-enabled", async () => {
        voiceQuestionSubmitted();
        speaker.feed("One sentence. Two sentences. ");
        speaker.flush();                              // answer fully received
        expect(mic.disabled).toBe(true);              // still being read

        utterances[0].onend(); await micro();
        expect(mic.disabled).toBe(true);              // one sentence left
        utterances[1].onend(); await micro();

        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
        expect(status.textContent).toBe("");
    });

    it("the mic is only freed after the LAST sentence even if the stream ends first", async () => {
        voiceQuestionSubmitted();
        speaker.feed("Only sentence. ");
        utterances[0].onend(); await micro();
        expect(mic.disabled).toBe(true);              // stream not finished yet: more text may come
        speaker.feed("Another one. ");
        speaker.flush();
        utterances[1].onend(); await micro();
        expect(mic.disabled).toBe(false);
    });

    it("a browser that never reports the speech ending still frees the mic", async () => {
        vi.useFakeTimers();
        voiceQuestionSubmitted();
        speaker.feed("Never reports the end. ");
        speaker.flush();
        expect(mic.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(20000);
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("an answer that never sends its end marker still frees the mic", async () => {
        vi.useFakeTimers();
        voiceQuestionSubmitted();
        speaker.feed("Query limit reached. ");
        utterances[0].onend(); await micro();
        expect(mic.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(speaker.idleMs + 100);
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("muting while reading also frees the mic", () => {
        voiceQuestionSubmitted();
        speaker.feed("One. ");
        speaker.setMuted(true);
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("typed questions never disable the mic or show Stop", () => {
        speaker.cancel();                             // what the submit handler does for every question
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("works again for the next voice question after Stop", () => {
        for (let turn = 0; turn < 3; turn++) {
            voiceQuestionSubmitted();
            speaker.feed("An answer. ");
            expect(mic.disabled).toBe(true);
            expect(stop.hidden).toBe(false);
            stop.click();
            expect(mic.disabled).toBe(false);
            expect(stop.hidden).toBe(true);
        }
    });
});

describe("Stop is robust", () => {
    beforeEach(() => setup());

    it("always tells the browser to cancel, even if it reports that nothing is speaking", () => {
        voiceQuestionSubmitted();
        speaker.feed("One. Two. ");
        window.speechSynthesis.speaking = false;          // e.g. Safari briefly claims it is idle
        window.speechSynthesis.pending = false;
        window.speechSynthesis.cancel.mockClear();
        stop.click();
        expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(1);
    });

    it("an ordinary cancel still leaves speechSynthesis alone when idle (protects Safari recognition)", () => {
        window.speechSynthesis.cancel.mockClear();
        speaker.cancel();
        expect(window.speechSynthesis.cancel).not.toHaveBeenCalled();
    });

    it("re-enables the mic even if the UI and the speaker had drifted out of sync", () => {
        ui.onSpeaking(true);                              // UI believes a response is being read...
        expect(speaker.busy).toBe(false);                 // ...but the speaker is idle (no event will ever come)
        expect(mic.disabled).toBe(true);
        stop.click();
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
        expect(status.textContent).toBe("");
    });

    it("clears a stuck 'Transcribing' state as well", () => {
        ui.onStart(); ui.onProcessing();
        expect(mic.disabled).toBe(true);
        ui.reset();
        expect(mic.disabled).toBe(false);
    });
});

describe("server (AI) voice", () => {
    beforeEach(() => setup({ server: true }));

    it("Stop during playback pauses the audio, drops the queue and re-enables the mic", async () => {
        voiceQuestionSubmitted();
        speaker.feed("One. Two. Three. ");
        speaker.flush();
        await wait();
        expect(audios).toHaveLength(1);               // first clip playing, rest queued
        expect(mic.disabled).toBe(true);
        expect(stop.hidden).toBe(false);

        stop.click();

        expect(audios[0].paused).toBe(true);
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
        await wait();
        expect(audios).toHaveLength(1);               // nothing further played
        expect(mic.disabled).toBe(false);
    });

    it("Stop while the audio is still being fetched", async () => {
        let release;
        globalThis.fetch = vi.fn(() => new Promise(r => { release = () => r({ ok: true, blob: async () => new Blob(["x"]) }); }));
        voiceQuestionSubmitted();
        speaker.feed("One. ");
        expect(mic.disabled).toBe(true);
        stop.click();
        expect(mic.disabled).toBe(false);
        release();                                    // the late response arrives after Stop
        await wait();
        expect(audios).toHaveLength(0);               // never played
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("when every clip has played the mic is re-enabled", async () => {
        voiceQuestionSubmitted();
        speaker.feed("One. Two. ");
        speaker.flush();
        await wait();
        audios[0].onended(); await wait();
        expect(mic.disabled).toBe(true);
        audios[1].onended(); await wait();
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });
});
