// @vitest-environment happy-dom
// Real Speaker + real createVoiceUi + real HandsFree, wired exactly as the front ends wire them,
// with a fake dictation engine standing in for the browser's recognition.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let mod, mic, stop, status, input, speaker, ui, hf, dictation, utterances, conv;

class FakeDictation {
    constructor() { this.listening = false; this.busy = false; this.supported = true; this.starts = 0; }
    start() { if (this.listening) return; this.starts++; this.listening = true; page.onStart(); }
    stop() { this.listening = false; }
    abort() { this.listening = false; this.aborted = true; page.onEnd(); }        // discards; no result is delivered
    // test helpers: what the recognizer does
    hear(text) { this.listening = false; page.onEnd(); page.onFinal(text); }
    // native browsers report the error first and THEN the end of the session
    silence() { this.listening = false; page.onError("No speech detected, please try again."); page.onEnd(); }
}
let page;

async function setup({ conversation = true } = {}) {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = `
      <textarea id="q"></textarea>
      <button id="mic" type="button" aria-label="Ask by voice"></button>
      <button id="stop" type="button" hidden></button>
      <div id="status"></div>`;
    mic = document.getElementById("mic"); stop = document.getElementById("stop");
    status = document.getElementById("status"); input = document.getElementById("q");

    utterances = [];
    window.speechSynthesis = {
        speaking: false, pending: false,
        speak: vi.fn(u => { utterances.push(u); window.speechSynthesis.speaking = true; }),
        cancel: vi.fn(() => { window.speechSynthesis.speaking = false; }),
    };
    globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
    window.SpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;

    mod = await import("../src/voice.js");
    conv = { enabled: conversation };
    submitted.length = 0;
    speaker = new mod.Speaker();
    dictation = new FakeDictation();
    ui = mod.createVoiceUi({ mic, stop, status, isBusy: () => dictation.busy });

    hf = new mod.HandsFree({
        start: () => dictation.start(),
        canListen: () => conv.enabled && dictation.supported && !dictation.listening && !dictation.busy && !speaker.busy
            && document.visibilityState !== "hidden"
            && document.activeElement !== input && !String(input.value || "").trim(),
    });

    // ---- the same wiring as the front ends ----
    page = {
        onStart: () => { speaker.cancel(); ui.onStart(hf.autoSession); },
        onEnd: () => ui.onEnd(),
        onError: (msg) => { hf.disarm(); ui.onError(hf.autoSession ? "Tap the microphone to keep talking." : msg); },
        onFinal: (text) => { ui.onFinal(); submit(text, true); },
    };
    speaker.onBusyChange = (busy) => { ui.onSpeaking(busy); if (!busy) hf.readingEnded(); };
    stop.addEventListener("click", () => {
        ui.reset();
        hf.stopping = true;
        try { speaker.cancel({ force: true }); } finally { hf.stopping = false; }
    });
    mic.addEventListener("click", () => {
        if (dictation.listening && hf.autoSession) {          // clicking the mic during an automatic listen ends the conversation
            hf.end();
            dictation.abort();
            input.value = "";
            ui.onConversationEnded();
            return;
        }
        hf.markManual();
        dictation.listening ? dictation.hear(input.value || "") : dictation.start();   // a manual click finishes and sends
    });
}

/** the submit handler */
const submitted = [];
function submit(text, voice) {
    submitted.push(text);
    speaker.cancel();
    if (voice) speaker.start();
    if (voice && conv.enabled) { hf.arm(); hf.beginAnswer(); } else { hf.disarm(); }
}
/** the answer streams in, finishes, and is read aloud */
function answer(sentences = "First sentence. Second sentence. ") {
    speaker.feed(sentences);
    speaker.flush();           // end of stream
    hf.answerComplete();       // qlog_id received
}
const micro = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function finishReading() {
    for (const u of utterances.splice(0)) u.onend();
    await micro();
}

