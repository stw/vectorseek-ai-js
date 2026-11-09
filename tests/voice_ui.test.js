// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createVoiceUi } from "../src/voice.js";

let mic, stop, status, busy, ui;

function setup(opts = {}) {
    document.body.innerHTML = `
      <button id="mic" type="button" aria-pressed="false" aria-label="Ask by voice"></button>
      <button id="stop" type="button" hidden></button>
      <div id="status"></div>`;
    mic = document.getElementById("mic");
    stop = document.getElementById("stop");
    status = document.getElementById("status");
    busy = false;
    ui = createVoiceUi({ mic, stop, status, isBusy: () => busy, ...opts });
}

beforeEach(() => setup());

describe("dictating", () => {
    it("keeps the mic clickable (it ends the dictation) and does NOT show Stop", () => {
        ui.onStart();
        expect(mic.disabled).toBe(false);
        expect(mic.classList.contains("vs-listening")).toBe(true);
        expect(mic.getAttribute("aria-pressed")).toBe("true");
        expect(mic.getAttribute("aria-label")).toBe("Stop listening");
        expect(stop.hidden).toBe(true);
        expect(status.textContent).toMatch(/Listening/);
        expect(status.textContent).toMatch(/microphone/i);
    });
});

describe("re-enabling the mic", () => {
    function listening() { ui.onStart(); }

    it("when the dictation ends", () => {
        listening();
        ui.onEnd();
        expect(mic.disabled).toBe(false);
        expect(mic.classList.contains("vs-listening")).toBe(false);
        expect(mic.getAttribute("aria-pressed")).toBe("false");
        expect(mic.getAttribute("aria-label")).toBe("Ask by voice");
        expect(stop.hidden).toBe(true);
        expect(status.textContent).toBe("");
    });

    it("when the speech is complete and the transcript is delivered", () => {
        listening();
        ui.onEnd();
        ui.onFinal("what is x");
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("after an error, and the message is shown", () => {
        listening();
        ui.onError("Microphone access was denied.");
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
        expect(status.textContent).toBe("Microphone access was denied.");
    });

    it("keeps the mic disabled while a server transcription is in progress, then re-enables", () => {
        listening();
        busy = true;                        // recording ended, transcript pending
        ui.onEnd();
        expect(stop.hidden).toBe(true);     // Stop is only for responses
        expect(mic.disabled).toBe(true);
        ui.onProcessing();
        expect(status.textContent).toBe("Transcribing...");
        busy = false;
        ui.onFinal("hello");
        expect(mic.disabled).toBe(false);
    });

    it("re-enables if the transcription fails", () => {
        listening();
        busy = true;
        ui.onEnd();
        ui.onProcessing();
        busy = false;
        ui.onError("Voice input failed.");
        expect(mic.disabled).toBe(false);
        expect(status.textContent).toBe("Voice input failed.");
    });

    it("can be used for another question straight after (conversation mode)", () => {
        for (let turn = 0; turn < 3; turn++) {
            ui.onStart();
            expect(mic.disabled).toBe(false);
            expect(stop.hidden).toBe(true);
            ui.onEnd();
            ui.onFinal("q" + turn);
            expect(mic.disabled).toBe(false);
            expect(stop.hidden).toBe(true);
        }
    });
});

describe("missing elements", () => {
    it("is a safe no-op when voice is not rendered for the project", () => {
        const none = createVoiceUi({});
        expect(() => { none.onStart(); none.onProcessing(); none.onEnd(); none.onError("x"); none.onFinal(); none.ready(); }).not.toThrow();
    });

    it("works without a stop button", () => {
        setup({ stop: undefined });
        ui.onStart();
        expect(mic.disabled).toBe(false);          // dictating: mic stays clickable
        ui.onEnd();
        ui.onSpeaking(true);
        expect(mic.disabled).toBe(true);           // responding: disabled, nothing to show for Stop
        ui.onSpeaking(false);
        expect(mic.disabled).toBe(false);
    });
});


describe("stop while the answer is being read", () => {
    it("disables the mic and shows Stop while the answer is read aloud", () => {
        ui.onSpeaking(true);
        expect(mic.disabled).toBe(true);
        expect(mic.classList.contains("vs-listening")).toBe(false);   // not the recording look
        expect(mic.getAttribute("aria-label")).toBe("Reading answer");
        expect(stop.hidden).toBe(false);
        expect(status.textContent).toMatch(/Reading the answer/);
    });

    it("re-enables the mic and hides Stop when reading ends (naturally or via Stop)", () => {
        ui.onSpeaking(true);
        ui.onSpeaking(false);
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
        expect(mic.getAttribute("aria-label")).toBe("Ask by voice");
        expect(status.textContent).toBe("");
    });

    it("only clears its own status message", () => {
        ui.onSpeaking(true);
        ui.onError("Something else happened");
        ui.onSpeaking(false);
        expect(status.textContent).toBe("Something else happened");
    });

    it("Stop is not shown while dictating, only while responding", () => {
        ui.onStart();
        expect(stop.hidden).toBe(true);
        ui.onEnd();
        ui.onFinal();
        expect(stop.hidden).toBe(true);
        ui.onSpeaking(true);                // response
        expect(stop.hidden).toBe(false);
        ui.onSpeaking(false);
        expect(stop.hidden).toBe(true);
    });

    it("the mic is re-enabled when the response has been read", () => {
        ui.onSpeaking(true);
        expect(mic.disabled).toBe(true);
        ui.onSpeaking(false);               // reading finished naturally
        expect(mic.disabled).toBe(false);
    });

    it("the mic is re-enabled when Stop is pressed (which ends the speech)", () => {
        ui.onSpeaking(true);
        expect(stop.hidden).toBe(false);
        ui.onSpeaking(false);               // what speaker.cancel() reports
        expect(mic.disabled).toBe(false);
        expect(stop.hidden).toBe(true);
    });

    it("a voice question cycle: dictate (no Stop), submit, response read (Stop), mic free again", () => {
        for (let turn = 0; turn < 2; turn++) {
            ui.onStart();
            expect(mic.disabled).toBe(false);
            expect(stop.hidden).toBe(true);
            ui.onEnd();
            ui.onFinal();
            ui.onSpeaking(true);
            expect(mic.disabled).toBe(true);
            expect(stop.hidden).toBe(false);
            ui.onSpeaking(false);
            expect(mic.disabled).toBe(false);
            expect(stop.hidden).toBe(true);
        }
    });

    it("is a no-op without elements", () => {
        const none = createVoiceUi({});
        expect(() => { none.onSpeaking(true); none.onSpeaking(false); }).not.toThrow();
    });
});


describe("error messages survive the end of the session", () => {
    it("native order: the error is reported first, then the session ends - the message must stay visible", () => {
        ui.onStart();
        ui.onError("No speech detected, please try again.");
        ui.onEnd();
        expect(status.textContent).toBe("No speech detected, please try again.");
        expect(mic.disabled).toBe(false);
        expect(mic.classList.contains("vs-listening")).toBe(false);
    });

    it("server order: the session ends first, then the error arrives", () => {
        ui.onStart();
        ui.onEnd();
        ui.onError("Voice input failed.");
        expect(status.textContent).toBe("Voice input failed.");
    });

    it("a new listening session replaces the old message", () => {
        ui.onError("Something failed");
        ui.onStart();
        expect(status.textContent).toMatch(/Listening/);
        ui.onEnd();
        expect(status.textContent).toBe("");                     // ended normally: nothing to report
    });
});


describe("ending a conversation", () => {
    it("automatic listens tell the visitor how to end the conversation", () => {
        ui.onStart(true);
        expect(status.textContent).toMatch(/next question/i);
        expect(status.textContent).toMatch(/end the conversation/i);
        ui.onEnd();
        ui.onStart(false);
        expect(status.textContent).toMatch(/when you are done/i);        // manual dictation keeps its wording
    });

    it("conversation ended: idle, mic enabled, and the message survives the recognizer's own end event", () => {
        ui.onStart(true);
        ui.onConversationEnded();
        ui.onEnd();                                                    // the aborted recognizer reports its end afterwards
        expect(status.textContent).toBe("Conversation ended. Click the microphone to start again.");
        expect(mic.disabled).toBe(false);
        expect(mic.classList.contains("vs-listening")).toBe(false);
        expect(mic.getAttribute("aria-pressed")).toBe("false");
        expect(stop.hidden).toBe(true);
    });

    it("a new session after the conversation ended clears the message", () => {
        ui.onConversationEnded();
        ui.onStart();
        expect(status.textContent).toMatch(/Listening/);
    });

    it("is a no-op without elements", () => {
        expect(() => createVoiceUi({}).onConversationEnded()).not.toThrow();
    });
});