afterEach(() => vi.useRealTimers());

describe("hands-free conversation", () => {
    beforeEach(() => setup());

    it("listens again on its own after the answer has been read", async () => {
        dictation.start(); dictation.hear("what do you do");
        expect(dictation.starts).toBe(1);
        answer();
        expect(mic.disabled).toBe(true);                       // reading
        await finishReading();
        expect(mic.disabled).toBe(false);
        expect(dictation.starts).toBe(1);                      // short pause first
        vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(2);                      // ...then listening again, unprompted
        expect(mic.classList.contains("vs-listening")).toBe(true);
        expect(status.textContent).toMatch(/next question/i);
        expect(stop.hidden).toBe(true);                        // Stop is for responses only
    });

    it("keeps going: the next spoken question is submitted and the loop continues", async () => {
        dictation.start(); dictation.hear("first question");
        answer(); await finishReading(); vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(2);
        dictation.hear("second question");                      // visitor answers the auto-listen
        answer(); await finishReading(); vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(3);
    });

    it("pressing Stop listens again immediately", async () => {
        dictation.start(); dictation.hear("tell me everything");
        speaker.feed("A very long answer. And more. And more. ");
        expect(stop.hidden).toBe(false);
        // the answer is still streaming: Stop must not collide with it
        stop.click();
        expect(dictation.starts).toBe(1);                      // waits for the stream to finish
        speaker.flush(); hf.answerComplete();
        vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(2);
    });

    it("Stop after the answer has fully arrived restarts listening right inside the click", async () => {
        dictation.start(); dictation.hear("question");
        answer("Long reading one. Long reading two. Long reading three. ");
        expect(stop.hidden).toBe(false);                       // still being read
        stop.click();
        expect(dictation.starts).toBe(2);                      // immediately: no timer needed
        expect(mic.classList.contains("vs-listening")).toBe(true);
        expect(stop.hidden).toBe(true);
    });

    it("silence ends the loop: it does not keep the microphone open indefinitely", async () => {
        dictation.start(); dictation.hear("question");
        answer(); await finishReading(); vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(2);
        dictation.silence();                                    // nobody spoke
        expect(status.textContent).toBe("Tap the microphone to keep talking.");
        expect(mic.disabled).toBe(false);
        vi.advanceTimersByTime(10000);
        expect(dictation.starts).toBe(2);                      // no third listen
        expect(hf.armed).toBe(false);
    });

    it("a browser that refuses to listen without a click falls back to a hint, then stays idle", async () => {
        dictation.start(); dictation.hear("question");
        dictation.start = function () { this.starts++; page.onStart(); this.listening = false; page.onError("Microphone access was denied."); page.onEnd(); };
        answer(); await finishReading(); vi.advanceTimersByTime(500);
        expect(status.textContent).toBe("Tap the microphone to keep talking.");
        expect(mic.disabled).toBe(false);
        vi.advanceTimersByTime(10000);
        expect(dictation.starts).toBe(2);
    });

    it("a typed question ends the loop", async () => {
        dictation.start(); dictation.hear("question");
        answer(); await finishReading();
        submit("a typed follow-up", false);                      // visitor typed instead
        vi.advanceTimersByTime(5000);
        expect(dictation.starts).toBe(1);
    });

    it("does not listen while the visitor is typing or has text in the box", async () => {
        dictation.start(); dictation.hear("question");
        answer(); await finishReading();
        input.value = "half a typed thought";
        vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(1);

    });

    it("does not listen while the input has focus", async () => {
        dictation.start(); dictation.hear("question");
        answer(); await finishReading();
        input.focus();
        vi.advanceTimersByTime(500);
        expect(dictation.starts).toBe(1);
    });

    it("does not listen in a hidden tab", async () => {
        dictation.start(); dictation.hear("question");
        answer(); await finishReading();
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        vi.advanceTimersByTime(500);
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        expect(dictation.starts).toBe(1);
    });

    it("clearing the conversation or leaving the page ends the loop", async () => {
        dictation.start(); dictation.hear("question");
        answer(); await finishReading();
        hf.disarm();                                            // what onClear / pagehide do
        vi.advanceTimersByTime(5000);
        expect(dictation.starts).toBe(1);
    });

    it("a manual mic click is not treated as an automatic session", async () => {
        mic.click();
        expect(hf.autoSession).toBe(false);
        expect(status.textContent).not.toMatch(/next question/i);
    });
});

describe("outside conversation mode", () => {
    it("never listens on its own", async () => {
        await setup({ conversation: false });
        dictation.start(); dictation.hear("question");
        answer(); await finishReading();
        vi.advanceTimersByTime(5000);
        expect(dictation.starts).toBe(1);
        expect(mic.disabled).toBe(false);                      // the mic is simply available again
    });

    it("Stop still frees the mic without listening", async () => {
        await setup({ conversation: false });
        dictation.start(); dictation.hear("question");
        answer("One. Two. Three. ");
        stop.click();
        expect(mic.disabled).toBe(false);
        expect(dictation.starts).toBe(1);
    });
});


describe("ending the conversation by clicking the microphone", () => {
    beforeEach(() => setup());

    async function intoAutoListen() {
        dictation.start(); dictation.hear("first question");
        answer(); await finishReading(); vi.advanceTimersByTime(500);
        expect(hf.autoSession).toBe(true);
        expect(dictation.listening).toBe(true);
    }

    it("stops listening, ends the conversation and does not restart", async () => {
        await intoAutoListen();
        mic.click();
        expect(dictation.listening).toBe(false);
        expect(dictation.aborted).toBe(true);
        expect(hf.armed).toBe(false);
        expect(status.textContent).toBe("Conversation ended. Click the microphone to start again.");
        expect(mic.disabled).toBe(false);
        expect(mic.classList.contains("vs-listening")).toBe(false);
        vi.advanceTimersByTime(10000);
        expect(dictation.starts).toBe(2);                         // no further automatic listen
    });

    it("what was being said is discarded, not sent", async () => {
        await intoAutoListen();
        input.value = "half a sentence the recognizer was showing";   // live text
        const before = submitted.length;
        mic.click();
        expect(submitted.length).toBe(before);                    // nothing submitted
        expect(input.value).toBe("");
    });

    it("the microphone works normally afterwards: a click starts a fresh manual dictation", async () => {
        await intoAutoListen();
        mic.click();                                              // end the conversation
        mic.click();                                              // start again by hand
        expect(dictation.listening).toBe(true);
        expect(hf.autoSession).toBe(false);
        expect(status.textContent).toMatch(/when you are done/i);
        dictation.hear("a brand new question");
        expect(submitted.at(-1)).toBe("a brand new question");
        expect(hf.armed).toBe(true);                              // a new voice conversation has begun
    });

    it("clicking the microphone during your OWN dictation still finishes and sends it", async () => {
        mic.click();                                              // manual listen
        expect(hf.autoSession).toBe(false);
        input.value = "send me please";
        mic.click();                                              // finish
        expect(submitted.at(-1)).toBe("send me please");
        expect(hf.armed).toBe(true);                              // and the conversation carries on
    });

    it("a silent automatic listen ends the conversation by itself (no click needed)", async () => {
        await intoAutoListen();
        dictation.silence();
        expect(hf.armed).toBe(false);
        vi.advanceTimersByTime(10000);
        expect(dictation.starts).toBe(2);
    });

    it("the visible 'conversation on' cue follows the loop", async () => {
        const on = [];
        hf.onActiveChange = (v) => on.push(v);
        dictation.start(); dictation.hear("question");           // arms
        expect(on).toEqual([true]);
        answer(); await finishReading(); vi.advanceTimersByTime(500);
        mic.click();                                              // ends
        expect(on).toEqual([true, false]);
    });
});
